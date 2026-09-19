import { render } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { api, post } from './api';
import { baseName, parseCommand, SLASH_COMMANDS } from './util';
import { prepareImageDataURL } from './image';
import {
  useLocalStorage, useModels, useSessions, useSessionView, useAttachments, useFlash, useTheme,
} from './hooks';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { Main } from './Main';

// md breakpoint: >= it the sidebar is in-flow; below it, an overlay drawer
// (auto-collapsed by default on mobile).
const isWide = () => window.matchMedia('(min-width: 768px)').matches;
// localStorage key for a session's composer draft.
const inputKey = (id) => `clown-circus-input-${id}`;
// Deep link: #/session/<id>. The hash is the routing source — select() writes
// it, closing clears it, and load / browser back-forward re-derive the open
// session from it. Null when the hash names no session (the welcome state).
const parseHash = () => location.hash.match(/^#\/session\/(.+)$/)?.[1] ?? null;
// Default for /trim when no turn count is typed: how many trailing turns to
// leave untouched. A web-UI convenience — the REST endpoint needs an explicit
// `keep`.
const TRIM_KEEP_DEFAULT = 5;

// ── root component: wires the hooks, keeps cross-cutting orchestration ─────
const App = () => {
  const { flash, flashMsg } = useFlash();
  const { theme, toggleTheme } = useTheme();
  const { sessions, refresh } = useSessions();
  const { models, model, setModel, isVisionCapable, visionModels } = useModels();
  const [current, setCurrent] = useState(null);
  const { view, setView, patch, clear } = useSessionView(current, { refresh, onFlash: flashMsg });
  const { attachments, set: setAttachments, addFiles, removeAttachment } = useAttachments(flashMsg);

  const [input, setInput] = useState('');
  const [newCwd, setNewCwd] = useState('');
  // Reasoning effort sent with the next model call: pure client state (like
  // the model), defaulting to 'medium' and pre-filled from the open session's
  // last-used value on select().
  const [effort, setEffort] = useState('medium');
  const [sideOpen, setSideOpen] = useState(isWide);
  // Archived sessions are fetched (see useSessions) but hidden by default; the
  // sidebar toggle flips this. Not persisted.
  const [showArchived, setShowArchived] = useState(false);
  // Group the sidebar by project (cwd); persisted (see useLocalStorage).
  const [grouped, setGrouped] = useLocalStorage('clown-circus-grouped', true);

  // The /config summary (base_url · db) shown in the header when no session is
  // open — a one-shot status line, so it stays here rather than in a hook.
  const [cfg, setCfg] = useState('loading…');
  useEffect(() => {
    (async () => {
      try { const c = await api('/config'); setCfg(`${c.base_url} · home: ${c.home}`); }
      catch { setCfg(''); }
    })();
  }, []);

  // Per-session composer draft: restored when the session changes, persisted on
  // every change, keyed by session id so switching back and forth keeps each
  // session's half-typed message. The two effects are deliberately keyed
  // differently — restore on `current`, persist on `input` — so a switch (new
  // `current`, still-old `input`) can't write the old session's text under a
  // stale key. (Can't be useLocalStorage: its write is keyed on [key, v].)
  useEffect(() => {
    if (!current) return;
    let saved = '';
    try { saved = localStorage.getItem(inputKey(current)) ?? ''; } catch {}
    setInput(saved);
  }, [current]);
  useEffect(() => {
    if (!current) return;
    try {
      if (input) localStorage.setItem(inputKey(current), input);
      else localStorage.removeItem(inputKey(current));
    } catch {}
  }, [input]);

  // Keep the drawer from covering the viewport when the window shrinks below
  // the md breakpoint (resize / rotate to portrait).
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = (e) => { if (!e.matches) setSideOpen(false); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Reflect the selected session in the tab title; fall back to the app name
  // when none is open.
  useEffect(() => {
    document.title = view?.cwd ? `${view.title ?? baseName(view.cwd)} · Clown-Circus` : 'Clown-Circus';
  }, [view?.cwd, view?.title]);

  // SSE events carry transcript + status, not meta — so a title set by the
  // first send only reaches the list poll. Mirror the open session's title
  // from the polled list into the view (the header + tab title read it).
  useEffect(() => {
    const s = current ? sessions.find((x) => x.id === current) : null;
    if (s && view?.title !== s.title) patch({ title: s.title });
  }, [sessions, current, view?.title]);

  // The id we last wrote into the hash — our own hashchange echo must be a
  // no-op, only external navigation (back/forward/pasted link) acts on it.
  const hashIdRef = useRef(null);

  // Deselect the open session: clear the view and drop the hash (pushState, so
  // browser back re-opens the session). The hash write goes through here too,
  // so a failed select never leaves a dead link behind.
  const closeSession = () => {
    hashIdRef.current = null;
    if (location.hash) history.pushState(null, '', location.pathname + location.search);
    setCurrent(null);
    clear();
  };

  const select = async (id) => {
    if (!isWide()) setSideOpen(false); // on mobile, a tap on a session reveals the chat
    hashIdRef.current = id;
    if (location.hash !== `#/session/${id}`) location.hash = `#/session/${id}`;
    setCurrent(id);
    refresh();
    try {
      const d = await api(`/sessions/${id}`);
      setView({
        id: d.id ?? id, cwd: d.cwd, model: d.model, status: d.status, last_error: d.last_error,
        messages: d.messages, tokens: d.total_tokens,
        archived: d.archived, title: d.title,
      });
      setNewCwd(d.cwd);
      setModel(d.model); // pre-fill the select (useModels drops stale values)
      setEffort(d.reasoning_effort ?? 'medium');
    } catch (err) {
      flashMsg(err.message);
      closeSession();
    }
  };

  const onNew = async (cwd) => {
    if (!model) { flashMsg('no models available — check the LLM endpoint'); return; }
    try {
      const s = await post('/sessions', { cwd, model, reasoning_effort: effort });
      await refresh();
      await select(s.id);
    } catch (err) { flashMsg(err.message); }
  };

  const handleAction = async (name, arg = null) => {
    if (!current) return;
    try {
      if (name === 'undo' || name === 'clear' || name === 'trim') {
        // synchronous history edits: re-fetch the detail and re-render. Only
        // `trim` carries a body (the `keep` arg); the rest are no-arg.
        const r = await post(`/sessions/${current}/${name}`, name === 'trim' ? { keep: arg } : undefined);
        // Undo restores the popped user message into the composer so it can be
        // edited and re-sent.
        if (name === 'undo' && r?.undone) setInput(r.undone);
        const d = await api(`/sessions/${current}`);
        patch({ status: d.status, last_error: d.last_error, messages: d.messages, tokens: d.total_tokens, title: d.title });
      } else if (name === 'archive' || name === 'unarchive') {
        // metadata-only flag: reflect it in the open view, refresh the list.
        const r = await post(`/sessions/${current}/${name}`);
        patch({ archived: r.archived });
        refresh();
      } else if (name === 'fork') {
        // fork: the server returns the new session; jump to it so the branch
        // continues immediately (the source stays open in the sidebar).
        const r = await post(`/sessions/${current}/fork`);
        await select(r.id);
      } else {
        // agent actions (retry/init/compact): fire-and-forget; SSE streams it.
        await post(`/sessions/${current}/${name}`);
        refresh();
      }
    } catch (err) { flashMsg(err.message); }
  };

  // Composer slash-commands (e.g. /retry). Parsed before the message path so a
  // command always dispatches — including /stop and the implicit-stop commands
  // (/undo, /clear, /trim) that must work while a run is in flight. Each
  // delegates to the existing handlers, so there's no new endpoint. /trim takes
  // an optional numeric `<turns>` arg; with no arg it keeps the last
  // TRIM_KEEP_DEFAULT. A non-numeric/negative arg flashes usage and keeps the
  // text; unknown commands keep the text so it can be edited.
  const runCommand = ({ name, arg }) => {
    switch (name) {
      case 'stop': setInput(''); void stop(); return;
      case 'undo': setInput(''); void handleAction('undo'); return;
      case 'retry': setInput(''); void handleAction('retry'); return;
      case 'retry-turn': setInput(''); void handleAction('retry-turn'); return;
      case 'init': setInput(''); void handleAction('init'); return;
      case 'compact': setInput(''); void handleAction('compact'); return;
      case 'clear': setInput(''); void handleAction('clear'); return;
      case 'trim': {
        const n = arg === '' ? TRIM_KEEP_DEFAULT : Number(arg);
        if (!Number.isInteger(n) || n < 0) { flashMsg(`usage: /trim [turns] — keep the last n (default ${TRIM_KEEP_DEFAULT})`); return; }
        setInput(''); void handleAction('trim', n); return;
      }
      case 'fork': setInput(''); void handleAction('fork'); return;
      // Informational: the text stays in the composer (like /trim usage).
      case 'help': flashMsg(`commands: ${SLASH_COMMANDS.filter((c) => c.name !== 'help').map((c) => `/${c.name}`).join(' ')}`); return;
      default: flashMsg(`unknown command: /${name}`);
    }
  };

  const send = async () => {
    const text = input.trim();
    if ((!text && !attachments.length) || !current) return;
    const parsed = parseCommand(text);
    if (parsed) { runCommand(parsed); return; }
    if (view?.status === 'running') return;
    const savedAttachments = attachments;
    setInput('');
    setAttachments([]);
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
      if (!model) { flashMsg('no models available — check the LLM endpoint'); setInput(text); setAttachments(savedAttachments); return; }
      await post(`/sessions/${current}/messages`, { message, model, reasoning_effort: effort });
    } catch (err) { flashMsg(err.message); setInput(text); setAttachments(savedAttachments); }
  };

  const onKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };

  const stop = async () => {
    try { await post(`/sessions/${current}/stop`); } catch (err) { flashMsg(err.message); }
  };

  const del = async () => {
    if (!confirm(`delete session ${baseName(view?.cwd ?? '')}?`)) return;
    try {
      await api(`/sessions/${current}`, { method: 'DELETE' });
      try { localStorage.removeItem(inputKey(current)); } catch {}
      closeSession();
      await refresh();
    } catch (err) { flashMsg(err.message); }
  };

  // Deep links: act on *external* hash changes (browser back/forward, a
  // pasted #/session/<id>) — our own writes are skipped via hashIdRef.
  useEffect(() => {
    const onHash = () => {
      const id = parseHash();
      if (id === hashIdRef.current) return; // echo of our own write
      if (id) void select(id);
      else if (hashIdRef.current !== null) closeSession();
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // On load, restore the session the URL points at once the list is known; a
  // stale link (session already gone) is dropped from the URL, not selected.
  useEffect(() => {
    if (current || !sessions.length) return;
    const id = parseHash();
    if (!id) return;
    if (sessions.some((s) => s.id === id)) void select(id);
    else { hashIdRef.current = null; history.replaceState(null, '', location.pathname + location.search); }
  }, [sessions, current]);

  return (
    <div class="h-dvh flex flex-col">
      <Header cfg={cfg} theme={theme} sideOpen={sideOpen}
              onSideToggle={() => setSideOpen((o) => !o)} onThemeToggle={toggleTheme}
              view={view} onAction={handleAction} onDel={del} onClose={closeSession}
              model={model} onModelChange={setModel} models={models} visionModels={visionModels}
              effort={effort} onEffortChange={setEffort} />
      <div class="flex-1 flex min-h-0">
        {sideOpen ? (
          // mobile (<md): fixed overlay drawer + dimmed backdrop;
          // desktop (>=md): display:contents wrapper, so the <aside>
          // joins the parent flex row as the in-flow column
          <div class="fixed inset-0 z-40 flex md:contents">
            <Sidebar cls="w-[280px] max-w-[85vw] md:max-w-none min-w-[220px] border-r border-hairline flex flex-col material shadow-xl md:shadow-none"
                     sessions={sessions} current={current}
                     onNew={onNew} onSelect={select} newCwd={newCwd} setNewCwd={setNewCwd}
                     showArchived={showArchived} onToggleArchived={() => setShowArchived((v) => !v)}
                     grouped={grouped} onToggleGrouped={() => setGrouped((v) => !v)} />
            <div class="flex-1 bg-black/50 md:hidden" onClick={() => setSideOpen(false)}></div>
          </div>
        ) : null}
        <Main view={view} flash={flash} cfg={cfg} sessions={sessions} onSelect={select}
              input={input} setInput={setInput}
              attachments={attachments} onAddFiles={addFiles} onRemoveAttachment={removeAttachment}
              visionCapable={isVisionCapable(view?.model)}
              onSend={send} onStop={stop} onKey={onKey} />
      </div>
    </div>
  );
};

render(<App />, document.getElementById('root'));
