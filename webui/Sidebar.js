import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import { html } from './ui.js';
import { baseName, timeAgo } from './util.js';

// ── status colour map (dot) ───────────────────────────────────────────
const dotColor = { running: 'bg-accent animate-pulse', idle: 'bg-ok', error: 'bg-err', stopped: 'bg-dim' };

// ── session list (grouped by project) ─────────────────────────────────
const SessionItem = ({ s, active, onSelect }) => html`
  <li class=${active
    ? 'py-2 pl-[7px] pr-2.5 border-b border-line cursor-pointer flex flex-col gap-0.5 bg-panel border-l-[3px] border-l-accent'
    : 'py-2 px-2.5 border-b border-line cursor-pointer flex flex-col gap-0.5 hover:bg-panel'}
      onclick=${() => onSelect(s.id)}>
    <span class="flex items-center gap-1.5">
      <span class="w-2 h-2 rounded-full flex-none ${dotColor[s.status] ?? 'bg-ok'}"></span>
      <span>${baseName(s.cwd)}</span>
    </span>
    <span class="text-dim text-[11px]">${s.status} · ${timeAgo(s.last_activity)} · ${s.message_count} msgs · ${s.total_tokens} tok</span>
  </li>`;

const SessionList = ({ sessions, current, onSelect }) => {
  // Group by cwd (project), preserving server sort order (most recent first).
  const groups = new Map();
  for (const s of sessions) {
    if (!groups.has(s.cwd)) groups.set(s.cwd, []);
    groups.get(s.cwd).push(s);
  }
  return html`
    <ul class="list-none m-0 p-0 overflow-y-auto flex-1">
      ${[...groups].map(([cwd, ss]) => html`
        <${Fragment} key=${cwd}>
          <li class="px-2.5 pt-3 pb-1 text-dim text-[10px] uppercase tracking-wider select-none">${baseName(cwd)} (${ss.length})</li>
          ${ss.map((s) => html`<${SessionItem} key=${s.id} s=${s} active=${s.id === current} onSelect=${onSelect} />`)}
        </${Fragment}>
      `)}
    </ul>`;
};

// `cls` carries the layout (width, border, background) so the caller can
// adapt it: in-flow column on desktop, fixed overlay drawer on mobile.
export const Sidebar = ({ cls, models, defaultModel, sessions, current, onNew, onSelect, newCwd, setNewCwd }) => {
  const [model, setModel] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    const c = newCwd.trim();
    if (!c) return;
    setNewCwd('');
    await onNew(c, model.trim());
  };
  return html`
    <aside class=${cls}>
      <form class="flex flex-col gap-1.5 p-2.5 border-b border-line" onsubmit=${submit}>
        <input value=${newCwd} oninput=${(e) => setNewCwd(e.target.value)} placeholder="/path/to/cwd" required autocomplete="off"
               class="text-ink bg-panel border border-line rounded py-1.5 px-2 focus:outline-none focus:border-accent" />
        <select value=${model} onchange=${(e) => setModel(e.target.value)}
                class="text-ink bg-panel border border-line rounded py-1.5 px-2 focus:outline-none focus:border-accent w-full">
          <option value="">default (${defaultModel ?? '?'})</option>
          ${models.map((m) => html`<option key=${m} value=${m}>${m}</option>`)}
        </select>
        <button type="submit"
                class="text-ink bg-panel border border-line rounded py-1.5 px-2 cursor-pointer hover:border-accent
                       disabled:opacity-40 disabled:cursor-default disabled:hover:border-line">new session</button>
      </form>
      <${SessionList} sessions=${sessions} current=${current} onSelect=${onSelect} />
    </aside>`;
};
