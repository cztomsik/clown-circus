#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { config } from './config.ts';
import { db } from './db.ts';
import { SessionManager } from './manager.ts';
import { buildApp } from './app.ts';

const WEBUI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'webui');

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

const main = async () => {
  // Bundle the web UI (entry webui/app.tsx, node_modules deps inlined) into one
  // file at /vendor/bundle.js. Preact JSX (automatic runtime → preact/jsx-runtime).
  // Blocking build at startup, then a background watch keeps it fresh while the
  // server runs.
  const webuiCtx = await esbuild.context({
    entryPoints: [join(WEBUI_DIR, 'app.tsx')],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    outfile: join(WEBUI_DIR, 'vendor', 'bundle.js'),
  });
  await webuiCtx.rebuild(); // blocks startup until the first bundle is on disk
  webuiCtx.watch(); // no await — rebuilds on webui/*.{js,tsx} changes in the background

  const manager = new SessionManager();
  const app = buildApp({ manager });

  const server = app.listen(config.port, config.host, () => {
    log(`clown-circus listening on http://${config.host}:${config.port}`);
    log(`db: ${config.dbFile} | llm: ${config.baseUrl}`);
    log(`sessions: ${manager.sessions.size}`);
  });

  let closing = false;
  const shutdown = (sig) => {
    if (closing) return;
    closing = true;
    log(`${sig} received, shutting down`);
    server.close(() => {
      webuiCtx.dispose();
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
};

main();
