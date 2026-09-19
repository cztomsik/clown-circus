import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, renameSync } from 'node:fs';

// Parse `--flag value` and `--flag=value` pairs out of process.argv.
const parseFlags = (argv) => {
  const flags: Record<string, any> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      flags[a.slice(2)] = argv[++i];
    } else {
      flags[a.slice(2)] = true;
    }
  }
  return flags;
};

const num = (v, dflt) => (v === undefined || v === '' || v === true ? dflt : Number(v));
const str = (v, dflt) => (v === undefined || v === true ? dflt : String(v));

// Resolve config from CLI flags with env fallbacks, then defaults.
const loadConfig = (argv = process.argv) => {
  const f = parseFlags(argv);
  const env = process.env;

  // The home dir holds the db and the built-in skills; created if missing.
  const home = resolve(str(f.home, env.CLOWN_HOME ?? `${homedir()}/.clown`));
  const homeExplicit = f.home !== undefined || env.CLOWN_HOME !== undefined;
  mkdirSync(home, { recursive: true });
  const dbFile = join(home, 'clown.db');

  // One-time legacy migration: with the default home only, move the old
  // ~/.clowndb in — never overwriting an existing clown.db.
  const legacy = `${homedir()}/.clowndb`;
  if (!homeExplicit && !existsSync(dbFile) && existsSync(legacy)) {
    try {
      renameSync(legacy, dbFile);
      console.log(`[${new Date().toISOString()}] moved legacy ${legacy} -> ${dbFile}`);
    } catch (e) {
      console.warn(`[${new Date().toISOString()}] could not move legacy ${legacy}: ${e.message}`);
    }
  }

  const cfg = {
    port: num(f.port, env.PORT ?? 8790),
    host: str(f.host, env.HOST ?? '127.0.0.1'),
    home,
    dbFile,
    baseUrl: str(f['base-url'], env.CLOWN_API ?? 'http://127.0.0.1:8080').replace(/\/+$/, ''),
    apiKey: env.CLOWN_API_KEY ?? null,
    timeoutMs: num(f.timeout, env.CLOWN_TIMEOUT_MS ?? 900000),
    verbose: f.verbose === true || str(f.verbose, '') === 'true',
  };
  // Print what was actually loaded (flag > env > default) — apiKey masked.
  console.log(`[${new Date().toISOString()}] config: ${JSON.stringify({ ...cfg, apiKey: cfg.apiKey ? '***' : null })}`);
  return cfg;
};

// One config for the whole process — resolved from CLI flags/env/defaults at import time.
export const config = loadConfig();
