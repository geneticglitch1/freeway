/**
 * The failover loop: walk candidates until one answers, then account for it.
 *
 * The rule that shapes this file: **once a byte of a stream has been written to
 * the client, failover is over**. A half-delivered SSE stream cannot be taken
 * back, so the commit point sits after the upstream returns 200 headers but
 * before its body is piped. A 429 arriving at that moment is still recoverable;
 * a 429 arriving one byte later is not.
 */

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import {
  ContextTooLargeError,
  SemanticCache,
  cacheKey,
  creditsFor,
  describeRefit,
  isCacheable,
  queryTextOf,
  refit,
  replayAsStream,
  systemPromptOf,
  type Blocked,
  type Candidate,
  type CacheEntry,
  type CacheTier,
  type ContextStore,
  type ExactCache,
  type FreewayConfig,
  type LimitSpec,
  type Logger,
  type Registry,
  type RefitMessage,
  type Router,
  type Store,
  previewOf,
  type Tokenizer,
} from '@freeway/core';

import { sendError, sendJson, type Res } from './http.ts';
import type { RouteRequest } from '@freeway/core';
import {
  callUpstream,
  completionText,
  deadline,
  estimateTokens,
  retryAfterMs,
  usageFromBody,
  type TokenUsage,
} from './upstream.ts';
import { UsageSniffer } from './sniffer.ts';
import { recordReply } from './session.ts';

export interface ProxyDeps {
  registry: Registry;
  store: Store;
  router: Router;
  config: FreewayConfig;
  logger: Logger;
  guard?: {
    limiter: { recordTokens(keyId: string | null, ip: string, tokens: number): void };
    calibrator: { observe(providerId: string, declared: LimitSpec, headers: Headers): unknown };
  };
  context?: {
    store: ContextStore;
    tokenizer: Tokenizer;
    /** Summarises a dropped span, routed back through this same gateway. */
    summarize?: (messages: RefitMessage[], budgetTokens: number) => Promise<string | null>;
  };
  cache?: {
    exact: ExactCache;
    semantic?: SemanticCache;
    /** Embeds a query for the semantic tier, through this same gateway. */
    embed?: (text: string) => Promise<number[] | null>;
  };
}

export interface ProxyRequest {
  route: RouteRequest;
  path: string;
  body: Record<string, unknown>;
  stream: boolean;
  /** Prompt text, used only to estimate tokens when a provider reports none. */
  promptText: string;
  requestedModel: string;
  /** Who asked, so inbound token limits can be charged to them. */
  caller?: { keyId: string | null; ip: string };
  /** Content-scan findings, recorded on the log entry. */
  findings?: { category: string; rule: string; path: string; severity: string }[];
  /** Set when the request carried a `session` id. */
  session?: { id: string; baseSeq: number; restored: number } | null;
  /** Full conversation after hydration, before any refit. */
  history?: RefitMessage[];
}

/** Used when a provider does not publish a model's window. Deliberately small. */
const DEFAULT_CONTEXT = 8192;

interface AttemptRecord {
  providerId: string;
  modelId: string;
  keyId: string | null;
  status: number | null;
  ms: number;
  error: string | null;
}

export async function proxy(deps: ProxyDeps, req: ProxyRequest, res: Res): Promise<void> {
  const { store, router, config, logger } = deps;
  const startedAt = Date.now();
  const requestId = store.nextRequestId();

  const result = router.route(req.route);

  // ---- cache ---------------------------------------------------------------
  // Checked after routing so the key can use the *resolution* rather than the
  // raw model string: `auto` and `fast` pointing at the same models should share
  // an entry. A hit costs no quota and no upstream call.
  const cacheable = deps.cache !== undefined && result.matched && isCacheable(deps.cache.exact.mode, req.body);
  let entryKey: string | null = null;
  let semanticScope: string | null = null;
  let queryText = '';
  /** Held from the miss path so a stored answer can be indexed without re-embedding. */
  let pendingEmbedding: number[] | null = null;

  if (cacheable && deps.cache) {
    entryKey = cacheKey(result.resolution, req.body);
    const hit = deps.cache.exact.get(entryKey);
    if (hit) {
      serveFromCache(deps, res, req, hit, 'exact', 1, result.resolution, requestId, startedAt);
      return;
    }

    const semantic = deps.cache.semantic;
    if (semantic?.enabled && deps.cache.embed && Array.isArray(req.body['messages'])) {
      const messages = req.body['messages'] as { role?: string; content?: unknown }[];
      queryText = queryTextOf(messages);
      semanticScope = SemanticCache.scopeOf(result.resolution, systemPromptOf(messages));

      if (queryText && !semantic.recentlyMissed(semanticScope, queryText)) {
        const embedding = await deps.cache.embed(queryText);
        if (embedding) {
          const match = semantic.search(embedding, semanticScope);
          if (match) {
            const entry = deps.cache.exact.get(match.entry.cacheKey);
            if (entry) {
              serveFromCache(deps, res, req, entry, 'semantic', match.score, result.resolution, requestId, startedAt);
              return;
            }
          }
          semantic.noteMiss(semanticScope, queryText);
          // Remember the vector so a hit can be stored once the answer arrives.
          pendingEmbedding = embedding;
        }
      }
    }
  }


  // Nothing matched the model string at all — that is a 404, not a capacity problem.
  if (!result.matched) {
    sendError(
      res,
      404,
      { message: `unknown model "${req.requestedModel}"`, type: 'invalid_request_error', code: 'model_not_found' },
      { requested: req.requestedModel, resolution: result.resolution, suggestions: result.suggestions },
      routeHeaders({ resolution: result.resolution, attempts: 0, ms: Date.now() - startedAt }),
    );
    logFailure(deps, requestId, req, result.resolution, [], 404, Date.now() - startedAt, `unknown model "${req.requestedModel}"`);
    return;
  }

  // The model exists but every provider offering it is blocked. The blocked list
  // *is* the error message, so it goes out in full.
  if (result.candidates.length === 0) {
    respondAllBlocked(deps, res, req, result.blocked, result.resolution, requestId, startedAt);
    return;
  }

  const attempts: AttemptRecord[] = [];
  const maxAttempts = Math.max(1, config.maxAttempts);
  const timeout = req.stream ? config.streamTimeoutMs : config.timeoutMs;

  // Candidates were chosen before the first call, so a provider benched partway
  // through this request is still sitting in the list with its other keys. A
  // provider-fault means every key will fail identically — skipping them spends
  // the attempt budget on a provider that might actually answer.
  const benched = new Set<string>();

  for (const candidate of result.candidates) {
    if (attempts.length >= maxAttempts) break;
    const { provider, model, key } = candidate;
    if (benched.has(provider.id)) continue;
    const keyId = provider.spec.auth.type === 'none' ? null : key.id;
    const dl = deadline(timeout);

    // Refit happens HERE, per candidate — not once up front. Each candidate has
    // a different context window, so a history that fits mistral's 128k has to
    // be reshaped again when the request fails over to an 8k model.
    let outgoing = req.body;
    let contextNote: string | null = null;

    if (req.history && req.history.length > 0) {
      try {
        const fitted = await refit(req.history, {
          contextWindow: model.spec.context ?? DEFAULT_CONTEXT,
          reserveOutputTokens: config.context.reserveOutputTokens,
          maxTurns: config.context.maxTurns,
          model: model.spec.id,
          ...(deps.context ? { tokenizer: deps.context.tokenizer } : {}),
          ...(deps.context?.summarize ? { summarize: deps.context.summarize } : {}),
        });
        outgoing = { ...req.body, messages: fitted.messages };
        contextNote = describeRefit(fitted);
      } catch (err) {
        if (err instanceof ContextTooLargeError) {
          // No trimming can help: the newest message alone exceeds the window.
          // Say so rather than silently mangling what the caller asked.
          sendError(res, 413,
            { message: err.message, type: 'invalid_request_error', code: 'context_too_large' },
            { provider: provider.id, model: model.spec.id, required: err.required, available: err.available },
            routeHeaders({ provider: provider.id, model: model.spec.id, resolution: result.resolution, attempts: attempts.length + 1, ms: Date.now() - startedAt }),
          );
          logFailure(deps, requestId, req, result.resolution, attempts, 413, Date.now() - startedAt, err.message);
          return;
        }
        throw err;
      }
    }

    const call = await callUpstream({
      candidate,
      path: req.path,
      body: { ...outgoing, model: model.spec.id },
      signal: dl.signal,
    });

    // ---- transport failure -------------------------------------------------
    if (call.response === null) {
      dl.cancel();
      const message = call.transportError ?? 'upstream call failed';
      store.recordFailure(provider.id, keyId, { status: null, message });
      attempts.push({ providerId: provider.id, modelId: model.spec.id, keyId, status: null, ms: call.ms, error: message });
      benched.add(provider.id);
      logger.warn(`${provider.id}/${model.spec.id} ${message}`);
      continue;
    }

    // Whatever the provider just said about its own limits is worth more than
    // whatever the JSON file claims. Observed on every reply, including errors —
    // a 429 usually carries the most accurate numbers of all.
    deps.guard?.calibrator.observe(provider.id, provider.spec.limits, call.response.headers);

    // ---- upstream error ----------------------------------------------------
    if (!call.ok) {
      dl.cancel();
      const status = call.status ?? 0;
      const errorBody = await safeJson(call.response);
      const message = extractMessage(errorBody) ?? `${status} from ${provider.id}`;
      const kind = store.recordFailure(provider.id, keyId, {
        status,
        message,
        // A provider telling us when to come back beats our configured guess.
        retryAfterMs: retryAfterMs(call.response) ?? config.cooldownSeconds * 1000,
      });
      attempts.push({ providerId: provider.id, modelId: model.spec.id, keyId, status, ms: call.ms, error: message });

      // A malformed request fails identically everywhere. Retrying it wastes
      // quota on a guaranteed failure, so it goes straight back to the caller.
      if (kind === 'request') {
        sendJson(res, status, errorBody ?? { error: { message, type: 'invalid_request_error', code: null } }, routeHeaders({
          provider: provider.id,
          model: model.spec.id,
          resolution: result.resolution,
          attempts: attempts.length,
          ms: Date.now() - startedAt,
        }));
        logFailure(deps, requestId, req, result.resolution, attempts, status, Date.now() - startedAt, message);
        return;
      }
      // A key fault leaves the pool's other keys worth trying; a provider fault
      // does not.
      if (kind === 'provider') benched.add(provider.id);
      continue;
    }

    // ---- success -----------------------------------------------------------
    const headers = routeHeaders({
      provider: provider.id,
      model: model.spec.id,
      resolution: result.resolution,
      attempts: attempts.length + 1,
      ms: Date.now() - startedAt,
      estimated: false,
    });
    // Both are derived from caller input; an unescapable byte here would make
    // writeHead throw and turn a good response into a 500.
    if (contextNote) headers['x-freeway-context'] = headerSafe(contextNote);
    if (req.session) headers['x-freeway-session'] = headerSafe(req.session.id);

    if (req.stream && call.response.body !== null) {
      await streamThrough(deps, res, candidate, call.response, headers, {
        requestId,
        req,
        resolution: result.resolution,
        attempts,
        startedAt,
        promptTokens: estimateTokens(req.promptText),
        ...(entryKey ? { cache: { key: entryKey, scope: semanticScope, queryText, embedding: pendingEmbedding } } : {}),
      });
      dl.cancel();
      return;
    }

    const bodyJson = await safeJson(call.response);
    dl.cancel();
    const usage = usageFromBody(bodyJson, req.promptText, completionText(bodyJson));
    if (usage.estimated) headers['x-freeway-usage'] = 'estimated';

    const credits = creditsFor(model.spec, provider.spec.limits, usage.promptTokens, usage.completionTokens);
    store.recordSuccess(provider.id, keyId, call.ms, usage.totalTokens, credits);
    if (req.caller) deps.guard?.limiter.recordTokens(req.caller.keyId, req.caller.ip, usage.totalTokens);

    if (entryKey && deps.cache && bodyJson) {
      deps.cache.exact.put(entryKey, JSON.stringify(bodyJson), provider.id, model.spec.id, usage.promptTokens, usage.completionTokens);
      if (pendingEmbedding && semanticScope && queryText) {
        deps.cache.semantic?.add(pendingEmbedding, entryKey, semanticScope, queryText);
      }
    }
    if (req.session && deps.context) {
      recordReply(deps.context.store, req.session.id, completionText(bodyJson), usage.completionTokens);
    }

    sendJson(res, 200, bodyJson ?? {}, headers);
    store.addLog({
      id: requestId,
      at: startedAt,
      requestedModel: req.requestedModel,
      resolution: result.resolution,
      providerId: provider.id,
      modelId: model.spec.id,
      keyId,
      attempts,
      status: 200,
      ms: Date.now() - startedAt,
      tokensIn: usage.promptTokens,
      tokensOut: usage.completionTokens,
      stream: false,
      cache: null,
      error: null,
      preview: { prompt: previewOf(req.promptText), response: previewOf(completionText(bodyJson)) },
    });
    return;
  }

  // Every candidate was tried and none answered.
  respondExhausted(deps, res, req, result.blocked, result.resolution, attempts, requestId, startedAt);
}

/**
 * Answer straight from the cache.
 *
 * A streaming client gets the response replayed as SSE, so a hit is
 * indistinguishable from a live call apart from the `x-freeway-cache` header
 * and the fact that it cost nothing.
 */
function serveFromCache(
  deps: ProxyDeps,
  res: Res,
  req: ProxyRequest,
  entry: CacheEntry,
  tier: CacheTier,
  score: number,
  resolution: string,
  requestId: string,
  startedAt: number,
): void {
  const headers = routeHeaders({
    provider: entry.providerId,
    model: entry.modelId,
    resolution,
    attempts: 0,
    ms: Date.now() - startedAt,
  });
  headers['x-freeway-cache'] = tier;
  if (tier === 'semantic') headers['x-freeway-cache-score'] = score.toFixed(4);

  if (req.stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      ...headers,
    });
    res.end(replayAsStream(entry.body));
  } else {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(entry.body);
    } catch {
      parsed = null;
    }
    sendJson(res, 200, parsed ?? {}, headers);
  }

  // Deliberately not metered: a cache hit spends no provider quota, and
  // counting it would make the quota bars lie.
  deps.store.addLog({
    id: requestId,
    at: startedAt,
    requestedModel: req.requestedModel,
    resolution,
    providerId: entry.providerId,
    modelId: entry.modelId,
    keyId: null,
    attempts: [],
    status: 200,
    ms: Date.now() - startedAt,
    tokensIn: entry.tokensIn,
    tokensOut: entry.tokensOut,
    stream: req.stream,
    cache: tier,
    error: null,
    preview: { prompt: previewOf(req.promptText), response: previewOf(cachedText(entry.body)) },
  });
}

/** Pull the assistant text out of a stored completion, for the log preview. */
function cachedText(body: string): string {
  try {
    return completionText(JSON.parse(body));
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

interface StreamContext {
  requestId: string;
  req: ProxyRequest;
  resolution: string;
  attempts: AttemptRecord[];
  startedAt: number;
  promptTokens: number;
  /** Cache slot to fill once the stream has finished and its text is known. */
  cache?: { key: string; scope: string | null; queryText: string; embedding: number[] | null };
}

/**
 * Pipe the upstream SSE body straight through with backpressure, sniffing the
 * final chunk for a usage block on the way past. Nothing is buffered: a slow
 * client slows the upstream read rather than filling memory here.
 */
async function streamThrough(
  deps: ProxyDeps,
  res: Res,
  candidate: Candidate,
  response: Response,
  headers: Record<string, string>,
  ctx: StreamContext,
): Promise<void> {
  const { store, logger } = deps;
  const { provider, model, key } = candidate;
  const keyId = provider.spec.auth.type === 'none' ? null : key.id;

  res.writeHead(200, {
    'content-type': response.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...headers,
  });

  const sniffer = new UsageSniffer();
  let failed: string | null = null;

  try {
    // `response.body` is a web stream; Node's Readable adapter needs the cast.
    await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), sniffer, res);
  } catch (err) {
    failed = err instanceof Error ? err.message : String(err);
    logger.warn(`stream from ${provider.id}/${model.spec.id} broke: ${failed}`);
  }

  // Streams only report usage in the very last chunk, which is why this cannot
  // happen at request time like the non-streaming path.
  const reported = sniffer.usage;
  const usage: TokenUsage = reported
    ? {
        promptTokens: reported.prompt_tokens ?? 0,
        completionTokens: reported.completion_tokens ?? 0,
        totalTokens: reported.total_tokens ?? (reported.prompt_tokens ?? 0) + (reported.completion_tokens ?? 0),
        estimated: false,
      }
    : {
        promptTokens: ctx.promptTokens,
        completionTokens: estimateTokens(sniffer.text),
        totalTokens: ctx.promptTokens + estimateTokens(sniffer.text),
        estimated: true,
      };

  const credits = creditsFor(model.spec, provider.spec.limits, usage.promptTokens, usage.completionTokens);
  const ms = Date.now() - ctx.startedAt;

  if (failed === null) {
    store.recordSuccess(provider.id, keyId, ms, usage.totalTokens, credits);
    if (ctx.req.caller) deps.guard?.limiter.recordTokens(ctx.req.caller.keyId, ctx.req.caller.ip, usage.totalTokens);
    // A stream's text is only complete once the pipe finishes, which is why the
    // session write happens here rather than at commit time.
    if (ctx.req.session && deps.context) recordReply(deps.context.store, ctx.req.session.id, sniffer.text, usage.completionTokens);
  } else {
    store.recordFailure(provider.id, keyId, { status: null, message: failed });
  }

  // A stream can only be cached once it has finished, because its text does not
  // exist until then. Reassembled into the non-streaming shape so a later hit
  // can be replayed either way.
  if (failed === null && ctx.cache && deps.cache && sniffer.text) {
    const assembled = JSON.stringify({
      id: `chatcmpl-${ctx.requestId}`,
      object: 'chat.completion',
      created: Math.floor(ctx.startedAt / 1000),
      model: model.spec.id,
      choices: [{ index: 0, message: { role: 'assistant', content: sniffer.text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens },
    });
    deps.cache.exact.put(ctx.cache.key, assembled, provider.id, model.spec.id, usage.promptTokens, usage.completionTokens);
    if (ctx.cache.embedding && ctx.cache.scope && ctx.cache.queryText) {
      deps.cache.semantic?.add(ctx.cache.embedding, ctx.cache.key, ctx.cache.scope, ctx.cache.queryText);
    }
  }

  store.addLog({
    id: ctx.requestId,
    at: ctx.startedAt,
    requestedModel: ctx.req.requestedModel,
    resolution: ctx.resolution,
    providerId: provider.id,
    modelId: model.spec.id,
    keyId,
    attempts: ctx.attempts,
    status: failed === null ? 200 : 499,
    ms,
    tokensIn: usage.promptTokens,
    tokensOut: usage.completionTokens,
    stream: true,
    cache: null,
    error: failed,
    preview: { prompt: previewOf(ctx.req.promptText), response: previewOf(sniffer.text) },
  });
}

// ---------------------------------------------------------------------------
// Failure responses
// ---------------------------------------------------------------------------

function respondAllBlocked(
  deps: ProxyDeps,
  res: Res,
  req: ProxyRequest,
  blocked: Blocked[],
  resolution: string,
  requestId: string,
  startedAt: number,
): void {
  const soonest = shortestRetry(blocked);
  const headers = routeHeaders({ resolution, attempts: 0, ms: Date.now() - startedAt });
  if (soonest !== null) headers['retry-after'] = String(Math.max(1, Math.ceil(soonest / 1000)));

  sendError(
    res,
    429,
    {
      message: `no provider currently available for model "${req.requestedModel}" — ${blocked.length} candidate${blocked.length === 1 ? '' : 's'} blocked`,
      type: 'rate_limit_error',
      code: 'all_providers_blocked',
    },
    {
      requested: req.requestedModel,
      resolution,
      retryAfterMs: soonest,
      blocked: blocked.map((b) => ({ provider: b.providerId, model: b.modelId, reason: b.reason, retryAfterMs: b.retryAfterMs })),
    },
    headers,
  );

  logFailure(deps, requestId, req, resolution, [], 429, Date.now() - startedAt, 'all providers blocked');
}

function respondExhausted(
  deps: ProxyDeps,
  res: Res,
  req: ProxyRequest,
  blocked: Blocked[],
  resolution: string,
  attempts: AttemptRecord[],
  requestId: string,
  startedAt: number,
): void {
  const lastStatus = attempts.length > 0 ? attempts[attempts.length - 1]?.status : null;
  const status = lastStatus === 429 ? 429 : 502;
  const headers = routeHeaders({ resolution, attempts: attempts.length, ms: Date.now() - startedAt });

  sendError(
    res,
    status,
    {
      message: `every provider failed for model "${req.requestedModel}" after ${attempts.length} attempt${attempts.length === 1 ? '' : 's'}`,
      type: status === 429 ? 'rate_limit_error' : 'api_error',
      code: 'all_attempts_failed',
    },
    {
      requested: req.requestedModel,
      resolution,
      attempts: attempts.map((a) => ({ provider: a.providerId, model: a.modelId, status: a.status, ms: a.ms, error: a.error })),
      blocked: blocked.map((b) => ({ provider: b.providerId, model: b.modelId, reason: b.reason, retryAfterMs: b.retryAfterMs })),
    },
    headers,
  );

  logFailure(deps, requestId, req, resolution, attempts, status, Date.now() - startedAt, 'all attempts failed');
}

function logFailure(
  deps: ProxyDeps,
  requestId: string,
  req: ProxyRequest,
  resolution: string,
  attempts: AttemptRecord[],
  status: number,
  ms: number,
  error: string,
): void {
  const last = attempts[attempts.length - 1];
  deps.store.addLog({
    id: requestId,
    at: Date.now() - ms,
    requestedModel: req.requestedModel,
    resolution,
    providerId: last?.providerId ?? null,
    modelId: last?.modelId ?? null,
    keyId: last?.keyId ?? null,
    attempts,
    status,
    ms,
    tokensIn: 0,
    tokensOut: 0,
    stream: req.stream,
    cache: null,
    error,
    preview: { prompt: previewOf(req.promptText), response: '' },
  });
}

function shortestRetry(blocked: Blocked[]): number | null {
  let soonest: number | null = null;
  for (const b of blocked) {
    if (b.retryAfterMs === null) continue;
    soonest = soonest === null ? b.retryAfterMs : Math.min(soonest, b.retryAfterMs);
  }
  return soonest;
}

interface RouteHeaderInput {
  provider?: string;
  model?: string;
  resolution: string;
  attempts: number;
  ms: number;
  estimated?: boolean;
}

/**
 * Strip anything a header value cannot legally carry.
 *
 * Resolution strings are built from user-supplied model names and provider ids,
 * so a stray non-latin-1 byte would make `writeHead` throw and turn a perfectly
 * good response into a 500. Sanitising at the boundary means no future caller
 * has to remember this.
 */
function headerSafe(value: string): string {
  // eslint-disable-next-line no-control-regex -- control chars are exactly what must go
  return value.replace(/[^\x20-\x7E]/g, '?').slice(0, 512);
}

/** Every reply carries these, so a curl tells you what happened without the dashboard. */
function routeHeaders(input: RouteHeaderInput): Record<string, string> {
  const headers: Record<string, string> = {
    'x-freeway-route': headerSafe(input.resolution),
    'x-freeway-attempts': String(input.attempts),
    'x-freeway-ms': String(input.ms),
  };
  if (input.provider) headers['x-freeway-provider'] = headerSafe(input.provider);
  if (input.model) headers['x-freeway-model'] = headerSafe(input.model);
  return headers;
}

async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await response.text();
    if (!text) return null;
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractMessage(body: Record<string, unknown> | null): string | null {
  const error = body?.['error'];
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  const message = body?.['message'];
  return typeof message === 'string' ? message : null;
}
