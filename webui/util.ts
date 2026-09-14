// Pure, dependency-free helpers shared by the web UI (named exports).
// No DOM, no state, no Preact — kept out of app.js so that file holds only
// the components, hooks, and wiring.

export const baseName = (cwd: string) => cwd.split('/').filter(Boolean).at(-1) || cwd;

// Plain text of a message's content (string | ContentPart[]): the text parts
// joined, image parts dropped. '' when the content carries no text.
export const contentText = (c) =>
  typeof c === 'string' ? c
  : Array.isArray(c) ? c.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n')
  : '';

// First line of a string, truncated to n chars with an ellipsis.
export const firstLine = (s, n = 80) => {
  const l = (s ?? '').split('\n')[0];
  return l.length > n ? l.slice(0, n) + '…' : l;
};

// The composer's slash commands (what `/` completes) + a one-line hint each.
// The palette rows above the field show the hints while a command is being
// chosen; a completed name shows its hint in the action bar instead.
export const SLASH_COMMANDS = [
  { name: 'retry', hint: 're-run the loop from the last user message' },
  { name: 'retry-turn', hint: 're-run from before the last assistant reply' },
  { name: 'stop', hint: 'stop the running turn' },
  { name: 'undo', hint: 'undo the last user message — it returns to the composer' },
  { name: 'trim', hint: 'trim bulky tool results + CoT from old turns · optional: turns to keep' },
  { name: 'compact', hint: 'summarize the conversation to free context' },
  { name: 'clear', hint: 'clear the transcript (keeps the session)' },
  { name: 'init', hint: 'explore the project and write an AGENTS.md' },
  { name: 'fork', hint: 'branch this transcript into a new session' },
  { name: 'help', hint: 'list the available slash commands' },
];

// Parse a `/cmd [arg]` line from the composer. Returns null for a plain message
// (no leading slash); otherwise { name, arg } with the command lowercased and
// everything after the first run of whitespace as `arg`.
export const parseCommand = (text: string) => {
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  const parts = t.slice(1).trim().split(/\s+/);
  return { name: (parts.shift() ?? '').toLowerCase(), arg: parts.join(' ') };
};

// Compact the session's token count for the header (1234 → 1.2k, 2048000 → 2m).
export const fmtTokens = (n) => {
  if (!n) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}m`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
};

// Normalise a /models entry ({id} | {name} | "id") to a plain id string.
export const modelId = (m) => m?.id ?? m?.name ?? m;

// Whether a /models entry accepts image input. Only llama.cpp exposes
// modalities (architecture.input_modalities) — honour them; providers
// without the field (e.g. vLLM) are assumed vision-capable (most recent
// models are).
export const isVisionModel = (m) => {
  const modalities = m?.architecture?.input_modalities;
  return !Array.isArray(modalities) || modalities.includes('image');
};

// The assistant chain-of-thought, whichever field the provider used (llama.cpp
// emits `reasoning_content`, vLLM emits `reasoning`). The wire and DB keep the
// provider's raw field verbatim — each message round-trips to the provider that
// made it — so only the display normalises here. Null when absent.
export const reasoningText = (m) => m?.reasoning_content ?? m?.reasoning ?? null;

export const timeAgo = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export const prettyArgs = (a: string) => { try { return JSON.stringify(JSON.parse(a)); } catch { return a ?? ''; } };

// Parse a tool call's `arguments` JSON string into an object, or null when it
// is absent / not valid JSON (callers then render the raw string instead).
export const parseArgs = (a: string) => { try { const o = JSON.parse(a); return o && typeof o === 'object' ? o : null; } catch { return null; } };

// Best-effort parse of the todos markdown string (checkbox convention lives in
// PREFIX.md). Returns one entry per non-empty line:
//   task line:  { done, inProgress, text }   // - [x] / - [ ] … (in progress) / - [ ]
//   other line: { text }                     // shown as-is
const CHECKBOX = /^\s*[-*+]\s+\[( |x|X)\]\s*(.*)$/;
const IN_PROGRESS = /\s*\(in progress\)\s*$/i;
export const parseTodos = (md: string) =>
  (md || '').split('\n').map((line) => {
    const m = line.match(CHECKBOX);
    if (!m) return line.trim() ? { text: line.trim() } : null;
    const done = m[1].toLowerCase() === 'x';
    const text = m[2].trim().replace(IN_PROGRESS, '').trim();
    return { done, inProgress: !done && IN_PROGRESS.test(m[2]), text };
  }).filter(Boolean);

// Derive the todo list markdown from the messages array: find the last
// assistant message whose tool_calls include write_todos and return its
// `content` argument (the tool is a no-op — the call in the transcript IS
// the todo list). Returns '' when no write_todos call is present.
export const extractTodos = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      if (tc.function?.name !== 'write_todos') continue;
      try { return JSON.parse(tc.function.arguments ?? '{}').content ?? ''; }
      catch { return ''; }
    }
  }
  return '';
};
