import { join, resolve } from 'node:path';

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

// A leading ~/ (or bare ~) expands to the session user's home — node:path
// does not. For remote sessions that is the remote home, not the local one
// (the backend's home()).
const fromHome = (p, home) => (p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p);
// Resolve a tool path: ~/ against the session home, then relative against
// the session dir — one expression, both kinds.
const resolvePath = async (ctx, p) =>
  resolve(ctx.backend.dir, fromHome(p, await ctx.backend.home()));

// --- Core tools -------------------------------------------------------------

const readFile = async (ctx, args) => {
  const buf = await ctx.backend.readFile(await resolvePath(ctx, args.path), MAX + 1);
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
  await ctx.backend.writeFile(await resolvePath(ctx, args.path), args.content);
  return 'File written successfully';
};

const editFile = async (ctx, args) => {
  if (typeof args.old_content !== 'string' || !args.old_content || typeof args.new_content !== 'string')
    throw new Error('expected: path (string), old_content (string), new_content (string), replace_all? (boolean)');
  const p = await resolvePath(ctx, args.path);
  const content = (await ctx.backend.readFile(p)).toString('utf8');
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
  await ctx.backend.writeFile(p, next);
  return 'File edited successfully';
};

// A command still running after this long is left alive in the background:
// its output is redirected to temp files and the tool resolves, so the agent
// can keep working and monitor/kill the process itself.
const CMD_TIMEOUT_MS = 60_000;

// The one run_command (both kinds): the policy — 60s detach, the abort
// kill, the render — lives here exactly once; all locality (spawn, tmux
// window, log files, tree kill) is inside the backend's exec / kill. Never
// throws — every failure is a result string.
const runCommand = async (ctx, args) => {
  const b = ctx.backend;
  const dir = args.cwd ? resolve(b.dir, args.cwd) : b.dir; // pure string op, both kinds
  let h;
  try {
    h = await b.exec(args.command, dir);
  } catch (e) {
    return `Error running command: ${e.message}`;
  }
  // Stop kills the in-flight command only; a backgrounded (detached) one
  // survives — stopping it is the agent's job. One listener both kills the
  // tree and settles the race (already-aborted → onAbort() runs
  // synchronously below).
  let detached = false;
  let fireAbort;
  const abortP = ctx.signal ? new Promise((res) => (fireAbort = res)) : null;
  // The 60s timer as a plain handle: a settled race must not keep the loop
  // alive for the remainder.
  let timeoutTimer;
  const timeoutP = new Promise((res) => (timeoutTimer = setTimeout(() => res({ kind: 'timeout' }), CMD_TIMEOUT_MS)));
  const onAbort = () => { if (!detached) b.kill(h.id); fireAbort?.(); };
  if (ctx.signal) {
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const outcome = await Promise.race([
      h.status.then((s) => ({ kind: 'done', ...s })),
      timeoutP,
      ...(abortP ? [abortP.then(() => ({ kind: 'aborted' }))] : []),
    ]);
    if (outcome.kind === 'aborted')
      return `Command stopped (kill requested for ${h.id}).`;
    if (outcome.kind === 'timeout') {
      detached = true; // it keeps running; stop() must not reach it
      return `Command exceeded ${CMD_TIMEOUT_MS / 1000}s and is still running; it was left running in the background. ` +
        `Its stdout is being written to ${h.out} and its stderr to ${h.err} — check those files to monitor progress, ` +
        `and run \`${h.killCmd}\` when it is no longer needed.`;
    }
    // Both streams, each capped at MAX (local: bounded read; remote: capped
    // before it crosses the wire); a missing/unreadable file renders empty.
    const read = async (p) => {
      try {
        return (await b.readFile(p, MAX + 1)).toString('utf8').slice(0, MAX);
      } catch {
        return '';
      }
    };
    const [out, err] = await Promise.all([read(h.out), read(h.err)]);
    // A signal death rides on `sig` (local only — a remote signal death
    // arrives as the shell's 128+N exit code): a failure, not an exit code.
    return outcome.sig
      ? `Command failed (killed by ${outcome.sig})\nStdout:\n${out}\nStderr:\n${err}`
      : outcome.code !== 0
      ? `Command failed with exit code ${outcome.code}\nStdout:\n${out}\nStderr:\n${err}`
      : err ? `${out}\n\nStderr:\n${err}`
      : out;
  } catch (e) {
    return `Error running command: ${e.message}`;
  } finally {
    clearTimeout(timeoutTimer); // drop the timer once the race is over
    h.cancel(); // abandon the wait (local: drop the clean-exit logs; remote: kill the waiter)
    ctx.signal?.removeEventListener('abort', onAbort);
  }
};

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
