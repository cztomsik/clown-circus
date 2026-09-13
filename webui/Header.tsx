import { useState, useEffect } from 'preact/hooks';
import { BTN } from './ui.js';
import { baseName } from './util.js';

// Status bubble (same look as the sidebar dot, incl. the pulse while running);
// the full status text lives in the `title` tooltip.
const dotColor = { running: 'bg-accent animate-pulse', idle: 'bg-ok', error: 'bg-err', stopped: 'bg-dim' };

// The session-level actions in a ⋮ dropdown, so the top bar stays a single,
// compact row (mobile-friendly, no horizontal overflow). Only things that
// aren't reachable from the composer live here — conversation manipulation
// (retry, undo, clear, compact, trim, …) is composer-only as slash commands.
// `delete` is kept last, separated by a rule.
// `archive` flips its label/key with the session's state (archive ↔ unarchive).
const ACTIONS = [
  { key: 'open-vscode', label: 'open in vscode', title: 'open the session working directory in VS Code (vscode:// URI)' },
  { key: 'archive',
    label: (archived) => (archived ? 'unarchive' : 'archive'),
    title: (archived) => (archived ? 'restore to the default session list' : 'hide from the default session list (kept for later)') },
];

// Unified top bar: sidebar toggle, brand, then the session status + live
// summary (a session is open) or the live config summary (none), then the
// session-actions dropdown (⋮), the context-aware model select, and the theme
// toggle. One row, always.
export const Header = ({ cfg, theme, sideOpen, onSideToggle, onThemeToggle, view, onAction, onDel,
                         model, onModelChange, models }) => {
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

  const run = (key) => {
    setMenuOpen(false);
    if (key === 'open-vscode') {
      // Not a REST action — hand the session cwd to the local VS Code URI handler.
      window.open('vscode://file/' + encodeURI(view.cwd ?? ''));
      return;
    }
    onAction(key);
  };

  // Resolve the label/title functions (archive flips with the session state)
  // and pick the endpoint key to call.
  const resolved = ACTIONS.map((a) => ({
    key: a.key === 'archive' ? (view?.archived ? 'unarchive' : 'archive') : a.key,
    label: typeof a.label === 'function' ? a.label(!!view?.archived) : a.label,
    title: typeof a.title === 'function' ? a.title(!!view?.archived) : a.title,
  }));

  return (
    <header class="relative flex items-center gap-2 px-3 py-2 border-b border-line">
      <button title="toggle sidebar" aria-label="toggle sidebar" aria-pressed={sideOpen}
              class={`${BTN} flex-none ${sideOpen ? 'border-accent' : ''}`}
              onClick={onSideToggle}>☰</button>
      <h1 class="text-[15px] m-0 text-accent flex-none hidden sm:block">clown-circus</h1>

      {view
        ? (<>
          <span title={view.status ?? 'idle'} class={`w-2 h-2 rounded-full flex-none ${dotColor[view.status] ?? 'bg-ok'}`}></span>
          <div title={view.cwd ?? ''} class="text-dim text-xs min-w-0 flex-1 truncate">{baseName(view.cwd ?? '')} · {view.tokens ?? 0} tok</div>
          <button title="session actions" aria-label="session actions" aria-expanded={menuOpen}
                  class={`${BTN} flex-none ${menuOpen ? 'border-accent' : ''}`}
                  onClick={() => setMenuOpen((o) => !o)}>⋮</button>
        </>)
        : <div class="text-dim text-xs min-w-0 flex-1 truncate">{cfg}</div>}

      <select title="model" aria-label="model" value={model} onChange={(e: any) => onModelChange(e.target.value)}
              class="text-ink bg-panel border border-line rounded py-1.5 md:py-1 px-2 focus:outline-none focus:border-accent flex-none w-32 max-w-[36vw]">
        {models.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      {/* Icon = the theme it switches TO (same semantics as the old "→ x" label). */}
      <button title={theme === 'dark' ? 'switch to the light theme' : 'switch to the dark theme'} aria-label="toggle theme"
              class={`${BTN} flex-none`} onClick={onThemeToggle}>{theme === 'dark' ? '☀' : '🌙'}</button>

      {menuOpen && view ? (<>
        <div class="fixed inset-0 z-40" onClick={() => setMenuOpen(false)}></div>
        <div class="absolute right-2 top-full z-50 mt-1 min-w-[180px] flex flex-col bg-panel border border-line rounded shadow-xl py-1">
          {resolved.map((a) => (
            <button key={a.key} title={a.title}
                    class="text-left text-ink text-xs py-1.5 px-3.5 cursor-pointer hover:bg-bg"
                    onClick={() => run(a.key)}>{a.label}</button>
          ))}
          <div class="h-px bg-line my-1"></div>
          <button title="delete this session"
                  class="text-left text-err text-xs py-1.5 px-3.5 cursor-pointer hover:bg-bg"
                  onClick={() => { setMenuOpen(false); onDel(); }}>delete</button>
        </div>
      </>) : null}
    </header>
  );
};
