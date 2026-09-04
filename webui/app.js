import { render } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { html } from './ui.js';
import { api, post, openSessionEvents } from './api.js';
import { baseName, parseCommand, modelId } from './util.js';
import { Header } from './Header.js';
import { Sidebar } from './Sidebar.js';
import { Main } from './Main.js';

// md breakpoint: >= it the sidebar sits in the flex flow; below it, it's an
// overlay drawer (auto-collapsed by default on mobile).
const isWide = () => window.matchMedia('(min-width: 768px)').matches;

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
        setModels((data ?? []).map(modelId).filter(Boolean).filter((m) => m !== def));
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

  // live updates: one EventSource per selected session (auto-reconnects with
  // Last-Event-ID; the server's replay ring covers brief disconnects).
  useEffect(() => {
    if (!current) return;
    return openSessionEvents(current, {
      snapshot: (snap) => setView((v) => v ? { ...v, messages: snap.messages, todos: snap.todos, tokens: snap.total_tokens } : v),
      todo: (todos) => setView((v) => v ? { ...v, todos } : v),
      status: (s) => { setView((v) => v ? { ...v, status: s.status } : v); refreshSessions(); },
      done: (d) => setView((v) => v ? { ...v, tokens: d.total_tokens } : v),
      error: (err) => { setView((v) => v ? { ...v, status: 'error' } : v); flashMsg(err.message); refreshSessions(); },
    });
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

  // Composer slash-commands (e.g. /retry), a port of the source TUI's
  // handleCommand. Parsed before the message path so a command always dispatches
  // — including /stop and the implicit-stop commands (/undo, /clear,
  // /clear-tools) that must work while a run is in flight. Each delegates to the
  // existing handlers, so there is no new endpoint. Unknown commands keep the
  // text in the box so it can be edited.
  const runCommand = ({ name }) => {
    switch (name) {
      case 'stop': setInput(''); void stop(); return;
      case 'undo': setInput(''); void handleAction('undo'); return;
      case 'retry': setInput(''); void handleAction('retry'); return;
      case 'init': setInput(''); void handleAction('init'); return;
      case 'compact': setInput(''); void handleAction('compact'); return;
      case 'clear': setInput(''); void handleAction('clear'); return;
      case 'clear-tools': setInput(''); void handleAction('clear-tools'); return;
      default: flashMsg(`unknown command: /${name}`);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !current) return;
    const parsed = parseCommand(text);
    if (parsed) { runCommand(parsed); return; }
    // Plain messages no-op while a run is in flight (the composer stays editable
    // so you can type ahead, but it won't fire a second message); the typed text
    // is preserved and can be sent once the session is idle.
    if (view?.status === 'running') return;
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
