/**
 * Keys added at runtime from the dashboard, kept in `data/keys.json`.
 *
 * Environment variables remain the primary path and always take precedence;
 * this exists so "add a provider" can be a paste rather than a restart.
 *
 * The file is written 0600 and is never read back out over HTTP — the API only
 * ever reports masked values, and only the gateway process itself sees the real
 * ones. Callers are responsible for gating the write endpoint; see
 * `KeyVault.writable` for the reason that gate exists.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { mask, splitKeys, type Logger, consoleLogger } from './util.ts';

interface VaultFile {
  version: number;
  updatedAt: number;
  /** providerId → comma-separated keys, same grammar as an env var. */
  keys: Record<string, string>;
}

const VERSION = 1;

export interface KeyVaultOptions {
  file: string;
  logger?: Logger;
  /**
   * When false, every mutation is refused. The gateway sets this from its bind
   * address: accepting secrets over a non-loopback socket without an admin key
   * would let anyone who can reach the port add credentials.
   */
  writable?: boolean;
}

export class KeyVault {
  private data: VaultFile = { version: VERSION, updatedAt: 0, keys: {} };
  private readonly file: string;
  private readonly logger: Logger;
  readonly writable: boolean;

  constructor(opts: KeyVaultOptions) {
    this.file = opts.file;
    this.logger = opts.logger ?? consoleLogger;
    this.writable = opts.writable ?? true;
    this.load();
  }

  private load(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`ignoring unreadable key file ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (typeof raw !== 'object' || raw === null) return;
    const file = raw as Partial<VaultFile>;
    if (file.version !== VERSION || typeof file.keys !== 'object' || file.keys === null) return;

    for (const [id, value] of Object.entries(file.keys)) {
      if (typeof value === 'string' && value.trim()) this.data.keys[id] = value;
    }
    this.data.updatedAt = typeof file.updatedAt === 'number' ? file.updatedAt : 0;
  }

  private persist(): void {
    this.data.updatedAt = Date.now();
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = join(dirname(this.file), `.keys.${process.pid}.tmp`);
    // Create the temp file with restrictive permissions *before* writing to it,
    // so the secret is never briefly world-readable on disk.
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }

  /** All runtime keys, in the shape `Registry` expects for `extraKeys`. */
  all(): Record<string, string> {
    return { ...this.data.keys };
  }

  /** Masked view for the dashboard. Raw values never leave this class. */
  describe(): { providerId: string; masked: string[]; updatedAt: number }[] {
    return Object.entries(this.data.keys).map(([providerId, value]) => ({
      providerId,
      masked: splitKeys(value).map(mask),
      updatedAt: this.data.updatedAt,
    }));
  }

  has(providerId: string): boolean {
    return typeof this.data.keys[providerId] === 'string';
  }

  /** Add a key to a provider's runtime pool. Returns the masked value. */
  add(providerId: string, key: string): string {
    if (!this.writable) throw new Error('runtime key storage is disabled');
    const trimmed = key.trim();
    if (!trimmed) throw new Error('key is empty');
    if (trimmed.includes(',')) throw new Error('one key at a time (commas separate pool entries)');

    const existing = splitKeys(this.data.keys[providerId]);
    if (!existing.includes(trimmed)) existing.push(trimmed);
    this.data.keys[providerId] = existing.join(',');
    this.persist();
    return mask(trimmed);
  }

  /** Remove one key by its masked form, or every key when `masked` is omitted. */
  remove(providerId: string, masked?: string): boolean {
    if (!this.writable) throw new Error('runtime key storage is disabled');
    const existing = splitKeys(this.data.keys[providerId]);
    if (existing.length === 0) return false;

    if (masked === undefined) {
      delete this.data.keys[providerId];
      this.persist();
      return true;
    }

    const kept = existing.filter((k) => mask(k) !== masked);
    if (kept.length === existing.length) return false;
    if (kept.length === 0) delete this.data.keys[providerId];
    else this.data.keys[providerId] = kept.join(',');
    this.persist();
    return true;
  }

  clear(): void {
    if (!this.writable) throw new Error('runtime key storage is disabled');
    this.data.keys = {};
    try {
      unlinkSync(this.file);
    } catch {
      /* already gone */
    }
  }
}
