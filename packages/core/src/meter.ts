/**
 * Usage metering against free-tier ceilings.
 *
 * Memory is flat regardless of traffic: every window is a fixed ring of numeric
 * buckets, never a list of events. A gateway left running for a month must not
 * grow, so nothing here accumulates per-request state.
 *
 * The meter deliberately does not own the limits it checks against. Limits are
 * passed in on every call, which is what lets the guard layer swap in values
 * learned from upstream rate-limit headers without touching this file.
 */

import {
  LIMIT_DEFS,
  type LimitDef,
  type LimitKey,
  type LimitSpec,
  type MeterBar,
  type MeterCheck,
  type MeterSnapshot,
  type ModelSpec,
  type Period,
} from './types.ts';

export type Clock = () => number;

// ---------------------------------------------------------------------------
// Rolling window: a ring of buckets summed over the trailing window
// ---------------------------------------------------------------------------

/**
 * Bucket granularity is `windowMs / slots`, so a 60s window with 60 slots
 * resolves to one second. A stale slot is recognised by its stamp rather than
 * being cleared on a timer — that keeps writes O(1) and needs no background work.
 */
class RollingWindow {
  readonly windowMs: number;
  readonly slots: number;
  private readonly counts: Float64Array;
  private readonly stamps: Float64Array;
  private readonly bucketMs: number;

  constructor(windowMs: number, slots: number) {
    this.windowMs = windowMs;
    this.slots = slots;
    this.counts = new Float64Array(slots);
    // -1 marks "never written"; real bucket indices are non-negative.
    this.stamps = new Float64Array(slots).fill(-1);
    this.bucketMs = windowMs / slots;
  }

  private bucketIndex(now: number): number {
    return Math.floor(now / this.bucketMs);
  }

  add(now: number, n: number): void {
    if (n === 0) return;
    const idx = this.bucketIndex(now);
    const slot = idx % this.slots;
    if ((this.stamps[slot] ?? -1) !== idx) {
      this.stamps[slot] = idx;
      this.counts[slot] = 0;
    }
    this.counts[slot] = (this.counts[slot] ?? 0) + n;
  }

  sum(now: number): number {
    const idx = this.bucketIndex(now);
    const oldest = idx - this.slots + 1;
    let total = 0;
    for (let i = 0; i < this.slots; i++) {
      if ((this.stamps[i] ?? -1) >= oldest) total += this.counts[i] ?? 0;
    }
    return total;
  }

  /**
   * When the oldest counted bucket falls out of the window — i.e. the soonest
   * moment this window frees up any room at all.
   */
  freesAt(now: number): number | null {
    const idx = this.bucketIndex(now);
    const oldest = idx - this.slots + 1;
    let earliest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.slots; i++) {
      const stamp = this.stamps[i] ?? -1;
      if (stamp >= oldest && (this.counts[i] ?? 0) > 0 && stamp < earliest) earliest = stamp;
    }
    if (earliest === Number.POSITIVE_INFINITY) return null;
    return (earliest + this.slots) * this.bucketMs;
  }

  snapshot(): { slots: number[]; stamps: number[] } {
    return { slots: Array.from(this.counts), stamps: Array.from(this.stamps) };
  }

  restore(s: { slots: number[]; stamps: number[] }): void {
    for (let i = 0; i < this.slots; i++) {
      this.counts[i] = s.slots[i] ?? 0;
      this.stamps[i] = s.stamps[i] ?? -1;
    }
  }
}

// ---------------------------------------------------------------------------
// Calendar window: snaps to a UTC boundary
// ---------------------------------------------------------------------------

function periodKey(now: number, period: Period): string {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  if (period === 'month') return `${y}-${m}`;
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function periodResetsAt(now: number, period: Period): number {
  const d = new Date(now);
  if (period === 'month') {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

class CalendarWindow {
  readonly period: Period;
  private key = '';
  private count = 0;

  constructor(period: Period) {
    this.period = period;
  }

  private roll(now: number): void {
    const k = periodKey(now, this.period);
    if (k !== this.key) {
      this.key = k;
      this.count = 0;
    }
  }

  add(now: number, n: number): void {
    this.roll(now);
    this.count += n;
  }

  sum(now: number): number {
    this.roll(now);
    return this.count;
  }

  resetsAt(now: number): number {
    return periodResetsAt(now, this.period);
  }

  snapshot(): { period: string; count: number } {
    return { period: this.key, count: this.count };
  }

  restore(s: { period: string; count: number }): void {
    this.key = s.period;
    this.count = s.count;
  }
}

// ---------------------------------------------------------------------------
// Meter
// ---------------------------------------------------------------------------

/** What a single request consumes. Tokens arrive late for streams. */
export interface Usage {
  requests?: number;
  tokens?: number;
  credits?: number;
}

export class Meter {
  private readonly rolling = new Map<LimitKey, RollingWindow>();
  private readonly calendar = new Map<LimitKey, CalendarWindow>();
  private readonly now: Clock;

  constructor(now: Clock = Date.now) {
    this.now = now;
    for (const def of LIMIT_DEFS) {
      if (def.kind === 'rolling') this.rolling.set(def.key, new RollingWindow(def.windowMs, def.slots));
      else this.calendar.set(def.key, new CalendarWindow(def.period));
    }
  }

  private current(def: LimitDef, now: number): number {
    if (def.kind === 'rolling') return this.rolling.get(def.key)?.sum(now) ?? 0;
    return this.calendar.get(def.key)?.sum(now) ?? 0;
  }

  private amountFor(def: LimitDef, u: Usage): number {
    if (def.family === 'req') return u.requests ?? 0;
    if (def.family === 'tok') return u.tokens ?? 0;
    return u.credits ?? 0;
  }

  /**
   * Would one more request fit? Conservative by design: failing over to another
   * free provider costs nothing, whereas eating a 429 burns the quota *and*
   * usually earns a cooldown.
   */
  check(limits: LimitSpec, estTokens = 0): MeterCheck {
    const now = this.now();
    const projected: Usage = {
      requests: 1,
      tokens: estTokens,
      credits: limits.creditsPerRequest ?? 0,
    };

    let worst: { key: LimitKey; retryAfterMs: number; reason: string } | null = null;

    for (const def of LIMIT_DEFS) {
      const limit = limits[def.key];
      if (limit === null || limit === undefined) continue;

      const used = this.current(def, now);
      const want = this.amountFor(def, projected);
      if (used + want <= limit) continue;

      const retryAfterMs = this.retryAfterFor(def, now);
      const reason = `${def.key} limit reached (${fmt(used)}/${fmt(limit)} ${def.label})`;
      if (worst === null || retryAfterMs > worst.retryAfterMs) {
        worst = { key: def.key, retryAfterMs, reason };
      }
    }

    if (worst === null) return { ok: true, blockedBy: null, retryAfterMs: null, reason: null };
    return { ok: false, blockedBy: worst.key, retryAfterMs: worst.retryAfterMs, reason: worst.reason };
  }

  private retryAfterFor(def: LimitDef, now: number): number {
    if (def.kind === 'calendar') {
      const w = this.calendar.get(def.key);
      return w ? Math.max(0, w.resetsAt(now) - now) : def.windowMs;
    }
    const w = this.rolling.get(def.key);
    const at = w?.freesAt(now) ?? null;
    return at === null ? def.windowMs : Math.max(0, at - now);
  }

  /** Record a completed request. */
  record(usage: Usage): void {
    const now = this.now();
    for (const def of LIMIT_DEFS) {
      const amount = this.amountFor(def, usage);
      if (amount === 0) continue;
      if (def.kind === 'rolling') this.rolling.get(def.key)?.add(now, amount);
      else this.calendar.get(def.key)?.add(now, amount);
    }
  }

  /**
   * Add tokens after the fact. Streamed responses only report usage in the very
   * last chunk, long after the request itself was recorded.
   */
  addTokens(n: number): void {
    if (n <= 0) return;
    this.record({ tokens: n });
  }

  addCredits(n: number): void {
    if (n <= 0) return;
    this.record({ credits: n });
  }

  /** Dashboard-facing view. Only limits the provider actually declares appear. */
  bars(limits: LimitSpec): MeterBar[] {
    const now = this.now();
    const out: MeterBar[] = [];
    for (const def of LIMIT_DEFS) {
      const limit = limits[def.key];
      if (limit === null || limit === undefined || limit <= 0) continue;
      const used = this.current(def, now);
      out.push({
        key: def.key,
        used,
        limit,
        pct: Math.min(100, Math.max(0, (used / limit) * 100)),
        window: def.label,
        resetsAt: def.kind === 'calendar' ? (this.calendar.get(def.key)?.resetsAt(now) ?? null) : null,
      });
    }
    return out;
  }

  /** Raw counter read, for the forecaster in the guard layer. */
  used(key: LimitKey): number {
    const def = LIMIT_DEFS.find((d) => d.key === key);
    if (!def) return 0;
    return this.current(def, this.now());
  }

  snapshot(): MeterSnapshot {
    const rolling: MeterSnapshot['rolling'] = {};
    for (const [k, w] of this.rolling) rolling[k] = w.snapshot();
    const calendar: MeterSnapshot['calendar'] = {};
    for (const [k, w] of this.calendar) calendar[k] = w.snapshot();
    return { rolling, calendar };
  }

  /**
   * Restore persisted counters. Daily and monthly counters that silently reset
   * on restart are how a free-tier quota gets blown, so this is load-bearing.
   */
  restore(snap: MeterSnapshot): void {
    for (const [k, w] of this.rolling) {
      const s = snap.rolling[k];
      if (s) w.restore(s);
    }
    for (const [k, w] of this.calendar) {
      const s = snap.calendar[k];
      if (s) w.restore(s);
    }
  }
}

/**
 * What one call costs in a provider's abstract credit unit.
 *
 * Prefers per-model rates because they differ enormously between models — see
 * the note on `CreditCost`. Falls back to the provider's flat per-request
 * estimate, and to zero when the provider is not credit-metered at all.
 */
export function creditsFor(
  model: Pick<ModelSpec, 'credits'>,
  limits: LimitSpec,
  tokensIn: number,
  tokensOut: number,
): number {
  const c = model.credits;
  if (c && (c.perMTokIn !== null || c.perMTokOut !== null)) {
    const inCost = ((c.perMTokIn ?? 0) * tokensIn) / 1_000_000;
    const outCost = ((c.perMTokOut ?? 0) * tokensOut) / 1_000_000;
    return inCost + outCost;
  }
  return limits.creditsPerRequest ?? 0;
}

function fmt(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}
