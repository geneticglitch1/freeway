/** Small shared helpers. Nothing here knows about providers or HTTP. */

import { createHash } from 'node:crypto';

/**
 * The only sanctioned representation of a secret outside the gateway process.
 * Everything that touches a key — logs, `/api/*`, the dashboard, error strings —
 * routes through here, so there is exactly one place to audit.
 */
export function mask(secret: string): string {
  if (!secret) return '';
  // Below this length, showing head and tail would reveal most of the value.
  if (secret.length <= 6) return '…';
  if (secret.length <= 12) return `${secret.slice(0, 2)}…${secret.slice(-2)}`;
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

/**
 * Stable, non-reversible identifier for a secret.
 *
 * `mask()` is lossy on purpose — `fw-app-key` and `fw-other-key` both render as
 * `fw…ey`. That is fine for a dashboard and catastrophic as an authorization
 * principal, where a collision means two keys share each other's sessions and
 * rate-limit budget. Anything that identifies a caller uses this instead.
 */
export function fingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

export interface Interpolation {
  value: string;
  missing: string[];
}

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Resolve `${ENV_VAR}` references. This is what keeps a provider that embeds an
 * account id in its URL — Cloudflare — pure data instead of a code change.
 */
export function interpolate(input: string, env: Record<string, string | undefined>): Interpolation {
  const missing: string[] = [];
  const value = input.replace(ENV_PATTERN, (_match, name: string) => {
    const found = env[name];
    if (found === undefined || found === '') {
      if (!missing.includes(name)) missing.push(name);
      return '';
    }
    return found;
  });
  return { value, missing };
}

export function envRefs(input: string): string[] {
  const out: string[] = [];
  for (const m of input.matchAll(ENV_PATTERN)) {
    const name = m[1];
    if (name !== undefined && !out.includes(name)) out.push(name);
  }
  return out;
}

/** A single env var may hold several comma-separated keys — that is the pool. */
export function splitKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function joinUrl(base: string, path: string): string {
  if (!path) return base;
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Exponentially weighted moving average. Seeds on first sample. */
export function ewma(prev: number | null, sample: number, alpha = 0.2): number {
  if (prev === null || !Number.isFinite(prev)) return sample;
  return prev + alpha * (sample - prev);
}

export interface Logger {
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
}

export const consoleLogger: Logger = {
  info: (m, ...r) => console.log(`[freeway] ${m}`, ...r),
  warn: (m, ...r) => console.warn(`[freeway] ${m}`, ...r),
  error: (m, ...r) => console.error(`[freeway] ${m}`, ...r),
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
