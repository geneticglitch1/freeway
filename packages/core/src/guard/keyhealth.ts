/**
 * Key health: which credentials still work, and which have quietly stopped.
 *
 * A key that gets revoked upstream looks identical to a key that is merely
 * rate-limited until you actually ask. Periodic re-probing is what separates
 * "wait a minute" from "go make a new key".
 */

import { probeKey, type ProbeResult } from '../probe.ts';
import type { KeyRef, ResolvedProvider } from '../types.ts';
import type { Logger } from '../util.ts';
import { silentLogger } from '../util.ts';

export type KeyVerdict = 'healthy' | 'invalid' | 'forbidden' | 'rate-limited' | 'unreachable' | 'unknown';

export interface KeyHealth {
  providerId: string;
  keyId: string;
  masked: string;
  verdict: KeyVerdict;
  checkedAt: number;
  ms: number;
  /** Models the key could reach, when the probe validated them. */
  reachable: number | null;
  detail: string | null;
}

export interface HealthReport {
  at: number;
  keys: KeyHealth[];
  /** Keys that need a human: revoked, wrong scope, or a dead provider. */
  actionable: KeyHealth[];
}

const VERDICT: Record<string, KeyVerdict> = {
  ok: 'healthy',
  invalid: 'invalid',
  forbidden: 'forbidden',
  'rate-limited': 'rate-limited',
  unreachable: 'unreachable',
  unknown: 'unknown',
};

function verdictOf(result: ProbeResult): KeyVerdict {
  return VERDICT[result.auth] ?? 'unknown';
}

function detailOf(result: ProbeResult): string | null {
  if (result.errors.length > 0) return result.errors[0] ?? null;
  if (result.auth === 'ok') return null;
  return `auth reported ${result.auth}`;
}

export interface KeyHealthOptions {
  logger?: Logger;
  /** Also validate models. Costs quota, so it is off for scheduled checks. */
  validateModels?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
}

export class KeyHealthMonitor {
  private readonly results = new Map<string, KeyHealth>();
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(options: { logger?: Logger } = {}) {
    this.logger = options.logger ?? silentLogger;
  }

  /** Probe every key of every configured provider. */
  async check(providers: ResolvedProvider[], options: KeyHealthOptions = {}): Promise<HealthReport> {
    // Overlapping sweeps would double-spend quota on the probe requests.
    if (this.running) return this.report();
    this.running = true;

    try {
      for (const provider of providers) {
        if (!provider.configured || !provider.enabled) continue;

        const keys: KeyRef[] =
          provider.keys.length > 0
            ? provider.keys
            : [{ id: `${provider.id}#none`, providerId: provider.id, index: 0, value: '', masked: '—', source: 'none' }];

        for (const key of keys) {
          const probeOptions: Parameters<typeof probeKey>[2] = {
            validateModels: options.validateModels === true,
            maxModels: 5,
            concurrency: 2,
            timeoutMs: options.timeoutMs ?? 15_000,
          };
          if (options.fetchImpl) probeOptions.fetchImpl = options.fetchImpl;

          const result = await probeKey(provider, key, probeOptions);
          const verdict = verdictOf(result);
          const reachable = options.validateModels === true ? result.models.filter((m) => m.status === 'ok').length : null;

          this.results.set(`${provider.id}:${key.id}`, {
            providerId: provider.id,
            keyId: key.id,
            masked: key.masked,
            verdict,
            checkedAt: Date.now(),
            ms: result.ms,
            reachable,
            detail: detailOf(result),
          });

          if (verdict === 'invalid' || verdict === 'forbidden') {
            // Masked, always — there is no code path that logs a key.
            this.logger.warn(`key ${key.masked} on ${provider.id} is ${verdict}: ${detailOf(result) ?? 'no detail'}`);
          }
        }
      }
    } finally {
      this.running = false;
    }

    return this.report();
  }

  report(): HealthReport {
    const keys = [...this.results.values()];
    return {
      at: Date.now(),
      keys,
      // Rate-limited is not actionable — it fixes itself. Revoked does not.
      actionable: keys.filter((k) => k.verdict === 'invalid' || k.verdict === 'forbidden' || k.verdict === 'unreachable'),
    };
  }

  get(providerId: string, keyId: string): KeyHealth | undefined {
    return this.results.get(`${providerId}:${keyId}`);
  }

  /** Run `check` on an interval. Returns a stop function. */
  schedule(getProviders: () => ResolvedProvider[], intervalMs: number, options: KeyHealthOptions = {}): () => void {
    this.stop();
    const run = (): void => {
      void this.check(getProviders(), options).catch((err: unknown) => {
        this.logger.warn(`key health sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    };
    this.timer = setInterval(run, Math.max(60_000, intervalMs));
    // Never hold the process open just to run a health check.
    this.timer.unref?.();
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
