import express from 'express';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import { HttpError, mapError } from './errors.ts';
import { config } from './config.ts';
import { llm, REASONING_EFFORTS } from './llm.ts';

const HEARTBEAT_MS = 15000;
const WEBUI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'webui');

// Build the Express app (all routes wired here).
export const buildApp = ({ manager }) => {
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.disable('x-powered-by');
  app.use(express.static(WEBUI_DIR)); // web UI at / (see WEB_UI.md)

  // A write that lands after the client is gone (a live `event`, the heartbeat,
  // or a destroyed session's wind-down) would throw ERR_STREAM_WRITE_AFTER_END;
  // inside an emitter listener or interval callback that throw is uncaught and
  // crashes the process, so skip it.
  const sseWrite = (res, str) => { if (res.writable && !res.writableEnded) res.write(str); };
  const sseFrame = (res, rec) =>
    sseWrite(res, `id: ${rec.seq}\nevent: ${rec.event}\ndata: ${JSON.stringify(rec.data)}\n\n`);

  // --- 7.1 Server / models --------------------------------------------------
  app.get('/health', (req, res) => res.json({ ok: true, sessions: manager.sessions.size }));

  app.get('/config', (req, res) =>
    res.json({
      base_url: config.baseUrl,
      db_file: config.dbFile,
      timeout_ms: config.timeoutMs,
      host: config.host,
      port: config.port,
    }));

  app.get('/models', async (req, res) => {
    res.json({ data: await llm.listModels() });
  });

  // `reasoning_effort` in a request body: absent → undefined (keep the
  // session's stored value), explicit null → unset, a known level → that
  // value; anything else → 400.
  const effortOf = (v) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v === 'string' && REASONING_EFFORTS.includes(v)) return v;
    throw new HttpError(400, 'bad_request', `reasoning_effort must be one of: ${REASONING_EFFORTS.join(', ')}`);
  };

  // --- 7.2 Sessions ---------------------------------------------------------
  app.get('/sessions', (req, res) => {
    const { cwd, archived } = req.query;
    if (cwd !== undefined && cwd === '') throw new HttpError(400, 'bad_request', 'cwd filter must not be empty');
    // Boolean flag: ?archived (true/1) → include archived sessions; absent or
    // "false"/"0" → non-archived only (the default). The web UI fetches with the
    // flag on and splits archived/non-archived client-side.
    const includeArchived = archived === 'true' || archived === '1';
    res.json(manager.list({ cwd, includeArchived }));
  });

  app.post('/sessions', (req, res) => {
    const body = req.body ?? {};
    const { cwd } = body;
    if (typeof cwd !== 'string' || cwd === '') throw new HttpError(400, 'bad_request', 'cwd is required');
    if (!isAbsolute(cwd)) throw new HttpError(400, 'bad_request', 'cwd must be an absolute path');
    let st;
    try {
      st = statSync(cwd);
    } catch {
      throw new HttpError(500, 'internal', `cwd path does not exist: ${cwd}`);
    }
    if (!st.isDirectory()) throw new HttpError(500, 'internal', `cwd is not a directory: ${cwd}`);

    const model = body.model;
    if (typeof model !== 'string' || model === '')
      throw new HttpError(400, 'bad_request', 'model is required');
    const s = manager.create({ cwd, model, reasoningEffort: effortOf(body.reasoning_effort) });
    res.status(201).json(s.detail());
  });

  app.get('/sessions/:id', (req, res) => res.json(manager.require(req.params.id).detail()));

  app.delete('/sessions/:id', (req, res) => {
    if (!manager.delete(req.params.id)) throw new HttpError(404, 'not_found', 'session not found');
    res.status(204).end();
  });

  // --- 7.3 Messages ---------------------------------------------------------
  app.post('/sessions/:id/messages', (req, res) => {
    const s = manager.require(req.params.id);
    const message = req.body?.message;
    const valid =
      (typeof message === 'string' && message !== '') ||
      (Array.isArray(message) && message.length > 0);
    if (!valid)
      throw new HttpError(400, 'bad_request', 'message must be a non-empty string or a non-empty ContentPart[]');
    const model = req.body?.model;
    if (typeof model !== 'string' || model === '')
      throw new HttpError(400, 'bad_request', 'model is required');
    s.send(message, model, effortOf(req.body?.reasoning_effort)); // throws 409 if busy
    res.status(202).json({ id: s.id, status: 'running' });
  });

  // --- 7.4 Controls ---------------------------------------------------------
  const session = (fn) => (req, res) => fn(manager.require(req.params.id), res);
  const started = (s) => ({ id: s.id, status: 'running' });
  const done = (s) => ({ id: s.id, status: s.status });

  app.post('/sessions/:id/stop', session((s, res) => {
    s.stop();
    res.json({ status: s.status });
  }));

  app.post('/sessions/:id/undo', session((s, res) => res.json({ undone: s.undo() })));

  app.post('/sessions/:id/retry', session((s, res) => {
    s.retry();
    res.status(202).json(started(s));
  }));

  app.post('/sessions/:id/retry-turn', session((s, res) => {
    s.retryTurn();
    res.status(202).json(started(s));
  }));

  app.post('/sessions/:id/clear', session((s, res) => {
    s.clear();
    res.json(done(s));
  }));

  app.post('/sessions/:id/trim', (req, res) => {
    const s = manager.require(req.params.id);
    const keep = Number(req.body?.keep);
    if (!Number.isInteger(keep) || keep < 0)
      throw new HttpError(400, 'bad_request', 'keep must be a non-negative integer');
    res.json(s.trim(keep));
  });

  app.post('/sessions/:id/compact', session((s, res) => {
    s.compact(); // throws 409 if busy; async work runs in background
    res.status(202).json(started(s));
  }));

  app.post('/sessions/:id/init', session((s, res) => {
    s.init();
    res.status(202).json(started(s));
  }));

  // Archive / unarchive: a metadata-only flag (allowed while running).
  // Archived sessions persist but are hidden from the default GET /sessions.
  app.post('/sessions/:id/archive', session((s, res) => {
    s.setArchived(true);
    res.json({ id: s.id, archived: true });
  }));

  app.post('/sessions/:id/unarchive', session((s, res) => {
    s.setArchived(false);
    res.json({ id: s.id, archived: false });
  }));

  // Fork the session: a new session with the same cwd/model and a deep copy of
  // the transcript (rolled back to the last user turn). Allowed while the
  // source is running — the copy is independent. Returns the new session.
  app.post('/sessions/:id/fork', (req, res) => {
    const s = manager.fork(req.params.id);
    res.status(201).json(s.detail());
  });

  // --- 7.5 Events (SSE) -----------------------------------------------------
  app.get('/sessions/:id/events', (req, res) => {
    const s = manager.require(req.params.id);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    sseWrite(res, 'retry: 3000\n\n');

    if (req.query.ping === 'true' || req.query.ping === '1') sseFrame(res, { seq: 0, event: 'pong', data: {} });

    // Replay only on resume (reconnect carries ?since / Last-Event-ID). A fresh
    // connection already has full state from GET /sessions/:id, so replaying the
    // ring buffer would resend the whole run history and make the UI re-render /
    // flicker its status through every past transition.
    const sinceRaw = req.query.since ?? req.headers['last-event-id'];
    if (sinceRaw !== undefined && sinceRaw !== '') {
      const since = Number(sinceRaw) || 0;
      const recs = s.eventsSince(since);
      if (recs[0]?.seq > since + 1) {
        // Gap: the ring no longer covers the client's backlog. Granular
        // `message` events can't be partially replayed without desyncing the
        // transcript, so send the full transcript once — a synthetic `history`
        // event at the current seq (the client replaces its state; everything
        // in the ring is already contained in it, so no ring replay follows).
        sseFrame(res, { seq: s.seq, event: 'history', data: { messages: s.messages } });
      } else {
        for (const rec of recs) sseFrame(res, rec);
      }
    }

    const onEvent = (rec) => sseFrame(res, rec);
    const onEnd = () => res.end();
    s.emitter.on('event', onEvent);
    s.emitter.on('end', onEnd);

    const hb = setInterval(() => sseWrite(res, ': keep-alive\n\n'), HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(hb);
      s.emitter.off('event', onEvent);
      s.emitter.off('end', onEnd);
      if (!res.writableEnded) res.end();
    });
  });

  // --- 404 + error handling -------------------------------------------------
  app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'not found' } }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const e = mapError(err);
    res.status(e.status).json({ error: { code: e.code, message: e.message } });
  });

  return app;
};
