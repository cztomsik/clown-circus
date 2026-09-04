import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIX = readFileSync(fileURLToPath(new URL('./PREFIX.md', import.meta.url)), 'utf8');
const LIMIT = 1024 * 1024; // 1MB cap on project context, as in the source

const readContext = (cwd, name) => {
  try {
    return readFileSync(join(cwd, name), 'utf8').slice(0, LIMIT);
  } catch {
    return null;
  }
};

// Compose the system prompt per-session from its cwd (port of loadSystemPrompt).
// Fallback chain: AGENTS.md -> CLOWN.md -> (none). When autoTruncate is on, append
// a note so the model knows stale tool results may be stubbed (see AUTO_TRUNCATE.md).
export const buildSystemPrompt = (cwd, autoTruncate = false) => {
  const context = readContext(cwd, 'AGENTS.md') ?? readContext(cwd, 'CLOWN.md') ?? '';
  const date = new Date().toISOString().slice(0, 10);
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    /* keep cwd */
  }
  const sep = context ? '\n\n' : '';
  const note = autoTruncate
    ? '\nNote: older (stale) tool results may be replaced with `<truncated N bytes>` to bound history; re-read the file or re-run the command to recover the full content.\n'
    : '';
  return `${PREFIX}${sep}${context}\n\nCurrent date: ${date}\nCurrent working directory: ${real}\n${note}`;
};
