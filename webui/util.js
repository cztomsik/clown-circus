// Pure, dependency-free helpers shared by the web UI (named exports).
// No DOM, no state, no Preact — kept out of app.js so that file holds only
// the components, hooks, and wiring.

export const baseName = (cwd) => cwd.split('/').filter(Boolean).at(-1) || cwd;

export const timeAgo = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export const prettyArgs = (a) => { try { return JSON.stringify(JSON.parse(a)); } catch { return a ?? ''; } };
