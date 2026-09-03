import { h, render, Fragment } from 'preact';
import { useState, useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import htm from 'htm';

const html = htm.bind(h);

// ── API helpers ──────────────────────────────────────────────────────
const api = async (path, opts = {}) => {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { msg = (await r.json()).error?.message ?? msg; } catch {}
    throw new Error(msg);
  }
  return r.status === 204 ? null : r.json();
};
const post = (path, body) => api(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

// ── pure helpers ─────────────────────────────────────────────────────
const baseName = (cwd) => cwd.split('/').filter(Boolean).at(-1) || cwd;
const timeAgo = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const prettyArgs = (a) => { try { return JSON.stringify(JSON.parse(a)); } catch { return a ?? ''; } };

// ── status colour maps ───────────────────────────────────────────────
const dotColor = { running: 'bg-accent animate-pulse', idle: 'bg-ok', error: 'bg-err', stopped: 'bg-dim' };
const badgeColor = { running: 'text-accent', idle: 'text-ok', error: 'text-err', stopped: 'text-dim' };

// ── shared class strings ─────────────────────────────────────────────
const BTN = 'text-ink bg-panel border border-line rounded py-[3px] px-2.5 text-xs cursor-pointer hover:border-accent';
const SEND_BTN = 'text-ink bg-panel border border-line rounded py-1.5 px-2 cursor-pointer hover:border-accent disabled:opacity-40 disabled:cursor-default disabled:hover:border-line';
const PRE = 'm-0 py-2 px-2.5 whitespace-pre-wrap break-words';

// ── leaf components ──────────────────────────────────────────────────
const Pre = ({ text, cls = PRE }) => html`<pre class=${cls}>${text ?? ''}</pre>`;

const Header = ({ cfg }) => html`
  <header class="flex items-baseline gap-3 px-3.5 py-2.5 border-b border-line">
    <h1 class="text-[15px] m-0 text-accent">clown-circus</h1>
    <div class="text-dim text-xs">${cfg}</div>
  </header>`;

const Message = ({ m }) => {
  if (m.role === 'system') {
    return html`
      <details class="border border-line rounded-md">
        <summary class="py-1 px-2.5 text-dim text-[11px] cursor-pointer">system</summary>
        <${Pre} text=${m.content} cls="m-0 py-2 px-2.5 whitespace-pre-wrap break-words text-dim border-t border-line max-h-[300px] overflow-y-auto" />
      </details>`;
  }
  if (m.role === 'tool') {
    const first = (m.content ?? '').split('\n')[0].slice(0, 120);
    return html`
      <details class="border border-dashed border-line rounded-md">
        <summary class="py-1 px-2.5 text-dim text-xs cursor-pointer">tool result — ${first}</summary>
        <${Pre} text=${m.content} cls="m-0 py-2 px-2.5 whitespace-pre-wrap break-words text-dim border-t border-dashed border-line" />
      </details>`;
  }
  const isUser = m.role === 'user';
  return html`
    <div class="border border-line rounded-md bg-panel">
      <div class="py-1 px-2.5 border-b border-line text-[11px] uppercase tracking-wide ${isUser ? 'text-accent' : 'text-dim'}">${m.role}</div>
      ${(m.tool_calls ?? []).map((tc) => html`
        <span class="inline-block mt-1.5 mr-1.5 ml-2.5 py-0.5 px-2 bg-chip border border-line rounded-full text-xs">${tc.function.name}(${prettyArgs(tc.function.arguments)})</span>`)}
      ${m.content ? html`<${Pre} text=${m.content} />` : null}
    </div>`;
};

// List of messages; keeps the container scrolled to the newest turn.
const Messages = ({ messages }) => {
  const ref = useRef(null);
  useLayoutEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [messages]);
  return html`
    <div ref=${ref} class="flex-1 overflow-y-auto p-3 flex flex-col gap-2.5">
      ${messages.map((m, i) => html`<${Message} key=${i} m=${m} />`)}
    </div>`;
};

const Todos = ({ todos }) => todos?.length
  ? html`
      <div class="mx-3 mt-2 p-2 px-2.5 border border-line rounded text-xs">
        <ul class="list-none m-0 p-0">
          ${todos.map((t, i) => html`
            <li key=${i} class=${t.status === 'completed' ? 'text-dim line-through' : t.status === 'in_progress' ? 'text-accent' : ''}>[${t.status}] ${t.name}</li>`)}
        </ul>
      </div>`
  : null;

const ErrorBox = ({ message }) => message
  ? html`<div class="mx-3 mt-2 p-2 px-2.5 border border-err text-err rounded whitespace-pre-wrap">${message}</div>`
  : null;

const Toolbar = ({ view, onAction, onDel }) => html`
  <div class="flex items-center gap-2 px-3 py-2 border-b border-line flex-wrap">
    <span class="py-0.5 px-2 rounded-full text-xs border border-line ${badgeColor[view.status] ?? 'text-ok'}">${view.status ?? 'idle'}</span>
    <span class="text-dim text-xs break-all">${view.cwd ?? ''} · ${view.model ?? ''} · ${view.tokens ?? 0} tokens</span>
    <span class="flex-1"></span>
    <button title="strip trailing assistant/tool messages and re-run" class=${BTN} onclick=${() => onAction('retry')}>retry</button>
    <button title="run the /init skill on this project" class=${BTN} onclick=${() => onAction('init')}>init</button>
    <span class="w-px h-4 bg-line"></span>
    <button title="summarize and replace the history" class=${BTN} onclick=${() => onAction('compact')}>compact</button>
    <button title="pop the last message" class=${BTN} onclick=${() => onAction('undo')}>undo</button>
    <button title="remove all tool results from history" class=${BTN} onclick=${() => onAction('clear-tools')}>clear-tools</button>
    <button title="reset history to the system prompt" class=${BTN} onclick=${() => onAction('clear')}>clear</button>
    <span class="w-px h-4 bg-line"></span>
    <button title="delete this session" class=${BTN} onclick=${onDel}>delete</button>
  </div>`;

const InputBar = ({ running, value, onInput, onKey, onSend, onStop }) => html`
  <div class="flex gap-2 px-3 py-2.5 border-t border-line">
    <textarea value=${value} oninput=${onInput} onkeydown=${onKey} disabled=${running}
              placeholder="message (Enter to send, Shift+Enter for newline)"
              class="flex-1 resize-y min-h-[44px] max-h-[200px] text-ink bg-panel border border-line rounded py-1.5 px-2 focus:outline-none focus:border-accent"></textarea>
    <div class="flex flex-col gap-1.5">
      <button disabled=${running} class=${SEND_BTN} onclick=${onSend}>send</button>
      ${running ? html`<button class=${SEND_BTN} onclick=${onStop}>stop</button>` : null}
    </div>
  </div>`;

// ── session list (grouped by project) ────────────────────────────────
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

const Sidebar = ({ models, defaultModel, sessions, current, onNew, onSelect }) => {
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    const c = cwd.trim();
    if (!c) return;
    setCwd('');
    await onNew(c, model.trim());
  };
  return html`
    <aside class="w-[280px] min-w-[220px] border-r border-line flex flex-col">
      <form class="flex flex-col gap-1.5 p-2.5 border-b border-line" onsubmit=${submit}>
        <input value=${cwd} oninput=${(e) => setCwd(e.target.value)} placeholder="/path/to/cwd" required autocomplete="off"
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

const Main = (p) => !p.view
  ? html`
      <main class="flex-1 flex flex-col min-w-0">
        <div class="flex-1 flex items-center justify-center text-dim">select or create a session</div>
      </main>`
  : html`
      <main class="flex-1 flex flex-col min-w-0">
        <${Toolbar} view=${p.view} onAction=${p.onAction} onDel=${p.onDel} />
        <${ErrorBox} message=${p.flash ?? p.view.last_error} />
        <${Todos} todos=${p.view.todos} />
        <${Messages} messages=${p.view.messages} />
        <${InputBar} running=${p.view.status === 'running'} value=${p.input}
                      onInput=${(e) => p.setInput(e.target.value)} onKey=${p.onKey} onSend=${p.onSend} onStop=${p.onStop} />
      </main>`;

// ── root component (owns all state + side effects) ───────────────────
const App = () => {
  const [cfg, setCfg] = useState('loading…');
  const [defaultModel, setDefaultModel] = useState(null);
  const [models, setModels] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [current, setCurrent] = useState(null);
  const [view, setView] = useState(null);
  const [input, setInput] = useState('');
  const [flash, setFlash] = useState(null);
  const flashTimer = useRef(null);

  const flashMsg = (msg) => {
    setFlash(msg);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 6000);
  };

  const refreshSessions = async () => {
    let list;
    try { list = await api('/sessions'); } catch { return; }
    setSessions(list);
  };

  // boot: load config + models, seed the session list, then poll every 10s.
  useEffect(() => {
    let timer;
    (async () => {
      let def = null;
      try {
        const c = await api('/config');
        def = c.default_model;
        setDefaultModel(def);
        setCfg(`${c.base_url} · default model: ${c.default_model} · db: ${c.db_file}`);
      } catch { setCfg(''); }
      try {
        const { data } = await api('/models');
        setModels((data ?? []).map((m) => m.id ?? m.name ?? m).filter(Boolean).filter((m) => m !== def));
      } catch {}
      await refreshSessions();
    })();
    timer = setInterval(refreshSessions, 10000);
    return () => { clearInterval(timer); clearTimeout(flashTimer.current); };
  }, []);

  // live updates: one EventSource per selected session (auto-reconnects with Last-Event-ID).
  useEffect(() => {
    if (!current) return;
    const es = new EventSource(`/sessions/${current}/events`);
    es.addEventListener('snapshot', (e) => {
      const snap = JSON.parse(e.data);
      setView((v) => v ? { ...v, messages: snap.messages, todos: snap.todos, tokens: snap.total_tokens } : v);
    });
    es.addEventListener('todo', (e) => setView((v) => v ? { ...v, todos: JSON.parse(e.data) } : v));
    es.addEventListener('status', (e) => {
      setView((v) => v ? { ...v, status: JSON.parse(e.data).status } : v);
      refreshSessions();
    });
    es.addEventListener('done', (e) => setView((v) => v ? { ...v, tokens: JSON.parse(e.data).total_tokens } : v));
    es.addEventListener('error', (e) => {
      if (e.data) {
        setView((v) => v ? { ...v, status: 'error' } : v);
        flashMsg(JSON.parse(e.data).message);
        refreshSessions();
      }
    });
    es.onerror = () => { /* EventSource auto-reconnects with Last-Event-ID */ };
    return () => es.close();
  }, [current]);

  const select = async (id) => {
    setCurrent(id);
    refreshSessions();
    try {
      const d = await api(`/sessions/${id}`);
      setView({
        id: d.id ?? id, cwd: d.cwd, model: d.model, status: d.status, last_error: d.last_error,
        messages: d.snapshot.messages, todos: d.snapshot.todos, tokens: d.snapshot.total_tokens,
      });
    } catch (err) {
      flashMsg(err.message);
      setCurrent(null);
      setView(null);
    }
  };

  const onNew = async (cwd, model) => {
    try {
      const s = await post('/sessions', model ? { cwd, model } : { cwd });
      await refreshSessions();
      await select(s.id);
    } catch (err) { flashMsg(err.message); }
  };

  const handleAction = async (name) => {
    if (!current) return;
    try {
      if (name === 'undo' || name === 'clear' || name === 'clear-tools') {
        // synchronous history edits: re-fetch the detail and re-render.
        const r = await post(`/sessions/${current}/${name}`);
        if (name === 'undo' && r?.undone) flashMsg(`undone: ${r.undone.slice(0, 120)}`);
        const d = await api(`/sessions/${current}`);
        setView((v) => v ? {
          ...v, status: d.status, last_error: d.last_error,
          messages: d.snapshot.messages, todos: d.snapshot.todos, tokens: d.snapshot.total_tokens,
        } : v);
      } else {
        // agent actions (retry/init/compact): fire-and-forget; SSE streams the rest.
        await post(`/sessions/${current}/${name}`);
        refreshSessions();
      }
    } catch (err) { flashMsg(err.message); }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !current) return;
    setInput('');
    try {
      await post(`/sessions/${current}/messages`, { message: text });
    } catch (err) { flashMsg(err.message); setInput(text); }
  };

  const onKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };

  const stop = async () => {
    try { await post(`/sessions/${current}/stop`); } catch (err) { flashMsg(err.message); }
  };

  const del = async () => {
    if (!confirm(`delete session ${baseName(view?.cwd ?? '')}?`)) return;
    try {
      await api(`/sessions/${current}`, { method: 'DELETE' });
      setCurrent(null);
      setView(null);
      await refreshSessions();
    } catch (err) { flashMsg(err.message); }
  };

  return html`
    <div class="h-dvh flex flex-col">
      <${Header} cfg=${cfg} />
      <div class="flex-1 flex min-h-0">
        <${Sidebar} models=${models} defaultModel=${defaultModel} sessions=${sessions} current=${current}
                  onNew=${onNew} onSelect=${select} />
        <${Main} view=${view} flash=${flash} input=${input} setInput=${setInput}
                 onAction=${handleAction} onSend=${send} onStop=${stop} onDel=${del} onKey=${onKey} />
      </div>
    </div>`;
};

render(html`<${App} />`, document.getElementById('root'));
