#!/usr/bin/env node
import { config } from './config.js';
import { db } from './db.js';
import { SessionManager } from './manager.js';
import { buildApp } from './app.js';

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

const main = () => {
  const manager = new SessionManager();
  const app = buildApp({ manager });

  const server = app.listen(config.port, config.host, () => {
    log(`clown-circus listening on http://${config.host}:${config.port}`);
    log(`db: ${config.dbFile} | llm: ${config.baseUrl} | model: ${config.model}`);
    log(`sessions: ${manager.sessions.size}`);
  });

  let closing = false;
  const shutdown = (sig) => {
    if (closing) return;
    closing = true;
    log(`${sig} received, shutting down`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
};

main();
