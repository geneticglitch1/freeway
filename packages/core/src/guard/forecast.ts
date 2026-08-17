/**
 * Quota forecasting: when does each provider run dry at the current burn rate?
 *
 * The dashboard already shows a bar at 40%. What it cannot show is whether that
 * 40% took all day or the last four minutes — and those are completely
 * different situations. This turns a level into a trajectory.
 */

import { LIMIT_DEFS, type LimitKey, type LimitSpec, type MeterBar } from '../types.ts';

export type ForecastLevel = 'ok' | 'warn' | 'critical' | 'exhausted';

export interface Forecast {
  key: LimitKey;
  used: number;
  limit: number;
  pct: number;
  window: string;
  /** Units per hour, from usage so far in the window. */
  burnPerHour: number;
  /** Estimated ms until the limit is hit. `null` when burn is zero or it resets first. */
  exhaustsInMs: number | null;
  /** For calendar windows: does it reset before it would run out? */
  resetsFirst: boolean;
  level: ForecastLevel;
  message: string;
}

export interface ProviderForecast {
  providerId: string;
  level: ForecastLevel;
  forecasts: Forecast[];
  /** The single most urgent line, for a one-glance alert. */
  headline: string | null;
}

/**
 * How far into the current window we are, which is what turns "used 400" into a
 * rate. Rolling windows are always fully elapsed by definition; calendar
 * windows need the wall clock.
 */
function elapsedMs(key: LimitKey, now: number): number {
  const def = LIMIT_DEFS.find((d) => d.key === key);
  if (!def) return 0;
  if (def.kind === 'rolling') return def.windowMs;

  const d = new Date(now);
  if (def.period === 'month') {
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    return Math.max(1, now - start);
  }
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.max(1, now - start);
}

function levelFor(pct: number, exhaustsInMs: number | null): ForecastLevel {
  if (pct >= 100) return 'exhausted';
  // An hour of headroom is the point at which it is worth telling someone.
  if (exhaustsInMs !== null && exhaustsInMs < 3_600_000) return 'critical';
  if (pct >= 85) return 'critical';
  if (pct >= 60) return 'warn';
  if (exhaustsInMs !== null && exhaustsInMs < 6 * 3_600_000) return 'warn';
  return 'ok';
}

export function forecastBars(bars: MeterBar[], now: number = Date.now()): Forecast[] {
  const out: Forecast[] = [];

  for (const bar of bars) {
    const def = LIMIT_DEFS.find((d) => d.key === bar.key);
    const elapsed = elapsedMs(bar.key, now);
    const burnPerHour = elapsed > 0 ? (bar.used / elapsed) * 3_600_000 : 0;
    const remaining = Math.max(0, bar.limit - bar.used);

    let exhaustsInMs: number | null = null;
    // Only calendar windows can genuinely run out. A rolling window refills
    // continuously, so "exhausted in 26s" is technically true and practically
    // useless — at any meaningful fill it would shout critical forever. Level
    // there comes from the fill alone.
    if (def?.kind === 'calendar' && burnPerHour > 0 && remaining > 0) {
      exhaustsInMs = (remaining / burnPerHour) * 3_600_000;
    }

    // A calendar window that resets before it would run out is not a problem.
    const msToReset = bar.resetsAt !== null ? Math.max(0, bar.resetsAt - now) : null;
    const resetsFirst = msToReset !== null && exhaustsInMs !== null && msToReset < exhaustsInMs;
    if (resetsFirst) exhaustsInMs = null;

    const pct = bar.limit > 0 ? (bar.used / bar.limit) * 100 : 0;
    const level = levelFor(pct, exhaustsInMs);

    out.push({
      key: bar.key,
      used: bar.used,
      limit: bar.limit,
      pct,
      window: bar.window,
      burnPerHour,
      exhaustsInMs,
      resetsFirst,
      level,
      message: describe(bar.key, pct, exhaustsInMs, resetsFirst, msToReset),
    });
  }

  return out;
}

function describe(key: LimitKey, pct: number, exhaustsInMs: number | null, resetsFirst: boolean, msToReset: number | null): string {
  if (pct >= 100) {
    return msToReset !== null ? `${key} exhausted — resets in ${humanise(msToReset)}` : `${key} exhausted`;
  }
  if (exhaustsInMs !== null) return `${key} exhausted in ~${humanise(exhaustsInMs)} at current burn`;
  if (resetsFirst && msToReset !== null) return `${key} at ${pct.toFixed(0)}% — resets in ${humanise(msToReset)} before it runs out`;
  if (pct === 0) return `${key} unused`;
  return `${key} at ${pct.toFixed(0)}%, burn too low to project`;
}

export function forecastProvider(providerId: string, bars: MeterBar[], now: number = Date.now()): ProviderForecast {
  const forecasts = forecastBars(bars, now);
  const rank: Record<ForecastLevel, number> = { ok: 0, warn: 1, critical: 2, exhausted: 3 };

  let worst: Forecast | null = null;
  for (const f of forecasts) {
    if (worst === null || rank[f.level] > rank[worst.level]) worst = f;
    else if (rank[f.level] === rank[worst.level] && (f.exhaustsInMs ?? Infinity) < (worst.exhaustsInMs ?? Infinity)) worst = f;
  }

  return {
    providerId,
    level: worst?.level ?? 'ok',
    forecasts,
    headline: worst && worst.level !== 'ok' ? `${providerId}: ${worst.message}` : null,
  };
}

export function humanise(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

/** Merge observed limits over declared ones. Observed is reality; declared is a claim. */
export function applyObserved(declared: LimitSpec, observed: Partial<LimitSpec>): LimitSpec {
  const out: LimitSpec = { ...declared };
  for (const [k, v] of Object.entries(observed)) {
    if (typeof v === 'number' && v > 0) out[k as keyof LimitSpec] = v;
  }
  return out;
}
