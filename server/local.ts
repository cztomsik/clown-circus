import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import { mkdir, open, readFile as fsReadFile, unlink, writeFile as fsWriteFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { HttpError } from './errors.ts';
import { assert } from './util.ts';
import type { Backend, ExecHandle } from './backend.ts';

// Grace after the direct child exits before forcing a finalize. Covers the
// case where `close` is delayed by a grandchild that inherited our stdio (we
// finalize on the grace; the grandchild's later output keeps landing in the
// log files).
const DRAIN_MS = 300;

// Kill a command's whole process tree. `detached: true` made the child the
// leader of its own process group (the sh plus everything it spawns), so
// -pid names exactly that tree and can never reach the server.
const killTree = (child) => {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
};

// The local per-session Backend (backend.ts): commands as detached process
// groups whose output goes to a temp .out/.err pair from t=0.
export class LocalBackend implements Backend {
  kind = 'local' as const;
  dir: string;
  #live = new Map(); // pid → ChildProcess: this session's commands (in-flight or backgrounded)
  #dead = false;

  constructor(dir) {
    this.dir = dir;
  }

  // The local user's home (for ~/ expansion in tool paths).
  async home() {
    return homedir();
  }

  // Read an already-resolved file. `maxBytes` (0/Infinity = unbounded)
  // bounds the read itself — the same contract as remote (a bounded read
  // never loads more than maxBytes); the read_file tool passes MAX+1 to
  // detect over-cap files. Unbounded reads slurp the whole file
  // (edit_file needs it all).
  async readFile(p, maxBytes) {
    assert(!this.#dead, 'local session destroyed');
    if (!Number.isFinite(maxBytes) || maxBytes === 0) return fsReadFile(p);
    const f = await open(p, 'r');
    try {
      const buf = Buffer.allocUnsafe(maxBytes);
      let off = 0;
      while (off < maxBytes) {
        const { bytesRead } = await f.read(buf, off, maxBytes - off, off);
        if (bytesRead === 0) break; // EOF — the file is shorter than the cap
        off += bytesRead;
      }
      return buf.subarray(0, off);
    } finally {
      await f.close();
    }
  }

  // Write content to a path, creating parent dirs.
  async writeFile(p, content) {
    assert(!this.#dead, 'local session destroyed');
    await mkdir(dirname(p), { recursive: true });
    await fsWriteFile(p, content);
  }

  // Create-time preflight — the create route's local branch, with its
  // inline checks.
  async validate(create) {
    const p = this.dir;
    if (!isAbsolute(p)) throw new HttpError(400, 'bad_request', 'cwd must be an absolute path');
    let st;
    try {
      st = statSync(p);
    } catch {
      if (create !== true) throw new HttpError(404, 'not_found', `cwd path does not exist: ${p}`);
      try {
        mkdirSync(p, { recursive: true });
      } catch (err) {
        throw new HttpError(500, 'internal', `could not create cwd path: ${p} — ${err.message}`);
      }
    }
    if (st && !st.isDirectory()) throw new HttpError(400, 'bad_request', `cwd is not a directory: ${p}`);
  }

  // Boot: local orphans have no marker (a SIGKILLed server's detached
  // children reparent to init) — a no-op by design.
  reap() {}

  // Destroy/shutdown: kill every command this session spawned — in-flight
  // or backgrounded; a deleted session's commands die with it, matching remote.
  dispose() {
    if (this.#dead) return;
    this.#dead = true;
    for (const child of this.#live.values()) killTree(child);
    this.#live.clear();
  }

  // Kill one command's whole process tree. Fire-and-forget.
  kill(id) {
    if (!id) return;
    try { process.kill(-Number(id), 'SIGKILL'); } catch { /* already gone */ }
  }

  // Run a command in `dir`. Output goes to the .out/.err pair from t=0 —
  // the same files a backgrounded command leaves behind, so a backgrounded
  // log contains output from t=0 (no mid-flight sink swap). `status`
  // settles on `close` (all stdio closed, streams flushed) or on the
  // DRAIN_MS grace after `exit` (a grandchild may hold the pipes),
  // whichever comes first; it rejects only when the spawn itself fails.
  async exec(command, dir): Promise<ExecHandle> {
    assert(!this.#dead, 'local session destroyed');
    const id = randomUUID();
    const out = join(tmpdir(), `clown-cmd-${id}.out`);
    const err = join(tmpdir(), `clown-cmd-${id}.err`);
    const outStream = createWriteStream(out);
    const errStream = createWriteStream(err);
    // `stdin: 'ignore'` so commands that read stdin (prompts, `cat`, npm
    // questions) get EOF immediately instead of hanging on input that never
    // arrives. We only ever capture stdout/stderr. `detached: true` makes
    // the child lead its own process group (+ session) so the whole tree
    // can be group-killed and terminal signals to the server can't reach it.
    const child = spawn('sh', ['-c', command], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout?.pipe(outStream);
    child.stderr?.pipe(errStream);
    child.stdout?.on('error', () => {}); // a broken pipe just stops the capture — never crash
    child.stderr?.on('error', () => {});
    if (child.pid) this.#live.set(child.pid, child);

    let code = 0;
    let sig: string | null = null; // a signal death (kill, segfault) is a failure, not exit 0
    let settled = false;
    let clean = false; // exit 0, no signal → the logs may be deleted
    let filesGone = false;
    let drainTimer;

    const unlinkLogs = () => {
      if (filesGone) return;
      filesGone = true;
      unlink(out).catch(() => {});
      unlink(err).catch(() => {});
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      clean = code === 0 && !sig;
      clearTimeout(drainTimer);
      this.#live.delete(child.pid);
    };
    const status = new Promise<{ code: number; sig?: string }>((resolve, reject) => {
      child.on('error', (e) => {
        // the spawn itself failed (bad cwd, no sh) — no exit will come, and
        // the logs are empty: drop them
        if (settled) return;
        settled = true;
        this.#live.delete(child.pid);
        outStream.destroy();
        errStream.destroy();
        unlinkLogs();
        reject(e);
      });
      child.on('exit', (c, s) => {
        code = c ?? 0;
        sig = s;
        if (settled) return;
        // The command itself is done, but `close` (all stdio closed) may be
        // deferred indefinitely if it backgrounded a grandchild that
        // inherited the pipes. Finalize after a short grace period to flush
        // trailing output.
        drainTimer = setTimeout(() => {
          settle();
          resolve({ code, sig: sig ?? undefined });
        }, DRAIN_MS);
      });
      // `close` = the child's stdio is closed → the pipes end and the
      // streams finish promptly: await the flush so the consumer's
      // post-settle read sees everything.
      child.on('close', () => {
        if (settled) return;
        void Promise.all([
          new Promise((res) => outStream.on('finish', res)),
          new Promise((res) => errStream.on('finish', res)),
        ]).then(() => {
          settle();
          resolve({ code, sig: sig ?? undefined });
        });
      });
    });
    status.catch(() => {}); // consumers cancel or handle; a floating rejection must never crash the process

    return {
      id: child.pid ? String(child.pid) : '',
      killCmd: child.pid ? `kill -- -${child.pid}` : '',
      out,
      err,
      status,
      cancel() {
        // The wait is over. If the command already exited cleanly, the
        // consumer has finished reading the logs — nobody's left, so drop
        // them. (If it has not exited yet, the command was backgrounded or
        // stopped — its logs are named in the tool result and stay, even on
        // a later clean exit.)
        if (settled && clean) unlinkLogs();
      },
    };
  }
}
