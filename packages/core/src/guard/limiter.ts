/**
 * Inbound abuse protection: limits on what *callers* may spend, as opposed to
 * the meter, which tracks what providers will allow.
 *
 * Without this, one runaway loop in one of your own apps drains every free tier
 * you have in a couple of minutes, and the first you know about it is a
 * dashboard full of red. Buckets are the same flat rings the provider meter
 * uses, so a thousand distinct callers cost a few kilobytes.
 */

import { Meter, type Clock } from '../meter.ts';
import { EMPTY_LIMITS, type GuardConfig, type LimitSpec } from '../types.ts';

export interface LimitDecision {
  ok: boolean;
  /** Which bucket rejected it: the caller's key, or their IP. */
  scope: 'key' | 'ip' | null;
  reason: string | null;
  retryAfterMs: number | null;
  /** Concurrency slots in use for this caller, after the decision. */
  inFlight: number;
}

interface Bucket {
  meter: Meter;
  inFlight: number;
  lastSeen: number;
}

/** Buckets for callers that have gone quiet are reclaimed after this long. */
const IDLE_EVICT_MS = 30 * 60_000;

export class Limiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: Clock;
  private config: GuardConfig;

  constructor(config: GuardConfig, now: Clock = Date.now) {
    this.config = config;
    this.now = now;
  }

  setConfig(config: GuardConfig): void {
    this.config = config;
  }

  private bucket(id: string): Bucket {
    let b = this.buckets.get(id);
    if (!b) {
      b = { meter: new Meter(this.now), inFlight: 0, lastSeen: this.now() };
      this.buckets.set(id, b);
    }
    b.lastSeen = this.now();
    return b;
  }

  private static limitsOf(source: { rpm: number | null; tpm?: number | null; rpd?: number | null }): LimitSpec {
    return { ...EMPTY_LIMITS, rpm: source.rpm, tpm: source.tpm ?? null, rpd: source.rpd ?? null };
  }

  /**
   * Decide whether a request may proceed. Does *not* reserve anything — call
   * `enter` once you commit, so a rejected request never occupies a slot.
   */
  check(keyId: string | null, ip: string, estTokens = 0): LimitDecision {
    const { perKey, perIp } = this.config;

    if (keyId !== null && hasAny(perKey)) {
      const b = this.bucket(`k:${keyId}`);
      if (perKey.concurrency !== null && b.inFlight >= perKey.concurrency) {
        return { ok: false, scope: 'key', reason: `concurrency limit reached (${b.inFlight}/${perKey.concurrency} in flight)`, retryAfterMs: 1000, inFlight: b.inFlight };
      }
      const check = b.meter.check(Limiter.limitsOf(perKey), estTokens);
      if (!check.ok) {
        return { ok: false, scope: 'key', reason: `virtual key ${check.reason ?? 'over its limit'}`, retryAfterMs: check.retryAfterMs, inFlight: b.inFlight };
      }
    }

    if (hasAny(perIp)) {
      const b = this.bucket(`i:${ip}`);
      if (perIp.concurrency !== null && b.inFlight >= perIp.concurrency) {
        return { ok: false, scope: 'ip', reason: `concurrency limit reached (${b.inFlight}/${perIp.concurrency} in flight)`, retryAfterMs: 1000, inFlight: b.inFlight };
      }
      const check = b.meter.check(Limiter.limitsOf({ rpm: perIp.rpm }), 0);
      if (!check.ok) {
        return { ok: false, scope: 'ip', reason: `client ${check.reason ?? 'over its limit'}`, retryAfterMs: check.retryAfterMs, inFlight: b.inFlight };
      }
    }

    return { ok: true, scope: null, reason: null, retryAfterMs: null, inFlight: 0 };
  }

  /** Reserve a concurrency slot and count the request. Returns a release function. */
  enter(keyId: string | null, ip: string): () => void {
    const ids = [keyId !== null ? `k:${keyId}` : null, `i:${ip}`].filter((v): v is string => v !== null);
    for (const id of ids) {
      const b = this.bucket(id);
      b.inFlight += 1;
      b.meter.record({ requests: 1 });
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const id of ids) {
        const b = this.buckets.get(id);
        if (b) b.inFlight = Math.max(0, b.inFlight - 1);
      }
    };
  }

  /** Late token accounting, so a caller's tpm reflects what they actually used. */
  recordTokens(keyId: string | null, ip: string, tokens: number): void {
    if (tokens <= 0) return;
    if (keyId !== null) this.bucket(`k:${keyId}`).meter.addTokens(tokens);
    this.bucket(`i:${ip}`).meter.addTokens(tokens);
  }

  /** Drop buckets for callers that have gone away. Safe to call periodically. */
  evictIdle(): number {
    const cutoff = this.now() - IDLE_EVICT_MS;
    let removed = 0;
    for (const [id, b] of this.buckets) {
      if (b.inFlight === 0 && b.lastSeen < cutoff) {
        this.buckets.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Dashboard view of active callers. */
  callers(): { id: string; scope: 'key' | 'ip'; rpm: number; tpm: number; inFlight: number }[] {
    return [...this.buckets.entries()].map(([id, b]) => ({
      id: id.slice(2),
      scope: id.startsWith('k:') ? 'key' : 'ip',
      rpm: b.meter.used('rpm'),
      tpm: b.meter.used('tpm'),
      inFlight: b.inFlight,
    }));
  }

  size(): number {
    return this.buckets.size;
  }
}

function hasAny(limits: Record<string, number | null>): boolean {
  return Object.values(limits).some((v) => v !== null);
}
