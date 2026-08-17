/**
 * Learn each provider's real limits from what it says on the way past, and
 * notice when a key has been quietly moved to a different tier.
 *
 * This is what makes the shipped catalog safe. Several providers no longer
 * publish free-tier numbers at all, so their files carry `null` — and a null
 * that becomes accurate on its own beats a guess that never does.
 */

import { observedLimitsFrom, limitDrift, type LimitDrift } from '../probe.ts';
import type { LimitSpec, LimitsSource } from '../types.ts';

export interface Calibration {
  providerId: string;
  /** Limits observed from response headers, newest wins. */
  observed: Partial<LimitSpec>;
  /** When each field was last seen. */
  seenAt: Partial<Record<keyof LimitSpec, number>>;
  samples: number;
  drift: LimitDrift[];
  /** True when the provider enforces less than its file claims. */
  downgraded: boolean;
}

export interface CalibrationSnapshot {
  version: number;
  providers: Record<string, { observed: Partial<LimitSpec>; seenAt: Partial<Record<keyof LimitSpec, number>>; samples: number }>;
}

const VERSION = 1;

export class Calibrator {
  private readonly state = new Map<string, Calibration>();
  private readonly enabled: boolean;

  constructor(enabled = true) {
    this.enabled = enabled;
  }

  /**
   * Feed a live response's headers in. Called on every upstream reply, so it
   * must stay cheap and must never throw into the request path.
   */
  observe(providerId: string, declared: LimitSpec, headers: Headers, now = Date.now()): Partial<LimitSpec> {
    if (!this.enabled) return {};

    let observed: Partial<LimitSpec>;
    try {
      observed = observedLimitsFrom(headers);
    } catch {
      return {};
    }
    if (Object.keys(observed).length === 0) return {};

    const entry = this.state.get(providerId) ?? {
      providerId,
      observed: {},
      seenAt: {},
      samples: 0,
      drift: [],
      downgraded: false,
    };

    for (const [k, v] of Object.entries(observed)) {
      if (typeof v !== 'number' || v <= 0) continue;
      const key = k as keyof LimitSpec;
      entry.observed[key] = v;
      entry.seenAt[key] = now;
    }
    entry.samples += 1;
    entry.drift = limitDrift(declared, entry.observed);
    // A provider enforcing *less* than the file claims is the signature of a
    // tier change; enforcing more just means the file was pessimistic.
    entry.downgraded = entry.drift.some((d) => d.declared !== null && d.observed < d.declared);

    this.state.set(providerId, entry);
    return entry.observed;
  }

  /**
   * The limits the meter should actually enforce: declared, with anything we
   * have observed layered on top.
   */
  effective(providerId: string, declared: LimitSpec): LimitSpec {
    const entry = this.state.get(providerId);
    if (!entry) return declared;

    const out: LimitSpec = { ...declared };
    for (const [k, v] of Object.entries(entry.observed)) {
      if (typeof v !== 'number' || v <= 0) continue;
      const key = k as keyof LimitSpec;
      const current = out[key];
      // Never widen a documented limit on the strength of one header — a
      // provider's per-request budget is not always its ceiling. Narrowing is
      // always safe, and filling in a null is the whole point.
      if (current === null || current === undefined || v < current) out[key] = v;
    }
    return out;
  }

  /** What `limitsSource` a provider has earned. */
  sourceFor(providerId: string, declared: LimitsSource): LimitsSource {
    return this.state.get(providerId)?.samples ? 'observed' : declared;
  }

  get(providerId: string): Calibration | undefined {
    return this.state.get(providerId);
  }

  all(): Calibration[] {
    return [...this.state.values()];
  }

  snapshot(): CalibrationSnapshot {
    const providers: CalibrationSnapshot['providers'] = {};
    for (const [id, e] of this.state) providers[id] = { observed: e.observed, seenAt: e.seenAt, samples: e.samples };
    return { version: VERSION, providers };
  }

  restore(snap: CalibrationSnapshot | undefined): void {
    if (!snap || snap.version !== VERSION) return;
    for (const [id, e] of Object.entries(snap.providers ?? {})) {
      this.state.set(id, {
        providerId: id,
        observed: e.observed ?? {},
        seenAt: e.seenAt ?? {},
        samples: typeof e.samples === 'number' ? e.samples : 0,
        drift: [],
        downgraded: false,
      });
    }
  }
}
