import { homedir } from 'node:os';
import { resolve } from 'node:path';

// Parse `--flag value` and `--flag=value` pairs out of process.argv.
const parseFlags = (argv) => {
  const flags = {};
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
// Bool flag with a `--no-` counterpart. Precedence: --no-X > --X > env > default.
// A bare `--X` is true, `--X=false` is false; `--no-X` mirrors that.
const bool = (f, name, env, dflt) => {
  const pick = (v) => (typeof v === 'string' ? v.toLowerCase() !== 'false' : true);
  if (f[`no-${name}`] !== undefined) return !pick(f[`no-${name}`]);
  if (f[name] !== undefined) return pick(f[name]);
  if (env !== undefined) return env.toLowerCase() !== 'false';
  return dflt;
};

// Resolve config from CLI flags with env fallbacks, then defaults.
const loadConfig = (argv = process.argv) => {
  const f = parseFlags(argv);
  const env = process.env;

  const dbFile = resolve(str(f['db-file'], env.DB_FILE ?? `${homedir()}/.clowndb`));

  const cfg = {
    port: num(f.port, env.PORT ?? 8790),
    host: str(f.host, env.HOST ?? '127.0.0.1'),
    dbFile,
    baseUrl: str(f['base-url'], env.CLOWN_API ?? 'http://127.0.0.1:8080').replace(/\/+$/, ''),
    apiKey: env.CLOWN_API_KEY ?? null,
    timeoutMs: num(f.timeout, env.CLOWN_TIMEOUT_MS ?? 900000),
    verbose: f.verbose === true || str(f.verbose, '') === 'true',
    autoTruncate: bool(f, 'trunc', env.CLOWN_TRUNC, true),
    truncateGap: num(f['truncate-gap'], env.CLOWN_TRUNC_GAP ?? 100000),
    truncateBytes: num(f['truncate-bytes'], env.CLOWN_TRUNC_BYTES ?? 256),
  };
  // Print what was actually loaded (flag > env > default) — apiKey masked.
  console.log(`[${new Date().toISOString()}] config: ${JSON.stringify({ ...cfg, apiKey: cfg.apiKey ? '***' : null })}`);
  return cfg;
};

// One config for the whole process — resolved from CLI flags/env/defaults at import time.
export const config = loadConfig();
