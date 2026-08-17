/**
 * @freeway/sdk — a small typed client for a Freeway gateway.
 *
 * Zero dependencies, runs in Node and the browser. Typed against the parts of
 * the OpenAI shapes that actually get used rather than the whole surface, and
 * every result carries a `.route` telling you which provider served it.
 */

// ---------------------------------------------------------------------------
// OpenAI-ish types (only the parts we use)
// ---------------------------------------------------------------------------

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export type ContentPart = TextPart | ImagePart;

export interface Message {
  role: Role;
  content: string | ContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Tool {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: Tool[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  response_format?: { type: 'text' | 'json_object' | 'json_schema'; json_schema?: Record<string, unknown> };
  /**
   * Freeway extension: server-side conversation id. Send only the new message
   * and the gateway rehydrates the thread, refitting it to whichever model ends
   * up serving the call.
   */
  session?: string;
  [key: string]: unknown;
}

export interface Choice {
  index: number;
  message: { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] };
  finish_reason: string | null;
}

export interface ChatCompletion {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Choice[];
  usage?: Usage;
}

export interface ChunkChoice {
  index: number;
  delta: { role?: Role; content?: string; tool_calls?: Partial<ToolCall>[] };
  finish_reason: string | null;
}

export interface ChatChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChunkChoice[];
  usage?: Usage;
}

export interface EmbeddingResponse {
  object: string;
  model: string;
  data: { object: string; index: number; embedding: number[] }[];
  usage?: Usage;
}

export interface ModelEntry {
  id: string;
  object: string;
  owned_by: string;
  freeway?: {
    virtual?: boolean;
    provider?: string;
    model?: string;
    aliases?: string[];
    caps?: string[];
    context?: number | null;
    enabled?: boolean;
    configured?: boolean;
    resolvesTo?: string[];
  };
}

// ---------------------------------------------------------------------------
// Freeway-specific
// ---------------------------------------------------------------------------

/** What the `x-freeway-*` response headers said about this call. */
export interface RouteInfo {
  provider: string | null;
  model: string | null;
  /** How the model string was interpreted, e.g. `alias:fast`. */
  route: string | null;
  attempts: number;
  ms: number;
  /** Whether token counts were estimated rather than reported by the provider. */
  estimated: boolean;
  /** Cache tier that served it, when the gateway's cache is enabled. */
  cache: string | null;
  /** How the context engine reshaped the history, when sessions are in use. */
  context: string | null;
}

export interface BlockedProvider {
  provider: string;
  model: string;
  reason: string;
  retryAfterMs: number | null;
}

/** Thrown for any non-2xx reply, carrying the gateway's diagnostics intact. */
export class FreewayError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly type: string | null;
  readonly route: RouteInfo;
  /** Per-provider rejection reasons — the whole point of a 429 from Freeway. */
  readonly blocked: BlockedProvider[];
  readonly suggestions: string[];
  readonly retryAfterMs: number | null;
  readonly body: unknown;

  constructor(init: {
    message: string;
    status: number;
    code?: string | null;
    type?: string | null;
    route: RouteInfo;
    blocked?: BlockedProvider[];
    suggestions?: string[];
    retryAfterMs?: number | null;
    body?: unknown;
  }) {
    super(init.message);
    this.name = 'FreewayError';
    this.status = init.status;
    this.code = init.code ?? null;
    this.type = init.type ?? null;
    this.route = init.route;
    this.blocked = init.blocked ?? [];
    this.suggestions = init.suggestions ?? [];
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.body = init.body;
  }
}

export type Routed<T> = T & { route: RouteInfo };

export interface FreewayOptions {
  /** e.g. `http://localhost:8787/v1`. A trailing `/v1` is added if missing. */
  baseUrl?: string;
  apiKey?: string;
  /** Total attempts per call, including the first. Default 3. */
  maxRetries?: number;
  /** Per-request timeout. Default 60s (300s for streams). */
  timeoutMs?: number;
  streamTimeoutMs?: number;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
  maxRetries?: number;
}

export interface ChatOptions extends RequestOptions {
  model?: string;
  system?: string;
  temperature?: number;
  max_tokens?: number;
  session?: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ChatFn {
  /** Prompt in, assistant text out. */
  (prompt: string, options?: ChatOptions): Promise<string>;
  /** The full completion, plus `.route`. */
  raw(body: ChatRequest, options?: RequestOptions): Promise<Routed<ChatCompletion>>;
}

export interface FreewayClient {
  chat: ChatFn;
  stream(body: ChatRequest, options?: RequestOptions): AsyncGenerator<ChatChunk, RouteInfo, undefined>;
  /** Streamed text only, for when the chunks themselves are not interesting. */
  streamText(body: ChatRequest, options?: RequestOptions): AsyncGenerator<string, RouteInfo, undefined>;
  embed(input: string | string[], options?: RequestOptions & { model?: string }): Promise<Routed<number[][]>>;
  models(options?: RequestOptions): Promise<ModelEntry[]>;
  health(options?: RequestOptions): Promise<{ ok: boolean; providers: { total: number; usable: number } }>;
  /**
   * Drop-in config for the official OpenAI SDK:
   * `new OpenAI(fw.openai())` — existing apps keep working unchanged.
   */
  openai(): { baseURL: string; apiKey: string; defaultHeaders?: Record<string, string> };
  readonly baseUrl: string;
  readonly apiKey: string;
}

const DEFAULT_BASE = 'http://localhost:8787/v1';

export function createFreeway(options: FreewayOptions = {}): FreewayClient {
  const baseUrl = normalizeBase(options.baseUrl ?? DEFAULT_BASE);
  const apiKey = options.apiKey ?? '';
  const maxRetries = Math.max(1, options.maxRetries ?? 3);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const streamTimeoutMs = options.streamTimeoutMs ?? 300_000;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  function headersFor(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...options.headers, ...extra };
    if (apiKey) h['authorization'] = `Bearer ${apiKey}`;
    return h;
  }

  /**
   * One HTTP attempt. Retries live in `send` so streaming can share them: a
   * stream that fails before its first byte is still safe to retry.
   */
  async function attempt(path: string, init: RequestInit, opts: RequestOptions | undefined, deadlineMs: number): Promise<Response> {
    const controller = new AbortController();
    // A signal that is *already* aborted never fires an `abort` event, so
    // listening alone would silently let the request through.
    if (opts?.signal?.aborted) controller.abort(opts.signal.reason);
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? deadlineMs);
    const onAbort = (): void => controller.abort(opts?.signal?.reason);
    opts?.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await doFetch(`${baseUrl}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * The gateway has already failed over across every provider it has, so a
   * retry here is a last resort for a transient gateway or network blip —
   * hence full jittered exponential backoff rather than a tight loop.
   */
  async function send(path: string, init: RequestInit, opts: RequestOptions | undefined, deadlineMs: number): Promise<Response> {
    const attempts = Math.max(1, opts?.maxRetries ?? maxRetries);
    let lastError: unknown;

    for (let i = 0; i < attempts; i++) {
      if (opts?.signal?.aborted) throw abortError(opts.signal.reason);
      let res: Response;
      try {
        res = await attempt(path, init, opts, deadlineMs);
      } catch (err) {
        lastError = err;
        if (opts?.signal?.aborted) throw err;
        if (i === attempts - 1) break;
        await sleep(backoffMs(i, null));
        continue;
      }

      if (res.ok || !isRetryable(res.status) || i === attempts - 1) return res;

      // Honour the gateway's own Retry-After — it knows when the upstream
      // window actually reopens, which is better than any local guess.
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      res.body?.cancel().catch(() => {});
      await sleep(backoffMs(i, retryAfter));
    }

    throw lastError instanceof Error
      ? lastError
      : new FreewayError({ message: String(lastError ?? 'request failed'), status: 0, route: emptyRoute() });
  }

  async function json<T>(path: string, body: unknown, opts?: RequestOptions): Promise<{ data: T; route: RouteInfo }> {
    const res = await send(path, { method: 'POST', headers: headersFor(opts?.headers), body: JSON.stringify(body) }, opts, timeoutMs);
    const route = routeFrom(res.headers);
    const parsed: unknown = await res.json().catch(() => null);
    if (!res.ok) throw errorFrom(res, parsed, route);
    return { data: parsed as T, route };
  }

  const chat = (async (prompt: string, opts: ChatOptions = {}): Promise<string> => {
    const messages: Message[] = [];
    if (opts.system) messages.push({ role: 'system', content: opts.system });
    messages.push({ role: 'user', content: prompt });

    const body: ChatRequest = { model: opts.model ?? 'auto', messages };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.max_tokens !== undefined) body.max_tokens = opts.max_tokens;
    if (opts.session !== undefined) body.session = opts.session;

    const { data } = await json<ChatCompletion>('/chat/completions', body, opts);
    return data.choices[0]?.message.content ?? '';
  }) as ChatFn;

  chat.raw = async (body: ChatRequest, opts?: RequestOptions): Promise<Routed<ChatCompletion>> => {
    const { data, route } = await json<ChatCompletion>('/chat/completions', { ...body, stream: false }, opts);
    return Object.assign(data, { route });
  };

  async function* stream(body: ChatRequest, opts?: RequestOptions): AsyncGenerator<ChatChunk, RouteInfo, undefined> {
    const res = await send(
      '/chat/completions',
      { method: 'POST', headers: headersFor({ accept: 'text/event-stream', ...opts?.headers }), body: JSON.stringify({ ...body, stream: true }) },
      opts,
      streamTimeoutMs,
    );
    const route = routeFrom(res.headers);
    if (!res.ok) throw errorFrom(res, await res.json().catch(() => null), route);
    if (!res.body) return route;

    for await (const payload of sseLines(res.body)) {
      if (payload === '[DONE]') break;
      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(payload) as ChatChunk;
      } catch {
        continue; // a keep-alive or comment frame, not a chunk
      }
      yield chunk;
    }
    return route;
  }

  async function* streamText(body: ChatRequest, opts?: RequestOptions): AsyncGenerator<string, RouteInfo, undefined> {
    const iter = stream(body, opts);
    while (true) {
      const next = await iter.next();
      if (next.done) return next.value;
      const text = next.value.choices[0]?.delta.content;
      if (text) yield text;
    }
  }

  return {
    chat,
    stream,
    streamText,

    async embed(input, opts) {
      const { data, route } = await json<EmbeddingResponse>(
        '/embeddings',
        { model: opts?.model ?? 'auto', input: Array.isArray(input) ? input : [input] },
        opts,
      );
      const vectors = [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      return Object.assign(vectors, { route });
    },

    async models(opts) {
      const res = await send('/models', { method: 'GET', headers: headersFor(opts?.headers) }, opts, timeoutMs);
      const route = routeFrom(res.headers);
      const parsed: unknown = await res.json().catch(() => null);
      if (!res.ok) throw errorFrom(res, parsed, route);
      return ((parsed as { data?: ModelEntry[] } | null)?.data ?? []);
    },

    async health(opts) {
      // `/healthz` sits outside `/v1`, and outside the virtual-key gate.
      const res = await doFetch(`${baseUrl.replace(/\/v1$/, '')}/healthz`, { headers: headersFor(opts?.headers) });
      if (!res.ok) throw new FreewayError({ message: `health check failed (${res.status})`, status: res.status, route: emptyRoute() });
      return (await res.json()) as { ok: boolean; providers: { total: number; usable: number } };
    },

    openai() {
      const cfg: { baseURL: string; apiKey: string; defaultHeaders?: Record<string, string> } = {
        baseURL: baseUrl,
        // The OpenAI SDK rejects an empty key, and an open gateway ignores it.
        apiKey: apiKey || 'fw-unused',
      };
      if (options.headers) cfg.defaultHeaders = options.headers;
      return cfg;
    },

    baseUrl,
    apiKey,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeBase(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function emptyRoute(): RouteInfo {
  return { provider: null, model: null, route: null, attempts: 0, ms: 0, estimated: false, cache: null, context: null };
}

function routeFrom(headers: Headers): RouteInfo {
  return {
    provider: headers.get('x-freeway-provider'),
    model: headers.get('x-freeway-model'),
    route: headers.get('x-freeway-route'),
    attempts: Number(headers.get('x-freeway-attempts') ?? '0') || 0,
    ms: Number(headers.get('x-freeway-ms') ?? '0') || 0,
    estimated: headers.get('x-freeway-usage') === 'estimated',
    cache: headers.get('x-freeway-cache'),
    context: headers.get('x-freeway-context'),
  };
}

function errorFrom(res: Response, body: unknown, route: RouteInfo): FreewayError {
  const b = (body ?? {}) as { error?: { message?: string; code?: string; type?: string }; freeway?: Record<string, unknown> };
  const fw = b.freeway ?? {};
  return new FreewayError({
    message: b.error?.message ?? `request failed with ${res.status}`,
    status: res.status,
    code: b.error?.code ?? null,
    type: b.error?.type ?? null,
    route,
    blocked: Array.isArray(fw['blocked']) ? (fw['blocked'] as BlockedProvider[]) : [],
    suggestions: Array.isArray(fw['suggestions']) ? (fw['suggestions'] as string[]) : [],
    retryAfterMs: typeof fw['retryAfterMs'] === 'number' ? fw['retryAfterMs'] : parseRetryAfter(res.headers.get('retry-after')),
    body,
  });
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Full jitter: retrying in lockstep is how a thundering herd starts. */
function backoffMs(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, 30_000);
  const capped = Math.min(500 * 2 ** attempt, 8000);
  return Math.random() * capped;
}

function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const err = new Error('the request was aborted');
  err.name = 'AbortError';
  return err;
}

/** Yield the payload of each `data:` frame, handling chunk-split lines. */
async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith('data:')) yield tail.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}
