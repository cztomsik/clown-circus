import { IconBtn, Menu, StatusDot } from './primitives';
import { ModelSelect } from './ModelSelect';
import { baseName, fmtTokens } from './util';
import { AppIcon, IcHamburger, IcDots, IcSun, IcMoon, IcCode, IcArchive, IcTrash, IcX } from './icons';

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

const Header = ({ cfg, theme, sideOpen, onSideToggle, onThemeToggle, view, onAction, onDel, onClose,
                   model, onModelChange, models, visionModels, effort, onEffortChange }) => {
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
            <span title={view.cwd ?? ''} class="text-dim text-[.82rem] whitespace-nowrap overflow-hidden text-ellipsis">{view.title ?? baseName(view.cwd ?? '')}</span>
            {view.tokens ? <span title="total tokens in the last LLM response" class="text-text3 text-[.7rem] whitespace-nowrap flex-none">{fmtTokens(view.tokens)} tok</span> : null}
            <IconBtn title="close session (back to the start screen)" aria-label="close session" onClick={onClose}><IcX /></IconBtn>
          </span>)
          : <span class="text-dim text-xs min-w-0 truncate">{cfg}</span>}
      </div>

      <div class="flex-1"></div>

      {/* Right: model picker + ⋮ + theme */}
      <div class="flex items-center gap-[7px]">
        {/* Model picker (opens the model + reasoning-effort modal) */}
        <ModelSelect models={models} model={model} effort={effort}
                     onPickModel={onModelChange} onPickEffort={onEffortChange}
                     visionModels={visionModels} />

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
