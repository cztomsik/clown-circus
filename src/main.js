#!/usr/bin/env node
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createLlm } from './llm.js';
import { buildTools, toolSchemas } from './tools.js';
import { SessionManager } from './manager.js';
import { buildApp } from './app.js';

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

const main = () => {
  const config = loadConfig();
  const db = openDb(config.dbFile);
  const llm = createLlm(config);
  const tools = buildTools();
  const manager = new SessionManager({ db, config, llm, tools, toolSchemas: toolSchemas(tools) });
  const app = buildApp({ manager, config, llm });

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
