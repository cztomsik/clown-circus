import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { scanSkills } from './skills.ts';

const readContext = (cwd, name) => {
  try {
    return readFileSync(join(cwd, name), 'utf8');
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

// Compose the system prompt per-session from its cwd.
// Fallback chain: AGENTS.md -> CLOWN.md -> (none).
export const buildSystemPrompt = (cwd) => {
  const context = readContext(cwd, 'AGENTS.md') ?? readContext(cwd, 'CLOWN.md') ?? '';
  const skills = skillsList(cwd);
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    /* keep cwd */
  }
  return `You are a helpful AI coding assistant with access to file system and shell commands.

Current date: ${today()}
Current working directory: ${real}

## Guidelines

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
- Mark everything as completed when you're finished (don't clear the list).

### When Using Skills
Skills are short instruction files for specific tasks. When a task matches a
skill's description, read its file with \`read_file\` before starting.

${skills}
${context ? `\n${context}\n` : ''}`;
};
