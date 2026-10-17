import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const MAX = 2 * 1024 * 1024; // 2MB cap

const tool = (name, description, parameters, run) => ({ name, description, parameters, run });

// JSON-schema shorthands (emit the same `parameters` as a literal object schema).
const S = (vals?) => ({ type: 'string', ...(vals ? { enum: vals } : {}) });
const B = () => ({ type: 'boolean' });
const obj = (properties, required) => ({ type: 'object', properties, required });

const isUtf8 = (buf) => buf.equals(Buffer.from(buf.toString('utf8'), 'utf8'));

// Magic-byte image detection. The MIME set is the one the LLM backend is
// guaranteed to decode — the same set the web UI sends as composer
// attachments (webui/image.ts). Returns the MIME, or null for non-images.
const IMAGE_MAGIC = [
  { mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
  { mime: 'image/gif', test: (b) => b.subarray(0, 4).toString('ascii') === 'GIF8' }, // 87a/88a/89a
];
const detectImageMime = (buf) =>
  buf.length >= 12 ? (IMAGE_MAGIC.find((m) => m.test(buf))?.mime ?? null) : null;

// A leading ~/ (or bare ~) expands to the user home — node:path.resolve does not.
const fromHome = (p) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
// Resolve a tool path: ~/ against the user home, then relative against the session cwd.
const resolvePath = (cwd, p) => resolve(cwd, fromHome(p));

// --- Core tools -------------------------------------------------------------

const readFile = async (ctx, args) => {
  const buf = await fsReadFile(resolvePath(ctx.cwd, args.path));
  if (buf.length > MAX) throw new Error('File too large');
  const mime = detectImageMime(buf);
  if (mime)
    return [
      { type: 'text', text: `Image (${mime}, ${buf.length} bytes):` },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
    ];
  if (!isUtf8(buf)) throw new Error('Invalid UTF-8');
  const text = buf.toString('utf8');
  return args.raw ? text : text.split('\n').map((l, i) => `${i + 1}:${l}`).join('\n');
};

const writeFile = async (ctx, args) => {
  const p = resolvePath(ctx.cwd, args.path);
  await mkdir(dirname(p), { recursive: true });
  await fsWriteFile(p, args.content);
  return 'File written successfully';
};

const editFile = async (ctx, args) => {
  if (typeof args.old_content !== 'string' || !args.old_content || typeof args.new_content !== 'string')
    throw new Error('expected: path (string), old_content (string), new_content (string), replace_all? (boolean)');
  const p = resolvePath(ctx.cwd, args.path);
  const content = (await fsReadFile(p)).toString('utf8');
  let next;
  if (args.replace_all) {
    next = content.split(args.old_content).join(args.new_content);
  } else {
    const pos = content.indexOf(args.old_content);
    if (pos === -1) throw new Error('Content not found');
    if (content.indexOf(args.old_content, pos + args.old_content.length) !== -1)
      throw new Error('Ambiguous match (appears more than once); set replace_all=true');
    next = content.slice(0, pos) + args.new_content + content.slice(pos + args.old_content.length);
  }
  await fsWriteFile(p, next);
  return 'File edited successfully';
};

// Grace period after the direct child exits before forcing a finalize. Covers
// the case where `close` is delayed by a grandchild that inherited our stdio.
const DRAIN_MS = 300;

// A command still running after this long is left alive in the background:
// its output is redirected to temp files and the tool resolves, so the agent
// can keep working and monitor/kill the process itself.
const CMD_TIMEOUT_MS = 60_000;

// Kill a command's whole process tree. `detached: true` made the child the
// leader of its own process group (the sh plus everything it spawns), so
// -pid names exactly that tree and can never reach the server.
const killTree = (child) => {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
};

// Every spawned command — in-flight or backgrounded past the timeout — so
// the server can kill their trees on shutdown instead of orphaning them.
const live = new Map(); // pid → ChildProcess
export const killAllChildren = () => {
  for (const child of live.values()) killTree(child);
  live.clear();
};

const runCommand = (ctx, args) =>
  new Promise((res) => {
    const cwd = args.cwd ? resolve(ctx.cwd, args.cwd) : ctx.cwd;
    // `stdin: 'ignore'` so commands that read stdin (prompts, `cat`, npm
    // questions) get EOF immediately instead of hanging on input that never
    // arrives. We only ever capture stdout/stderr. `detached: true` makes the
    // child lead its own process group (+ session) so the whole tree can be
    // group-killed and terminal signals to the server can't reach it.
    const child = spawn('sh', ['-c', args.command], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    if (child.pid) live.set(child.pid, child);
    let out = '';
    let err = '';
    let code = 0;
    let sig = null; // a signal death (kill, segfault) is a failure, not exit 0
    let done = false;
    let drainTimer;
    let timeoutTimer;
    let outStream;
    let errStream;
    // Output sinks: in-memory (capped) while awaited, temp-file once the
    // command is backgrounded past the timeout (the child keeps writing to
    // its pipe; only where we put the data changes).
    let sinkOut = (d) => { if (out.length < MAX) out += d; };
    let sinkErr = (d) => { if (err.length < MAX) err += d; };
    const onAbort = () => killTree(child);
    const reap = () => {
      clearTimeout(drainTimer);
      clearTimeout(timeoutTimer);
      ctx.signal?.removeEventListener('abort', onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      outStream?.end();
      errStream?.end();
      live.delete(child.pid);
    };
    const finish = (s) => {
      if (done) return;
      done = true;
      res(s);
    };
    const render = () =>
      code !== 0 || sig
        ? `Command failed${sig ? ` (killed by ${sig})` : ` with exit code ${code}`}\nStdout:\n${out}\nStderr:\n${err}`
        : err.length ? `${out}\n\nStderr:\n${err}`
        : out;
    // Still running past the timeout: stop buffering in memory, redirect
    // output to temp files, and resolve — the process keeps running and the
    // agent owns it from here.
    const detach = () => {
      if (done || !child.pid) return;
      done = true;
      const id = randomUUID();
      outStream = createWriteStream(join(tmpdir(), `clown-cmd-${id}.out`));
      errStream = createWriteStream(join(tmpdir(), `clown-cmd-${id}.err`));
      sinkOut = (d) => outStream.write(d);
      sinkErr = (d) => errStream.write(d);
      res(`Command exceeded ${CMD_TIMEOUT_MS / 1000}s and is still running; it was left running in the background as PID ${child.pid}. ` +
        `Its stdout is being written to ${outStream.path} and its stderr to ${errStream.path} — check those files to monitor progress, ` +
        `and kill the process (e.g. \`kill ${child.pid}\`) when it is no longer needed.`);
    };
    timeoutTimer = setTimeout(detach, CMD_TIMEOUT_MS);
    if (ctx.signal) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (d) => sinkOut(d));
    child.stderr.on('data', (d) => sinkErr(d));
    child.on('error', (e) => {
      reap();
      finish(`Error running command: ${e.message}`);
    });
    child.on('exit', (c, s) => {
      code = c ?? 0;
      sig = s;
      if (done) return;
      // The command itself is done, but `close` (all stdio closed) may be
      // deferred indefinitely if it backgrounded a grandchild that inherited
      // the pipes. Finalize on `close` (exact drain) or after a short grace
      // period to flush trailing output, whichever comes first.
      drainTimer = setTimeout(() => finish(render()), DRAIN_MS);
    });
    child.on('close', () => {
      reap();
      finish(render());
    });
  });

// The todo list is a user-visible markdown string (see prompt.ts for the
// checkbox convention). The tool is a no-op: the tool call's presence in the
// transcript IS the todo list — the web UI derives it from messages.
const writeTodos = (_ctx, _args) => 'Todos updated';

// --- Registration -----------------------------------------------------------

const buildTools = () =>
  new Map([
    tool('read_file', 'Read the contents of a file (images are returned as a base64 image the model can see)',
      obj({ path: S(), raw: B() }, ['path']), readFile),
    tool('write_file', 'Write content to a file, creating directories if needed',
      obj({ path: S(), content: S() }, ['path', 'content']), writeFile),
    tool('edit_file', 'Edit a file by replacing specific content. Set replace_all=true to replace all occurrences',
      obj({ path: S(), old_content: S(), new_content: S(), replace_all: B() }, ['path', 'old_content', 'new_content']), editFile),
    tool('run_command', 'Execute a shell command in the current working directory and return its output.',
      obj({ command: S() }, ['command']), runCommand),
    tool('write_todos', "Set the session's todo list — a markdown string, shown to the user. Full replace: pass the entire updated list.",
      obj({ content: { type: 'string', description: 'The full todo list as markdown.' } }, ['content']), writeTodos),
  ].map((t) => [t.name, t]));

// OpenAI `tools` array for the LLM, derived from a registry.
const schemasOf = (registry) =>
  [...registry.values()].map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

// One tool registry (and its OpenAI schemas) for the whole process.
export const tools = buildTools();
export const toolSchemas = schemasOf(tools);
