import { useState, useEffect } from 'preact/hooks';
import { html, BTN } from './ui.js';

const badgeColor = { running: 'text-accent', idle: 'text-ok', error: 'text-err', stopped: 'text-dim' };

// The session actions that used to fill a dedicated toolbar row, now folded
// into a ⋮ dropdown so the top bar stays a single, compact row (mobile-friendly
// and no horizontal overflow). `delete` is kept last, separated by a rule.
// `archive` flips its label/key with the session's state (archive ↔ unarchive).
const ACTIONS = [
  { key: 'retry', label: 'retry', title: 'strip trailing assistant/tool messages and re-run' },
  { key: 'init', label: 'init', title: 'run the /init skill on this project' },
  { key: 'compact', label: 'compact', title: 'summarize and replace the history' },
  { key: 'undo', label: 'undo', title: 'pop the last message' },
  { key: 'clear-tools', label: 'clear-tools', title: 'remove all tool results from history' },
  { key: 'clear', label: 'clear', title: 'reset history to the system prompt' },
  { key: 'duplicate', label: 'duplicate', title: 'fork into a new session with the same cwd and history' },
  { key: 'archive',
    label: (archived) => (archived ? 'unarchive' : 'archive'),
    title: (archived) => (archived ? 'restore to the default session list' : 'hide from the default session list (kept for later)') },
];

// Unified top bar: sidebar toggle, brand, then the session status + live
// summary (a session is open) or the live config summary (none), then the
// session-actions dropdown (⋮), the context-aware model select, and the theme
// toggle. One row, always.
export const Header = ({ cfg, theme, sideOpen, onSideToggle, onThemeToggle, view, onAction, onDel,
                         model, onModelChange, models, defaultModel }) => {
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the menu whenever the selected session changes (e.g. delete/clear).
  useEffect(() => { setMenuOpen(false); }, [view?.id]);
  // …and on Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const run = (key) => { setMenuOpen(false); onAction(key); };

  // Resolve the label/title functions (archive flips with the session state)
  // and pick the endpoint key to call.
  const resolved = ACTIONS.map((a) => ({
    key: a.key === 'archive' ? (view?.archived ? 'unarchive' : 'archive') : a.key,
    label: typeof a.label === 'function' ? a.label(!!view?.archived) : a.label,
    title: typeof a.title === 'function' ? a.title(!!view?.archived) : a.title,
  }));

  return html`
    <header class="relative flex items-center gap-2 px-3 py-2 border-b border-line">
      <button title="toggle sidebar" aria-label="toggle sidebar" aria-pressed=${sideOpen}
              class=${`${BTN} flex-none ${sideOpen ? 'border-accent' : ''}`}
              onclick=${onSideToggle}>☰</button>
      <h1 class="text-[15px] m-0 text-accent flex-none hidden sm:block">clown-circus</h1>

      ${view
        ? html`
          <span class="py-0.5 px-2 rounded-full text-xs border border-line flex-none ${badgeColor[view.status] ?? 'text-ok'}">${view.status ?? 'idle'}</span>
          <div class="text-dim text-xs min-w-0 flex-1 truncate">${view.cwd ?? ''} · ${view.tokens ?? 0} tok</div>
          <button title="session actions" aria-label="session actions" aria-expanded=${menuOpen}
                  class=${`${BTN} flex-none ${menuOpen ? 'border-accent' : ''}`}
                  onclick=${() => setMenuOpen((o) => !o)}>⋮</button>`
        : html`
          <div class="text-dim text-xs min-w-0 flex-1 truncate">${cfg}</div>`}

      <select title="model" aria-label="model" value=${model} onchange=${(e) => onModelChange(e.target.value)}
              class="text-ink bg-panel border border-line rounded py-1 px-2 focus:outline-none focus:border-accent flex-none w-40 max-w-[38vw]">
        <option value="">default (${defaultModel ?? '?'})</option>
        ${models.map((m) => html`<option key=${m} value=${m}>${m}</option>`)}
      </select>
      <button title="toggle theme" class=${`${BTN} flex-none`} onclick=${onThemeToggle}>${theme === 'dark' ? '→ light' : '→ dark'}</button>

      ${menuOpen && view ? html`
        <div class="fixed inset-0 z-40" onclick=${() => setMenuOpen(false)}></div>
        <div class="absolute right-2 top-full z-50 mt-1 min-w-[180px] flex flex-col bg-panel border border-line rounded shadow-xl py-1">
          ${resolved.map((a) => html`
            <button key=${a.key} title=${a.title}
                    class="text-left text-ink text-xs py-1.5 px-3.5 cursor-pointer hover:bg-bg"
                    onclick=${() => run(a.key)}>${a.label}</button>`)}
          <div class="h-px bg-line my-1"></div>
          <button title="delete this session"
                  class="text-left text-err text-xs py-1.5 px-3.5 cursor-pointer hover:bg-bg"
                  onclick=${() => { setMenuOpen(false); onDel(); }}>delete</button>
        </div>` : null}
    </header>`;
};
