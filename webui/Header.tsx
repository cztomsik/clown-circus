import { IconBtn, Menu, StatusDot } from './primitives';
import { baseName } from './util';

// SVG icon components (stroke-based, 24x24 viewBox).
const IcHamburger = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
);
const IcDots = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg>
);
const IcSun = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
);
const IcMoon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>
);
const IcChevron = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l4-4 4 4M8 15l4 4 4-4"/></svg>
);

// Menu item icons
const IcCode = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4l6 6-6 6"/><path d="M4 12h16"/><path d="M4 18h10"/></svg>
);
const IcArchive = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg>
);
const IcTrash = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5M12 16v.5"/><path d="M5 8h14l-1 12H6z"/><path d="M9 8V5h6v3"/></svg>
);

// The session-level actions for the ⋮ dropdown. Only things that aren't
// reachable from the composer live here — conversation manipulation
// (retry, undo, clear, compact, trim, …) is composer-only as slash commands.
// `archive` flips its label/icon with the session's state; `delete` is kept
// last, separated by a rule.
const menuItems = (view) => view ? [
  { key: 'open-vscode', label: 'Open in VS Code', icon: IcCode, title: 'open the session working directory in VS Code (vscode:// URI)' },
  { key: view.archived ? 'unarchive' : 'archive',
    label: view.archived ? 'Unarchive' : 'Archive', icon: IcArchive,
    title: view.archived ? 'restore to the default session list' : 'hide from the default session list (kept for later)' },
  { key: 'delete', label: 'Delete session', icon: IcTrash, title: 'delete this session', danger: true, rule: true },
] : [];

const AppIcon = () => (
  <span class="w-[25px] h-[25px] rounded-[7px] grid place-items-center flex-none text-white"
        style={{ background: 'linear-gradient(145deg, #5ac8fa, #0a84ff)', boxShadow: 'inset 0 .5px 0 rgba(255,255,255,.5), 0 1px 2px rgba(0,0,0,.18)' }}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
  </span>
);

const Header = ({ cfg, theme, sideOpen, onSideToggle, onThemeToggle, view, onAction, onDel,
                   model, onModelChange, models }) => {
  const run = (key) => {
    if (key === 'open-vscode') {
      window.open('vscode://file/' + encodeURI(view.cwd ?? ''));
      return;
    }
    if (key === 'delete') { onDel(); return; }
    onAction(key);
  };

  return (
    <header class="material relative z-30 flex items-center gap-2.5 px-3.5 h-[50px] border-b border-hairline flex-none">
      {/* Left: hamburger + app icon + name | divider | session */}
      <div class="flex items-center gap-2.5 min-w-0">
        <IconBtn title="toggle sidebar" aria-label="toggle sidebar" aria-pressed={sideOpen}
                 onClick={onSideToggle}><IcHamburger /></IconBtn>
        <AppIcon />
        <span class="text-[.9rem] font-semibold tracking-[-.01em] whitespace-nowrap hidden sm:block text-ink">Clown-Circus</span>

        <div class="w-px h-[22px] bg-hairline flex-none"></div>

        {view
          ? (<span class="flex items-center gap-2 min-w-0">
            <StatusDot status={view.status} size="w-[7px] h-[7px]" title={view.status ?? 'idle'} />
            <span title={view.cwd ?? ''} class="text-dim text-[.82rem] whitespace-nowrap overflow-hidden text-ellipsis">{baseName(view.cwd ?? '')}</span>
          </span>)
          : <span class="text-dim text-xs min-w-0 truncate">{cfg}</span>}
      </div>

      <div class="flex-1"></div>

      {/* Right: model picker + ⋮ + theme */}
      <div class="flex items-center gap-[7px]">
        {/* Model picker */}
        <label class="inline-flex items-center gap-[7px] h-7 pl-[11px] pr-[7px] rounded-[7px] border border-line bg-field text-[.78rem] cursor-pointer transition-colors hover:bg-card">
          <select value={model} onChange={(e: any) => onModelChange(e.target.value)} aria-label="Model"
                  class="appearance-none bg-transparent font-inherit text-[.78rem] text-ink cursor-pointer max-w-[96px] sm:max-w-[130px] focus:outline-none">
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <span class="text-text3"><IcChevron /></span>
        </label>

        {/* Session actions (⋮) — only when a session is open */}
        {view ? (
          <Menu trigger={<IcDots />} title="session actions" ariaLabel="session actions"
                heading="Session" items={menuItems(view)} resetKey={view.id} onSelect={run} />
        ) : null}

        {/* Theme toggle */}
        <IconBtn title={theme === 'dark' ? 'switch to the light theme' : 'switch to the dark theme'} aria-label="toggle theme"
                 onClick={onThemeToggle}>
          {theme === 'dark' ? <IcSun /> : <IcMoon />}
        </IconBtn>
      </div>
    </header>
  );
};

export { Header };
