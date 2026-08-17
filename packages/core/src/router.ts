/**
 * Turn a model string into an ordered list of provider+model+key triples to try.
 *
 * Two outputs matter equally. `candidates` is what the gateway walks. `blocked`
 * is what the caller sees when nothing is viable — it *is* the error message, so
 * every rejection carries a specific reason rather than a generic "unavailable".
 * "tpm limit reached (500.0K/500.0K last 60s)" tells you to wait; "unavailable"
 * tells you nothing.
 */

import type { Registry } from './registry.ts';
import type { Store } from './store.ts';
import type { Blocked, Cap, Candidate, FreewayConfig, LimitSpec, ResolvedModel, ResolvedProvider, Strategy } from './types.ts';

export interface RouteRequest {
  /** The `model` field from the request body. */
  model: string;
  /** Capabilities derived from the body — tools, json, vision. */
  requiredCaps?: Cap[];
  /** Reject models whose window is smaller than this. */
  minContext?: number;
  /** Estimated prompt tokens, checked against quota before sending. */
  estTokens?: number;
  /** `/v1/embeddings` needs embedding models; chat routes must exclude them. */
  embedding?: boolean;
  /** Overrides the configured strategy for one call. */
  strategy?: Strategy;
}

export interface RouteResult {
  candidates: Candidate[];
  blocked: Blocked[];
  /** Human-readable account of how the model string was interpreted. */
  resolution: string;
  /**
   * Whether the model string matched anything at all, before filtering.
   * False means 404 (unknown model); true with no candidates means 429.
   */
  matched: boolean;
  /** Closest ids by edit distance, for a 404 body. */
  suggestions: string[];
}

const AUTO_TOKENS = new Set(['', 'auto', 'freeway', 'any', 'default']);

export class Router {
  private readonly registry: Registry;
  private readonly store: Store;
  private config: FreewayConfig;
  /**
   * Lets the guard layer substitute limits learned from upstream headers for the
   * ones declared in the JSON file. Without it, a provider whose file says
   * `null` would be treated as unlimited forever.
   */
  private limitsFor: (providerId: string, declared: LimitSpec) => LimitSpec;

  constructor(registry: Registry, store: Store, config: FreewayConfig) {
    this.registry = registry;
    this.store = store;
    this.config = config;
    this.limitsFor = (_id, declared) => declared;
  }

  setLimitsResolver(resolve: (providerId: string, declared: LimitSpec) => LimitSpec): void {
    this.limitsFor = resolve;
  }

  setConfig(config: FreewayConfig): void {
    this.config = config;
  }

  route(req: RouteRequest): RouteResult {
    const wanted = (req.model ?? '').trim();
    const { models, resolution, matched } = this.resolve(wanted, req);

    if (!matched) {
      return { candidates: [], blocked: [], resolution, matched: false, suggestions: this.suggest(wanted) };
    }

    const blocked: Blocked[] = [];
    const viable: { provider: ResolvedProvider; model: ResolvedModel; keys: string[] }[] = [];

    for (const model of models) {
      const provider = this.registry.get(model.providerId);
      if (!provider) continue;
      const reason = this.rejectPair(provider, model, req);
      if (reason) {
        blocked.push({ providerId: provider.id, modelId: model.spec.id, reason: reason.reason, retryAfterMs: reason.retryAfterMs });
        continue;
      }
      const keys = this.viableKeys(provider, model, req, blocked);
      if (keys.length > 0) viable.push({ provider, model, keys });
    }

    const sorted = this.sort(viable, req.strategy ?? this.config.strategy);

    const candidates: Candidate[] = [];
    for (const entry of sorted) {
      for (const keyId of entry.keys) {
        const key = entry.provider.keys.find((k) => k.id === keyId);
        if (key) candidates.push({ provider: entry.provider, model: entry.model, key });
      }
      // A keyless provider (a local Ollama) still needs one candidate.
      if (entry.keys.length === 0 && entry.provider.spec.auth.type === 'none') {
        candidates.push({
          provider: entry.provider,
          model: entry.model,
          key: { id: `${entry.provider.id}#none`, providerId: entry.provider.id, index: 0, value: '', masked: '', source: 'none' },
        });
      }
    }

    return { candidates, blocked, resolution, matched: true, suggestions: [] };
  }

  // -------------------------------------------------------------------------
  // Model string resolution
  // -------------------------------------------------------------------------

  private resolve(wanted: string, req: RouteRequest): { models: ResolvedModel[]; resolution: string; matched: boolean } {
    const all = this.registry.allModels();
    const kindFiltered = all.filter((m) => this.matchesKind(m, req));

    // 1. auto — everything that can serve this kind of request.
    if (AUTO_TOKENS.has(wanted.toLowerCase())) {
      return { models: kindFiltered, resolution: 'auto', matched: kindFiltered.length > 0 };
    }

    // 2. provider/model pin. Split on the FIRST slash only: Cloudflare model ids
    // like @cf/meta/llama-3.1-8b-instruct contain slashes of their own.
    const slash = wanted.indexOf('/');
    if (slash > 0) {
      const providerId = wanted.slice(0, slash);
      const modelPart = wanted.slice(slash + 1);
      const provider = this.registry.get(providerId);
      if (provider) {
        if (modelPart === '*') {
          const models = provider.models.filter((m) => this.matchesKind(m, req));
          return { models, resolution: `pin:${providerId}/*`, matched: true };
        }
        const exact = provider.models.filter((m) => m.spec.id === modelPart);
        if (exact.length > 0) return { models: exact, resolution: `pin:${wanted}`, matched: true };
        // Pinned provider, unknown model — still a match failure, but a specific one.
        const fuzzy = provider.models.filter((m) => m.spec.id.toLowerCase().includes(modelPart.toLowerCase()));
        if (fuzzy.length > 0) return { models: fuzzy, resolution: `pin-fuzzy:${wanted}`, matched: true };
        return { models: [], resolution: `pin:${wanted}`, matched: false };
      }
    }

    const lower = wanted.toLowerCase();

    // 3. Alias from freeway.config.json — user-defined aliases win over registry ones.
    const configTarget = this.config.aliases[wanted] ?? this.config.aliases[lower];
    if (configTarget !== undefined) {
      const inner = this.resolve(configTarget, req);
      // ASCII only: this string is served as `x-freeway-route`, and a header
      // value must be latin-1. A Unicode arrow here makes writeHead throw and
      // turns every aliased request into a 500.
      return { models: inner.models, resolution: `alias:${wanted}->${configTarget}`, matched: inner.matched };
    }

    // 4. Alias declared by a model in the registry.
    //
    // Scanned directly rather than through `registry.aliases()`, which hides
    // disabled entries. A disabled provider must still reach the filter below so
    // it can be reported as blocked — silently vanishing is exactly the failure
    // the `blocked` list exists to prevent.
    const aliasMatches = kindFiltered.filter((m) => m.spec.alias.some((a) => a === wanted || a.toLowerCase() === lower));
    if (aliasMatches.length > 0) return { models: aliasMatches, resolution: `alias:${wanted}`, matched: true };

    // 5. Exact upstream model id, possibly offered by several providers.
    const exact = kindFiltered.filter((m) => m.spec.id === wanted);
    if (exact.length > 0) return { models: exact, resolution: `model:${wanted}`, matched: true };

    // 6. Fuzzy substring — `llama-3.1-8b` should find `@cf/meta/llama-3.1-8b-instruct`.
    const fuzzy = kindFiltered.filter((m) => m.spec.id.toLowerCase().includes(lower) || m.ref.toLowerCase().includes(lower));
    if (fuzzy.length > 0) return { models: fuzzy, resolution: `fuzzy:${wanted}`, matched: true };

    return { models: [], resolution: `unmatched:${wanted}`, matched: false };
  }

  /** Embedding requests need embedding models; chat requests must not get them. */
  private matchesKind(m: ResolvedModel, req: RouteRequest): boolean {
    return req.embedding === true ? m.spec.caps.includes('embed') : m.spec.caps.includes('chat');
  }

  // -------------------------------------------------------------------------
  // Filtering
  // -------------------------------------------------------------------------

  private rejectPair(
    provider: ResolvedProvider,
    model: ResolvedModel,
    req: RouteRequest,
  ): { reason: string; retryAfterMs: number | null } | null {
    if (!provider.enabled) return { reason: 'provider disabled', retryAfterMs: null };
    if (!provider.configured) return { reason: `provider not configured: ${provider.configError ?? 'unknown reason'}`, retryAfterMs: null };
    if (!model.spec.enabled) return { reason: 'model disabled', retryAfterMs: null };

    for (const cap of req.requiredCaps ?? []) {
      if (!model.spec.caps.includes(cap)) return { reason: `missing capability: ${cap}`, retryAfterMs: null };
    }

    if (req.minContext !== undefined && req.minContext > 0) {
      if (model.spec.context === null) {
        return { reason: `context window unknown, cannot guarantee ${req.minContext} tokens`, retryAfterMs: null };
      }
      if (model.spec.context < req.minContext) {
        return { reason: `context window ${model.spec.context} < required ${req.minContext}`, retryAfterMs: null };
      }
    }

    const pState = this.store.provider(provider.id);
    const now = Date.now();
    if (pState.cooldownUntil > now) {
      const secs = Math.ceil((pState.cooldownUntil - now) / 1000);
      return {
        reason: `provider cooling down for ${secs}s: ${pState.lastError ?? 'recent failure'}`,
        retryAfterMs: pState.cooldownUntil - now,
      };
    }

    const check = pState.meter.check(this.limitsFor(provider.id, provider.spec.limits), req.estTokens ?? 0);
    if (!check.ok) return { reason: check.reason ?? 'quota exhausted', retryAfterMs: check.retryAfterMs };

    return null;
  }

  /** Keys that are neither benched nor out of their own quota. */
  private viableKeys(provider: ResolvedProvider, model: ResolvedModel, req: RouteRequest, blocked: Blocked[]): string[] {
    if (provider.spec.auth.type === 'none') return [];

    const now = Date.now();
    const viable: string[] = [];
    const reasons: string[] = [];
    let soonest: number | null = null;

    for (const key of provider.keys) {
      const kState = this.store.key(provider.id, key.id);
      if (kState.cooldownUntil > now) {
        const wait = kState.cooldownUntil - now;
        soonest = soonest === null ? wait : Math.min(soonest, wait);
        reasons.push(`${key.id} (${key.masked}) cooling down for ${Math.ceil(wait / 1000)}s: ${kState.lastError ?? kState.status}`);
        continue;
      }
      const check = kState.meter.check(this.limitsFor(provider.id, provider.spec.limits), req.estTokens ?? 0);
      if (!check.ok) {
        if (check.retryAfterMs !== null) soonest = soonest === null ? check.retryAfterMs : Math.min(soonest, check.retryAfterMs);
        reasons.push(`${key.id} (${key.masked}) ${check.reason ?? 'quota exhausted'}`);
        continue;
      }
      viable.push(key.id);
    }

    if (viable.length === 0 && provider.keys.length > 0) {
      blocked.push({
        providerId: provider.id,
        modelId: model.spec.id,
        reason: `all ${provider.keys.length} key${provider.keys.length > 1 ? 's' : ''} unavailable — ${reasons.join('; ')}`,
        retryAfterMs: soonest,
      });
    }

    // Rotate so a pool actually spreads load rather than always hammering key #0.
    if (viable.length > 1) {
      const offset = this.store.nextCursor(provider.id) % viable.length;
      return [...viable.slice(offset), ...viable.slice(0, offset)];
    }
    return viable;
  }

  // -------------------------------------------------------------------------
  // Ordering
  // -------------------------------------------------------------------------

  private sort<T extends { provider: ResolvedProvider; model: ResolvedModel; keys: string[] }>(entries: T[], strategy: Strategy): T[] {
    const out = [...entries];
    switch (strategy) {
      case 'priority':
        out.sort(byPriority);
        break;

      case 'least-used':
        out.sort((a, b) => {
          const ua = this.store.provider(a.provider.id).meter.used('rpm');
          const ub = this.store.provider(b.provider.id).meter.used('rpm');
          return ua - ub || byPriority(a, b);
        });
        break;

      case 'fastest':
        out.sort((a, b) => {
          // Optimistic initialisation: an untried provider sorts first so it gets
          // sampled once and earns a real number, rather than never being tried.
          const la = this.store.provider(a.provider.id).latencyMs ?? 0;
          const lb = this.store.provider(b.provider.id).latencyMs ?? 0;
          return la - lb || byPriority(a, b);
        });
        break;

      case 'round-robin': {
        out.sort(byPriority);
        if (out.length > 1) {
          const offset = this.store.nextCursor('__router__') % out.length;
          return [...out.slice(offset), ...out.slice(0, offset)];
        }
        break;
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 404 suggestions
  // -------------------------------------------------------------------------

  /** Closest known ids, so an unknown model returns something actionable. */
  suggest(wanted: string, limit = 5): string[] {
    const q = wanted.toLowerCase();
    if (!q) return [];
    const scored = this.registry
      .allModels()
      .map((m) => ({ ref: m.ref, score: similarity(q, m.spec.id.toLowerCase()) }))
      .sort((a, b) => b.score - a.score)
      .filter((s) => s.score > 0.2);
    return scored.slice(0, limit).map((s) => s.ref);
  }
}

function byPriority(
  a: { provider: ResolvedProvider; model: ResolvedModel },
  b: { provider: ResolvedProvider; model: ResolvedModel },
): number {
  return (
    a.provider.spec.priority - b.provider.spec.priority ||
    a.model.spec.priority - b.model.spec.priority ||
    a.model.ref.localeCompare(b.model.ref)
  );
}

/** Normalised edit distance, 0..1. Cheap enough to run over a few hundred ids. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.9;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length] ?? 0;
}
