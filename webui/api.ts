// All client → server traffic (REST + SSE) lives here, apart from the Preact
// components. No DOM, no Preact, no JSX. Callers use the namespaced `api`
// object; path construction (and the only knowledge of the REST shape) stays
// in this file.

// JSON REST transport: throws Error(message) on a non-2xx body (message taken
// from the server's { error: { message } } shape when present; the error's
// `code` is attached too, for the rare caller that branches on it).
const request = async (path: string, opts: RequestInit = {}) => {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    let code;
    try { const e = (await r.json()).error; msg = e?.message ?? msg; code = e?.code; } catch {}
    throw Object.assign(new Error(msg), { code });
  }
  return r.status === 204 ? null : r.json();
};
const get = (path: string) => request(path);
const post = (path: string, body?: unknown) =>
  request(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const del = (path: string) => request(path, { method: 'DELETE' });

export const api = {
  config: {
    get: () => get('/config'),
  },
  models: {
    list: async () => (await get('/models')).data,
  },
  sessions: {
    list: ({ includeArchived }: { includeArchived?: boolean } = {}) =>
      get(`/sessions${includeArchived ? '?archived=1' : ''}`),
    get: (id: string) => get(`/sessions/${id}`),
    create: (args: { cwd: string; model: string; reasoning_effort?: string | null; create?: boolean }) =>
      post('/sessions', args),
    delete: (id: string) => del(`/sessions/${id}`),
    send: (id: string, args: { message: string | any[]; model: string; reasoning_effort?: string | null }) =>
      post(`/sessions/${id}/messages`, args),
    stop: (id: string) => post(`/sessions/${id}/stop`),
    retry: (id: string) => post(`/sessions/${id}/retry`),
    retryTurn: (id: string) => post(`/sessions/${id}/retry-turn`),
    undo: (id: string) => post(`/sessions/${id}/undo`),
    undoTurn: (id: string) => post(`/sessions/${id}/undo-turn`),
    clear: (id: string) => post(`/sessions/${id}/clear`),
    trim: (id: string, keep: number) => post(`/sessions/${id}/trim`, { keep }),
    compact: (id: string) => post(`/sessions/${id}/compact`),
    init: (id: string) => post(`/sessions/${id}/init`),
    archive: (id: string) => post(`/sessions/${id}/archive`),
    unarchive: (id: string) => post(`/sessions/${id}/unarchive`),
    fork: (id: string) => post(`/sessions/${id}/fork`),

    // Open the SSE stream for one session. `handlers` maps an event name
    // (message / history / status / done / error) to a callback that receives
    // the event's JSON-parsed `data`. EventSource auto-reconnects and re-sends
    // Last-Event-ID, so the server's replay ring (SPEC §7.5) covers brief
    // disconnects. A connection failure (a native `error` event with no data)
    // is ignored — only server `error` events (which carry a data payload)
    // reach the handler. Returns close() to detach.
    events: (id: string, handlers: Record<string, (data: any) => void>) => {
      const es = new EventSource(`/sessions/${id}/events`);
      for (const [name, fn] of Object.entries(handlers)) {
        es.addEventListener(name, (e) => {
          const me = e as MessageEvent;
          if (me.data) fn(JSON.parse(me.data));
        });
      }
      es.onerror = () => { /* EventSource auto-reconnects with Last-Event-ID */ };
      return () => es.close();
    },
  },
};
