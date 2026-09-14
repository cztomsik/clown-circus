import { useState, useEffect } from 'preact/hooks';

// ── mini UI kit ──────────────────────────────────────────────────────────
// The app's small shared building blocks: one component per idiom, headless
// of data (no API calls, no session state). A class token lives here when
// only its component uses it; in ui.ts when shared by several components.

// ── buttons ────────────────────────────────────────────────────────────
const ICON_BTN = 'w-[30px] h-[30px] rounded-lg grid place-items-center text-dim transition-colors hover:bg-material2 hover:text-ink border border-transparent flex-none cursor-pointer';

// Square ghost icon button — the default shape for every icon-only action
// (header, composer). `cls` can tweak size / colour on top.
export const IconBtn = ({ cls = '', children, ...rest }) => (
  <button type="button" class={`${ICON_BTN} ${cls}`} {...rest}>{children}</button>
);

// Gradient primary (filled) button — the one real CTA per view
// (the sidebar's "New Session").
const PRIMARY = 'h-[34px] w-full rounded-lg text-white text-[.84rem] font-medium flex items-center justify-center gap-2 grad-accent cursor-pointer transition-[filter] hover:brightness-105';
export const PrimaryBtn = ({ cls = '', children, ...rest }) => (
  <button type="button" class={`${PRIMARY} ${cls}`} {...rest}>{children}</button>
);

// ── status ─────────────────────────────────────────────────────────────
// Session status dot (header + sidebar); the accent pulse marks a run in
// flight. The colour map lives here so the two views can't drift apart.
const DOT = { running: 'bg-accent animate-pulse', idle: 'bg-ok', error: 'bg-err', stopped: 'bg-dim' };
export const StatusDot = ({ status, size = 'w-2 h-2', title = null }) => (
  <span title={title} class={`rounded-full flex-none ${DOT[status] ?? 'bg-ok'} ${size}`}></span>
);

// The CSS spinner from index.html — the single "in flight" glyph.
export const Spinner = ({ cls = '' }) => <span class={`spinner ${cls}`}></span>;

// The small bullet that leads a quiet tool/reasoning line in the transcript
// (Message.tsx). `cls` can retint it (the Activity line uses a dimmer dot).
export const Dot = ({ cls = 'bg-text3' }) => (
  <span class={`w-[5px] h-[5px] rounded-full ${cls} flex-none self-center opacity-85`}></span>
);

// The faint left-guided body that expands under a quiet line's summary.
// `cls` adds per-caller spacing (e.g. `space-y-1.5`).
export const Guide = ({ cls = '', children }) => (
  <div class={`mb-1.5 ml-[7px] py-1 pl-3.5 border-l border-line/70 ${cls}`}>{children}</div>
);

// A bottom-bar key hint (the composer's ↵ / ⇧↵ affordances).
export const Kbd = ({ children }) => (
  <kbd class="text-[11px] leading-none px-1 py-[1px] rounded border border-line bg-line/40 text-dim">{children}</kbd>
);

// iOS-style on/off switch (the .sw CSS in index.html).
export const Switch = ({ on, onToggle, label = null }) => (
  <button type="button" title={label} class={`sw ${on ? 'on' : ''}`} aria-pressed={on} onClick={onToggle}></button>
);

// ── dropdown menu ──────────────────────────────────────────────────────
// Icon-triggered popover (the ⋮ menus). Owns its open state: a fixed
// backdrop click or Escape closes it, a selected item closes it, and it
// closes whenever `resetKey` changes (e.g. the selected session). Items are
// `{ key, label, icon, title, danger?, rule? }` — `rule` draws a separator
// above the item, `danger` tints it as a destructive action.
const MENU_ITEM = 'flex items-center gap-[11px] w-full px-2.5 py-[7px] rounded-lg text-[.83rem] cursor-pointer transition-colors';
export const Menu = ({ trigger, title, ariaLabel, heading = null, items, resetKey = null, onSelect }) => {
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [resetKey]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <div class="relative">
      <IconBtn title={title} aria-label={ariaLabel} aria-expanded={open}
               onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>{trigger}</IconBtn>
      {open ? (<>
        <div class="fixed inset-0 z-40" onClick={() => setOpen(false)}></div>
        <div class="menu-card absolute top-full right-0 mt-2 min-w-[220px] rounded-xl border border-line p-1 shadow-2xl z-50">
          {heading ? <div class="text-[.62rem] font-bold tracking-[.05em] uppercase text-text3 px-2.5 pt-1.5 pb-1">{heading}</div> : null}
          {items.map((a) => (
            <div key={a.key}>
              {a.rule ? <div class="h-px bg-hairline my-1.5 mx-1.5"></div> : null}
              <button title={a.title}
                      class={`${MENU_ITEM} ${a.danger ? 'text-err hover:bg-err/10' : 'text-ink hover:bg-material2'}`}
                      onClick={() => { setOpen(false); onSelect(a.key); }}>
                <span class={`w-[17px] grid place-items-center flex-none ${a.danger ? 'text-err' : 'text-dim'}`}><a.icon /></span>
                {a.label}
              </button>
            </div>
          ))}
        </div>
      </>) : null}
    </div>
  );
};
