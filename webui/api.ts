// All client → server traffic (REST + SSE) lives here, apart from the Preact
// components. No DOM, no Preact, no JSX.

// JSON REST helper: throws Error(message) on a non-2xx body (message taken from
// the server's { error: { message } } shape when present).
export const api = async (path: string, opts: RequestInit = {}) => {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { msg = (await r.json()).error?.message ?? msg; } catch {}
    throw new Error(msg);
  }
  return r.status === 204 ? null : r.json();
};

export const post = (path: string, body?: unknown) => api(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

// Open the SSE stream for one session. `handlers` maps an event name
// (snapshot / status / done / error) to a callback that receives the
// event's JSON-parsed `data`. EventSource auto-reconnects and re-sends
// Last-Event-ID, so the server's replay ring (SPEC §7.6) covers brief
// disconnects. A connection failure (a native `error` event with no data) is
// ignored — only server `error` events (which carry a data payload) reach the
// handler. Returns close() to detach.
export const openSessionEvents = (id: string, handlers: Record<string, (data: any) => void>) => {
  const es = new EventSource(`/sessions/${id}/events`);
  for (const [name, fn] of Object.entries(handlers)) {
    es.addEventListener(name, (e) => {
      const me = e as MessageEvent;
      if (me.data) fn(JSON.parse(me.data));
    });
  }
  es.onerror = () => { /* EventSource auto-reconnects with Last-Event-ID */ };
  return () => es.close();
};
