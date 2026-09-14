import { Fragment } from 'preact';
import { baseName, timeAgo } from './util';
import { PrimaryBtn, StatusDot, Switch } from './primitives';
import { IcPlus } from './icons';

// ── session list item ─────────────────────────────────────────────────
const SessionItem = ({ s, active, onSelect }) => (
  <div class={`${active ? 'bg-sel' : 'hover:bg-material2'} mx-0.5 my-px px-2.5 py-2 rounded-lg cursor-pointer flex items-center gap-2.5 transition-colors`}
       onClick={() => onSelect(s.id)}>
    <StatusDot status={s.status} />
    <div class="min-w-0 flex-1">
      <div class={`text-[.84rem] truncate ${active ? 'font-semibold text-ink' : 'text-ink'} ${s.archived ? 'opacity-50' : ''}`}>
        {s.title ?? baseName(s.cwd)}
        {s.archived ? <span class="ml-1.5 text-[9px] uppercase tracking-wider text-text3 border border-line rounded px-1">archived</span> : null}
      </div>
      <div class="text-[.7rem] text-text3 truncate" title={s.cwd}>{baseName(s.cwd)} · {s.status} · {timeAgo(s.last_activity)} · {s.message_count} msgs</div>
    </div>
  </div>
);

// ── session list (grouped by project) ─────────────────────────────────
const SessionList = ({ sessions, current, onSelect, showArchived, grouped }) => {
  const visible = sessions.filter((s) => !s.archived);
  const archived = showArchived ? sessions.filter((s) => s.archived) : [];
  const groups = new Map();
  for (const s of visible) {
    if (!groups.has(s.cwd)) groups.set(s.cwd, []);
    groups.get(s.cwd).push(s);
  }
  const items = (ss) => ss.map((s) => <SessionItem key={s.id} s={s} active={s.id === current} onSelect={onSelect} />);
  return (
    <div class="flex-1 overflow-y-auto px-2 py-1.5">
      {grouped
        ? [...groups].map(([cwd, ss]) => (
          <Fragment key={cwd}>
            <div class="px-3 pt-3 pb-1 text-[.66rem] font-bold tracking-[.04em] uppercase text-text3">{baseName(cwd)}</div>
            {items(ss)}
          </Fragment>
        ))
        : items(visible)}
      {archived.length ? (
        <Fragment key="archived">
          <div class="px-3 pt-3 pb-1 text-[.66rem] font-bold tracking-[.04em] uppercase text-text3">archived</div>
          {archived.map((s) => <SessionItem key={s.id} s={s} active={s.id === current} onSelect={onSelect} />)}
        </Fragment>
      ) : null}
    </div>
  );
};

// ── switch row (label + the iOS-style Switch) ─────────────────────────
const SwitchRow = ({ label, on, onToggle }) => (
  <div class="flex items-center justify-between py-[7px] text-[.82rem] text-dim">
    <span>{label}</span>
    <Switch on={on} onToggle={onToggle} label={label} />
  </div>
);

// ── sidebar ───────────────────────────────────────────────────────────
export const Sidebar = ({ cls, sessions, current, onNew, onSelect, newCwd, setNewCwd,
                          showArchived, onToggleArchived, grouped, onToggleGrouped }) => {
  const submit = async (e) => {
    e.preventDefault();
    const c = newCwd.trim();
    if (!c) return;
    await onNew(c);
  };

  return (
    <aside class={cls}>
      {/* New session: gradient pill + cwd input */}
      <div class="p-3.5 pb-2.5 flex flex-col gap-2">
        <form class="flex flex-col gap-2" onSubmit={submit}>
          <PrimaryBtn type="submit">
            <IcPlus />
            New Session
          </PrimaryBtn>
          <input value={newCwd} onInput={(e: any) => setNewCwd(e.target.value)} placeholder="/path/to/cwd" required autocomplete="off"
                 class="text-ink bg-field border border-line rounded-lg py-2 px-3 text-[.82rem] focus:outline-none focus:border-accent" />
        </form>
      </div>

      {/* Session list */}
      <SessionList sessions={sessions} current={current} onSelect={onSelect} showArchived={showArchived} grouped={grouped} />

      {/* Toggles (iOS switches) */}
      <div class="px-4 py-2 border-t border-hairline flex flex-col gap-0.5">
        <SwitchRow label="Group by project" on={grouped} onToggle={onToggleGrouped} />
        <SwitchRow label="Show archived" on={showArchived} onToggle={onToggleArchived} />
      </div>

      {/* User bar */}
      <div class="flex items-center gap-2.5 px-4 py-3 border-t border-hairline">
        <span class="w-7 h-7 rounded-full grid place-items-center text-white text-[.74rem] font-semibold flex-none"
              style={{ background: 'linear-gradient(145deg, #ff9f0a, #ff375f)' }}>L</span>
        <div class="min-w-0">
          <div class="text-[.82rem] font-medium text-ink">localhost</div>
          <div class="text-[.7rem] text-text3">{sessions.length} sessions</div>
        </div>
      </div>
    </aside>
  );
};
