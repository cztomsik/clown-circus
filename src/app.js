import express from 'express';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import { HttpError, mapError } from './errors.js';

const HEARTBEAT_MS = 15000;
const WEBUI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'webui');

// Build the Express app (all routes wired here).
export const buildApp = ({ manager, config, llm }) => {
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.disable('x-powered-by');
  app.use(express.static(WEBUI_DIR)); // web UI at / (see WEB_UI.md)

  const sseFrame = (res, rec) =>
    res.write(`id: ${rec.seq}\nevent: ${rec.event}\ndata: ${JSON.stringify(rec.data)}\n\n`);

  // --- 7.1 Server / models --------------------------------------------------
  app.get('/health', (req, res) => res.json({ ok: true, sessions: manager.sessions.size }));

  app.get('/config', (req, res) =>
    res.json({
      base_url: config.baseUrl,
      db_file: config.dbFile,
      default_model: config.model,
      timeout_ms: config.timeoutMs,
      max_sessions: config.maxSessions,
      host: config.host,
      port: config.port,
      auto_truncate: config.autoTruncate,
      truncate_gap: config.truncateGap,
      truncate_bytes: config.truncateBytes,
    }));

  app.get('/models', async (req, res) => {
    res.json({ data: await llm.listModels() });
  });

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
    const abs = resolve(process.cwd(), cwd);
    let st;
    try {
      st = statSync(abs);
    } catch {
      throw new HttpError(500, 'internal', `cwd path does not exist: ${abs}`);
    }
    if (!st.isDirectory()) throw new HttpError(500, 'internal', `cwd is not a directory: ${abs}`);

    const s = manager.create({ cwd: abs, model: body.model });
    res.status(201).json(s.detail());
  });

  app.get('/sessions/:id', (req, res) => res.json(manager.require(req.params.id).detail()));

  app.delete('/sessions/:id', (req, res) => {
    if (!manager.delete(req.params.id)) throw new HttpError(404, 'not_found', 'session not found');
    res.status(204).end();
  });

  // --- 7.3 Projects ---------------------------------------------------------
  app.get('/projects', (req, res) => res.json(manager.projects()));

  // --- 7.4 Messages ---------------------------------------------------------
  app.post('/sessions/:id/messages', (req, res) => {
    const s = manager.require(req.params.id);
    const message = req.body?.message;
    const valid =
      (typeof message === 'string' && message !== '') ||
      (Array.isArray(message) && message.length > 0);
    if (!valid)
      throw new HttpError(400, 'bad_request', 'message must be a non-empty string or a non-empty ContentPart[]');
    s.send(message); // throws 409 if busy
    res.status(202).json({ id: s.id, status: 'running' });
  });

  // --- 7.5 Controls ---------------------------------------------------------
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

  app.post('/sessions/:id/clear', session((s, res) => {
    s.clear();
    res.json(done(s));
  }));

  app.post('/sessions/:id/clear-tools', session((s, res) => {
    s.clearTools();
    res.json(done(s));
  }));

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

  // Set the session's model. Allowed while running (takes effect next turn).
  app.post('/sessions/:id/model', (req, res) => {
    const s = manager.require(req.params.id);
    const model = req.body?.model;
    if (typeof model !== 'string' || model === '')
      throw new HttpError(400, 'bad_request', 'model is required');
    s.setModel(model);
    res.json({ id: s.id, model: s.model });
  });

  // --- 7.6 Events (SSE) -----------------------------------------------------
  app.get('/sessions/:id/events', (req, res) => {
    const s = manager.require(req.params.id);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    if (req.query.ping === 'true' || req.query.ping === '1') sseFrame(res, { seq: 0, event: 'pong', data: {} });

    // Replay only on resume (reconnect carries ?since / Last-Event-ID). A fresh
    // connection already has full state from GET /sessions/:id, so replaying the
    // ring buffer would resend the whole run history and make the UI re-render /
    // flicker its status through every past transition.
    const sinceRaw = req.query.since ?? req.headers['last-event-id'];
    if (sinceRaw !== undefined && sinceRaw !== '') {
      const since = Number(sinceRaw) || 0;
      for (const rec of s.eventsSince(since)) sseFrame(res, rec);
    }

    const onEvent = (rec) => sseFrame(res, rec);
    const onEnd = () => res.end();
    s.emitter.on('event', onEvent);
    s.emitter.on('end', onEnd);

    const hb = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS);
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
