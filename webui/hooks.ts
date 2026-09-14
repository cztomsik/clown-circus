// Shared Preact hooks. Preact supports the same hooks as React, so much of
// app.tsx's state + side effects live here as small composable hooks: each owns
// its own state and effects, and app.tsx wires them together, keeping only the
// cross-cutting orchestration (select / send / actions) that needs several at
// once. No DOM-global state leaks between hooks — anything one hook needs from
// another (e.g. a flash callback, the sessions refresher) is passed in.

import { useState, useEffect, useRef } from 'preact/hooks';
import { api, openSessionEvents } from './api';
import { modelId, isVisionModel } from './util';
import { fileToDataURL, isImageFile } from './image';

// Attachment id. crypto.randomUUID() is only exposed in *secure* contexts
// (https / localhost); a phone that reaches the server over a LAN IP is not,
// so fall back to a non-crypto id. It only needs to be unique among the
// current thumbnails (Preact keys + remove-by-id).
const uid = () =>
  (crypto.randomUUID
    ? crypto.randomUUID()
    : `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

// Persistent state, JSON-encoded in localStorage. Reads once on mount (falling
// back to `initial` on an absent key or any parse error) and writes on every
// change; null/undefined removes the key so a cleared value isn't left stale.
export const useLocalStorage = (key, initial) => {
  const [v, setV] = useState(() => {
    try { const raw = localStorage.getItem(key); return raw === null ? initial : JSON.parse(raw); }
    catch { return initial; }
  });
  useEffect(() => {
    try { v == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(v)); }
    catch {}
  }, [key, v]);
  return [v, setV];
};

// A transient toast: `flashMsg(text)` shows it for 6s, `flash` is the text (or
// null). Re-flashing resets the timer; unmount clears it.
export const useFlash = () => {
  const [flash, setFlash] = useState(null);
  const timer = useRef(null);
  const flashMsg = (msg) => {
    setFlash(msg);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlash(null), 6000);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return { flash, flashMsg };
};

// Light/dark theme, persisted and reflected on <html data-theme> so the CSS
// tokens recolour. Toggling flips between the two.
export const useTheme = () => {
  const [theme, setTheme] = useLocalStorage('clown-circus-theme', 'dark');
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return { theme, toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) };
};

// The session list: fetched on mount and re-polled every 10s. Archived sessions
// are fetched too (toggle-agnostic poll); the sidebar splits them client-side.
export const useSessions = () => {
  const [sessions, setSessions] = useState([]);
  const refresh = async () => {
    let list;
    try { list = await api('/sessions?archived=1'); } catch { return; }
    setSessions(list);
  };
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, []);
  return { sessions, refresh };
};

// The model list + the currently-selected model. Loads /models once, derives
// the known-id and vision-id sets, and keeps the selection pointing at a real
// model: it's pre-filled by the open session, editable, and falls back to the
// first model when its value is stale (dropped from the backend) or unset.
export const useModels = () => {
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [knownModelIds, setKnown] = useState(new Set());
  const [visionModels, setVision] = useState(new Set());
  useEffect(() => {
    (async () => {
      try {
        const { data } = await api('/models');
        const list = data ?? [];
        setModels(list.map(modelId).filter(Boolean));
        const known = new Set();
        const vision = new Set();
        for (const m of list) {
          const id = modelId(m);
          if (!id) continue;
          known.add(id);
          if (isVisionModel(m)) vision.add(id);
        }
        setKnown(known);
        setVision(vision);
      } catch {}
    })();
  }, []);
  useEffect(() => { if (models.length && !models.includes(model)) setModel(models[0]); }, [models, model]);
  const isVisionCapable = (id) => !knownModelIds.has(id) || visionModels.has(id);
  return { models, model, setModel, isVisionCapable };
};

// The open session's live view + its SSE subscription. `view` is the detail
// object ({ id, cwd, model, status, last_error, messages, tokens, archived });
// `patch(p)` merges a partial in (no-op when nothing is open), `setView`
// replaces it wholesale (select), `clear` nulls it (delete). The SSE handlers
// call `refresh` (to bump list counts) and `onFlash` (on errors) — both passed
// in so this hook doesn't own those concerns.
export const useSessionView = (current, { refresh, onFlash }) => {
  const [view, setView] = useState(null);
  const patch = (p) => setView((v) => (v ? { ...v, ...p } : v));
  useEffect(() => {
    if (!current) return;
    return openSessionEvents(current, {
      snapshot: (snap) => patch({ messages: snap.messages, tokens: snap.total_tokens }),
      status: (s) => { patch({ status: s.status }); refresh(); },
      done: (d) => patch({ tokens: d.total_tokens }),
      error: (err) => { patch({ status: 'error' }); onFlash(err.message); refresh(); },
    });
  }, [current]);
  return { view, setView, patch, clear: () => setView(null) };
};

// Composer image attachments: the thumbnail list + the add/remove/set controls.
// `onFlash` surfaces read/validation errors. `set` is exposed so a failed send
// can roll back the optimistic clear.
export const useAttachments = (onFlash) => {
  const [attachments, set] = useState([]);
  const addFiles = async (fileList) => {
    const files = Array.from(fileList ?? []);
    if (!files.length) return;
    const valid = files.filter(isImageFile);
    if (!valid.length) { onFlash('no supported image in that'); return; }
    try {
      const items = await Promise.all(valid.map(async (f: any) => ({
        id: uid(),
        name: f.name || 'image',
        dataUrl: await fileToDataURL(f),
      })));
      set((prev) => [...prev, ...items]);
    } catch (err) { onFlash(`couldn't read image: ${err?.message ?? err}`); }
  };
  const removeAttachment = (id) => set((prev) => prev.filter((a) => a.id !== id));
  return { attachments, set, addFiles, removeAttachment };
};
