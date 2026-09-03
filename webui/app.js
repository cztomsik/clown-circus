import { h, render } from 'preact';
import { useState, useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import htm from 'htm';
import { baseName, prettyArgs } from './util.js';
import { InputBar } from './InputBar.js';
import { Sidebar } from './Sidebar.js';

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
// md breakpoint: at/above it the sidebar sits in the flex flow; below it,
// it is an overlay drawer (auto-collapsed by default on mobile).
const isWide = () => window.matchMedia('(min-width: 768px)').matches;

// ── status colour map (badge) ─────────────────────────────────────────
const badgeColor = { running: 'text-accent', idle: 'text-ok', error: 'text-err', stopped: 'text-dim' };

// ── shared class strings ─────────────────────────────────────────────
const BTN = 'text-ink bg-panel border border-line rounded py-[3px] px-2.5 text-xs cursor-pointer hover:border-accent';
const PRE = 'm-0 py-2 px-2.5 whitespace-pre-wrap break-words';

// ── leaf components ──────────────────────────────────────────────────
const Pre = ({ text, cls = PRE }) => html`<pre class=${cls}>${text ?? ''}</pre>`;

const Header = ({ cfg, theme, sideOpen, onSideToggle, onThemeToggle }) => html`
  <header class="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-line">
    <button title="toggle sidebar" aria-label="toggle sidebar" aria-pressed=${sideOpen}
            class=${`${BTN} flex-none ${sideOpen ? 'border-accent' : ''}`}
            onclick=${onSideToggle}>☰</button>
    <h1 class="text-[15px] m-0 text-accent flex-none">clown-circus</h1>
    <div class="text-dim text-xs min-w-0 flex-1 truncate">${cfg}</div>
    <button title="toggle theme" class=${`${BTN} flex-none`} onclick=${onThemeToggle}>${theme === 'dark' ? '→ light' : '→ dark'}</button>
  </header>`;

// Roles are distinguished by colour / weight / tint instead of boxed cards:
// user = accent amber on a faint amber wash, assistant = plain ink (tool
// calls as dim `» name(args)` lines), system/tool = collapsed dim details
// with a thin left rule.
const Message = ({ m }) => {
  if (m.role === 'system') {
    return html`
      <details class="border-l-2 border-line pl-2.5">
        <summary class="py-0.5 text-dim/70 text-xs italic cursor-pointer select-none">system</summary>
        <${Pre} text=${m.content} cls="m-0 pt-1.5 pb-1 text-dim text-xs italic whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto" />
      </details>`;
  }
  if (m.role === 'tool') {
    const first = (m.content ?? '').split('\n')[0].slice(0, 120);
    return html`
      <details class="border-l-2 border-line bg-panel/70 rounded-r-md">
        <summary class="py-1 px-2.5 text-dim text-xs cursor-pointer select-none">tool result — ${first}</summary>
        <${Pre} text=${m.content} cls="m-0 pt-0.5 pb-1.5 px-2.5 text-dim text-xs whitespace-pre-wrap break-words" />
      </details>`;
  }
  const isUser = m.role === 'user';
  return html`
    <div class=${`font-mono ${isUser ? 'border-l-2 border-accent bg-accent/10 rounded-r-md pl-3 pr-2 py-1.5' : ''}`}>
      ${m.content ? html`<${Pre} text=${m.content} cls=${isUser ? 'm-0 font-medium text-accent whitespace-pre-wrap break-words' : PRE} />` : null}
      ${(m.tool_calls ?? []).map((tc) => html`
        <div class="text-dim text-xs mb-1 break-words">» ${tc.function.name}(${prettyArgs(tc.function.arguments)})</div>`)}
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
        <${InputBar} running=${p.view.status === 'running'} current=${p.view.id} value=${p.input}
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
  const [newCwd, setNewCwd] = useState('');
  const [flash, setFlash] = useState(null);
  const flashTimer = useRef(null);
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('clown-circus-theme') === 'light' ? 'light' : 'dark'; }
    catch { return 'dark'; }
  });

  // Sidebar: open by default on desktop, auto-collapsed on narrow viewports.
  const [sideOpen, setSideOpen] = useState(isWide);

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

  // theme: reflect to <html data-theme> and persist so it survives reloads.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('clown-circus-theme', theme); } catch {}
  }, [theme]);

  // Keep the drawer from covering the whole viewport when the window shrinks
  // below the md breakpoint (resize / rotate to portrait).
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = (e) => { if (!e.matches) setSideOpen(false); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
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
      const me = /** @type {MessageEvent} */ (e);
      if (me.data) {
        setView((v) => v ? { ...v, status: 'error' } : v);
        flashMsg(JSON.parse(me.data).message);
        refreshSessions();
      }
    });
    es.onerror = () => { /* EventSource auto-reconnects with Last-Event-ID */ };
    return () => es.close();
  }, [current]);

  const select = async (id) => {
    if (!isWide()) setSideOpen(false); // on mobile, a tap on a session reveals the chat
    setCurrent(id);
    refreshSessions();
    try {
      const d = await api(`/sessions/${id}`);
      setView({
        id: d.id ?? id, cwd: d.cwd, model: d.model, status: d.status, last_error: d.last_error,
        messages: d.snapshot.messages, todos: d.snapshot.todos, tokens: d.snapshot.total_tokens,
      });
      setNewCwd(d.cwd);
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
        // Undo restores the popped user message into the composer so it can be
        // edited and re-sent.
        if (name === 'undo' && r?.undone) setInput(r.undone);
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
    // Enter does nothing while a run is in flight (the composer stays editable
    // so you can type ahead, but it won't fire a second message); the typed text
    // is preserved and can be sent once the session is idle.
    if (!text || !current || view?.status === 'running') return;
    setInput('');
    try {
      await post(`/sessions/${current}/messages`, { message: text });
    } catch (err) { flashMsg(err.message); setInput(text); }
  };

  const onKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };

  const stop = async () => {
    try { await post(`/sessions/${current}/stop`); } catch (err) { flashMsg(err.message); }
  };

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

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
      <${Header} cfg=${cfg} theme=${theme} sideOpen=${sideOpen}
                 onSideToggle=${() => setSideOpen((o) => !o)} onThemeToggle=${toggleTheme} />
      <div class="flex-1 flex min-h-0">
        ${sideOpen ? html`
          <!-- mobile (<md): fixed overlay drawer + dimmed backdrop;
               desktop (>=md): display:contents wrapper, so the <aside>
               joins the parent flex row as the in-flow column -->
          <div class="fixed inset-0 z-40 flex md:contents">
            <${Sidebar} cls="w-[280px] max-w-[85vw] md:max-w-none min-w-[220px] border-r border-line flex flex-col bg-bg shadow-xl md:shadow-none"
                       models=${models} defaultModel=${defaultModel} sessions=${sessions} current=${current}
                       onNew=${onNew} onSelect=${select} newCwd=${newCwd} setNewCwd=${setNewCwd} />
            <div class="flex-1 bg-black/50 md:hidden" onclick=${() => setSideOpen(false)}></div>
          </div>` : null}
        <${Main} view=${view} flash=${flash} input=${input} setInput=${setInput}
                 onAction=${handleAction} onSend=${send} onStop=${stop} onDel=${del} onKey=${onKey} />
      </div>
    </div>`;
};

render(html`<${App} />`, document.getElementById('root'));
