/**
 * The gateway server. Plain `node:http`, one dispatch function, no framework.
 */

import { createServer as createHttpServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  Calibrator,
  KeyHealthMonitor,
  Limiter,
  consoleLogger,
  forecastProvider,
  fingerprint,
  probeKey,
  scanBody,
  type FreewayConfig,
  type KeyVault,
  type Logger,
  type ProbeResult,
  type Registry,
  type ResolvedModel,
  type Router,
  ContextStore,
  ExactCache,
  SemanticCache,
  Tokenizer,
  type Finding,
  type LimitSpec,
  type RefitMessage,
  type Store,
} from '@freeway/core';

import { bearerToken, clientIp, isLoopback, readBody, safeEqual, sendError, sendJson, sendText, type Req, type Res } from './http.ts';
import { proxy, type ProxyDeps } from './proxy.ts';
import { callUpstream, capsFromBody, deadline, textOfMessages, estimateTokens } from './upstream.ts';
import { SessionForbiddenError, hydrate } from './session.ts';

export interface GatewayOptions {
  registry: Registry;
  store: Store;
  router: Router;
  config: FreewayConfig;
  logger?: Logger;
  /** Directory holding the dashboard. Defaults to the package's `public/`. */
  publicDir?: string;
  /** Called by `POST /api/reload`. */
  onReload?: () => void;
  /** Enables the dashboard's paste-a-key flow when present. */
  vault?: KeyVault;
  /** Shared guard state. Created here when not supplied, so tests can inject. */
  limiter?: Limiter;
  calibrator?: Calibrator;
  keyHealth?: KeyHealthMonitor;
  /** Enables server-side sessions when present. */
  contextStore?: ContextStore;
  tokenizer?: Tokenizer;
  /** Enables response caching when present. */
  cache?: ExactCache;
  semanticCache?: SemanticCache;
}

/** Guard components, created once per gateway. */
export interface Guard {
  limiter: Limiter;
  calibrator: Calibrator;
  keyHealth: KeyHealthMonitor;
}

export function createGateway(opts: GatewayOptions): Server {
  const logger = opts.logger ?? consoleLogger;
  const publicDir = opts.publicDir ?? join(import.meta.dirname, '..', 'public');
  const guard: Guard = {
    limiter: opts.limiter ?? new Limiter(opts.config.guard),
    calibrator: opts.calibrator ?? new Calibrator(opts.config.guard.calibrate),
    keyHealth: opts.keyHealth ?? new KeyHealthMonitor({ logger }),
  };
  const deps: ProxyDeps = {
    registry: opts.registry, store: opts.store, router: opts.router,
    config: opts.config, logger, guard,
  };
  // Routing decisions use observed limits, not just declared ones.
  opts.router.setLimitsResolver((id, declared) => guard.calibrator.effective(id, declared));

  if (opts.cache && opts.cache.mode !== 'off') {
    deps.cache = {
      exact: opts.cache,
      ...(opts.semanticCache ? { semanticCache: opts.semanticCache } : {}),
    };
    if (opts.semanticCache?.enabled) {
      deps.cache.semantic = opts.semanticCache;
      // Embedding goes through this gateway too, so it lands on whichever
      // provider has embedding headroom rather than a hardcoded one.
      deps.cache.embed = makeEmbedder(deps, opts.config.cache.semantic.model);
    }
  }

  if (opts.contextStore && opts.config.context.enabled) {
    const tokenizer = opts.tokenizer ?? new Tokenizer();
    deps.context = {
      store: opts.contextStore,
      tokenizer,
      // Compaction is itself a completion, routed through this same gateway so
      // it picks a provider with headroom instead of the one that just ran out.
      summarize: makeSummarizer(deps, opts.config.context.compactModel, opts.contextStore),
    };
  }

  return createHttpServer((req, res) => {
    handle(req, res, opts, deps, publicDir, logger, guard).catch((err: unknown) => {
      logger.error(`unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      sendError(res, 500, { message: 'internal gateway error', type: 'api_error', code: null });
    });
  });
}

async function handle(
  req: Req, res: Res, opts: GatewayOptions, deps: ProxyDeps,
  publicDir: string, logger: Logger, guard: Guard,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';
  const config = opts.config;

  // Applied to every response, not just the preflight — a listed origin that
  // gets a 200 with no allow-origin header still cannot read it.
  for (const [name, value] of Object.entries(cors(req, config))) res.setHeader(name, value);

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ---- unauthenticated -----------------------------------------------------
  if (path === '/healthz') {
    const stats = opts.store.stats();
    const providers = opts.registry.all();
    sendJson(res, 200, {
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      providers: { total: providers.length, usable: opts.registry.usable().length },
      requests: stats,
    });
    return;
  }

  if (path === '/' && method === 'GET') {
    serveDashboard(res, publicDir);
    return;
  }

  // ---- virtual key gate ----------------------------------------------------
  //
  // Real provider keys never leave this process. Apps present an `fw-` key from
  // the config instead, so a leaked app credential costs a rotation here rather
  // than at every provider.
  const auth = checkVirtualKey(req, config);
  if (!auth.ok) {
    sendError(res, 401, { message: auth.message, type: 'invalid_request_error', code: 'invalid_api_key' }, {}, cors(req, config));
    return;
  }

  // ---- OpenAI surface ------------------------------------------------------
  if (path === '/v1/chat/completions' || path === '/v1/embeddings') {
    if (method !== 'POST') {
      sendError(res, 405, { message: `${path} requires POST`, type: 'invalid_request_error', code: 'method_not_allowed' });
      return;
    }
    // Inbound abuse protection runs before any upstream work, so a runaway
    // caller cannot spend provider quota it was never entitled to.
    const decision = guard.limiter.check(auth.keyId, clientIp(req), 0);
    if (!decision.ok) {
      const retryAfter = Math.max(1, Math.ceil((decision.retryAfterMs ?? 1000) / 1000));
      sendError(res, 429,
        { message: decision.reason ?? 'rate limited', type: 'rate_limit_error', code: 'caller_rate_limited' },
        { scope: decision.scope, retryAfterMs: decision.retryAfterMs },
        { 'retry-after': String(retryAfter), 'x-freeway-limit-scope': decision.scope ?? '' },
      );
      return;
    }

    const release = guard.limiter.enter(auth.keyId, clientIp(req));
    try {
      if (path === '/v1/chat/completions') await handleChat(req, res, deps, auth.keyId, clientIp(req));
      else await handleEmbeddings(req, res, deps, auth.keyId, clientIp(req));
    } finally {
      release();
    }
    return;
  }
  if (path === '/v1/models' && method === 'GET') return handleModels(res, opts);

  // ---- dashboard API -------------------------------------------------------
  //
  // Everything below is administrative: it reads stored conversations, writes
  // credentials, or spends quota. One gate, applied before any of it.
  if (path.startsWith('/api/')) {
    const admin = allowAdmin(auth, config);
    if (!admin.ok) {
      sendError(res, 403, { message: admin.message, type: 'invalid_request_error', code: 'admin_required' }, {}, cors(req, config));
      return;
    }
  }

  if (path === '/api/providers' && method === 'GET') return handleProviders(res, opts, guard);
  if (path === '/api/stats' && method === 'GET') return handleStats(res, opts);
  if (path === '/api/logs' && method === 'GET') return handleLogs(res, opts, url);
  if (path === '/api/events' && method === 'GET') return handleEvents(req, res, opts);
  if (path === '/api/alerts' && method === 'GET') return handleAlerts(res, opts, guard);
  if (path === '/api/sessions' && method === 'GET') return handleSessions(res, opts, deps);
  if (path === '/api/cache' && method === 'GET') return handleCacheStats(res, deps, opts);
  if (path === '/api/usage' && method === 'GET') return handleUsage(res, opts, guard);
  if (path === '/api/cache' && method === 'DELETE') {
    deps.cache?.exact.clear();
    deps.cache?.semantic?.clear();
    sendJson(res, 200, { ok: true });
    return;
  }
  const sessionRoute = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (sessionRoute) {
    const id = decodeURIComponent(sessionRoute[1] ?? '');
    if (method === 'GET') return handleSession(res, opts, deps, id);
    if (method === 'DELETE') return handleSessionDelete(res, deps, id);
  }
  if (path === '/api/keyhealth' && method === 'POST') return handleKeyHealth(res, opts, guard);

  const toggle = /^\/api\/providers\/([^/]+)\/enabled$/.exec(path);
  if (toggle && method === 'POST') return handleToggle(req, res, opts, decodeURIComponent(toggle[1] ?? ''));

  const keyRoute = /^\/api\/providers\/([^/]+)\/key$/.exec(path);
  if (keyRoute && (method === 'POST' || method === 'DELETE')) {
    return handleKey(req, res, opts, decodeURIComponent(keyRoute[1] ?? ''), method, logger);
  }

  const probeRoute = /^\/api\/providers\/([^/]+)\/probe$/.exec(path);
  if (probeRoute && method === 'POST') return handleProbe(req, res, opts, decodeURIComponent(probeRoute[1] ?? ''));

  if (path === '/api/reload' && method === 'POST') {
    opts.onReload?.();
    opts.registry.reload();
    logger.info(`reloaded providers — ${opts.registry.all().length} loaded, ${opts.registry.usable().length} usable`);
    sendJson(res, 200, { ok: true, providers: opts.registry.all().length, usable: opts.registry.usable().length, issues: opts.registry.issues() });
    return;
  }

  sendError(res, 404, { message: `no route for ${method} ${path}`, type: 'invalid_request_error', code: 'not_found' });
}

// ---------------------------------------------------------------------------
// OpenAI-compatible handlers
// ---------------------------------------------------------------------------

async function handleChat(req: Req, res: Res, deps: ProxyDeps, callerKeyId: string | null, ip: string): Promise<void> {
  const parsed = await parseJsonBody(req, res, deps.config.guard.maxBodyBytes);
  if (!parsed) return;

  const scan = scanRequest(parsed, deps);
  if (scan.blocked) {
    sendError(res, 400,
      { message: 'request blocked by content scanning', type: 'invalid_request_error', code: 'content_blocked' },
      { findings: scan.findings });
    return;
  }

  const messages = parsed['messages'];
  if (!Array.isArray(messages) || messages.length === 0) {
    sendError(res, 400, { message: '`messages` must be a non-empty array', type: 'invalid_request_error', code: 'missing_messages' });
    return;
  }
  if (messages.length > deps.config.guard.maxMessages) {
    sendError(res, 400, {
      message: `too many messages (${messages.length} > ${deps.config.guard.maxMessages})`,
      type: 'invalid_request_error',
      code: 'too_many_messages',
    });
    return;
  }

  const requestedModel = typeof parsed['model'] === 'string' ? parsed['model'] : 'auto';
  const stream = parsed['stream'] === true;

  // `session` is a Freeway extension; it must never reach a provider.
  const sessionId = typeof parsed['session'] === 'string' && parsed['session'].trim() ? parsed['session'].trim() : null;
  delete parsed['session'];

  let history: RefitMessage[] | undefined;
  let session: { id: string; baseSeq: number; restored: number } | null = null;
  if (sessionId && deps.context) {
    try {
      const hydrated = hydrate(deps.context.store, sessionId, messages as RefitMessage[], deps.context.tokenizer, requestedModel, callerKeyId);
      history = hydrated.messages;
      session = hydrated.session;
      parsed['messages'] = hydrated.messages;
    } catch (err) {
      if (err instanceof SessionForbiddenError) {
        sendError(res, 403, { message: err.message, type: 'invalid_request_error', code: 'session_forbidden' });
        return;
      }
      throw err;
    }
  } else if (deps.context) {
    // Even without a session, history is refit per candidate so a failover to a
    // smaller window still works.
    history = messages as RefitMessage[];
  }

  const promptText = textOfMessages(parsed['messages']);

  await proxy(
    deps,
    {
      route: {
        model: requestedModel,
        requiredCaps: capsFromBody(parsed),
        estTokens: estimateTokens(promptText),
      },
      path: '/chat/completions',
      body: parsed,
      stream,
      promptText,
      requestedModel,
      caller: { keyId: callerKeyId, ip },
      findings: scan.findings,
      session,
      ...(history ? { history } : {}),
    },
    res,
  );
}

async function handleEmbeddings(req: Req, res: Res, deps: ProxyDeps, callerKeyId: string | null, ip: string): Promise<void> {
  const parsed = await parseJsonBody(req, res, deps.config.guard.maxBodyBytes);
  if (!parsed) return;

  const scan = scanRequest(parsed, deps);
  if (scan.blocked) {
    sendError(res, 400,
      { message: 'request blocked by content scanning', type: 'invalid_request_error', code: 'content_blocked' },
      { findings: scan.findings });
    return;
  }

  const input = parsed['input'];
  if (input === undefined || input === null) {
    sendError(res, 400, { message: '`input` is required', type: 'invalid_request_error', code: 'missing_input' });
    return;
  }

  const requestedModel = typeof parsed['model'] === 'string' ? parsed['model'] : 'auto';
  const promptText = Array.isArray(input) ? input.map((i) => String(i)).join('\n') : String(input);

  await proxy(
    deps,
    {
      route: { model: requestedModel, embedding: true, estTokens: estimateTokens(promptText) },
      path: '/embeddings',
      body: parsed,
      stream: false,
      promptText,
      requestedModel,
      caller: { keyId: callerKeyId, ip },
      findings: scan.findings,
    },
    res,
  );
}

/** Flattened catalog in OpenAI shape, plus aliases exposed as virtual models. */
function handleModels(res: Res, opts: GatewayOptions): void {
  const created = Math.floor(Date.now() / 1000);
  const data: Record<string, unknown>[] = [];

  for (const provider of opts.registry.all()) {
    for (const model of provider.models) {
      data.push({
        id: model.ref,
        object: 'model',
        created,
        owned_by: provider.id,
        freeway: {
          provider: provider.id,
          providerLabel: provider.label,
          model: model.spec.id,
          label: model.spec.label,
          aliases: model.spec.alias,
          caps: model.spec.caps,
          context: model.spec.context,
          enabled: model.spec.enabled && provider.enabled,
          configured: provider.configured,
        },
      });
    }
  }

  const aliasMap = new Map<string, ResolvedModel[]>();
  for (const [alias, models] of opts.registry.aliases()) aliasMap.set(alias, models);
  for (const [alias, target] of Object.entries(opts.config.aliases)) {
    if (!aliasMap.has(alias)) aliasMap.set(alias, []);
    void target;
  }

  for (const [alias, models] of aliasMap) {
    data.push({
      id: alias,
      object: 'model',
      created,
      owned_by: 'freeway',
      freeway: {
        virtual: true,
        alias,
        target: opts.config.aliases[alias] ?? null,
        resolvesTo: models.map((m) => m.ref),
      },
    });
  }

  data.push({
    id: 'auto',
    object: 'model',
    created,
    owned_by: 'freeway',
    freeway: { virtual: true, alias: 'auto', description: 'route to whichever provider is healthy and under quota' },
  });

  sendJson(res, 200, { object: 'list', data });
}

// ---------------------------------------------------------------------------
// Dashboard API
// ---------------------------------------------------------------------------

function handleProviders(res: Res, opts: GatewayOptions, guard: Guard): void {
  const now = Date.now();
  const effectiveLimits = (id: string, declared: LimitSpec): LimitSpec => guard.calibrator.effective(id, declared);
  const providers = opts.registry.all().map((p) => {
    const state = opts.store.provider(p.id);
    return {
      id: p.id,
      label: p.label,
      docs: p.spec.docs,
      console: p.spec.console,
      notes: p.spec.notes,
      enabled: p.enabled,
      configured: p.configured,
      // Rendered verbatim in the UI, so it has to read like advice.
      configError: p.configError,
      priority: p.spec.priority,
      baseUrl: p.baseUrl,
      limitsSource: guard.calibrator.sourceFor(p.id, p.spec.limitsSource),
      verifiedOn: p.spec.verifiedOn,
      // So the dashboard can offer a copyable `.env` line instead of making the
      // reader parse it back out of the error message.
      envKeys: p.spec.auth.envKeys,
      authType: p.spec.auth.type,
      ok: state.ok,
      fail: state.fail,
      latencyMs: state.latencyMs,
      cooldownMsRemaining: Math.max(0, state.cooldownUntil - now),
      lastError: state.lastError,
      bars: state.meter.bars(effectiveLimits(p.id, p.spec.limits)),
      // Keys appear masked and only masked. `KeyRef.value` never crosses this line.
      keys: p.keys.map((k) => {
        const ks = opts.store.key(p.id, k.id);
        return {
          id: k.id,
          masked: k.masked,
          source: k.source,
          status: ks.status,
          ok: ks.ok,
          fail: ks.fail,
          latencyMs: ks.latencyMs,
          cooldownMsRemaining: Math.max(0, ks.cooldownUntil - now),
          lastError: ks.lastError,
          bars: ks.meter.bars(effectiveLimits(p.id, p.spec.limits)),
        };
      }),
      models: p.models.map((m) => ({
        id: m.spec.id,
        ref: m.ref,
        label: m.spec.label,
        alias: m.spec.alias,
        caps: m.spec.caps,
        context: m.spec.context,
        enabled: m.spec.enabled,
      })),
    };
  });

  sendJson(res, 200, { providers, issues: opts.registry.issues() });
}

function handleStats(res: Res, opts: GatewayOptions): void {
  const stats = opts.store.stats();
  const providers = opts.registry.all();
  sendJson(res, 200, {
    requests: stats,
    providers: {
      total: providers.length,
      enabled: providers.filter((p) => p.enabled).length,
      configured: providers.filter((p) => p.configured).length,
      usable: opts.registry.usable().length,
    },
    models: {
      total: opts.registry.allModels().length,
      enabled: opts.registry.allModels().filter((m) => m.spec.enabled).length,
    },
    strategy: opts.config.strategy,
    uptimeSec: Math.round(process.uptime()),
  });
}

function handleLogs(res: Res, opts: GatewayOptions, url: URL): void {
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? '100') || 100));
  sendJson(res, 200, { logs: opts.store.logs(limit) });
}

/**
 * Live request log over SSE.
 *
 * Polling `/api/logs` shows you what happened up to three seconds ago; this
 * pushes each entry the moment it is recorded. Deliberately served as a plain
 * `fetch`-readable stream rather than something only `EventSource` can consume,
 * because `EventSource` cannot send an Authorization header — the alternative
 * would be putting a virtual key in a query string, where it lands in every
 * access log between here and the browser.
 */
const MAX_EVENT_STREAMS = 16;

function handleEvents(req: Req, res: Res, opts: GatewayOptions): void {
  // Each subscriber holds a store listener that receives every log entry.
  // Uncapped, opening connections is a cheap way to exhaust memory and CPU.
  if (opts.store.listenerCount() >= MAX_EVENT_STREAMS) {
    sendError(res, 503, {
      message: `too many live log subscribers (${MAX_EVENT_STREAMS} max)`,
      type: 'api_error',
      code: 'too_many_streams',
    }, {}, { 'retry-after': '5' });
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const write = (event: string, data: unknown): void => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  write('hello', { at: Date.now(), backlog: opts.store.logs(1).length });
  const unsubscribe = opts.store.onLog((entry) => write('log', entry));

  // Idle SSE connections get reaped by proxies; a comment frame is the cheapest
  // possible keep-alive and is ignored by every SSE parser.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15_000);
  heartbeat.unref?.();

  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
}

async function handleToggle(req: Req, res: Res, opts: GatewayOptions, id: string): Promise<void> {
  const body = await parseJsonBody(req, res, 64 * 1024);
  if (!body) return;

  const enabled = body['enabled'];
  if (typeof enabled !== 'boolean') {
    sendError(res, 400, { message: '`enabled` must be a boolean', type: 'invalid_request_error', code: 'invalid_body' });
    return;
  }
  if (!opts.registry.setEnabled(id, enabled)) {
    sendError(res, 404, { message: `unknown provider "${id}"`, type: 'invalid_request_error', code: 'not_found' });
    return;
  }
  sendJson(res, 200, { ok: true, id, enabled });
}

/**
 * Add or remove a runtime key for a provider.
 *
 * The key arrives in the body, is written 0600 to `data/keys.json`, and is
 * echoed back masked. It is never logged and never returned in full by any
 * endpoint. On success the registry re-resolves so the provider is usable
 * immediately, without a restart.
 */
async function handleKey(req: Req, res: Res, opts: GatewayOptions, id: string, method: string, logger: Logger): Promise<void> {
  const vault = opts.vault;
  if (!vault) {
    sendError(res, 501, { message: 'runtime key storage is not enabled on this gateway', type: 'invalid_request_error', code: 'vault_disabled' });
    return;
  }
  if (!vault.writable) {
    sendError(res, 403, {
      message: 'refusing to accept keys over a non-loopback interface without an admin key — set FREEWAY_ADMIN_KEY, or use an environment variable instead',
      type: 'invalid_request_error',
      code: 'vault_readonly',
    });
    return;
  }
  if (!opts.registry.get(id)) {
    sendError(res, 404, { message: `unknown provider "${id}"`, type: 'invalid_request_error', code: 'not_found' });
    return;
  }

  const body = await parseJsonBody(req, res, 16 * 1024);
  if (!body) return;

  try {
    if (method === 'DELETE') {
      const masked = typeof body['masked'] === 'string' ? body['masked'] : undefined;
      const removed = masked === undefined ? vault.remove(id) : vault.remove(id, masked);
      opts.registry.setExtraKeys(vault.all());
      logger.info(`removed runtime key(s) for ${id}`);
      sendJson(res, 200, { ok: removed, id });
      return;
    }

    const key = body['key'];
    if (typeof key !== 'string' || !key.trim()) {
      sendError(res, 400, { message: '`key` must be a non-empty string', type: 'invalid_request_error', code: 'invalid_body' });
      return;
    }

    const masked = vault.add(id, key);
    opts.registry.setExtraKeys(vault.all());
    // Deliberately logs only the mask. There is no code path that logs the key.
    logger.info(`stored a runtime key for ${id} (${masked})`);

    const provider = opts.registry.get(id);
    sendJson(res, 200, { ok: true, id, masked, configured: provider?.configured ?? false, configError: provider?.configError ?? null });
  } catch (err) {
    sendError(res, 400, { message: err instanceof Error ? err.message : String(err), type: 'invalid_request_error', code: 'vault_error' });
  }
}

/**
 * "Give it a key and it tells you which models work."
 *
 * Discovery alone is free. `validate` sends a one-token request per model and
 * therefore spends real quota, so it stays opt-in per call.
 */
async function handleProbe(req: Req, res: Res, opts: GatewayOptions, id: string): Promise<void> {
  const provider = opts.registry.get(id);
  if (!provider) {
    sendError(res, 404, { message: `unknown provider "${id}"`, type: 'invalid_request_error', code: 'not_found' });
    return;
  }
  if (!provider.configured) {
    sendError(res, 400, { message: provider.configError ?? 'provider is not configured', type: 'invalid_request_error', code: 'not_configured' });
    return;
  }

  const body = await parseJsonBody(req, res, 16 * 1024);
  if (!body) return;
  const validate = body['validate'] === true;

  const keys = provider.keys.length > 0
    ? provider.keys
    : [{ id: `${id}#none`, providerId: id, index: 0, value: '', masked: '—', source: 'none' }];

  const results: ProbeResult[] = [];
  for (const key of keys) {
    results.push(
      await probeKey(provider, key, {
        validateModels: validate,
        maxModels: 25,
        concurrency: 3,
        timeoutMs: Math.min(opts.config.timeoutMs, 30_000),
      }),
    );
  }

  sendJson(res, 200, { id, validated: validate, results });
}

function handleSessions(res: Res, opts: GatewayOptions, deps: ProxyDeps): void {
  if (!deps.context) {
    sendError(res, 501, { message: 'sessions are not enabled on this gateway', type: 'invalid_request_error', code: 'context_disabled' });
    return;
  }
  sendJson(res, 200, {
    sessions: deps.context.store.list(100),
    // The estimator's learned per-model correction, so the numbers above carry
    // their own confidence.
    ratios: deps.context.tokenizer.all(),
    config: opts.config.context,
  });
}

function handleSession(res: Res, opts: GatewayOptions, deps: ProxyDeps, id: string): void {
  if (!deps.context) {
    sendError(res, 501, { message: 'sessions are not enabled on this gateway', type: 'invalid_request_error', code: 'context_disabled' });
    return;
  }
  const info = deps.context.store.info(id);
  if (!info) {
    sendError(res, 404, { message: `unknown session "${id}"`, type: 'invalid_request_error', code: 'not_found' });
    return;
  }
  sendJson(res, 200, {
    session: info,
    messages: deps.context.store.messages(id),
    summaries: deps.context.store.summaries(id),
  });
}

function handleSessionDelete(res: Res, deps: ProxyDeps, id: string): void {
  if (!deps.context) {
    sendError(res, 501, { message: 'sessions are not enabled on this gateway', type: 'invalid_request_error', code: 'context_disabled' });
    return;
  }
  deps.context.store.delete(id);
  sendJson(res, 200, { ok: true, id });
}

/**
 * Compaction runs as a normal completion through this gateway, so it lands on
 * whichever provider currently has headroom — never on the one that just ran
 * out and triggered the compaction in the first place.
 */
function makeSummarizer(deps: ProxyDeps, compactModel: string, store: ContextStore) {
  return async (messages: RefitMessage[], budgetTokens: number): Promise<string | null> => {
    const transcript = messages
      .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
      .join('\n')
      .slice(0, 24_000);

    const route = deps.router.route({ model: compactModel, estTokens: Math.ceil(transcript.length / 4) });
    const candidate = route.candidates[0];
    if (!candidate) {
      deps.logger.warn(`cannot compact: no provider available for "${compactModel}"`);
      return null;
    }

    const dl = deadline(Math.min(deps.config.timeoutMs, 30_000));
    try {
      const call = await callUpstream({
        candidate,
        path: '/chat/completions',
        body: {
          model: candidate.model.spec.id,
          max_tokens: budgetTokens,
          temperature: 0,
          messages: [
            { role: 'system', content: 'Summarise the conversation below. Preserve decisions, facts, names, numbers and any open questions. Be terse. Do not add commentary.' },
            { role: 'user', content: transcript },
          ],
        },
        signal: dl.signal,
      });
      if (!call.ok || !call.response) return null;

      const body = (await call.response.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
      const text = body?.choices?.[0]?.message?.content ?? null;
      if (text) {
        deps.store.recordSuccess(candidate.provider.id, candidate.key.id, call.ms, Math.ceil(text.length / 4));
      }
      return text;
    } catch (err) {
      deps.logger.warn(`compaction failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      dl.cancel();
    }
  };
}

/** Embed one query for the semantic cache, routed through this gateway. */
function makeEmbedder(deps: ProxyDeps, model: string) {
  return async (text: string): Promise<number[] | null> => {
    const route = deps.router.route({ model, embedding: true, estTokens: Math.ceil(text.length / 4) });
    const candidate = route.candidates[0];
    if (!candidate) return null;

    const dl = deadline(Math.min(deps.config.timeoutMs, 15_000));
    try {
      const call = await callUpstream({
        candidate,
        path: '/embeddings',
        body: { model: candidate.model.spec.id, input: text },
        signal: dl.signal,
      });
      if (!call.ok || !call.response) return null;
      const body = (await call.response.json().catch(() => null)) as { data?: { embedding?: number[] }[] } | null;
      const vector = body?.data?.[0]?.embedding;
      return Array.isArray(vector) ? vector : null;
    } catch {
      // A cache lookup must never be able to fail the request it was meant to
      // make cheaper.
      return null;
    } finally {
      dl.cancel();
    }
  };
}

function handleCacheStats(res: Res, deps: ProxyDeps, opts: GatewayOptions): void {
  if (!deps.cache) {
    sendJson(res, 200, { enabled: false });
    return;
  }
  sendJson(res, 200, {
    enabled: true,
    mode: deps.cache.exact.mode,
    exact: deps.cache.exact.stats(),
    semantic: deps.cache.semantic?.stats() ?? null,
    threshold: opts.config.cache.semantic.threshold,
    recent: deps.cache.exact.recent(25),
  });
}

/**
 * Where the tokens went.
 *
 * Two different questions, answered separately: the meters are authoritative
 * for quota (they persist and drive routing), while the request log is the only
 * place that knows which model spent what. Mixing them would let a restart make
 * the breakdown disagree with the bars.
 */
function handleUsage(res: Res, opts: GatewayOptions, guard: Guard): void {
  const logs = opts.store.logs(500);

  const totals = { requests: 0, ok: 0, failed: 0, cached: 0, streamed: 0, tokensIn: 0, tokensOut: 0, ms: 0 };
  const byProvider = new Map<string, { id: string; requests: number; tokensIn: number; tokensOut: number; ms: number; failed: number }>();
  const byModel = new Map<string, { id: string; provider: string; requests: number; tokensIn: number; tokensOut: number }>();

  for (const l of logs) {
    totals.requests += 1;
    totals.tokensIn += l.tokensIn;
    totals.tokensOut += l.tokensOut;
    totals.ms += l.ms;
    if (l.status < 400) totals.ok += 1;
    else totals.failed += 1;
    if (l.cache) totals.cached += 1;
    if (l.stream) totals.streamed += 1;

    if (l.providerId) {
      const p = byProvider.get(l.providerId) ?? { id: l.providerId, requests: 0, tokensIn: 0, tokensOut: 0, ms: 0, failed: 0 };
      p.requests += 1;
      p.tokensIn += l.tokensIn;
      p.tokensOut += l.tokensOut;
      p.ms += l.ms;
      if (l.status >= 400) p.failed += 1;
      byProvider.set(l.providerId, p);
    }
    if (l.modelId) {
      const key = `${l.providerId ?? '?'}/${l.modelId}`;
      const m = byModel.get(key) ?? { id: l.modelId, provider: l.providerId ?? '?', requests: 0, tokensIn: 0, tokensOut: 0 };
      m.requests += 1;
      m.tokensIn += l.tokensIn;
      m.tokensOut += l.tokensOut;
      byModel.set(key, m);
    }
  }

  // Quota as the provider sees it, which is what actually gates routing.
  const quota = opts.registry.all()
    .filter((p) => p.configured)
    .map((p) => ({
      id: p.id,
      label: p.label,
      bars: opts.store.provider(p.id).meter.bars(guard.calibrator.effective(p.id, p.spec.limits)),
    }))
    .filter((p) => p.bars.length > 0);

  sendJson(res, 200, {
    window: `last ${logs.length} requests`,
    totals: { ...totals, avgMs: totals.requests > 0 ? Math.round(totals.ms / totals.requests) : 0 },
    byProvider: [...byProvider.values()].sort((a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut)),
    byModel: [...byModel.values()].sort((a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut)).slice(0, 20),
    quota,
  });
}

/** Scan a body once and reuse the result for both the block check and the log. */
function scanRequest(body: Record<string, unknown>, deps: ProxyDeps): { findings: Finding[]; blocked: boolean } {
  const cfg = deps.config.guard.scan;
  if (cfg.mode === 'off') return { findings: [], blocked: false };
  return scanBody(body, {
    mode: cfg.mode,
    secrets: cfg.secrets,
    pii: cfg.pii,
    injection: cfg.injection,
  });
}

/**
 * Everything worth waking up for, in one place: quota trajectories, keys that
 * have stopped working, providers enforcing less than their file claims, and
 * files that failed to load.
 */
function handleAlerts(res: Res, opts: GatewayOptions, guard: Guard): void {
  const now = Date.now();
  const forecasts = [];
  const alerts: { level: string; source: string; message: string }[] = [];

  for (const provider of opts.registry.all()) {
    if (!provider.configured || !provider.enabled) continue;
    const state = opts.store.provider(provider.id);
    const limits = guard.calibrator.effective(provider.id, provider.spec.limits);
    const forecast = forecastProvider(provider.id, state.meter.bars(limits), now);
    forecasts.push(forecast);
    if (forecast.headline) alerts.push({ level: forecast.level, source: 'quota', message: forecast.headline });

    const cal = guard.calibrator.get(provider.id);
    if (cal?.downgraded) {
      const detail = cal.drift
        .filter((d) => d.declared !== null && d.observed < d.declared)
        .map((d) => `${d.key} ${d.declared}→${d.observed}`)
        .join(', ');
      alerts.push({
        level: 'warn',
        source: 'tier-drift',
        message: `${provider.id} is enforcing less than providers/${provider.id}.json claims (${detail})`,
      });
    }
  }

  const health = guard.keyHealth.report();
  for (const k of health.actionable) {
    alerts.push({ level: 'critical', source: 'key-health', message: `${k.providerId} key ${k.masked} is ${k.verdict}${k.detail ? ` — ${k.detail}` : ''}` });
  }

  for (const issue of opts.registry.issues()) {
    if (issue.level === 'error') alerts.push({ level: 'critical', source: 'registry', message: `${issue.file}: ${issue.message}` });
  }

  const rank: Record<string, number> = { exhausted: 4, critical: 3, warn: 2, ok: 1 };
  alerts.sort((a, b) => (rank[b.level] ?? 0) - (rank[a.level] ?? 0));

  sendJson(res, 200, {
    alerts,
    forecasts,
    keyHealth: health,
    calibration: guard.calibrator.all(),
    callers: guard.limiter.callers(),
  });
}

async function handleKeyHealth(res: Res, opts: GatewayOptions, guard: Guard): Promise<void> {
  const report = await guard.keyHealth.check(opts.registry.all());
  sendJson(res, 200, report);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export type Role = 'anonymous' | 'inference' | 'admin';

interface AuthResult {
  ok: boolean;
  message: string;
  /** Masked identity of the caller, for per-key limiting. Never the raw key. */
  keyId: string | null;
  role: Role;
}

function checkVirtualKey(req: Req, config: FreewayConfig): AuthResult {
  // An empty key list is "open" mode. `bin.ts` refuses to bind a non-loopback
  // interface in that state, so this can only be reached from localhost.
  const presented = bearerToken(req);

  // The admin key is checked first and unconditionally, so it still works when
  // no inference keys are configured at all.
  if (presented && config.adminKey && safeEqual(presented, config.adminKey)) {
    return { ok: true, message: '', keyId: fingerprint(config.adminKey), role: 'admin' };
  }

  if (config.keys.length === 0) return { ok: true, message: '', keyId: null, role: 'anonymous' };

  if (!presented) {
    return { ok: false, message: 'missing API key — pass a Freeway virtual key as `Authorization: Bearer fw-…`', keyId: null, role: 'anonymous' };
  }
  for (const key of config.keys) {
    // Buckets are keyed by the mask, so no limiter state ever holds a secret.
    if (safeEqual(presented, key)) return { ok: true, message: '', keyId: fingerprint(key), role: 'inference' };
  }

  return { ok: false, message: 'invalid API key', keyId: null, role: 'anonymous' };
}

/**
 * Gate for everything under `/api/*`.
 *
 * These endpoints read stored conversations, write provider credentials and
 * spend quota — an inference key handed to an app must not reach them. When no
 * admin key is configured the gateway falls back to allowing any valid caller,
 * but only on loopback, where the operator is the only one who can reach it.
 */
function allowAdmin(auth: AuthResult, config: FreewayConfig): { ok: boolean; message: string } {
  if (auth.role === 'admin') return { ok: true, message: '' };
  if (config.adminKey !== null) {
    return { ok: false, message: 'this endpoint requires the Freeway admin key' };
  }
  if (isLoopback(config.host)) return { ok: true, message: '' };
  return {
    ok: false,
    message: 'refusing administrative access over a non-loopback interface with no admin key configured — set FREEWAY_ADMIN_KEY',
  };
}

async function parseJsonBody(req: Req, res: Res, maxBytes: number): Promise<Record<string, unknown> | null> {
  const body = await readBody(req, maxBytes);
  if (!body.ok) {
    if (body.tooLarge) {
      // The client is still uploading. Answer, then close the connection rather
      // than reading the rest of a body already known to be over the limit.
      sendError(
        res,
        413,
        { message: body.error ?? 'request body too large', type: 'invalid_request_error', code: 'payload_too_large' },
        {},
        { connection: 'close' },
      );
      res.on('finish', () => req.destroy());
      return null;
    }
    sendError(res, 400, {
      message: body.error ?? 'could not read request body',
      type: 'invalid_request_error',
      code: 'invalid_body',
    });
    return null;
  }
  if (!body.raw.trim()) {
    sendError(res, 400, { message: 'request body is empty', type: 'invalid_request_error', code: 'invalid_body' });
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(body.raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      sendError(res, 400, { message: 'request body must be a JSON object', type: 'invalid_request_error', code: 'invalid_body' });
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    sendError(res, 400, {
      message: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      type: 'invalid_request_error',
      code: 'invalid_json',
    });
    return null;
  }
}

function serveDashboard(res: Res, publicDir: string): void {
  try {
    const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
    sendText(res, 200, html, 'text/html; charset=utf-8');
  } catch {
    sendText(res, 200, 'Freeway is running. The dashboard is not built yet.\nTry GET /healthz or GET /api/providers.\n');
  }
}

/**
 * CORS against an explicit allowlist.
 *
 * `*` used to be sent on every response, which meant any page the operator
 * visited could drive the gateway from their browser — draining quota and, on
 * an open gateway, reading `/api/*`. The bundled dashboard is same-origin and
 * needs no CORS at all, so the default is to send nothing.
 */
function cors(req: Req, config: FreewayConfig): Record<string, string> {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || config.corsOrigins.length === 0) return {};
  if (!config.corsOrigins.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    // Signals that the response varies by Origin, so a cache cannot serve one
    // origin's response to another.
    vary: 'Origin',
    'access-control-allow-headers': 'authorization, content-type, x-api-key',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-max-age': '86400',
  };
}

export { clientIp };
