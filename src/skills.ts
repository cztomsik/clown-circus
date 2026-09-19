import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.ts';

// The built-in init skill. Seeded into <home>/skills/init/ on first run — the
// user can edit or delete the seeded file freely; it is only (re)created when
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

// Seed the built-in init skill into <home>/skills/init/ if not already there.
export const seedInitSkill = () => {
  const file = join(config.home, 'skills', 'init', SKILL_FILE);
  if (existsSync(file)) return;
  mkdirSync(join(config.home, 'skills', 'init'), { recursive: true });
  writeFileSync(file, INIT_SKILL);
  console.log(`[${new Date().toISOString()}] seeded built-in skill: ${file}`);
};
