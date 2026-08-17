/**
 * SDK tests drive a real gateway in front of real mock upstreams — the same
 * stack an app would hit, so nothing here is mocked at the fetch layer.
 */

import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { Registry, Router, Store, parseConfig, silentLogger, type FreewayConfig } from '@freeway/core';
import { createGateway } from '@freeway/gateway';

import { FreewayError, createFreeway, type FreewayClient } from '../src/index.ts';
import { createMockUpstream } from '../../../scripts/mock-upstream.js';

const cleanups: (() => unknown)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

interface Mock {
  url: string;
  script(steps: unknown[]): void;
  callsTo(path: string): unknown[];
  close(): Promise<unknown>;
}

interface Harness {
  fw: FreewayClient;
  base: string;
  alpha: Mock;
  beta: Mock;
  store: Store;
}

async function harness(overrides: Partial<FreewayConfig> = {}, clientKey = ''): Promise<Harness> {
  const alpha = (await createMockUpstream({ name: 'alpha' })) as Mock;
  const beta = (await createMockUpstream({ name: 'beta' })) as Mock;
  cleanups.push(() => alpha.close(), () => beta.close());

  const dir = mkdtempSync(join(tmpdir(), 'freeway-sdk-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, 'alpha.json'), JSON.stringify({
    id: 'alpha', priority: 10, baseUrl: alpha.url,
    auth: { type: 'bearer', envKeys: ['ALPHA_KEY'] }, limits: { rpm: 100 },
    models: [
      { id: 'alpha-chat', alias: ['fast'], context: 128000, caps: ['chat', 'tools'] },
      { id: 'alpha-embed', alias: ['embed'], context: 8000, caps: ['embed'] },
    ],
  }));
  writeFileSync(join(dir, 'beta.json'), JSON.stringify({
    id: 'beta', priority: 20, baseUrl: beta.url,
    auth: { type: 'bearer', envKeys: ['BETA_KEY'] }, limits: { rpm: 100 },
    models: [{ id: 'beta-chat', alias: ['fast'], context: 8192, caps: ['chat'] }],
  }));

  const registry = new Registry({ dir, env: { ALPHA_KEY: 'ak-00000000001', BETA_KEY: 'bk-00000000001' }, logger: silentLogger });
  const store = new Store({ file: null, logger: silentLogger });
  const { config } = parseConfig({}, {});
  Object.assign(config, overrides);
  const router = new Router(registry, store, config);

  const server: Server = createGateway({ registry, store, router, config, logger: silentLogger });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  cleanups.push(() => new Promise((r) => server.close(() => r(undefined))));

  const base = `http://127.0.0.1:${port}`;
  return { fw: createFreeway({ baseUrl: `${base}/v1`, apiKey: clientKey, maxRetries: 2 }), base, alpha, beta, store };
}

describe('SDK — chat', () => {
  it('prompt in, string out', async () => {
    const { fw } = await harness();
    const text = await fw.chat('summarize this');
    assert.equal(typeof text, 'string');
    assert.match(text, /\[alpha\]/);
  });

  it('accepts a system prompt and options', async () => {
    const { fw, alpha } = await harness();
    await fw.chat('hello', { model: 'fast', system: 'be terse', temperature: 0.1, max_tokens: 64 });

    const call = alpha.callsTo('/chat/completions')[0] as { body: { messages: { role: string }[]; temperature: number; max_tokens: number } };
    assert.deepEqual(call.body.messages.map((m) => m.role), ['system', 'user']);
    assert.equal(call.body.temperature, 0.1);
    assert.equal(call.body.max_tokens, 64);
  });

  it('chat.raw exposes the full completion plus the route', async () => {
    const { fw } = await harness();
    const res = await fw.chat.raw({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });

    assert.ok(Array.isArray(res.choices));
    assert.equal(res.route.provider, 'alpha');
    assert.equal(res.route.model, 'alpha-chat');
    assert.equal(res.route.route, 'auto');
    assert.equal(res.route.attempts, 1);
    assert.ok(res.route.ms >= 0);
  });

  it('surfaces which provider actually served a failed-over call', async () => {
    const { fw, alpha } = await harness();
    alpha.script([{ status: 429, repeat: Infinity }]);

    const res = await fw.chat.raw({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.route.provider, 'beta', 'the app can see the failover from inside');
    assert.equal(res.route.attempts, 2);
  });
});

describe('SDK — streaming', () => {
  it('yields chunks and returns the route when done', async () => {
    const { fw } = await harness();
    const iter = fw.stream({ model: 'alpha/alpha-chat', messages: [{ role: 'user', content: 'stream please' }] });

    let text = '';
    let result = await iter.next();
    while (!result.done) {
      text += result.value.choices[0]?.delta.content ?? '';
      result = await iter.next();
    }

    assert.match(text, /\[alpha\]/);
    assert.equal(result.value.provider, 'alpha');
  });

  it('streamText yields only the text', async () => {
    const { fw } = await harness();
    const parts: string[] = [];
    for await (const piece of fw.streamText({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] })) {
      parts.push(piece);
    }
    assert.ok(parts.length > 1, 'arrived in several chunks');
    assert.match(parts.join(''), /\[alpha\]/);
  });

  it('reassembles a frame split across network chunks', async () => {
    // The mock deliberately chunks mid-word; a naive parser drops those.
    const { fw } = await harness();
    let text = '';
    for await (const piece of fw.streamText({ model: 'fast', messages: [{ role: 'user', content: 'x'.repeat(300) }] })) {
      text += piece;
    }
    assert.ok(text.length > 50);
  });
});

describe('SDK — embeddings and models', () => {
  it('returns vectors in input order', async () => {
    const { fw } = await harness();
    const vectors = await fw.embed(['alpha', 'beta', 'gamma']);
    assert.equal(vectors.length, 3);
    assert.ok(Array.isArray(vectors[0]));
    assert.equal(vectors.route.model, 'alpha-embed');
  });

  it('accepts a bare string', async () => {
    const { fw } = await harness();
    const vectors = await fw.embed('just one');
    assert.equal(vectors.length, 1);
  });

  it('lists the catalog including virtual aliases', async () => {
    const { fw } = await harness();
    const models = await fw.models();
    const ids = models.map((m) => m.id);
    assert.ok(ids.includes('alpha/alpha-chat'));
    assert.ok(ids.includes('auto'));
    assert.ok(models.find((m) => m.id === 'auto')?.freeway?.virtual);
  });

  it('reads health without a key', async () => {
    const { fw } = await harness();
    const health = await fw.health();
    assert.equal(health.ok, true);
    assert.equal(health.providers.usable, 2);
  });
});

describe('SDK — errors', () => {
  it('throws FreewayError carrying the blocked list', async () => {
    const { fw, store } = await harness();
    for (let i = 0; i < 100; i++) {
      store.recordSuccess('alpha', 'alpha#0', 1);
      store.recordSuccess('beta', 'beta#0', 1);
    }

    await assert.rejects(
      () => fw.chat('hi', { model: 'fast', maxRetries: 1 }),
      (err: unknown) => {
        assert.ok(err instanceof FreewayError);
        assert.equal(err.status, 429);
        assert.equal(err.code, 'all_providers_blocked');
        assert.equal(err.blocked.length, 2);
        assert.match(err.blocked[0]?.reason ?? '', /rpm limit reached/);
        assert.ok((err.retryAfterMs ?? 0) > 0);
        return true;
      },
    );
  });

  it('throws with suggestions for an unknown model', async () => {
    const { fw } = await harness();
    await assert.rejects(
      () => fw.chat('hi', { model: 'gpt-9-ultra', maxRetries: 1 }),
      (err: unknown) => {
        assert.ok(err instanceof FreewayError);
        assert.equal(err.status, 404);
        assert.equal(err.code, 'model_not_found');
        return true;
      },
    );
  });

  it('does not retry a 400', async () => {
    const { fw, alpha } = await harness();
    alpha.script([{ status: 400, body: { error: { message: 'bad param' } }, repeat: Infinity }]);

    await assert.rejects(() => fw.chat('hi', { model: 'alpha/alpha-chat' }));
    assert.equal(alpha.callsTo('/chat/completions').length, 1, 'a malformed request is not worth repeating');
  });

  it('honours the gateway’s Retry-After and succeeds once the bench expires', async () => {
    // A 5xx benches the provider for `cooldownSeconds`, so a useful retry has to
    // wait that long — which is exactly what Retry-After tells the client.
    const { fw, alpha, beta } = await harness({ maxAttempts: 1, cooldownSeconds: 1 });
    alpha.script([{ status: 500, repeat: 1 }, { status: 200, repeat: Infinity }]);
    beta.script([{ status: 500, repeat: 1 }, { status: 200, repeat: Infinity }]);

    const started = Date.now();
    const text = await fw.chat('hi', { model: 'fast', maxRetries: 4 });
    assert.match(text, /\[(alpha|beta)\]/);
    assert.ok(Date.now() - started >= 900, 'it waited for the window rather than hammering');
  });
});

describe('SDK — auth and configuration', () => {
  it('sends the virtual key', async () => {
    const { fw } = await harness({ keys: ['fw-secret'] }, 'fw-secret');
    assert.match(await fw.chat('hi'), /\[alpha\]/);
  });

  it('fails cleanly with a wrong key', async () => {
    const { fw } = await harness({ keys: ['fw-secret'] }, 'fw-wrong');
    await assert.rejects(
      () => fw.chat('hi', { maxRetries: 1 }),
      (err: unknown) => err instanceof FreewayError && err.status === 401,
    );
  });

  it('normalises a base URL without /v1', () => {
    assert.equal(createFreeway({ baseUrl: 'http://localhost:8787' }).baseUrl, 'http://localhost:8787/v1');
    assert.equal(createFreeway({ baseUrl: 'http://localhost:8787/v1/' }).baseUrl, 'http://localhost:8787/v1');
  });

  it('exports a drop-in config for the OpenAI SDK', async () => {
    const { fw, base } = await harness({}, 'fw-key');
    const cfg = fw.openai();
    assert.equal(cfg.baseURL, `${base}/v1`);
    assert.equal(cfg.apiKey, 'fw-key');

    // Prove the shape actually works by calling it the way that SDK would.
    const res = await fetch(`${cfg.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
  });

  it('substitutes a placeholder key when the gateway is open', () => {
    // The OpenAI SDK refuses to construct with an empty apiKey.
    assert.equal(createFreeway({ baseUrl: 'http://x/v1' }).openai().apiKey, 'fw-unused');
  });

  it('puts a session id in the request body', async () => {
    // Asserted against the wire the SDK writes, not against what a provider
    // eventually sees — the gateway consumes `session` once Phase 8 lands.
    let sent: Record<string, unknown> | null = null;
    const client = createFreeway({
      baseUrl: 'http://example.invalid/v1',
      fetch: async (_url, init) => {
        sent = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await client.chat('hi', { session: 'thread-42' });
    assert.equal((sent as unknown as Record<string, unknown>)['session'], 'thread-42');
  });

  it('respects an external AbortSignal', async () => {
    const { fw } = await harness();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => fw.chat('hi', { signal: controller.signal, maxRetries: 1 }));
  });
});
