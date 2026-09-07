import { render } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { html } from './ui.js';
import { api, post, openSessionEvents } from './api.js';
import { baseName, parseCommand, modelId } from './util.js';
import { fileToDataURL, prepareImageDataURL, isImageFile } from './image.js';
import { Header } from './Header.js';
import { Sidebar } from './Sidebar.js';
import { Main } from './Main.js';

// md breakpoint: >= it the sidebar sits in the flex flow; below it, it's an
// overlay drawer (auto-collapsed by default on mobile).
const isWide = () => window.matchMedia('(min-width: 768px)').matches;

// localStorage key for a session's composer draft.
const inputKey = (id) => `clown-circus-input-${id}`;

// Attachment id. crypto.randomUUID() is only exposed in *secure* contexts
// (https / localhost); a phone that reaches the server over a LAN IP is not,
// so fall back to a non-crypto id. It only needs to be unique among the
// current thumbnails (Preact keys + remove-by-id).
const uid = () =>
  (crypto.randomUUID
    ? crypto.randomUUID()
    : `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

// ── root component (owns all state + side effects) ───────────────────
const App = () => {
  const [cfg, setCfg] = useState('loading…');
  const [defaultModel, setDefaultModel] = useState(null);
  const [models, setModels] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [current, setCurrent] = useState(null);
  const [view, setView] = useState(null);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [newCwd, setNewCwd] = useState('');
  const [model, setModel] = useState(''); // header select: '' = the default model
  const [flash, setFlash] = useState(null);
  const flashTimer = useRef(null);
  const [visionModels, setVisionModels] = useState(new Set());
  const [knownModelIds, setKnownModelIds] = useState(new Set());
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('clown-circus-theme') === 'light' ? 'light' : 'dark'; }
    catch { return 'dark'; }
  });

  // Sidebar: open by default on desktop, auto-collapsed on narrow viewports.
  const [sideOpen, setSideOpen] = useState(isWide);
  // Archived sessions are fetched but hidden by default; the sidebar toggle
  // flips this (client-side split, so the 10s poll stays toggle-agnostic).
  const [showArchived, setShowArchived] = useState(false);

  const flashMsg = (msg) => {
    setFlash(msg);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 6000);
  };

  const refreshSessions = async () => {
    let list;
    try { list = await api('/sessions?archived=1'); } catch { return; }
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
        const list = data ?? [];
        setModels(list.map(modelId).filter(Boolean).filter((m) => m !== def));
        const known = new Set();
        const vision = new Set();
        for (const m of list) {
          const id = modelId(m);
          if (!id) continue;
          known.add(id);
          if (m?.architecture?.input_modalities?.includes('image')) vision.add(id);
        }
        setKnownModelIds(known);
        setVisionModels(vision);
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

  // Reflect the selected session in the tab title; falls back to the app
  // name when no session is open.
  useEffect(() => {
    document.title = view?.cwd ? `${baseName(view.cwd)} · Clown-Circus` : 'Clown-Circus';
  }, [view?.cwd]);

  // Per-session composer draft: restore it when the session changes, and
  // persist it on every change, keyed by session id so switching back and
  // forth keeps each session's half-typed message.
  useEffect(() => {
    if (!current) return;
    let saved = '';
    try { saved = localStorage.getItem(inputKey(current)) ?? ''; } catch {}
    setInput(saved);
  }, [current]);

  // Deliberately keyed on `input` only (not `current`): on a session switch the
  // render carries the new `current` but the *old* `input`, so depending on
  // `current` here would write the previous session's text into the new key
  // before the restore above has loaded it. By then `current` is already fresh
  // in the closure, so the write always lands on the right session.
  useEffect(() => {
    if (!current) return;
    try {
      if (input) localStorage.setItem(inputKey(current), input);
      else localStorage.removeItem(inputKey(current));
    } catch {}
  }, [input]);

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
      snapshot: (snap) => setView((v) => v ? { ...v, messages: snap.messages, tokens: snap.total_tokens } : v),
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
        messages: d.snapshot.messages, tokens: d.snapshot.total_tokens,
        archived: d.archived,
      });
      setNewCwd(d.cwd);
      setModel(d.model === defaultModel ? '' : d.model); // sync the select to the session
    } catch (err) {
      flashMsg(err.message);
      setCurrent(null);
      setView(null);
    }
  };

  const onNew = async (cwd) => {
    try {
      const s = await post('/sessions', model ? { cwd, model } : { cwd });
      await refreshSessions();
      await select(s.id);
    } catch (err) { flashMsg(err.message); }
  };

  // The header model select is context-aware: with a session open it switches
  // that session's model; with none open it just seeds the next new session.
  const onModelChange = async (v) => {
    const prev = model;
    setModel(v);
    if (!current) return;
    const target = v || defaultModel;
    try {
      const r = await post(`/sessions/${current}/model`, { model: target });
      setView((w) => (w ? { ...w, model: r.model ?? target } : w));
    } catch (err) {
      flashMsg(err.message);
      setModel(prev); // revert on failure
    }
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
          messages: d.snapshot.messages, tokens: d.snapshot.total_tokens,
        } : v);
      } else if (name === 'archive' || name === 'unarchive') {
        // metadata-only flag: reflect it in the open view, refresh the list.
        const r = await post(`/sessions/${current}/${name}`);
        setView((v) => (v ? { ...v, archived: r.archived } : v));
        refreshSessions();
      } else if (name === 'duplicate') {
        // fork: the server returns the new session; jump to it so the branch
        // can continue immediately (the source stays open in the sidebar).
        const r = await post(`/sessions/${current}/duplicate`);
        await select(r.id);
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
      case 'duplicate': setInput(''); void handleAction('duplicate'); return;
      default: flashMsg(`unknown command: /${name}`);
    }
  };

  // --- Attachments (image upload) -------------------------------------------

  const addFiles = async (fileList) => {
    const files = Array.from(fileList ?? []);
    if (!files.length) return;
    const valid = files.filter(isImageFile);
    if (!valid.length) { flashMsg('no supported image in that'); return; }
    try {
      const items = await Promise.all(valid.map(async (f) => ({
        id: uid(),
        name: f.name || 'image',
        dataUrl: await fileToDataURL(f),
      })));
      setAttachments((prev) => [...prev, ...items]);
    } catch (err) { flashMsg(`couldn't read image: ${err?.message ?? err}`); }
  };

  const removeAttachment = (id) => setAttachments((prev) => prev.filter((a) => a.id !== id));
  const clearAttachments = () => setAttachments([]);

  const isVisionCapable = (modelId) => !knownModelIds.has(modelId) || visionModels.has(modelId);

  const send = async () => {
    const text = input.trim();
    if ((!text && !attachments.length) || !current) return;
    const parsed = parseCommand(text);
    if (parsed) { runCommand(parsed); return; }
    if (view?.status === 'running') return;
    const savedAttachments = attachments;
    setInput('');
    clearAttachments();
    try {
      let message;
      if (savedAttachments.length) {
        const parts = [];
        if (text) parts.push({ type: 'text', text });
        for (const a of savedAttachments) {
          const capped = await prepareImageDataURL(a.dataUrl);
          parts.push({ type: 'image_url', image_url: { url: capped } });
        }
        message = parts;
      } else {
        message = text;
      }
      await post(`/sessions/${current}/messages`, { message });
    } catch (err) { flashMsg(err.message); setInput(text); setAttachments(savedAttachments); }
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
      try { localStorage.removeItem(inputKey(current)); } catch {}
      setCurrent(null);
      setView(null);
      await refreshSessions();
    } catch (err) { flashMsg(err.message); }
  };

  return html`
    <div class="h-dvh flex flex-col">
      <${Header} cfg=${cfg} theme=${theme} sideOpen=${sideOpen}
                 onSideToggle=${() => setSideOpen((o) => !o)} onThemeToggle=${toggleTheme}
                 view=${view} onAction=${handleAction} onDel=${del}
                 model=${model} onModelChange=${onModelChange} models=${models} />
      <div class="flex-1 flex min-h-0">
        ${sideOpen ? html`
          <!-- mobile (<md): fixed overlay drawer + dimmed backdrop;
               desktop (>=md): display:contents wrapper, so the <aside>
               joins the parent flex row as the in-flow column -->
          <div class="fixed inset-0 z-40 flex md:contents">
            <${Sidebar} cls="w-[280px] max-w-[85vw] md:max-w-none min-w-[220px] border-r border-line flex flex-col bg-bg shadow-xl md:shadow-none"
                       sessions=${sessions} current=${current}
                       onNew=${onNew} onSelect=${select} newCwd=${newCwd} setNewCwd=${setNewCwd}
                       showArchived=${showArchived} onToggleArchived=${() => setShowArchived((v) => !v)} />
            <div class="flex-1 bg-black/50 md:hidden" onclick=${() => setSideOpen(false)}></div>
          </div>` : null}
        <${Main} view=${view} flash=${flash} input=${input} setInput=${setInput}
                 attachments=${attachments} onAddFiles=${addFiles} onRemoveAttachment=${removeAttachment}
                 visionCapable=${isVisionCapable(view?.model)}
                 onSend=${send} onStop=${stop} onKey=${onKey} />
      </div>
    </div>`;
};

render(html`<${App} />`, document.getElementById('root'));
