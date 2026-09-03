# Init Skill

Create a new `AGENTS.md` file in the current directory using the `write_file` tool. The file should contain **project-specific context only** — its content will be inserted in the agent's system prompt (after the shared common part).

## Available system tools

Do a quick check of the current system environment and include a brief section at the top with information like:

- if any of `node`, `python`, `python3`, `uv`, `rg`, `jq`, `wget`, `curl` are installed and can be used
- that quick computations and evaluations should always be done using such tools (pick one and provide concrete `-e`-like snippet)
- that something like `rg -o '^\s*(def|class|struct|function|fn)\s+\w+' .` should be used for quick navigations (if available)

## Project Info

Explore the project to understand its structure. Read key files (build config, entry point, main modules, README, etc.) and include a summary with:

- **Project overview** — what it is, tech stack, build command
- **Source structure** — a table of source files and their purposes
- **Architecture notes** — key patterns, dependencies, data flow, notable implementation details

This section should be specific to the current project, not generic.

Write the content to `AGENTS.md` and confirm success.
