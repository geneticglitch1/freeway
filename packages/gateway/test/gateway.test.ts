/**
 * End-to-end tests against mock upstreams.
 *
 * Everything here runs a real HTTP gateway against real HTTP fakes — no
 * stubbing of fetch, no injected doubles — so what is verified is what actually
 * happens on the wire, and it costs no free-tier quota to run.
 */

import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { Registry, Router, Store, parseConfig, silentLogger, type FreewayConfig } from '@freeway/core';

import { createGateway } from '../src/server.ts';
// eslint-disable-next-line -- plain JS harness, deliberately not TypeScript so it can be run standalone
import { createMockUpstream } from '../../../scripts/mock-upstream.js';

const cleanups: (() => unknown)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

interface Mock {
  url: string;
  name: string;
  calls: { path: string; body: unknown; key: string | null }[];
  script(steps: unknown[]): void;
  setKeys(k: Record<string, unknown>): void;
  callsTo(path: string): { path: string; body: unknown; key: string | null }[];
  reset(): void;
  close(): Promise<unknown>;
}

interface Harness {
  base: string;
  alpha: Mock;
  beta: Mock;
  store: Store;
  registry: Registry;
  config: FreewayConfig;
}

async function harness(configOverrides: Partial<FreewayConfig> = {}, env: Record<string, string> = {}): Promise<Harness> {
  const alpha = (await createMockUpstream({ name: 'alpha' })) as Mock;
  const beta = (await createMockUpstream({ name: 'beta' })) as Mock;
  cleanups.push(() => alpha.close(), () => beta.close());

  const dir = mkdtempSync(join(tmpdir(), 'freeway-gw-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(
    join(dir, 'alpha.json'),
    JSON.stringify({
      id: 'alpha',
      priority: 10,
      baseUrl: alpha.url,
      auth: { type: 'bearer', envKeys: ['ALPHA_KEY'] },
      limits: { rpm: 100 },
      models: [
        { id: 'alpha-chat', alias: ['fast'], context: 128000, caps: ['chat', 'tools', 'json'], priority: 10 },
        { id: 'alpha-embed', alias: ['embed'], context: 8000, caps: ['embed'] },
      ],
    }),
  );
  writeFileSync(
    join(dir, 'beta.json'),
    JSON.stringify({
      id: 'beta',
      priority: 20,
      baseUrl: beta.url,
      auth: { type: 'bearer', envKeys: ['BETA_KEY'] },
      limits: { rpm: 100 },
      models: [{ id: '@cf/meta/llama-3.1-8b-instruct', alias: ['fast'], context: 8192, caps: ['chat'], priority: 10 }],
    }),
  );

  const registry = new Registry({
    dir,
    env: { ALPHA_KEY: 'ak-000000000001,ak-000000000002', BETA_KEY: 'bk-000000000001', ...env },
    logger: silentLogger,
  });
  const store = new Store({ file: null, cooldownMs: 60_000, logger: silentLogger });
  const { config } = parseConfig({}, {});
  Object.assign(config, configOverrides);
  const router = new Router(registry, store, config);

  const server: Server = createGateway({ registry, store, router, config, logger: silentLogger });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  cleanups.push(() => new Promise((r) => server.close(() => r(undefined))));

  return { base: `http://127.0.0.1:${port}`, alpha, beta, store, registry, config };
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const CHAT = { model: 'auto', messages: [{ role: 'user', content: 'hello there' }] };

// ---------------------------------------------------------------------------

describe('gateway — a normal completion', () => {
  it('proxies the request and reports who served it', async () => {
    const h = await harness();
    const res = await post(h.base, '/v1/chat/completions', CHAT);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-freeway-provider'), 'alpha', 'priority order picked alpha');
    assert.equal(res.headers.get('x-freeway-model'), 'alpha-chat');
    assert.equal(res.headers.get('x-freeway-attempts'), '1');
    assert.equal(res.headers.get('x-freeway-route'), 'auto');
    assert.ok(Number(res.headers.get('x-freeway-ms')) >= 0);

    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    assert.match(body.choices[0]?.message.content ?? '', /\[alpha\]/);
  });

  it('never forwards the virtual key upstream, only the provider key', async () => {
    const h = await harness({ keys: ['fw-secret-key'] });
    await post(h.base, '/v1/chat/completions', CHAT, { authorization: 'Bearer fw-secret-key' });

    const call = h.alpha.callsTo('/chat/completions')[0];
    assert.ok(call);
    // Which key of the pool served it depends on cursor rotation; what matters
    // is that it is a provider key and never the caller's virtual one.
    assert.ok(['ak-000000000001', 'ak-000000000002'].includes(call.key ?? ''), `unexpected upstream key ${call.key}`);
    assert.notEqual(call.key, 'fw-secret-key');
  });

  it('rewrites the model to the upstream id', async () => {
    const h = await harness();
    await post(h.base, '/v1/chat/completions', { ...CHAT, model: 'fast' });
    const call = h.alpha.callsTo('/chat/completions')[0];
    assert.equal((call?.body as { model: string }).model, 'alpha-chat');
  });

  it('records tokens from the upstream usage block', async () => {
    const h = await harness();
    await post(h.base, '/v1/chat/completions', CHAT);
    assert.ok(h.store.provider('alpha').meter.used('tpm') > 0, 'usage was metered');
  });

  it('falls back to an estimate when a provider reports no usage', async () => {
    // A provider reporting nothing must not leave the quota counter reading zero.
    const h = await harness();
    h.alpha.script([{ status: 200, dropUsage: true, repeat: Infinity }]);

    const res = await post(h.base, '/v1/chat/completions', CHAT);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-freeway-usage'), 'estimated');
    assert.ok(h.store.provider('alpha').meter.used('tpm') > 0, 'estimated tokens still count');
  });
});

describe('gateway — failover', () => {
  it('a 429 on provider A fails over to provider B', async () => {
    const h = await harness();
    h.alpha.script([{ status: 429, repeat: Infinity }]);

    const res = await post(h.base, '/v1/chat/completions', { ...CHAT, model: 'fast' });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-freeway-provider'), 'beta');
    // 3, not 2: a 429 is a key fault, so alpha's *other* pool key is tried
    // before the provider is abandoned. That is the point of a key pool.
    assert.equal(res.headers.get('x-freeway-attempts'), '3');
    assert.equal(h.alpha.callsTo('/chat/completions').length, 2, 'both alpha keys were tried');

    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    assert.match(body.choices[0]?.message.content ?? '', /\[beta\]/);
  });

  it('a 429 on one key retries the other key of the same provider', async () => {
    const h = await harness();
    h.alpha.setKeys({ 'ak-000000000001': { status: 429 } });

    const res = await post(h.base, '/v1/chat/completions', { ...CHAT, model: 'alpha/alpha-chat' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-freeway-provider'), 'alpha', 'stayed on the same provider');

    const keysUsed = h.alpha.callsTo('/chat/completions').map((c) => c.key);
    assert.ok(keysUsed.includes('ak-000000000002'), 'the pool’s other key served it');
  });

  it('a 5xx benches the provider so the next request skips it entirely', async () => {
    const h = await harness();
    h.alpha.script([{ status: 503, repeat: Infinity }]);

    await post(h.base, '/v1/chat/completions', { ...CHAT, model: 'fast' });
    const before = h.alpha.callsTo('/chat/completions').length;

    const res = await post(h.base, '/v1/chat/completions', { ...CHAT, model: 'fast' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-freeway-provider'), 'beta');
    assert.equal(res.headers.get('x-freeway-attempts'), '1', 'the benched provider is not even tried');
    assert.equal(h.alpha.callsTo('/chat/completions').length, before, 'no second call to the dead provider');
  });

  it('honours an upstream Retry-After over the configured cooldown', async () => {
    const h = await harness({ cooldownSeconds: 600 });
    h.alpha.script([{ status: 429, headers: { 'retry-after': '2' }, repeat: Infinity }]);

    await post(h.base, '/v1/chat/completions', { ...CHAT, model: 'alpha/alpha-chat' });
    const cooldown = h.store.key('alpha', 'alpha#0').cooldownUntil - Date.now();
    assert.ok(cooldown <= 2500 && cooldown > 0, `expected ~2s from Retry-After, got ${cooldown}ms`);
  });

  it('stops after maxAttempts rather than walking every candidate', async () => {
    const h = await harness({ maxAttempts: 1 });
    h.alpha.script([{ status: 500, repeat: Infinity }]);

    const res = await post(h.base, '/v1/chat/completions', { ...CHAT, model: 'fast' });
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('x-freeway-attempts'), '1');
    assert.equal(h.beta.callsTo('/chat/completions').length, 0, 'never got to beta');
  });

  it('returns a 400 immediately without retrying anywhere', async () => {
    // A malformed body fails identically everywhere; retrying burns quota for nothing.
    const h = await harness();
    h.alpha.script([{ status: 400, body: { error: { message: 'bad parameter foo', type: 'invalid_request_error' } }, repeat: Infinity }]);

    const res = await post(h.base, '/v1/chat/completions', { ...CHAT, model: 'fast' });

    assert.equal(res.status, 400);
    assert.equal(res.headers.get('x-freeway-attempts'), '1');
    assert.equal(h.beta.callsTo('/chat/completions').length, 0, 'beta was never tried');

    const body = (await res.json()) as { error: { message: string } };
    assert.equal(body.error.message, 'bad parameter foo', 'the upstream error is passed through verbatim');
    assert.equal(h.store.isProviderCooling('alpha'), false, 'a 400 benches nothing');
  });

  it('reports every attempt when they all fail', async () => {
    const h = await harness();
    h.alpha.script([{ status: 500, repeat: Infinity }]);
    h.beta.script([{ status: 502, repeat: Infinity }]);

    const res = await post(h.base, '/v1/chat/completions', { ...CHAT, model: 'fast' });
    assert.equal(res.status, 502);

    const body = (await res.json()) as { freeway: { attempts: { provider: string; status: number }[] } };
    // A 500 is a provider fault, so alpha's second key is skipped — every key
    // would fail identically and the attempt budget is better spent on beta.
    assert.equal(body.freeway.attempts.length, 2);
    assert.deepEqual(body.freeway.attempts.map((a) => a.provider), ['alpha', 'beta']);
    assert.deepEqual(body.freeway.attempts.map((a) => a.status), [500, 502]);
    assert.equal(h.alpha.callsTo('/chat/completions').length, 1, 'the benched provider was not retried on another key');
  });
});

describe('gateway — streaming', () => {
  it('proxies SSE through intact', async () => {
    const h = await harness();
    const res = await post(h.base, '/v1/chat/completions', { ...CHAT, stream: true });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(res.headers.get('x-freeway-provider'), 'alpha');

    const text = await res.text();
    assert.match(text, /^data: /m);
    assert.match(text, /data: \[DONE\]/);

    // Reassemble the deltas — the content must survive the transform untouched.
    const content = [...text.matchAll(/^data: (.+)$/gm)]
      .map((m) => m[1])
      .filter((p): p is string => p !== undefined && p !== '[DONE]')
      .map((p) => JSON.parse(p) as { choices?: { delta?: { content?: string } }[] })
      .flatMap((o) => o.choices ?? [])
      .map((c) => c.delta?.content ?? '')
      .join('');
    assert.match(content, /\[alpha\]/);
  });

  it('accounts for tokens from the final usage chunk of a stream', async () => {
    const h = await harness();
    const res = await post(h.base, '/v1/chat/completions', { ...CHAT, stream: true });
    await res.text();

    // Usage arrives only in the last chunk, long after the response committed.
    assert.ok(h.store.provider('alpha').meter.used('tpm') > 0, 'late usage was still metered');
    const log = h.store.logs(1)[0];
    assert.ok(log);
    assert.equal(log.stream, true);
    assert.ok(log.tokensOut > 0);
  });

  it('still fails over when the first provider 429s a stream request', async () => {
    // The commit point is after 200 headers, so a pre-body failure is recoverable.
    const h = await harness();
    h.alpha.script([{ status: 429, repeat: Infinity }]);

    const res = await post(h.base, '/v1/chat/completions', { ...CHAT, model: 'fast', stream: true });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-freeway-provider'), 'beta');
    assert.match(await res.text(), /\[beta\]/);
  });

  it('estimates stream tokens when the provider omits usage', async () => {
    const h = await harness();
    h.alpha.script([{ status: 200, dropUsage: true, repeat: Infinity }]);

    const res = await post(h.base, '/v1/chat/completions', { ...CHAT, stream: true });
    await res.text();
    assert.ok(h.store.provider('alpha').meter.used('tpm') > 0);
  });
});

describe('gateway — quota exhaustion', () => {
  it('returns 429 with a diagnostic reason per provider', async () => {
    const h = await harness();
    for (let i = 0; i < 100; i++) {
      h.store.recordSuccess('alpha', 'alpha#0', 5);
      h.store.recordSuccess('beta', 'beta#0', 5);
    }

    const res = await post(h.base, '/v1/chat/completions', { ...CHAT, model: 'fast' });
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 0, 'tells the client when to come back');

    const body = (await res.json()) as {
      error: { code: string };
      freeway: { blocked: { provider: string; reason: string }[]; retryAfterMs: number };
    };
    assert.equal(body.error.code, 'all_providers_blocked');
    assert.equal(body.freeway.blocked.length, 2);
    for (const b of body.freeway.blocked) {
      assert.match(b.reason, /rpm limit reached \(100\/100 last 60s\)/, `reason must be specific, got "${b.reason}"`);
    }
    assert.equal(h.alpha.callsTo('/chat/completions').length, 0, 'no upstream call was wasted');
  });

  it('tells you which env var to set when nothing is configured', async () => {
    const h = await harness({}, { ALPHA_KEY: '', BETA_KEY: '' });
    const res = await post(h.base, '/v1/chat/completions', { ...CHAT, model: 'fast' });

    assert.equal(res.status, 429);
    const body = (await res.json()) as { freeway: { blocked: { reason: string }[] } };
    const reasons = body.freeway.blocked.map((b) => b.reason).join(' ');
    assert.match(reasons, /ALPHA_KEY/);
    assert.match(reasons, /BETA_KEY/);
  });
});

describe('gateway — unknown models', () => {
  it('returns 404 with the closest available ids', async () => {
    const h = await harness();
    const res = await post(h.base, '/v1/chat/completions', { ...CHAT, model: 'gpt-4o-turbo-max' });

    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string }; freeway: { suggestions: string[] } };
    assert.equal(body.error.code, 'model_not_found');
    assert.ok(Array.isArray(body.freeway.suggestions));
  });
});

describe('gateway — virtual keys', () => {
  it('rejects a request with no key when keys are configured', async () => {
    const h = await harness({ keys: ['fw-good'] });
    const res = await post(h.base, '/v1/chat/completions', CHAT);

    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'invalid_api_key');
    assert.match(body.error.message, /missing API key/);
  });

  it('rejects a wrong key', async () => {
    const h = await harness({ keys: ['fw-good'] });
    const res = await post(h.base, '/v1/chat/completions', CHAT, { authorization: 'Bearer fw-wrong' });
    assert.equal(res.status, 401);
    assert.equal(h.alpha.callsTo('/chat/completions').length, 0, 'never reached an upstream');
  });

  it('accepts a correct key, via Authorization or x-api-key', async () => {
    const h = await harness({ keys: ['fw-good'] });
    assert.equal((await post(h.base, '/v1/chat/completions', CHAT, { authorization: 'Bearer fw-good' })).status, 200);
    assert.equal((await post(h.base, '/v1/chat/completions', CHAT, { 'x-api-key': 'fw-good' })).status, 200);
  });

  it('is open when no keys are configured', async () => {
    const h = await harness();
    assert.equal((await post(h.base, '/v1/chat/completions', CHAT)).status, 200);
  });

  it('leaves /healthz reachable without a key', async () => {
    const h = await harness({ keys: ['fw-good'] });
    const res = await fetch(`${h.base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { ok: boolean }).ok, true);
  });
});

describe('gateway — embeddings', () => {
  it('routes to an embedding model, never a chat one', async () => {
    const h = await harness();
    const res = await post(h.base, '/v1/embeddings', { model: 'auto', input: ['alpha', 'beta'] });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-freeway-model'), 'alpha-embed');

    const body = (await res.json()) as { data: { embedding: number[] }[] };
    assert.equal(body.data.length, 2);
    assert.ok(Array.isArray(body.data[0]?.embedding));
  });

  it('rejects an embeddings call with no input', async () => {
    const h = await harness();
    const res = await post(h.base, '/v1/embeddings', { model: 'auto' });
    assert.equal(res.status, 400);
  });
});

describe('gateway — capability routing', () => {
  it('sends a tools request only to a provider that supports tools', async () => {
    const h = await harness();
    const res = await post(h.base, '/v1/chat/completions', {
      ...CHAT,
      model: 'fast',
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-freeway-provider'), 'alpha', 'beta lacks the tools capability');
    assert.equal(h.beta.callsTo('/chat/completions').length, 0);
  });

  it('routes a json_object request to a json-capable model', async () => {
    const h = await harness();
    const res = await post(h.base, '/v1/chat/completions', { ...CHAT, model: 'fast', response_format: { type: 'json_object' } });
    assert.equal(res.headers.get('x-freeway-provider'), 'alpha');
  });
});

describe('gateway — dashboard API', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it('GET /v1/models returns provider/model ids plus virtual aliases', async () => {
    const res = await fetch(`${h.base}/v1/models`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { object: string; data: { id: string; owned_by: string }[] };
    assert.equal(body.object, 'list');
    const ids = body.data.map((d) => d.id);
    assert.ok(ids.includes('alpha/alpha-chat'));
    assert.ok(ids.includes('beta/@cf/meta/llama-3.1-8b-instruct'), 'slashy ids survive the catalog');
    assert.ok(ids.includes('fast'), 'aliases appear as virtual models');
    assert.ok(ids.includes('auto'));
  });

  it('GET /api/providers exposes state with masked keys only', async () => {
    const res = await fetch(`${h.base}/api/providers`);
    const body = (await res.json()) as { providers: { id: string; keys: { masked: string }[]; bars: unknown[] }[] };

    const alpha = body.providers.find((p) => p.id === 'alpha');
    assert.ok(alpha);
    assert.equal(alpha.keys.length, 2);
    assert.equal(alpha.keys[0]?.masked, 'ak-0…0001');

    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('ak-000000000001'), 'a raw provider key must never reach the dashboard');
    assert.ok(!raw.includes('bk-000000000001'));
  });

  it('GET /api/logs shows the served request', async () => {
    await post(h.base, '/v1/chat/completions', CHAT);
    const res = await fetch(`${h.base}/api/logs`);
    const body = (await res.json()) as { logs: { providerId: string; status: number; resolution: string }[] };

    assert.equal(body.logs.length, 1);
    assert.equal(body.logs[0]?.providerId, 'alpha');
    assert.equal(body.logs[0]?.status, 200);
    assert.equal(body.logs[0]?.resolution, 'auto');
  });

  it('POST /api/providers/:id/enabled takes a provider out of rotation', async () => {
    const toggle = await post(h.base, '/api/providers/alpha/enabled', { enabled: false });
    assert.equal(toggle.status, 200);

    const res = await post(h.base, '/v1/chat/completions', { ...CHAT, model: 'fast' });
    assert.equal(res.headers.get('x-freeway-provider'), 'beta');
  });

  it('POST /api/reload re-reads providers without a restart', async () => {
    const res = await post(h.base, '/api/reload', {});
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { ok: boolean }).ok, true);
  });

  it('GET /api/stats summarises the fleet', async () => {
    const res = await fetch(`${h.base}/api/stats`);
    const body = (await res.json()) as { providers: { total: number; usable: number }; strategy: string };
    assert.equal(body.providers.total, 2);
    assert.equal(body.providers.usable, 2);
    assert.equal(body.strategy, 'priority');
  });
});

describe('gateway — live event stream', () => {
  /** Read SSE frames off a fetch body until `want` events arrive or time runs out. */
  async function collect(res: Response, want: number, timeoutMs = 4000): Promise<{ event: string; data: Record<string, unknown> }[]> {
    const out: { event: string; data: Record<string, unknown> }[] = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event = 'message';
    const deadline = Date.now() + timeoutMs;

    while (out.length < want && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) {
          out.push({ event, data: JSON.parse(line.slice(5).trim()) as Record<string, unknown> });
          event = 'message';
        }
      }
    }
    await reader.cancel().catch(() => {});
    return out;
  }

  it('pushes a log entry the moment a request completes', async () => {
    const h = await harness();
    const res = await fetch(`${h.base}/api/events`, { headers: { accept: 'text/event-stream' } });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    const events = collect(res, 2);
    await post(h.base, '/v1/chat/completions', CHAT);
    const got = await events;

    assert.equal(got[0]?.event, 'hello');
    const log = got.find((e) => e.event === 'log');
    assert.ok(log, 'the completed request arrived as a live event');
    assert.equal(log.data['providerId'], 'alpha');
    assert.equal(log.data['status'], 200);
    assert.equal(log.data['resolution'], 'auto');
  });

  it('pushes failures too, with their attempt trail', async () => {
    const h = await harness();
    h.alpha.script([{ status: 429, repeat: Infinity }]);
    const res = await fetch(`${h.base}/api/events`, { headers: { accept: 'text/event-stream' } });

    const events = collect(res, 2);
    await post(h.base, '/v1/chat/completions', { ...CHAT, model: 'fast' });
    const log = (await events).find((e) => e.event === 'log');

    assert.ok(log);
    assert.equal(log.data['providerId'], 'beta');
    assert.ok(Array.isArray(log.data['attempts']) && (log.data['attempts'] as unknown[]).length > 0);
  });

  it('unsubscribes when the client goes away, so listeners cannot leak', async () => {
    const h = await harness();
    assert.equal(h.store.listenerCount(), 0);

    const controller = new AbortController();
    const res = await fetch(`${h.base}/api/events`, { signal: controller.signal });
    await collect(res, 1); // wait for `hello` so the subscription is registered
    assert.equal(h.store.listenerCount(), 1);

    controller.abort();
    // A long-lived dashboard reconnecting all day must not accumulate listeners.
    for (let i = 0; i < 40 && h.store.listenerCount() > 0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(h.store.listenerCount(), 0);
  });

  it('requires a virtual key like the rest of /api', async () => {
    const h = await harness({ keys: ['fw-good'] });
    assert.equal((await fetch(`${h.base}/api/events`)).status, 401);
    const ok = await fetch(`${h.base}/api/events`, { headers: { authorization: 'Bearer fw-good' } });
    assert.equal(ok.status, 200);
    await ok.body?.cancel();
  });
});

describe('gateway — dashboard', () => {
  it('serves the dashboard at / without requiring a key', async () => {
    // The dashboard has to load before it can ask for a key, so `/` itself is
    // never gated; its `/api/*` fetches are.
    const h = await harness({ keys: ['fw-good'] });
    const res = await fetch(`${h.base}/`);

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /<title>Freeway<\/title>/);
  });

  it('is entirely self-contained — no CDN, no external anything', async () => {
    // A dashboard that phones out is a dashboard that breaks on an air-gapped
    // box and leaks which providers you run to whoever hosts the asset.
    const h = await harness();
    const html = await (await fetch(`${h.base}/`)).text();

    const external = [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
      .map((m) => m[1] ?? '')
      .filter((url) => /^(https?:)?\/\//i.test(url));

    assert.deepEqual(external, [], `dashboard must not reference external assets, found: ${external.join(', ')}`);
    assert.ok(!/@import/i.test(html), 'no CSS @import either');
  });
});

describe('gateway — malformed input', () => {
  it('rejects a body that is not JSON', async () => {
    const h = await harness();
    const res = await fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'invalid_json');
  });

  it('rejects a chat request with no messages', async () => {
    const h = await harness();
    const res = await post(h.base, '/v1/chat/completions', { model: 'auto' });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'missing_messages');
  });

  it('rejects a body over the size cap with 413, not a dropped connection', async () => {
    const { config: defaults } = parseConfig({}, {});
    const h = await harness({ guard: { ...defaults.guard, maxBodyBytes: 512 } });

    const res = await post(h.base, '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'x'.repeat(5000) }],
    });
    assert.equal(res.status, 413);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'payload_too_large');
  });

  it('404s an unknown route', async () => {
    const h = await harness();
    const res = await fetch(`${h.base}/v1/nonsense`);
    assert.equal(res.status, 404);
  });
});
