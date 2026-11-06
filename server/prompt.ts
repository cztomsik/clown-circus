import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { scanSkills } from './skills.ts';
import { RemoteBackend } from './remote.ts';

// The session's AGENTS.md (from cwd), if present.
const readContext = (cwd) => {
  try {
    return readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
  } catch {
    return null;
  }
};

// Local date as YYYY-MM-DD (a UTC slice would be off by a day near midnight).
const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// Shorten a path for the prompt: ./ under the session cwd, ~ under the user
// home, absolute otherwise (e.g. a custom --home outside the home dir).
const shortPath = (cwd, p) => {
  const base = cwd.endsWith(sep) ? cwd.slice(0, -1) : cwd;
  if (p.startsWith(base + sep)) return `./${p.slice(base.length + 1)}`;
  const home = homedir();
  if (p.startsWith(home + sep)) return `~/${p.slice(home.length + 1)}`;
  return p;
};

// Skill list: one bullet per skill — **name**, description, then its SKILL.md
// path (shortened — the prefix also signals the origin root). init is always
// seeded, so this is always non-empty.
const skillsList = (cwd) =>
  scanSkills(cwd)
    .map((s) => `- **${s.name}** — ${s.description}\n  \`${shortPath(cwd, s.location)}\``)
    .join('\n');

// The prompt body shared by local and remote sessions (guidelines + best
// practices).
const COMMON = `## Guidelines

- **Be Concise**: Provide focused, direct responses. Avoid using any emojis.
- **Explain Actions**: When using tools, briefly explain what you're doing
- **Handle Errors**: If a tool fails, try an alternative approach
- **Safety First**: Never execute destructive commands without explicit user confirmation

## Best Practices

### When Reading Code
- Start by reading relevant files to understand context
- Check for existing patterns and conventions

### When Writing Code
- Follow existing code style and patterns
- Add appropriate error handling
- Comment only non-obvious logic (explain why, not what)

### When Modifying Code
- Use \`edit_file\` for targeted changes
- Verify changes by reading the file after editing
- Run tests if available

### When Running Commands
- Explain what the command will do
- Show the output to the user
- Handle errors gracefully

### When Performing Multi-step tasks
- Always track your progress with the \`write_todos\` tool — the list is shown
  to the user.
- Create a todo list at the start, one task per line, as markdown checkboxes:
  - \`- [ ] task\` — pending
  - \`- [ ] task (in progress)\` — in progress (suffix the task you're working on)
  - \`- [x] task\` — done (drop the suffix when marking done)
- \`write_todos\` is a **full replace**: send the entire updated list each time
  — keep unchanged items, reorder freely, mark items done as you go. At most
  one task in progress at a time.
- Mark everything as completed when you're finished (don't clear the list).`;

const SKILLS = `### When Using Skills
Skills are short instruction files for specific tasks. When a task matches a
skill's description, read its file with \`read_file\` before starting. When the
session keeps repeating the same kind of work, offer to capture it as a new
skill (the \`make_skill\` built-in explains how).`;

const REMOTE = `## Remote Session
- Every file path and command you issue runs on the remote host — never on the local machine.
- Commands run in a tmux session on the remote host. When a command is left running in the background, the tool result names its remote log file and tmux window — monitor it with \`read_file\` on that log file and stop it with \`run_command\` (\`tmux kill-window -t <window>\`).`;

// The real path, keeping p itself when the link doesn't resolve.
const realPath = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

// The project context file's content (AGENTS.md), prompt-shaped, or '' when
// absent.
const localContext = (cwd) => {
  const c = readContext(cwd) ?? '';
  return c ? `\n${c}\n` : '';
};

// Compose the system prompt per-session from its backend (derived from the
// cwd, never stored): reads its data (kind, dir, the remote target) — no
// re-parsing of the cwd.
export const buildSystemPrompt = (b) => {
  const remote = b instanceof RemoteBackend;
  // Skills and the context file exist only for local cwds — for remote ones
  // the path is on the far side of ssh.
  const tail = remote
    ? REMOTE
    : `${SKILLS}\n\n${skillsList(b.dir)}\n${localContext(b.dir)}`;
  return `You are a helpful AI coding assistant with access to file system and shell commands.

Current date: ${today()}
Current working directory: ${remote ? `${b.dir} — on the remote host ${b.target.target}, reached over SSH` : realPath(b.dir)}

${COMMON}

${tail}`;
};
