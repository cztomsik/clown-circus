import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const MAX = 2 * 1024 * 1024; // 2MB cap
const BUILTIN_INIT = readFileSync(fileURLToPath(new URL('./skills/init.md', import.meta.url)), 'utf8');

const tool = (name, description, parameters, run) => ({ name, description, parameters, run });

// JSON-schema shorthands (emit the same `parameters` as a literal object schema).
const S = (vals) => ({ type: 'string', ...(vals ? { enum: vals } : {}) });
const B = () => ({ type: 'boolean' });
const obj = (properties, required) => ({ type: 'object', properties, required });

const isUtf8 = (buf) => buf.equals(Buffer.from(buf.toString('utf8'), 'utf8'));

// --- Core tools -------------------------------------------------------------

const readFile = async (ctx, args) => {
  const buf = await fsReadFile(resolve(ctx.cwd, args.path));
  if (buf.length > MAX) throw new Error('File too large');
  if (!isUtf8(buf)) throw new Error('Invalid UTF-8');
  const text = buf.toString('utf8');
  return args.raw ? text : text.split('\n').map((l, i) => `${i + 1}:${l}`).join('\n');
};

const writeFile = async (ctx, args) => {
  const p = resolve(ctx.cwd, args.path);
  await mkdir(dirname(p), { recursive: true });
  await fsWriteFile(p, args.content);
  return 'File written successfully';
};

const editFile = async (ctx, args) => {
  const p = resolve(ctx.cwd, args.path);
  const content = (await fsReadFile(p)).toString('utf8');
  let next;
  if (args.replace_all) {
    if (!args.old_content) throw new Error('old_content must be non-empty');
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

const runCommand = (ctx, args) =>
  new Promise((res) => {
    const cwd = args.cwd ? resolve(ctx.cwd, args.cwd) : ctx.cwd;
    // `stdin: 'ignore'` so commands that read stdin (prompts, `cat`, npm
    // questions) get EOF immediately instead of hanging on input that never
    // arrives. We only ever capture stdout/stderr.
    const child = spawn('sh', ['-c', args.command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let code = 0;
    let done = false;
    let drainTimer;
    const onAbort = () => child.kill('SIGKILL');
    const cleanup = () => {
      clearTimeout(drainTimer);
      ctx.signal?.removeEventListener('abort', onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const finish = (s) => {
      if (done) return;
      done = true;
      cleanup();
      res(s);
    };
    const render = () =>
      code !== 0 ? `Command failed with exit code ${code}\nStdout:\n${out}\nStderr:\n${err}`
      : err.length ? `${out}\n\nStderr:\n${err}`
      : out;
    if (ctx.signal) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (d) => (out.length < MAX ? (out += d) : null));
    child.stderr.on('data', (d) => (err.length < MAX ? (err += d) : null));
    child.on('error', (e) => finish(`Error running command: ${e.message}`));
    child.on('exit', (c) => {
      code = c ?? 0;
      // The command itself is done, but `close` (all stdio closed) may be
      // deferred indefinitely if it backgrounded a grandchild that inherited
      // the pipes. Finalize on `close` (exact drain) or after a short grace
      // period to flush trailing output, whichever comes first.
      drainTimer = setTimeout(() => finish(render()), DRAIN_MS);
    });
    child.on('close', () => finish(render()));
  });

// The todo list is a user-visible markdown string (see PREFIX.md for the
// checkbox convention). The tool is a no-op: the tool call's presence in the
// transcript IS the todo list — the web UI derives it from messages.
const writeTodos = (_ctx, _args) => 'Todos updated';

const loadSkill = async (ctx, args) => {
  if (args.skill_name === 'init') return BUILTIN_INIT;
  return (await fsReadFile(resolve(ctx.cwd, `skills/${args.skill_name}.md`))).toString('utf8');
};

// --- Registration -----------------------------------------------------------

const buildTools = () =>
  new Map([
    tool('read_file', 'Read the contents of a file',
      obj({ path: S(), raw: B() }, ['path']), readFile),
    tool('write_file', 'Write content to a file, creating directories if needed',
      obj({ path: S(), content: S() }, ['path', 'content']), writeFile),
    tool('edit_file', 'Edit a file by replacing specific content. Set replace_all=true to replace all occurrences',
      obj({ path: S(), old_content: S(), new_content: S(), replace_all: B() }, ['path', 'old_content', 'new_content']), editFile),
    tool('run_command', 'Execute a shell command in the current working directory and return its output.',
      obj({ command: S() }, ['command']), runCommand),
    tool('write_todos', "Set the session's todo list — a markdown string, shown to the user. Full replace: pass the entire updated list.",
      obj({ content: { type: 'string', description: 'The full todo list as markdown.' } }, ['content']), writeTodos),
    tool('load_skill', 'Load a set of specialized instructions (a skill) into the current context to improve performance on a specific task.',
      obj({ skill_name: S() }, ['skill_name']), loadSkill),
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
