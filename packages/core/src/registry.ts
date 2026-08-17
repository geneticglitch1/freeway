/**
 * The registry: `providers/*.json` on disk becomes the runtime provider list.
 *
 * This module is the whole reason "providers are data, not code" holds. Adding a
 * provider must never require a TypeScript edit, so everything variable about a
 * provider — its URL, its auth style, its account id, its limits — arrives here
 * as data and is resolved against the environment.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { formatIssues, parseProviderSpec, type SpecIssue } from './spec.ts';
import type { KeyRef, ProviderSpec, ResolvedModel, ResolvedProvider } from './types.ts';
import { interpolate, mask, splitKeys, type Logger, consoleLogger } from './util.ts';

export interface LoadIssue {
  file: string;
  providerId: string | null;
  level: 'error' | 'warning';
  message: string;
}

export interface RegistryOptions {
  /** Directory holding `providers/*.json`. */
  dir: string;
  env?: Record<string, string | undefined>;
  logger?: Logger;
  /**
   * Keys supplied at runtime rather than through the environment, keyed by
   * provider id (comma-separated, same grammar as an env var). The dashboard's
   * paste box writes these; env vars still win.
   */
  extraKeys?: Record<string, string>;
}

export class Registry {
  private providers = new Map<string, ResolvedProvider>();
  private loadIssues: LoadIssue[] = [];
  /** Survives reload, so a toggle in the dashboard is not undone by re-reading disk. */
  private enabledOverrides = new Map<string, boolean>();
  private extraKeys: Record<string, string>;
  private readonly logger: Logger;
  private env: Record<string, string | undefined>;
  private readonly opts: RegistryOptions;

  constructor(opts: RegistryOptions) {
    this.opts = opts;
    this.logger = opts.logger ?? consoleLogger;
    this.env = opts.env ?? process.env;
    this.extraKeys = opts.extraKeys ?? {};
    this.reload();
  }

  /** Re-read `providers/` from disk. Safe to call while serving traffic. */
  reload(): void {
    const next = new Map<string, ResolvedProvider>();
    this.loadIssues = [];

    let files: string[];
    try {
      files = readdirSync(this.opts.dir);
    } catch (err) {
      this.logger.warn(`cannot read providers dir ${this.opts.dir}: ${errMsg(err)}`);
      this.providers = next;
      return;
    }

    for (const file of files.sort()) {
      // A leading underscore marks a non-provider file — the JSON Schema lives
      // in the same directory and must not be loaded as a provider.
      if (file.startsWith('_') || file.startsWith('.')) continue;
      if (!file.endsWith('.json')) continue;

      const full = join(this.opts.dir, file);
      try {
        if (!statSync(full).isFile()) continue;
      } catch {
        continue;
      }

      const spec = this.loadOne(full, file);
      if (!spec) continue;

      if (next.has(spec.id)) {
        this.issue(file, spec.id, 'error', `duplicate provider id "${spec.id}" — already defined by another file`);
        continue;
      }
      next.set(spec.id, this.resolve(spec));
    }

    this.providers = next;
  }

  /** A malformed file is reported and skipped. It must never take the gateway down. */
  private loadOne(full: string, file: string): ProviderSpec | null {
    let text: string;
    try {
      text = readFileSync(full, 'utf8');
    } catch (err) {
      this.issue(file, null, 'error', `cannot read file: ${errMsg(err)}`);
      return null;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      this.issue(file, null, 'error', `invalid JSON: ${errMsg(err)}`);
      return null;
    }

    const parsed = parseProviderSpec(raw);
    for (const w of parsed.warnings) this.issue(file, idOf(raw), 'warning', fmtIssue(w));

    if (!parsed.ok) {
      this.issue(file, idOf(raw), 'error', formatIssues(parsed.errors));
      this.logger.warn(`skipping ${file}: ${formatIssues(parsed.errors)}`);
      return null;
    }
    return parsed.spec;
  }

  /** Apply the environment: interpolate URLs and headers, then gather the key pool. */
  private resolve(spec: ProviderSpec): ResolvedProvider {
    const missingEnv: string[] = [];

    const base = interpolate(spec.baseUrl, this.env);
    for (const m of base.missing) if (!missingEnv.includes(m)) missingEnv.push(m);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.headers)) {
      const r = interpolate(v, this.env);
      for (const m of r.missing) if (!missingEnv.includes(m)) missingEnv.push(m);
      headers[k] = r.value;
    }

    const keys = this.collectKeys(spec);

    let configured = true;
    let configError: string | null = null;

    if (missingEnv.length > 0) {
      configured = false;
      configError = `missing environment variable${missingEnv.length > 1 ? 's' : ''}: ${missingEnv.join(', ')}`;
    } else if (spec.auth.type !== 'none' && keys.length === 0) {
      configured = false;
      configError = `no API key found (set one of: ${spec.auth.envKeys.join(', ')})`;
    }

    const models: ResolvedModel[] = spec.models.map((m) => ({
      spec: m,
      providerId: spec.id,
      ref: `${spec.id}/${m.id}`,
    }));

    return {
      spec,
      id: spec.id,
      label: spec.label,
      enabled: this.enabledOverrides.get(spec.id) ?? spec.enabled,
      baseUrl: base.value,
      headers,
      keys,
      configured,
      configError,
      models,
    };
  }

  private collectKeys(spec: ProviderSpec): KeyRef[] {
    if (spec.auth.type === 'none') return [];
    const out: KeyRef[] = [];
    const seen = new Set<string>();

    const push = (value: string, source: string): void => {
      if (seen.has(value)) return;
      seen.add(value);
      const index = out.length;
      out.push({
        id: `${spec.id}#${index}`,
        providerId: spec.id,
        index,
        value,
        masked: mask(value),
        source,
      });
    };

    for (const envName of spec.auth.envKeys) {
      for (const k of splitKeys(this.env[envName])) push(k, envName);
    }
    // Runtime-supplied keys come last so an env var always takes precedence.
    for (const k of splitKeys(this.extraKeys[spec.id])) push(k, 'runtime');

    return out;
  }

  private issue(file: string, providerId: string | null, level: LoadIssue['level'], message: string): void {
    this.loadIssues.push({ file, providerId, level, message });
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  get(id: string): ResolvedProvider | undefined {
    return this.providers.get(id);
  }

  all(): ResolvedProvider[] {
    return [...this.providers.values()].sort((a, b) => a.spec.priority - b.spec.priority || a.id.localeCompare(b.id));
  }

  /** Providers that could actually serve a request right now. */
  usable(): ResolvedProvider[] {
    return this.all().filter(
      (p) => p.enabled && p.configured && (p.spec.auth.type === 'none' || p.keys.length > 0) && p.models.some((m) => m.spec.enabled),
    );
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const p = this.providers.get(id);
    if (!p) return false;
    this.enabledOverrides.set(id, enabled);
    p.enabled = enabled;
    return true;
  }

  /** Aliases declared by models in the registry: alias → every model offering it. */
  aliases(): Map<string, ResolvedModel[]> {
    const out = new Map<string, ResolvedModel[]>();
    for (const p of this.all()) {
      if (!p.enabled) continue;
      for (const m of p.models) {
        if (!m.spec.enabled) continue;
        for (const a of m.spec.alias) {
          const list = out.get(a);
          if (list) list.push(m);
          else out.set(a, [m]);
        }
      }
    }
    return out;
  }

  /** Every model across every provider, for `/v1/models` and the catalog table. */
  allModels(): ResolvedModel[] {
    return this.all().flatMap((p) => p.models);
  }

  issues(): LoadIssue[] {
    return [...this.loadIssues];
  }

  /** Replace runtime keys and re-resolve without re-reading disk. */
  setExtraKeys(extra: Record<string, string>): void {
    this.extraKeys = extra;
    this.reload();
  }

  /** Swap the environment view. Used by tests and by `.env` loading at startup. */
  setEnv(env: Record<string, string | undefined>): void {
    this.env = env;
    this.reload();
  }
}

function idOf(raw: unknown): string | null {
  if (typeof raw === 'object' && raw !== null && 'id' in raw) {
    const v = (raw as { id: unknown }).id;
    if (typeof v === 'string') return v;
  }
  return null;
}

function fmtIssue(i: SpecIssue): string {
  return i.path ? `${i.path}: ${i.message}` : i.message;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
