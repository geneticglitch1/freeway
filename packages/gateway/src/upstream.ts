/**
 * Calling a real provider: auth, header assembly, param stripping, timeouts,
 * and pulling usage back out of the response.
 *
 * Everything here is driven by the provider's JSON spec. Nothing in this file
 * knows the name of a single provider, which is what keeps "add a provider by
 * writing JSON" true.
 */

import type { Candidate, Cap } from '@freeway/core';
import { joinUrl } from '@freeway/core';

export interface UpstreamCall {
  candidate: Candidate;
  /** Path relative to the provider's baseUrl, e.g. `/chat/completions`. */
  path: string;
  body: unknown;
  /**
   * Owned by the caller, not by this function. A streamed response is still
   * arriving long after `fetch` resolves, so the deadline has to outlive the
   * call itself — clearing a timer here would leave a hung stream immortal.
   */
  signal: AbortSignal;
  method?: string;
}

export interface Deadline {
  signal: AbortSignal;
  cancel: () => void;
  timedOut: () => boolean;
}

export function deadline(ms: number): Deadline {
  const controller = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort();
  }, ms);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
    timedOut: () => fired,
  };
}

export interface UpstreamResult {
  ok: boolean;
  status: number | null;
  response: Response | null;
  /** Set when the call never produced an HTTP response (network, DNS, timeout). */
  transportError: string | null;
  timedOut: boolean;
  ms: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** True when the numbers are our own estimate rather than the provider's. */
  estimated: boolean;
}

/** Build the URL and headers for one candidate, applying its auth scheme. */
export function buildRequest(candidate: Candidate, path: string): { url: string; headers: Record<string, string> } {
  const { provider, key } = candidate;
  const auth = provider.spec.auth;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...provider.headers,
  };

  let url = joinUrl(provider.baseUrl, path);

  switch (auth.type) {
    case 'bearer':
      headers['authorization'] = `${auth.prefix ?? 'Bearer '}${key.value}`;
      break;
    case 'header':
      if (auth.header) headers[auth.header.toLowerCase()] = `${auth.prefix ?? ''}${key.value}`;
      break;
    case 'query':
      if (auth.query) {
        const u = new URL(url);
        u.searchParams.set(auth.query, key.value);
        url = u.toString();
      }
      break;
    case 'none':
      break;
  }

  return { url, headers };
}

/** Remove body params this provider rejects. Returns a copy; the input is untouched. */
export function stripDropParams(body: unknown, dropParams: string[]): unknown {
  if (dropParams.length === 0 || typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const p of dropParams) delete out[p];
  return out;
}

export async function callUpstream(call: UpstreamCall): Promise<UpstreamResult> {
  const { candidate, path, signal } = call;
  const { url, headers } = buildRequest(candidate, path);
  const body = stripDropParams(call.body, candidate.provider.spec.dropParams);
  const started = Date.now();

  const method = call.method ?? 'POST';
  const init: RequestInit = { method, headers, signal };
  if (method !== 'GET' && method !== 'HEAD') init.body = JSON.stringify(body);

  try {
    const response = await fetch(url, init);
    return {
      ok: response.ok,
      status: response.status,
      response,
      transportError: null,
      timedOut: false,
      ms: Date.now() - started,
    };
  } catch (err) {
    const timedOut = signal.aborted;
    return {
      ok: false,
      status: null,
      response: null,
      transportError: timedOut ? 'upstream timed out' : errMsg(err),
      timedOut,
      ms: Date.now() - started,
    };
  }
}

/**
 * Honour an upstream `Retry-After`, which may be seconds or an HTTP date.
 * A provider telling us when to come back is always better than our guess.
 */
export function retryAfterMs(response: Response | null): number | null {
  const raw = response?.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

/** Rough token count. Only used when a provider reports nothing. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function textOfMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  const parts: string[] = [];
  for (const m of messages) {
    if (typeof m !== 'object' || m === null) continue;
    const content = (m as { content?: unknown }).content;
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) {
      for (const p of content) {
        if (typeof p === 'object' && p !== null && typeof (p as { text?: unknown }).text === 'string') {
          parts.push((p as { text: string }).text);
        }
      }
    }
  }
  return parts.join('\n');
}

/**
 * Pull usage out of a non-streaming response body, falling back to an estimate.
 *
 * Degrading to `chars/4` matters: a provider that reports nothing would
 * otherwise leave every quota counter reading zero, and the gateway would
 * cheerfully burn a monthly allowance believing it had spent nothing.
 */
export function usageFromBody(body: unknown, promptText: string, completionText: string): TokenUsage {
  const usage = (body as { usage?: Record<string, unknown> } | null)?.usage;
  const prompt = numberAt(usage, 'prompt_tokens');
  const completion = numberAt(usage, 'completion_tokens');
  const total = numberAt(usage, 'total_tokens');

  if (prompt !== null || completion !== null || total !== null) {
    const p = prompt ?? 0;
    const c = completion ?? 0;
    return { promptTokens: p, completionTokens: c, totalTokens: total ?? p + c, estimated: false };
  }

  const p = estimateTokens(promptText);
  const c = estimateTokens(completionText);
  return { promptTokens: p, completionTokens: c, totalTokens: p + c, estimated: true };
}

export function completionText(body: unknown): string {
  const choices = (body as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices)) return '';
  const parts: string[] = [];
  for (const c of choices) {
    const message = (c as { message?: { content?: unknown } } | null)?.message;
    if (typeof message?.content === 'string') parts.push(message.content);
  }
  return parts.join('');
}

/** Capabilities the request body implies. Drives the router's filtering. */
export function capsFromBody(body: Record<string, unknown>): Cap[] {
  const caps: Cap[] = [];
  const tools = body['tools'];
  if (Array.isArray(tools) && tools.length > 0) caps.push('tools');
  if (body['functions'] !== undefined && !caps.includes('tools')) caps.push('tools');

  const format = body['response_format'];
  if (typeof format === 'object' && format !== null) {
    const type = (format as { type?: unknown }).type;
    if (type === 'json_object' || type === 'json_schema') caps.push('json');
  }

  if (hasImagePart(body['messages'])) caps.push('vision');
  return caps;
}

function hasImagePart(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const m of messages) {
    const content = (m as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const type = (part as { type?: unknown } | null)?.type;
      if (type === 'image_url' || type === 'image' || type === 'input_image') return true;
    }
  }
  return false;
}

function numberAt(obj: Record<string, unknown> | undefined, key: string): number | null {
  const v = obj?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return `${err.message}: ${cause.message}`;
    return err.message;
  }
  return String(err);
}
