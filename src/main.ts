#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watch } from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
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

  // Build webui/styles.css → vendor/tailwind.css (index.html just links it).
  // The CLI scans *source files* for class candidates — unlike the old
  // in-browser JIT, utilities on conditionally rendered elements are always
  // emitted, so there's no runtime DOM guessing.
  // The CLI's bin is dist/index.mjs (only ./package.json is in its exports map).
  const cssCli = join(dirname(createRequire(import.meta.url).resolve('@tailwindcss/cli/package.json')), 'dist', 'index.mjs');
  const buildCss = () => new Promise<void>((resolve, reject) =>
    execFile(process.execPath, [cssCli, '-i', join(WEBUI_DIR, 'styles.css'), '-o', join(WEBUI_DIR, 'vendor', 'tailwind.css')],
      (err) => err ? reject(err) : resolve()));
  await buildCss(); // blocks startup until the stylesheet is on disk
  // Keep it fresh: any webui/ edit (a class string in a .tsx, a utility in
  // index.html, styles.css itself) rebuilds it. `vendor/` is our own output —
  // watching it would loop (each rebuild rewrites it and re-fires the watch).
  let cssTimer;
  watch(WEBUI_DIR, { recursive: true }, (evt, file) => {
    if (!file || String(file).startsWith('vendor')) return;
    clearTimeout(cssTimer);
    cssTimer = setTimeout(() => buildCss().catch((e) => log(`css rebuild failed: ${e.message}`)), 150);
  });

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
