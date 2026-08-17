/**
 * Hand it a key, it tells you what that key can actually reach.
 *
 * Three jobs, in increasing cost:
 *  1. discover  — GET the provider's models endpoint and read the ids out of it
 *  2. validate  — send a 1-token completion per model and classify the answer
 *  3. calibrate — read the real rate limits out of the response headers
 *
 * Step 3 is the important one. A published limit is a claim; a response header
 * is what the provider is actually enforcing on *your* key today. For providers
 * that no longer publish free-tier numbers at all, it is the only source.
 */

import type { KeyRef, LimitSpec, ResolvedProvider } from './types.ts';
import { joinUrl } from './util.ts';

export type AuthStatus = 'ok' | 'invalid' | 'forbidden' | 'rate-limited' | 'unreachable' | 'unknown';
/**
 * `ok` means the model answered the probe. `exists` means it is a real id that
 * rejected our probe body — almost always because it is not a chat model at all
 * (OCR, TTS, transcription, moderation). The distinction matters: "this id is
 * real" and "this id serves chat" are different questions.
 */
export type ModelStatus = 'ok' | 'exists' | 'unknown-model' | 'forbidden' | 'rate-limited' | 'error' | 'undiscovered';

export interface ProbedModel {
  id: string;
  status: ModelStatus;
  ms: number | null;
  error: string | null;
  /** True when the id came from live discovery rather than the JSON file. */
  discovered: boolean;
}

export interface ProbeResult {
  providerId: string;
  keyId: string;
  keyMasked: string;
  at: number;
  ms: number;
  auth: AuthStatus;
  /** Ids the provider's own endpoint reported. Empty when discovery is disabled. */
  discovered: string[];
  models: ProbedModel[];
  /** Limits read from response headers — reality, not documentation. */
  observedLimits: Partial<LimitSpec>;
  errors: string[];
}

export interface ProbeOptions {
  /** Also send a tiny completion per model. Costs real quota, so it is opt-in. */
  validateModels?: boolean;
  /** Cap on models to validate, so a 300-model catalog cannot run away. */
  maxModels?: number;
  concurrency?: number;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Response-shape extraction
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Pull strings out of a JSON response using a tiny path grammar: `data[].id`,
 * `models[].name`, `[].id`, `result[].name`.
 *
 * This exists so a provider whose `/models` reply is not OpenAI-shaped stays a
 * one-line JSON edit (`"modelsPath": "result[].name"`) instead of a code change.
 */
export function extractByPath(root: unknown, path: string): string[] {
  const parts = path.split('.').filter((p) => p.length > 0);
  let current: unknown[] = [root];

  for (const part of parts) {
    const isArray = part.endsWith('[]');
    const key = isArray ? part.slice(0, -2) : part;
    const next: unknown[] = [];

    for (const item of current) {
      const value = key ? (isRecord(item) ? item[key] : undefined) : item;
      if (isArray) {
        if (Array.isArray(value)) next.push(...value);
      } else if (value !== undefined) {
        next.push(value);
      }
    }
    current = next;
  }

  return current.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

// ---------------------------------------------------------------------------
// Rate-limit header calibration
// ---------------------------------------------------------------------------

/** `1s`, `6m0s`, `2h`, `1000ms`, or a bare number of seconds. */
export function parseDuration(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const plain = Number(trimmed);
  if (Number.isFinite(plain)) return plain * 1000;

  const matches = [...trimmed.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/g)];
  if (matches.length === 0) return null;

  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  let total = 0;
  for (const m of matches) total += Number(m[1]) * (unit[m[2] ?? 's'] ?? 1000);
  return total;
}

/**
 * Read whatever limits a provider is willing to admit to in its headers.
 *
 * Every vendor spells these differently, so both the explicitly-windowed forms
 * (`x-ratelimit-limit-requests-day`) and the bare forms paired with a reset
 * duration are handled. When only a reset is available the window is inferred
 * from it, which is a guess — but a guess grounded in the provider's own reply
 * rather than in a blog post.
 */
export function observedLimitsFrom(headers: Headers): Partial<LimitSpec> {
  const out: Partial<LimitSpec> = {};
  const get = (name: string): string | null => headers.get(name);
  const num = (name: string): number | null => {
    const raw = get(name);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  // Explicitly windowed (Cerebras, some Groq models).
  const windowed: [string, keyof LimitSpec][] = [
    ['x-ratelimit-limit-requests-day', 'rpd'],
    ['x-ratelimit-limit-requests-minute', 'rpm'],
    ['x-ratelimit-limit-tokens-minute', 'tpm'],
    ['x-ratelimit-limit-tokens-day', 'tpd'],
    ['x-ratelimit-limit-requests-hour', 'rpd'],
  ];
  for (const [header, key] of windowed) {
    const value = num(header);
    if (value !== null) out[key] = value;
  }

  // Bare limits plus a reset duration (OpenAI-style, which Groq follows).
  const reqLimit = num('x-ratelimit-limit-requests');
  if (reqLimit !== null) {
    const reset = get('x-ratelimit-reset-requests');
    const ms = reset ? parseDuration(reset) : null;
    const key = windowKeyFor(ms, 'req');
    if (key && out[key] === undefined) out[key] = reqLimit;
  }

  const tokLimit = num('x-ratelimit-limit-tokens');
  if (tokLimit !== null) {
    const reset = get('x-ratelimit-reset-tokens');
    const ms = reset ? parseDuration(reset) : null;
    const key = windowKeyFor(ms, 'tok');
    if (key && out[key] === undefined) out[key] = tokLimit;
  }

  // IETF draft `RateLimit-Limit` / `RateLimit-Reset`.
  const generic = num('ratelimit-limit') ?? num('x-ratelimit-limit');
  if (generic !== null) {
    const reset = get('ratelimit-reset') ?? get('x-ratelimit-reset');
    const key = windowKeyFor(reset ? parseDuration(reset) : null, 'req');
    if (key && out[key] === undefined) out[key] = generic;
  }

  return out;
}

function windowKeyFor(resetMs: number | null, family: 'req' | 'tok'): keyof LimitSpec | null {
  // No reset hint at all: a per-minute window is the common default and the
  // conservative read, since assuming "per day" would let a burst straight through.
  if (resetMs === null) return family === 'req' ? 'rpm' : 'tpm';
  if (resetMs <= 90_000) return family === 'req' ? 'rpm' : 'tpm';
  if (resetMs <= 26 * 3_600_000) return family === 'req' ? 'rpd' : 'tpd';
  return family === 'tok' ? 'tpmo' : null;
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

function authHeaders(provider: ResolvedProvider, key: KeyRef): { headers: Record<string, string>; query: [string, string] | null } {
  const auth = provider.spec.auth;
  const headers: Record<string, string> = { accept: 'application/json', ...provider.headers };
  let query: [string, string] | null = null;

  switch (auth.type) {
    case 'bearer':
      headers['authorization'] = `${auth.prefix ?? 'Bearer '}${key.value}`;
      break;
    case 'header':
      if (auth.header) headers[auth.header.toLowerCase()] = `${auth.prefix ?? ''}${key.value}`;
      break;
    case 'query':
      if (auth.query) query = [auth.query, key.value];
      break;
    case 'none':
      break;
  }
  return { headers, query };
}

function urlFor(provider: ResolvedProvider, path: string, query: [string, string] | null): string {
  const base = joinUrl(provider.baseUrl, path);
  if (!query) return base;
  const u = new URL(base);
  u.searchParams.set(query[0], query[1]);
  return u.toString();
}

function classify(status: number): ModelStatus {
  if (status === 200) return 'ok';
  if (status === 404) return 'unknown-model';
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 429) return 'rate-limited';
  // The model exists but disliked our probe body. Real id, wrong shape — do not
  // infer a chat capability from it.
  if (status === 400 || status === 422) return 'exists';
  return 'error';
}

export async function probeKey(provider: ResolvedProvider, key: KeyRef, options: ProbeOptions = {}): Promise<ProbeResult> {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 20_000;
  const started = Date.now();
  const { headers, query } = authHeaders(provider, key);

  const result: ProbeResult = {
    providerId: provider.id,
    keyId: key.id,
    keyMasked: key.masked,
    at: started,
    ms: 0,
    auth: 'unknown',
    discovered: [],
    models: [],
    observedLimits: {},
    errors: [],
  };

  const call = async (url: string, init: RequestInit): Promise<Response | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) }, signal: controller.signal });
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // ---- discovery ----------------------------------------------------------
  if (provider.spec.modelsEndpoint) {
    const res = await call(urlFor(provider, provider.spec.modelsEndpoint, query), { method: 'GET' });
    if (res === null) {
      result.auth = 'unreachable';
    } else {
      Object.assign(result.observedLimits, observedLimitsFrom(res.headers));
      if (res.ok) {
        result.auth = 'ok';
        const body: unknown = await res.json().catch(() => null);
        result.discovered = [...new Set(extractByPath(body, provider.spec.modelsPath))];
        if (result.discovered.length === 0) {
          result.errors.push(
            `models endpoint answered but modelsPath "${provider.spec.modelsPath}" matched nothing — check the response shape`,
          );
        }
      } else {
        result.auth = res.status === 401 ? 'invalid' : res.status === 403 ? 'forbidden' : res.status === 429 ? 'rate-limited' : 'unknown';
        result.errors.push(`GET ${provider.spec.modelsEndpoint} → ${res.status}`);
      }
    }
  }

  // Declared models come first: those are the ones the gateway can actually route
  // to today. Discovered-only ids are reported so they can be added to the file.
  const declared = provider.models.map((m) => m.spec.id);
  const discoveredOnly = result.discovered.filter((id) => !declared.includes(id));
  const toReport = [...declared, ...discoveredOnly];

  if (!options.validateModels) {
    result.models = toReport.map((id) => ({
      id,
      status: 'undiscovered' as ModelStatus,
      ms: null,
      error: null,
      discovered: !declared.includes(id),
    }));
    // Discovery alone still proves the credential works.
    if (result.auth === 'unknown' && result.discovered.length > 0) result.auth = 'ok';
    result.ms = Date.now() - started;
    return result;
  }

  // ---- validation ---------------------------------------------------------
  const targets = toReport.slice(0, options.maxModels ?? 40);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, 8));
  const probed: ProbedModel[] = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < targets.length) {
      const id = targets[cursor++];
      if (id === undefined) return;
      // For a declared model, trust its caps. For one we only just discovered
      // there is nothing to trust, so fall back to the id — probing an
      // embeddings model with a chat body just makes it look broken.
      const declaredModel = provider.models.find((m) => m.spec.id === id);
      const isEmbed = declaredModel
        ? declaredModel.spec.caps.includes('embed')
        : /(^|[-/])(embed|embedding)/i.test(id);
      const path = isEmbed ? '/embeddings' : '/chat/completions';
      const body = isEmbed
        ? { model: id, input: 'ping' }
        : { model: id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 };

      const at = Date.now();
      const res = await call(urlFor(provider, path, query), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res === null) {
        probed.push({ id, status: 'error', ms: Date.now() - at, error: 'no response', discovered: !declared.includes(id) });
        continue;
      }
      Object.assign(result.observedLimits, observedLimitsFrom(res.headers));

      const status = classify(res.status);
      let error: string | null = null;
      if (status !== 'ok') {
        const text = await res.text().catch(() => '');
        error = text.slice(0, 200) || `HTTP ${res.status}`;
      }
      probed.push({ id, status, ms: Date.now() - at, error, discovered: !declared.includes(id) });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  result.models = probed.sort((a, b) => targets.indexOf(a.id) - targets.indexOf(b.id));
  if (result.auth === 'unknown') {
    const anyOk = probed.some((p) => p.status === 'ok' || p.status === 'exists');
    const allForbidden = probed.length > 0 && probed.every((p) => p.status === 'forbidden');
    result.auth = anyOk ? 'ok' : allForbidden ? 'invalid' : 'unknown';
  }
  result.ms = Date.now() - started;
  return result;
}

/**
 * Where a provider's declared limits and its observed ones disagree.
 *
 * A key silently moved to a lower tier looks exactly like this, and nothing
 * else in the system would notice.
 */
export interface LimitDrift {
  key: keyof LimitSpec;
  declared: number | null;
  observed: number;
}

export function limitDrift(declared: LimitSpec, observed: Partial<LimitSpec>): LimitDrift[] {
  const out: LimitDrift[] = [];
  for (const [k, value] of Object.entries(observed)) {
    if (typeof value !== 'number') continue;
    const key = k as keyof LimitSpec;
    const current = declared[key];
    if (current === null || current === undefined) {
      out.push({ key, declared: null, observed: value });
    } else if (Math.abs(current - value) / Math.max(current, value) > 0.05) {
      out.push({ key, declared: current, observed: value });
    }
  }
  return out;
}
