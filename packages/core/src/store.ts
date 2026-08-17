/**
 * Live state: what each provider and each key has spent, how healthy they are,
 * and what happened on recent requests.
 *
 * The single most important decision in this file is how a failure is
 * attributed. A 401 means *that key* is bad and the pool's other keys may be
 * fine; a 502 means the *provider* is down and every key will fail identically.
 * Benching the wrong thing makes a key pool pointless in one direction and
 * hammers a dead provider in the other.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Meter, type Clock } from './meter.ts';
import type { MeterSnapshot } from './types.ts';
import { ewma, type Logger, consoleLogger } from './util.ts';

export type FaultKind = 'key' | 'provider' | 'request';

export type KeyStatus = 'unknown' | 'ok' | 'invalid' | 'rate-limited' | 'cooling';

/**
 * Attribute a failure to a key, a provider, or the request itself.
 *
 * `request` faults bench nothing: a 400 is the caller's malformed body and will
 * fail identically on every provider, so retrying is pure waste.
 */
export function classifyFailure(status: number | null): FaultKind {
  if (status === null) return 'provider'; // network error, timeout, DNS
  if (status === 401 || status === 403 || status === 429) return 'key';
  if (status >= 500) return 'provider';
  if (status === 408) return 'provider';
  return 'request';
}

export interface KeyState {
  keyId: string;
  meter: Meter;
  ok: number;
  fail: number;
  latencyMs: number | null;
  cooldownUntil: number;
  lastError: string | null;
  lastErrorAt: number | null;
  status: KeyStatus;
}

export interface ProviderState {
  providerId: string;
  meter: Meter;
  ok: number;
  fail: number;
  latencyMs: number | null;
  cooldownUntil: number;
  lastError: string | null;
  lastErrorAt: number | null;
  /** Round-robin position, advanced per selection. */
  cursor: number;
  keys: Map<string, KeyState>;
}

export interface AttemptLog {
  providerId: string;
  modelId: string;
  keyId: string | null;
  status: number | null;
  ms: number;
  error: string | null;
}

export interface LogEntry {
  id: string;
  at: number;
  requestedModel: string;
  resolution: string;
  providerId: string | null;
  modelId: string | null;
  keyId: string | null;
  attempts: AttemptLog[];
  status: number;
  ms: number;
  tokensIn: number;
  tokensOut: number;
  stream: boolean;
  cache: 'exact' | 'semantic' | null;
  error: string | null;
  /**
   * What actually went over the wire, truncated. This is the whole point of a
   * personal gateway dashboard — seeing the answer, not just that there was one.
   * Bounded so 500 entries stay a couple of megabytes at worst.
   */
  preview: { prompt: string; response: string } | null;
}

/** Keeps the ring buffer's memory flat no matter how large a response is. */
export const PREVIEW_LIMIT = 1500;

export function previewOf(text: string): string {
  if (text.length <= PREVIEW_LIMIT) return text;
  return `${text.slice(0, PREVIEW_LIMIT)}\n… [${text.length - PREVIEW_LIMIT} more characters]`;
}

export interface FailureInfo {
  status: number | null;
  message: string;
  /** Upstream `Retry-After`, honoured in preference to the configured cooldown. */
  retryAfterMs?: number | null;
}

export interface StoreOptions {
  /** Where to persist meters. `null` disables persistence entirely. */
  file?: string | null;
  autosaveMs?: number;
  logSize?: number;
  cooldownMs?: number;
  clock?: Clock;
  logger?: Logger;
}

const SNAPSHOT_VERSION = 1;

interface PersistedKey {
  meter: MeterSnapshot;
  ok: number;
  fail: number;
}

interface PersistedProvider {
  meter: MeterSnapshot;
  ok: number;
  fail: number;
  keys: Record<string, PersistedKey>;
}

interface PersistedState {
  version: number;
  savedAt: number;
  providers: Record<string, PersistedProvider>;
}

export class Store {
  private readonly providers = new Map<string, ProviderState>();
  private readonly listeners = new Set<(entry: LogEntry) => void>();
  private readonly log: (LogEntry | undefined)[];
  private logHead = 0;
  private logCount = 0;
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  private readonly file: string | null;
  private readonly autosaveMs: number;
  private readonly cooldownMs: number;
  private readonly now: Clock;
  private readonly logger: Logger;

  constructor(opts: StoreOptions = {}) {
    this.file = opts.file ?? null;
    this.autosaveMs = opts.autosaveMs ?? 15_000;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.now = opts.clock ?? Date.now;
    this.logger = opts.logger ?? consoleLogger;
    this.log = new Array<LogEntry | undefined>(opts.logSize ?? 500);
    if (this.file) this.load();
  }

  // -------------------------------------------------------------------------
  // State access
  // -------------------------------------------------------------------------

  provider(id: string): ProviderState {
    let p = this.providers.get(id);
    if (!p) {
      p = {
        providerId: id,
        meter: new Meter(this.now),
        ok: 0,
        fail: 0,
        latencyMs: null,
        cooldownUntil: 0,
        lastError: null,
        lastErrorAt: null,
        cursor: 0,
        keys: new Map(),
      };
      this.providers.set(id, p);
    }
    return p;
  }

  key(providerId: string, keyId: string): KeyState {
    const p = this.provider(providerId);
    let k = p.keys.get(keyId);
    if (!k) {
      k = {
        keyId,
        meter: new Meter(this.now),
        ok: 0,
        fail: 0,
        latencyMs: null,
        cooldownUntil: 0,
        lastError: null,
        lastErrorAt: null,
        status: 'unknown',
      };
      p.keys.set(keyId, k);
    }
    return k;
  }

  providerIds(): string[] {
    return [...this.providers.keys()];
  }

  isProviderCooling(id: string): boolean {
    return this.provider(id).cooldownUntil > this.now();
  }

  isKeyCooling(providerId: string, keyId: string): boolean {
    return this.key(providerId, keyId).cooldownUntil > this.now();
  }

  /** Advance and return the round-robin cursor for a provider. */
  nextCursor(providerId: string): number {
    const p = this.provider(providerId);
    p.cursor = (p.cursor + 1) % Number.MAX_SAFE_INTEGER;
    return p.cursor;
  }

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  recordSuccess(providerId: string, keyId: string | null, ms: number, tokens = 0, credits = 0): void {
    const p = this.provider(providerId);
    p.ok += 1;
    p.latencyMs = ewma(p.latencyMs, ms);
    p.meter.record({ requests: 1, tokens, credits });
    // A success clears a provider-level bench: whatever was wrong has passed.
    p.cooldownUntil = 0;
    p.lastError = null;

    if (keyId !== null) {
      const k = this.key(providerId, keyId);
      k.ok += 1;
      k.latencyMs = ewma(k.latencyMs, ms);
      k.meter.record({ requests: 1, tokens, credits });
      k.cooldownUntil = 0;
      k.status = 'ok';
      k.lastError = null;
    }
    this.dirty = true;
  }

  /**
   * Attribute a failure and bench whatever is actually at fault.
   * Returns what was benched, so the caller can decide whether to try another
   * key from the same provider or move on entirely.
   */
  recordFailure(providerId: string, keyId: string | null, info: FailureInfo): FaultKind {
    const now = this.now();
    const kind = classifyFailure(info.status);
    const cooldown = info.retryAfterMs ?? this.cooldownMs;

    const p = this.provider(providerId);
    p.fail += 1;

    if (kind === 'provider') {
      p.cooldownUntil = now + cooldown;
      p.lastError = info.message;
      p.lastErrorAt = now;
    }

    if (keyId !== null) {
      const k = this.key(providerId, keyId);
      k.fail += 1;
      if (kind === 'key') {
        k.lastError = info.message;
        k.lastErrorAt = now;
        if (info.status === 401 || info.status === 403) {
          // A rejected credential will keep being rejected. Bench it for long
          // enough that it stops being tried on every request, but not forever
          // — keys get re-enabled upstream and a re-probe should find that.
          k.cooldownUntil = now + Math.max(cooldown, 15 * 60_000);
          k.status = 'invalid';
        } else {
          k.cooldownUntil = now + cooldown;
          k.status = 'rate-limited';
        }
      }
    }

    this.dirty = true;
    return kind;
  }

  /** Late usage from a stream's final chunk. */
  addTokens(providerId: string, keyId: string | null, tokens: number, credits = 0): void {
    if (tokens <= 0 && credits <= 0) return;
    this.provider(providerId).meter.record({ tokens, credits });
    if (keyId !== null) this.key(providerId, keyId).meter.record({ tokens, credits });
    this.dirty = true;
  }

  /** Apply an upstream cooldown without recording a failure (e.g. observed 429 headers). */
  coolProvider(providerId: string, ms: number, reason: string): void {
    const p = this.provider(providerId);
    p.cooldownUntil = Math.max(p.cooldownUntil, this.now() + ms);
    p.lastError = reason;
    p.lastErrorAt = this.now();
  }

  coolKey(providerId: string, keyId: string, ms: number, reason: string): void {
    const k = this.key(providerId, keyId);
    k.cooldownUntil = Math.max(k.cooldownUntil, this.now() + ms);
    k.status = 'cooling';
    k.lastError = reason;
    k.lastErrorAt = this.now();
  }

  // -------------------------------------------------------------------------
  // Request log (ring buffer — never grows)
  // -------------------------------------------------------------------------

  nextRequestId(): string {
    this.seq += 1;
    return `r${this.seq.toString(36)}`;
  }

  addLog(entry: LogEntry): void {
    this.log[this.logHead] = entry;
    this.logHead = (this.logHead + 1) % this.log.length;
    if (this.logCount < this.log.length) this.logCount += 1;

    // Push to live subscribers. A broken listener must never take down the
    // request that produced the entry, so each one is isolated.
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        /* a dashboard disconnecting mid-write is not the request's problem */
      }
    }
  }

  /** Subscribe to log entries as they happen. Returns an unsubscribe function. */
  onLog(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  /** Most recent first. */
  logs(limit = 100): LogEntry[] {
    const out: LogEntry[] = [];
    for (let i = 0; i < this.logCount && out.length < limit; i++) {
      const idx = (this.logHead - 1 - i + this.log.length * 2) % this.log.length;
      const e = this.log[idx];
      if (e) out.push(e);
    }
    return out;
  }

  stats(): { requests: number; ok: number; fail: number; providers: number } {
    let ok = 0;
    let fail = 0;
    for (const p of this.providers.values()) {
      ok += p.ok;
      fail += p.fail;
    }
    return { requests: ok + fail, ok, fail, providers: this.providers.size };
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * Daily and monthly free-tier counters that reset on restart are how a quota
   * gets blown by accident, so meters survive a restart. The request log does
   * not — it is ephemeral ops data and reloading it would be misleading.
   */
  save(): void {
    if (!this.file) return;
    const state: PersistedState = { version: SNAPSHOT_VERSION, savedAt: this.now(), providers: {} };
    for (const [id, p] of this.providers) {
      const keys: Record<string, PersistedKey> = {};
      for (const [kid, k] of p.keys) keys[kid] = { meter: k.meter.snapshot(), ok: k.ok, fail: k.fail };
      state.providers[id] = { meter: p.meter.snapshot(), ok: p.ok, fail: p.fail, keys };
    }

    try {
      mkdirSync(dirname(this.file), { recursive: true });
      // tmp + rename so a crash mid-write cannot leave a truncated file that
      // would silently zero every counter on the next start.
      const tmp = join(dirname(this.file), `.${Date.now()}.tmp`);
      writeFileSync(tmp, JSON.stringify(state), 'utf8');
      renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      this.logger.warn(`could not persist usage to ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private load(): void {
    if (!this.file) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`ignoring unreadable usage file ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    if (typeof raw !== 'object' || raw === null) return;
    const state = raw as Partial<PersistedState>;
    if (state.version !== SNAPSHOT_VERSION || typeof state.providers !== 'object' || state.providers === null) {
      this.logger.warn(`ignoring usage file with unexpected version ${String(state.version)}`);
      return;
    }

    for (const [id, pRaw] of Object.entries(state.providers)) {
      if (typeof pRaw !== 'object' || pRaw === null) continue;
      const p = this.provider(id);
      const pd = pRaw as PersistedProvider;
      if (pd.meter) p.meter.restore(pd.meter);
      p.ok = typeof pd.ok === 'number' ? pd.ok : 0;
      p.fail = typeof pd.fail === 'number' ? pd.fail : 0;
      for (const [kid, kRaw] of Object.entries(pd.keys ?? {})) {
        const k = this.key(id, kid);
        if (kRaw.meter) k.meter.restore(kRaw.meter);
        k.ok = typeof kRaw.ok === 'number' ? kRaw.ok : 0;
        k.fail = typeof kRaw.fail === 'number' ? kRaw.fail : 0;
      }
    }
  }

  /** Begin autosaving and install shutdown handlers. Returns a stop function. */
  startAutosave(): () => void {
    if (!this.file || this.timer) return () => this.stopAutosave();
    this.timer = setInterval(() => {
      if (this.dirty) this.save();
    }, this.autosaveMs);
    this.timer.unref?.();

    const onExit = (): void => {
      this.save();
    };
    process.once('SIGINT', onExit);
    process.once('SIGTERM', onExit);
    process.once('beforeExit', onExit);

    return () => {
      process.off('SIGINT', onExit);
      process.off('SIGTERM', onExit);
      process.off('beforeExit', onExit);
      this.stopAutosave();
    };
  }

  stopAutosave(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
