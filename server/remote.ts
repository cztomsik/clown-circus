import { spawn, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { HttpError } from './errors.ts';
import { assert } from './util.ts';
import type { Backend, ExecHandle } from './backend.ts';

// Remote (ssh://) sessions: one-shot ssh for file ops; commands run in a
// per-session remote tmux session (one window per command — tmux kills the
// window's whole tree, and a blocking ssh "waiter" never owns the command,
// so it survives a detached waiter, a transport death, and a restart).
// Untrusted values (paths, commands, contents) cross only as base64 or on
// ssh's stdin — embedded script text is always server-generated.

export type RemoteTarget = { user: string | null, host: string, port: number | null, dir: string, target: string };

// Parse an ssh:// cwd into a target; null for local (or malformed) cwds.
export const parseRemoteCwd = (cwd): RemoteTarget | null => {
  if (typeof cwd !== 'string' || !cwd.startsWith('ssh://')) return null;
  try {
    const u = new URL(cwd);
    if (u.protocol !== 'ssh:' || !u.hostname || !u.pathname.startsWith('/')) return null;
    // URL keeps the path (and user) percent-encoded — decode to the literal
    // remote values (a bad % sequence throws → malformed cwd).
    const user = u.username ? decodeURIComponent(u.username) : null;
    return {
      user,
      host: u.hostname,
      port: u.port ? Number(u.port) : null,
      dir: decodeURIComponent(u.pathname),
      target: user ? `${user}@${u.hostname}` : u.hostname,
    };
  } catch {
    return null;
  }
};

// The remote tmux session name for a session (uuid = safe charset).
export const tmuxSession = (sid) => `clown-${sid}`;
// Per-session scratch dir on the remote: <tok>.out + <tok>.err + <tok>.exit
// per command — removed with the session's remote footprint (boot reap,
// shutdown, dispose).
export const remoteScratchDir = (sid) => `/tmp/clown-${sid}`;

// POSIX-single-quote one remote word — ssh joins argv with spaces and the
// remote shell re-parses, so a script must arrive as a single word.
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// The ssh client options: never hang on an auth prompt, auto-trust a new
// host key (changed keys are still detected), fail fast on connect.
const sshArgs = (r) => [
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ConnectTimeout=10',
  ...(r.port ? ['-p', String(r.port)] : []),
  r.target,
];

// One-shot ssh: run a server-generated POSIX sh script on the remote.
// `stdin` (file content) crosses the pipe, never a command line. Exit 255
// means the transport itself failed (host down, auth, DNS) — it is never a
// remote command's own exit code.
const ssh = (r, script, stdin = null) =>
  new Promise<{ code: number, stdout: Buffer, stderr: string }>((res, rej) => {
    // No pipe → detach stdin from our fds: an orphaned child (a fire-and-forget
    // kill surviving process.exit) must not keep the server's pipes open.
    const opts: SpawnOptions = stdin == null
      ? { stdio: ['ignore', 'pipe', 'pipe'] }
      : { stdio: ['pipe', 'pipe', 'pipe'] };
    const child = spawn('ssh', [...sshArgs(r), 'sh', '-c', sq(script)], opts);
    const chunks = [];
    let err = '';
    child.stdout.on('data', (b) => chunks.push(b));
    child.stderr.on('data', (b) => { if (err.length < 4096) err += b; });
    child.on('error', (e) => rej(new Error(`ssh: ${e.message}`)));
    child.on('close', (code) => res({ code: code ?? 255, stdout: Buffer.concat(chunks), stderr: err }));
    child.stdin?.on('error', () => {}); // EPIPE: the remote side closed stdin early
    child.stdin?.end(stdin);
  });

// The user-facing text for a transport failure (255 / spawn error).
const unreachable = (r, out) =>
  `cannot reach remote host ${r.target} — ${out.stderr.trim() || 'ssh exited 255'}`;

// Throw for a transport failure (255) or a non-zero remote exit; return stdout.
const need = (r, out, what) => {
  if (out.code === 255) throw new Error(unreachable(r, out));
  if (out.code !== 0)
    throw new Error(`${what} on ${r.target}: ${out.stderr.trim() || `ssh exited ${out.code}`}`);
  return out.stdout.toString('utf8');
};

// Kill a session's remote footprint (startup reap, shutdown, dispose): its
// tmux session plus its scratch dir, plus any `extra` cleanup (the boot reap
// also sweeps write temps). Resolves even on transport failure —
// uninterested callers .catch(() => {}).
export const cleanRemoteSession = (sid, target, extra = '') =>
  ssh(target, `tmux kill-session -t ${tmuxSession(sid)} 2>/dev/null; rm -rf -- ${remoteScratchDir(sid)}; ${extra}exit 0`);

// The remote per-session Backend (backend.ts): file ops over ssh, commands
// in the per-session tmux session, and the lifecycle hooks (validate / reap
// / dispose).
export class RemoteBackend implements Backend {
  kind = 'remote' as const;
  target: RemoteTarget;
  #sid: string;
  #dead = false;
  #home = null; // remote $HOME, resolved lazily
  #launch: Promise<unknown> = Promise.resolve(); // serializes tmux window launches
  #waiters = new Set<{ cancel: () => void }>(); // in-flight waiter connections (one per running command)

  constructor(sid, target) {
    this.#sid = sid;
    this.target = target;
  }

  get dir() {
    return this.target.dir;
  }

  // Create-time preflight: reachability, tmux installed, dir exists (or
  // create it when `create` is true). One round-trip for tmux + dir state
  // (the probe must end in `exit 0` — a missing path makes `[ -e ]` fail,
  // and a non-zero exit would read as "no tmux").
  async validate(create) {
    const r = this.target;
    // The path travels as base64, never onto a command line.
    const B = b64(r.dir);
    const d = await ssh(r, `command -v tmux >/dev/null || exit 1
d=$(printf %s ${B} | base64 -d); [ -d "$d" ] && echo dir; [ -e "$d" ] && echo file; exit 0`);
    if (d.code === 255) throw new HttpError(502, 'remote_unavailable', unreachable(r, d));
    if (d.code !== 0) throw new HttpError(502, 'remote_unavailable', `tmux is not installed on ${r.target}`);
    if (d.stdout.includes('dir')) return;
    if (d.stdout.includes('file')) throw new HttpError(400, 'bad_request', `cwd is not a directory: ${r.dir} on ${r.target}`);
    if (create !== true) throw new HttpError(404, 'not_found', `cwd path does not exist: ${r.dir} on ${r.target}`);
    const m = await ssh(r, `mkdir -p -- "$(printf %s ${B} | base64 -d)"`);
    if (m.code !== 0)
      throw new HttpError(500, 'internal', `could not create cwd path: ${r.dir} on ${r.target} — ${m.stderr.trim() || `ssh exited ${m.code}`}`);
  }

  // Boot: end the session's remote footprint — its orphaned tmux session
  // (a crash or prior shutdown), its scratch dir, and any `.clown-*` write
  // temp a crashed run left in the session dir (a mid-`cat` transport death
  // skips the inline cleanup, so it leaks until here). Fire-and-forget;
  // reachability is best-effort at boot.
  reap() {
    const B = b64(this.target.dir);
    cleanRemoteSession(this.#sid, this.target, `rm -f -- "$(printf %s ${B} | base64 -d)"/.clown-*; `).catch(() => {});
  }

  // The remote user's $HOME (for ~/ in tool paths), resolved once per
  // backend. A downed host surfaces as an explicit error, never ''.
  async home() {
    assert(!this.#dead, 'remote session destroyed');
    if (this.#home) return this.#home;
    const out = await ssh(this.target, 'printf %s "$HOME"');
    this.#home = need(this.target, out, 'read $HOME failed');
    if (!this.#home) throw new Error(`remote host ${this.target.target} reported an empty $HOME`);
    return this.#home;
  }

  // Read a (already-resolved) file; a missing/non-regular file rejects.
  // `maxBytes` (0/Infinity = unbounded) bounds the transfer on the remote
  // before anything crosses the wire; an over-cap file returns its first
  // maxBytes.
  async readFile(path, maxBytes) {
    assert(!this.#dead, 'remote session destroyed');
    const cap = Number.isFinite(maxBytes) ? maxBytes : 0;
    const out = await ssh(this.target, `p=$(printf %s ${b64(path)} | base64 -d)
[ -f "$p" ] || exit 42
sz=$(wc -c < "$p" | tr -d ' ')
if [ ${cap} = 0 ] || [ "$sz" -le ${cap} ]; then
  echo "OK $sz"
  base64 < "$p" | tr -d '\\n'
else
  echo "PART $sz"
  head -c ${cap} < "$p" | base64 | tr -d '\\n'
fi`);
    if (out.code === 42) throw new Error(`file not found: ${path}`);
    const text = need(this.target, out, 'read failed');
    const nl = text.indexOf('\n');
    const status = text.slice(0, nl);
    if (!status.startsWith('OK') && !status.startsWith('PART'))
      throw new Error(`read failed on ${this.target.target}: bad status ${JSON.stringify(status)}`);
    return Buffer.from(text.slice(nl + 1), 'base64');
  }

  // Write content to a path, creating parent dirs. Content crosses ssh stdin
  // (never a command line); the write is an atomic rename.
  async writeFile(path, content) {
    assert(!this.#dead, 'remote session destroyed');
    const t = `wr-${randomUUID()}`;
    const out = await ssh(this.target, `p=$(printf %s ${b64(path)} | base64 -d)
d=$(dirname -- "$p")
mkdir -p -- "$d" || exit 1
tt="$d/.clown-${t}"
cat > "$tt" && mv -f -- "$tt" "$p"`, Buffer.from(content, 'utf8'));
    // A 255 (a transport death mid-`cat`) can leave a partial `.clown-*`
    // temp behind — a cleanup round-trip to a dead host would only fail, so
    // it is left for the boot reap's sweep.
    if (out.code !== 0 && out.code !== 255)
      ssh(this.target, `rm -f -- "$(dirname -- "$(printf %s ${b64(path)} | base64 -d)")"/.clown-${t}`).catch(() => {});
    need(this.target, out, 'write failed');
  }

  // Run a command in `dir` — one window in the session's remote tmux
  // session. Returns the session's `ExecHandle`: `id` (the window id — what
  // `kill()` takes), `out`/`err` (the remote log files, written from t=0),
  // `status` (Promise<{ code }> — rejects on a lost transport or an early
  // window kill), `cancel()` (abandon the wait — the command itself keeps
  // running in tmux).
  async exec(command, dir): Promise<ExecHandle> {
    assert(!this.#dead, 'remote session destroyed');
    const tok = randomUUID();
    const win = await this.#launchWindow(command, dir, tok);
    const d = remoteScratchDir(this.#sid);
    const sess = tmuxSession(this.#sid);
    // The waiter blocks ON the remote host until the exit file appears or
    // the window is gone (a killed window prints KILLED). It exits 0 when
    // it concludes, so a 255/null close can only mean the transport died
    // (or the waiter was cancelled locally).
    const w = `while [ ! -f ${d}/${tok}.exit ]; do tmux list-windows -t ${sess} -F '#{window_id}' 2>/dev/null | grep -Fxq ${win} || break; sleep 0.2; done; [ -f ${d}/${tok}.exit ] && cat ${d}/${tok}.exit || printf KILLED`;
    const child = spawn('ssh', [...sshArgs(this.target), 'sh', '-c', sq(w)]);
    const h: ExecHandle & { tok: string, cancelled: boolean } = {
      tok,
      id: win,
      killCmd: `tmux kill-window -t ${win}`,
      out: `${d}/${tok}.out`,
      err: `${d}/${tok}.err`,
      cancelled: false,
      cancel: () => { h.cancelled = true; child.kill('SIGKILL'); },
      status: null,
    };
    // The waiter's own stdout carries the exit code (or KILLED) — not the
    // command's output (that goes to the window's log files).
    let code = '';
    const status = new Promise<{ code: number }>((resolve, reject) => {
      child.stdout.on('data', (b) => { if (code.length < 64) code += b; });
      child.stdout.on('error', () => {});
      child.on('error', (e) => reject(new Error(`ssh: ${e.message}`)));
      child.on('close', (rc) => {
        this.#waiters.delete(h);
        if (h.cancelled) return; // abandoned: never settles
        if (rc === null || rc === 255)
          return reject(new Error(`lost ssh to ${this.target.target} while waiting for the command — it may still be running in tmux window ${h.id}; check ${h.out} (stdout) and ${h.err} (stderr)`));
        const t = code.trim();
        if (t === 'KILLED')
          return reject(new Error(`the command's tmux window ${h.id} on ${this.target.target} was killed before it finished — its partial output is in ${h.out} (stdout) and ${h.err} (stderr)`));
        resolve({ code: Number(t) });
      });
    });
    status.catch(() => {}); // consumers cancel or handle; a floating rejection must never crash the process
    h.status = status;
    this.#waiters.add(h);
    return h;
  }

  // One ssh call; stdout = the new window id. Serialized per backend so two
  // concurrent first commands can't both take the new-session path.
  #launchWindow(command, dir, tok) {
    const p = this.#launch.then(() => this.#doLaunch(command, dir, tok));
    this.#launch = p.catch(() => {});
    return p;
  }

  async #doLaunch(command, dir, tok) {
    const d = remoteScratchDir(this.#sid);
    const sess = tmuxSession(this.#sid);
    // The window wrapper runs in the pane (so `tmux kill-window` kills the
    // whole tree): cd into the command dir (a missing dir is a stderr
    // diagnostic + 127), run the command with stdout and stderr to their
    // own log files, and the exit code to the exit file.
    const w = `cd "$(printf %s ${b64(dir)} | base64 -d)" 2>/dev/null || { printf "working directory not found\\n" > ${d}/${tok}.err; printf %s 127 > ${d}/${tok}.exit; exit 1; }; sh -c "$(printf %s ${b64(command)} | base64 -d)" > ${d}/${tok}.out 2> ${d}/${tok}.err < /dev/null; printf %s $? > ${d}/${tok}.exit`;
    // The session is created WITH the first command (a bare new-session
    // would leave an empty shell window behind); later commands open plain
    // windows. The exit file in /tmp outlives the auto-closing window.
    const out = await ssh(this.target, `mkdir -p -- ${d}
if tmux has-session -t ${sess} 2>/dev/null; then
  tmux new-window -d -t ${sess} -P -F '#{window_id}' '${w}'
else
  tmux new-session -d -s ${sess} -x 200 -y 50 -P -F '#{window_id}' '${w}'
fi`);
    const win = need(this.target, out, 'failed to start the command').trim();
    if (!win) throw new Error(`failed to start the command on ${this.target.target}: tmux returned no window id`);
    return win;
  }

  // Kill one command's whole process tree (the window's pane session).
  // Fire-and-forget: a stop/destroy must not block on the remote.
  kill(id) {
    if (!id) return;
    ssh(this.target, `tmux kill-window -t ${id} 2>/dev/null; exit 0`).catch(() => {});
  }

  // End the backend: kill any waiter connections, then kill the remote tmux
  // session — all windows, including backgrounded commands (when the session
  // goes, its tmux session goes).
  dispose() {
    if (this.#dead) return;
    this.#dead = true;
    this.#home = null;
    for (const h of this.#waiters) h.cancel();
    cleanRemoteSession(this.#sid, this.target).catch(() => {});
  }
}
