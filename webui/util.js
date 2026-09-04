// Pure, dependency-free helpers shared by the web UI (named exports).
// No DOM, no state, no Preact — kept out of app.js so that file holds only
// the components, hooks, and wiring.

export const baseName = (cwd) => cwd.split('/').filter(Boolean).at(-1) || cwd;

// Parse a `/cmd [arg]` line from the composer. Returns null for a plain message
// (no leading slash); otherwise { name, arg } with the command lowercased and
// everything after the first run of whitespace as `arg`.
export const parseCommand = (text) => {
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  const parts = t.slice(1).trim().split(/\s+/);
  return { name: (parts.shift() ?? '').toLowerCase(), arg: parts.join(' ') };
};

// Normalise a /models entry ({id} | {name} | "id") to a plain id string.
export const modelId = (m) => m?.id ?? m?.name ?? m;

export const timeAgo = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export const prettyArgs = (a) => { try { return JSON.stringify(JSON.parse(a)); } catch { return a ?? ''; } };
