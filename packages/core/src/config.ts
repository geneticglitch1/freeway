/**
 * Gateway configuration: `freeway.config.json`, overlaid with environment.
 *
 * Every field has a working default, so an empty config file is valid and a
 * missing one is not an error. Unknown keys are reported rather than ignored,
 * for the same reason provider specs report them.
 */

import { readFileSync } from 'node:fs';

import type { CacheConfig, ContextConfig, FreewayConfig, GuardConfig, Strategy } from './types.ts';
import { splitKeys } from './util.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const DEFAULT_CONFIG: FreewayConfig = {
  strategy: 'priority',
  maxAttempts: 3,
  cooldownSeconds: 60,
  timeoutMs: 60_000,
  streamTimeoutMs: 300_000,
  host: '127.0.0.1',
  port: 8787,
  keys: [],
  adminKey: null,
  corsOrigins: [],
  aliases: {},
  guard: {
    perKey: { rpm: null, tpm: null, rpd: null, concurrency: null },
    perIp: { rpm: null, concurrency: null },
    // Generous enough for a vision payload, small enough that a runaway client
    // cannot exhaust memory before the limiter sees it.
    maxBodyBytes: 8 * 1024 * 1024,
    maxMessages: 500,
    scan: { mode: 'flag', secrets: true, pii: true, injection: true },
    calibrate: true,
    keyHealthIntervalMs: 6 * HOUR,
  },
  context: {
    enabled: true,
    maxTurns: 12,
    reserveOutputTokens: 1024,
    compactModel: 'fast',
    autoCompactAt: 0.8,
  },
  cache: {
    mode: 'safe',
    ttlMs: 24 * HOUR,
    maxEntries: 5000,
    semantic: { enabled: false, threshold: 0.92, model: 'embed', maxEntries: 5000 },
  },
};

const STRATEGIES: readonly Strategy[] = ['priority', 'round-robin', 'least-used', 'fastest'];

export interface ConfigIssue {
  path: string;
  message: string;
}

export interface ConfigResult {
  config: FreewayConfig;
  issues: ConfigIssue[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge a partial override over a default, one level of nesting at a time. */
function mergeSection<T extends Record<string, unknown>>(base: T, over: unknown, path: string, issues: ConfigIssue[]): T {
  if (over === undefined || over === null) return base;
  if (!isRecord(over)) {
    issues.push({ path, message: `expected an object, got ${typeof over}` });
    return base;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (!(k in base)) {
      issues.push({ path: `${path}.${k}`, message: 'unknown option (ignored)' });
      continue;
    }
    const current = base[k];
    out[k] = isRecord(current) && isRecord(v) ? mergeSection(current as Record<string, unknown>, v, `${path}.${k}`, issues) : v;
  }
  return out as T;
}

export function parseConfig(raw: unknown, env: Record<string, string | undefined> = process.env): ConfigResult {
  const issues: ConfigIssue[] = [];
  const cfg: FreewayConfig = structuredClone(DEFAULT_CONFIG);

  if (raw !== undefined && raw !== null) {
    if (!isRecord(raw)) {
      issues.push({ path: '', message: `expected a JSON object, got ${typeof raw}` });
    } else {
      const known = new Set(Object.keys(DEFAULT_CONFIG));
      known.add('$schema');
      for (const k of Object.keys(raw)) {
        // JSON has no comments, so `"//note": [...]` is the conventional stand-in.
        if (k.startsWith('//')) continue;
        if (!known.has(k)) issues.push({ path: k, message: 'unknown option (ignored)' });
      }

      if (typeof raw['strategy'] === 'string') {
        if ((STRATEGIES as readonly string[]).includes(raw['strategy'])) cfg.strategy = raw['strategy'] as Strategy;
        else issues.push({ path: 'strategy', message: `must be one of ${STRATEGIES.join(' | ')}` });
      }
      cfg.maxAttempts = posInt(raw['maxAttempts'], 'maxAttempts', cfg.maxAttempts, issues);
      cfg.cooldownSeconds = posInt(raw['cooldownSeconds'], 'cooldownSeconds', cfg.cooldownSeconds, issues);
      cfg.timeoutMs = posInt(raw['timeoutMs'], 'timeoutMs', cfg.timeoutMs, issues);
      cfg.streamTimeoutMs = posInt(raw['streamTimeoutMs'], 'streamTimeoutMs', cfg.streamTimeoutMs, issues);
      cfg.port = posInt(raw['port'], 'port', cfg.port, issues);
      if (typeof raw['host'] === 'string') cfg.host = raw['host'];
      if (typeof raw['adminKey'] === 'string') cfg.adminKey = raw['adminKey'];

      if (Array.isArray(raw['corsOrigins'])) {
        for (const o of raw['corsOrigins']) {
          if (typeof o !== 'string') continue;
          // A wildcard here would defeat the point of having the list.
          if (o === '*') issues.push({ path: 'corsOrigins', message: 'refusing "*" — list the exact origins that may call this gateway' });
          else cfg.corsOrigins.push(o);
        }
      }

      if (Array.isArray(raw['keys'])) {
        cfg.keys = raw['keys'].filter((k): k is string => typeof k === 'string');
      } else if (raw['keys'] !== undefined) {
        issues.push({ path: 'keys', message: 'expected an array of strings' });
      }

      if (isRecord(raw['aliases'])) {
        for (const [k, v] of Object.entries(raw['aliases'])) {
          if (typeof v === 'string') cfg.aliases[k] = v;
          else issues.push({ path: `aliases.${k}`, message: 'expected a string' });
        }
      }

      cfg.guard = mergeSection(cfg.guard as unknown as Record<string, unknown>, raw['guard'], 'guard', issues) as unknown as GuardConfig;
      cfg.context = mergeSection(cfg.context as unknown as Record<string, unknown>, raw['context'], 'context', issues) as unknown as ContextConfig;
      cfg.cache = mergeSection(cfg.cache as unknown as Record<string, unknown>, raw['cache'], 'cache', issues) as unknown as CacheConfig;
    }
  }

  // Environment wins over the file, so a container can be reconfigured without
  // rebuilding the image or editing a mounted file.
  const envPort = env['PORT'] ?? env['FREEWAY_PORT'];
  if (envPort) cfg.port = Number(envPort) || cfg.port;
  const envHost = env['HOST'] ?? env['FREEWAY_HOST'];
  if (envHost) cfg.host = envHost;
  const envKeys = splitKeys(env['FREEWAY_KEYS']);
  if (envKeys.length > 0) cfg.keys = envKeys;
  if (env['FREEWAY_ADMIN_KEY']) cfg.adminKey = env['FREEWAY_ADMIN_KEY'];
  const envCors = splitKeys(env['FREEWAY_CORS_ORIGINS']);
  if (envCors.length > 0) cfg.corsOrigins = envCors.filter((o) => o !== '*');
  if (env['FREEWAY_STRATEGY'] && (STRATEGIES as readonly string[]).includes(env['FREEWAY_STRATEGY'])) {
    cfg.strategy = env['FREEWAY_STRATEGY'] as Strategy;
  }

  return { config: cfg, issues };
}

export function loadConfig(path: string, env: Record<string, string | undefined> = process.env): ConfigResult {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    // A missing config file is normal — every option has a default.
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    const result = parseConfig(undefined, env);
    if (!missing) {
      result.issues.push({ path: '', message: `could not read ${path}: ${err instanceof Error ? err.message : String(err)}` });
    }
    return result;
  }
  return parseConfig(raw, env);
}

function posInt(v: unknown, path: string, fallback: number, issues: ConfigIssue[]): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    issues.push({ path, message: `expected a positive number, got ${JSON.stringify(v)}` });
    return fallback;
  }
  return v;
}
