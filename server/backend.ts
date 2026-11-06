import { HttpError } from './errors.ts';
import { LocalBackend } from './local.ts';
import { parseRemoteCwd, RemoteBackend } from './remote.ts';

// A running command, as the tool layer sees it. Both kinds (local / remote)
// capture into two log files from t=0; `id` is what `kill()` takes (local:
// pid, remote: tmux window) and `killCmd` is that same kill as a shell
// command the agent can run; `status` settles exactly once — resolves on
// completion, rejects when the transport is lost or the window is killed
// early.
export type ExecHandle = {
  id: string;
  killCmd: string;                   // the whole-tree kill as a shell command (local: `kill -- -<pid>` — the process group, remote: `tmux kill-window -t <win>`)
  out: string;                       // stdout log — local: temp file, remote: scratch file
  err: string;                       // stderr log — separate file, same lifecycle
  status: Promise<{ code: number; sig?: string }>; // `sig` only for a local direct-child signal death
  cancel(): void;                    // abandon the wait; the command keeps running
};

// The per-session backend: owns everything locality-specific (file ops,
// command execution, lifecycle). The DB row stores only `cwd` — the backend
// is derived state, reconstructed from it by `backendFor` exactly like the
// system prompt (never persisted).
export type Backend = {
  kind: 'local' | 'remote';
  dir: string;
  home(): Promise<string>;                       // for ~/ expansion
  readFile(p: string, maxBytes?: number): Promise<Buffer>;
  writeFile(p: string, content: string): Promise<void>;
  exec(command: string, dir: string): Promise<ExecHandle>;
  kill(id: string): void;                        // fire-and-forget, whole tree
  validate(create?: boolean): Promise<void>;     // create-time preflight
  reap(): void;                                  // boot: kill orphans (no-op local)
  dispose(): void;                               // destroy/shutdown: kill everything the backend owns
};

// The backend for a session's cwd. A malformed ssh:// cwd (the prefix is
// there but it doesn't parse) is a 400 — same as the create route throws
// today.
export const backendFor = (sid, cwd): Backend => {
  if (typeof cwd === 'string' && cwd.startsWith('ssh://')) {
    const t = parseRemoteCwd(cwd);
    if (t) return new RemoteBackend(sid, t);
    throw new HttpError(400, 'bad_request',
      `invalid remote cwd: ${cwd} — expected ssh://[user@]host[:port]/absolute/path`);
  }
  return new LocalBackend(cwd);
};
