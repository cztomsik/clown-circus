import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.ts';

// Built-in skills, seeded into <home>/skills/<name>/ on first run — the user
// can edit or delete the seeded files freely; they are only (re)created when
// missing.
const INIT_SKILL = `---
name: init
description: Explore the project and write an AGENTS.md.
---
# Init Skill

Create a new \`AGENTS.md\` file in the current directory using the \`write_file\` tool. The file should contain **project-specific context only** — its content will be inserted in the agent's system prompt (after the shared common part).

## Available system tools

Do a quick check of the current system environment and include a brief section at the top with information like:

- if any of \`node\`, \`python\`, \`python3\`, \`uv\`, \`rg\`, \`jq\`, \`wget\`, \`curl\` are installed and can be used
- that quick computations and evaluations should always be done using such tools (pick one and provide concrete \`-e\`-like snippet)
- that something like \`rg -o '^\\s*(def|class|struct|function|fn)\\s+\\w+' .\` should be used for quick navigations (if available)

## Project Info

Explore the project to understand its structure. Read key files (build config, entry point, main modules, README, etc.) and include a summary with:

- **Project overview** — what it is, tech stack, build command
- **Source structure** — a table of source files and their purposes
- **Architecture notes** — key patterns, dependencies, data flow, notable implementation details

This section should be specific to the current project, not generic.

Write the content to \`AGENTS.md\` and confirm success.
`;

const MAKE_SKILL = `---
name: make_skill
description: Author a new skill on user request — a direct ask, or an approved offer to make one.
---
# Make Skill

Create a reusable **skill**: a single \`SKILL.md\` that future sessions load with \`read_file\` when a task matches its description. Skills are plain files — no registration.

## Where it goes

Pick the root by scope — a same-named skill in a closer root wins:

| Root | Scope | Use for |
|------|-------|---------|
| \`<cwd>/.agents/skills/\` | project | skills specific to this repo / workflow |
| \`~/.agents/skills/\` | user | general-purpose skills, reused across projects |
| \`<home>/skills/\` (clown home, default \`~/.clown\`) | built-in | rarely — skills that ship with the agent |

Decide, don't ask: if the skill is obviously project-specific (it references this repo's paths, files, or workflows), put it in the project root. Only general-purpose skills — no project-specific references — belong in the user root, since only those make sense to reuse across projects.

Layout: \`<root>/<name>/SKILL.md\`. The skill's name is the directory name (the \`name:\` frontmatter key may override it).

## Frontmatter

A leading \`---\` block of single-line \`key: value\` pairs:

\`\`\`
---
name: my-skill           # optional; defaults to the directory name
description: <one line>  # REQUIRED — this is the routing signal
---
\`\`\`

- The \`description\` is what the agent sees in the system prompt (one bullet: name, description, path). Write it as **when to use** — "Take browser screenshots of a URL (Playwright + system Chrome)" — not "about screenshots".
- No other keys are needed.

## Body

The body is read verbatim by the model when a task matches, so make it a **concrete recipe**, not generic advice:

- Terse, imperative steps with exact commands and paths (copy-pasteable).
- Include detection / ordering steps when the tooling may vary, and **gotchas learned the hard way** — the highest-value lines in a skill.
- End with a verification step (how to confirm success — e.g. re-read the output with \`read_file\`).

Aim for well under ~150 lines: a skill the model doesn't finish reading is a skill that fails.

## After writing

1. Re-read the file with \`read_file\` and check the frontmatter is well-formed (a leading \`---\` block, \`description\` present).
2. Tell the user where it landed and that it shows up in **new** sessions' system prompts — the skill list is composed at session creation and on \`/clear\`; running sessions are not refreshed.
3. Offer to exercise it: send a matching message in a new session and confirm the model loads it with \`read_file\`.

Seeded built-ins (like \`init\` and this skill) are also just files — edit or delete them freely; they are only (re)created when missing.
`;

const SKILL_FILE = 'SKILL.md';

// Minimal frontmatter: a leading `---` block of single-line `key: value` pairs.
const parseFrontmatter = (text) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return meta;
};

// Walk one skill root: each subdirectory holding a SKILL.md with a
// description is a skill. First root to claim a name wins — call roots in
// precedence order.
const scanRoot = (root, skills) => {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return; // missing root
  }
  for (const e of entries) {
    if (!e.isDirectory() || skills.has(e.name)) continue;
    let text;
    try {
      text = readFileSync(join(root, e.name, SKILL_FILE), 'utf8');
    } catch {
      continue; // no SKILL.md
    }
    const meta = parseFrontmatter(text);
    if (!meta?.description) continue; // no description → not a skill
    const name = meta.name ?? e.name;
    skills.set(name, { name, description: meta.description, location: join(root, e.name, SKILL_FILE) });
  }
};

// Skills the model can load via read_file, highest precedence first:
// project (<cwd>/.agents/skills) → user (~/.agents/skills) → clown home (<home>/skills).
export const scanSkills = (cwd) => {
  const skills = new Map();
  scanRoot(join(cwd, '.agents', 'skills'), skills);
  scanRoot(join(homedir(), '.agents', 'skills'), skills);
  scanRoot(join(config.home, 'skills'), skills);
  return [...skills.values()];
};

// The built-ins, by directory name.
const BUILTIN_SKILLS = [
  ['init', INIT_SKILL],
  ['make_skill', MAKE_SKILL],
] as const;

// Seed the built-in skills into <home>/skills/<name>/ if not already there.
export const seedBuiltinSkills = () => {
  for (const [name, content] of BUILTIN_SKILLS) {
    const file = join(config.home, 'skills', name, SKILL_FILE);
    if (existsSync(file)) continue;
    mkdirSync(join(config.home, 'skills', name), { recursive: true });
    writeFileSync(file, content);
    console.log(`[${new Date().toISOString()}] seeded built-in skill: ${file}`);
  }
};
