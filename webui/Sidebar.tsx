import { Fragment } from 'preact';
import { baseName, timeAgo } from './util';

// ── status colour map (dot) ───────────────────────────────────────────
const dotColor = { running: 'bg-accent animate-pulse', idle: 'bg-ok', error: 'bg-err', stopped: 'bg-dim' };

// ── session list (grouped by project) ─────────────────────────────────
const SessionItem = ({ s, active, onSelect }) => (
  <li class={active
    ? 'py-2 pl-[7px] pr-2.5 border-b border-line cursor-pointer flex flex-col gap-0.5 bg-panel border-l-[3px] border-l-accent'
    : 'py-2 px-2.5 border-b border-line cursor-pointer flex flex-col gap-0.5 hover:bg-panel'}
      onClick={() => onSelect(s.id)}>
    <span class={`flex items-center gap-1.5 ${s.archived ? 'text-dim' : ''}`}>
      <span class={`w-2 h-2 rounded-full flex-none ${dotColor[s.status] ?? 'bg-ok'}`}></span>
      <span class="truncate">{baseName(s.cwd)}</span>
      {s.archived ? <span class="text-[9px] uppercase tracking-wider text-dim border border-line rounded px-1 flex-none">archived</span> : null}
    </span>
    <span class="text-dim text-[11px]">{s.status} · {timeAgo(s.last_activity)} · {s.message_count} msgs · {s.total_tokens} tok</span>
  </li>
);

const SessionList = ({ sessions, current, onSelect, showArchived, grouped }) => {
  // Archived sessions are hidden unless the toggle is on; they render in a
  // flat, dimmed section at the bottom (still selectable / openable).
  const visible = sessions.filter((s) => !s.archived);
  const archived = showArchived ? sessions.filter((s) => s.archived) : [];
  // Group by cwd (project), preserving server sort order (most recent first).
  const groups = new Map();
  for (const s of visible) {
    if (!groups.has(s.cwd)) groups.set(s.cwd, []);
    groups.get(s.cwd).push(s);
  }
  const items = (ss) => ss.map((s) => <SessionItem key={s.id} s={s} active={s.id === current} onSelect={onSelect} />);
  return (
    <ul class="list-none m-0 p-0 overflow-y-auto flex-1">
      {grouped
        ? [...groups].map(([cwd, ss]) => (
          <Fragment key={cwd}>
            <li class="px-2.5 pt-3 pb-1 text-dim text-[10px] uppercase tracking-wider select-none">{baseName(cwd)} ({ss.length})</li>
            {items(ss)}
          </Fragment>
        ))
        : items(visible)}
      {archived.length ? (
        <Fragment key="archived">
          <li class="px-2.5 pt-3 pb-1 text-dim text-[10px] uppercase tracking-wider select-none">archived ({archived.length})</li>
          {archived.map((s) => <SessionItem key={s.id} s={s} active={s.id === current} onSelect={onSelect} />)}
        </Fragment>
      ) : null}
    </ul>
  );
};

// `cls` carries the layout (width, border, background) so the caller can
// adapt it: in-flow column on desktop, fixed overlay drawer on mobile.
export const Sidebar = ({ cls, sessions, current, onNew, onSelect, newCwd, setNewCwd,
                          showArchived, onToggleArchived, grouped, onToggleGrouped }) => {
  const submit = async (e) => {
    e.preventDefault();
    const c = newCwd.trim();
    if (!c) return;
    setNewCwd('');
    await onNew(c);
  };
  return (
    <aside class={cls}>
      <form class="flex flex-col gap-1.5 p-2.5 border-b border-line" onSubmit={submit}>
        <input value={newCwd} onInput={(e: any) => setNewCwd(e.target.value)} placeholder="/path/to/cwd" required autocomplete="off"
               class="text-ink bg-panel border border-line rounded py-1.5 px-2 focus:outline-none focus:border-accent" />
        <button type="submit"
                class="text-ink bg-panel border border-line rounded py-1.5 px-2 cursor-pointer hover:border-accent
                       disabled:opacity-40 disabled:cursor-default disabled:hover:border-line">new session</button>
      </form>
      <label class="flex items-center gap-1.5 px-2.5 py-2 border-b border-line text-dim text-[11px] cursor-pointer select-none">
        <input type="checkbox" checked={grouped} onChange={onToggleGrouped} />
        group by project
      </label>
      <label class="flex items-center gap-1.5 px-2.5 py-2 border-b border-line text-dim text-[11px] cursor-pointer select-none">
        <input type="checkbox" checked={showArchived} onChange={onToggleArchived} />
        show archived
      </label>
      <SessionList sessions={sessions} current={current} onSelect={onSelect} showArchived={showArchived} grouped={grouped} />
    </aside>
  );
};
