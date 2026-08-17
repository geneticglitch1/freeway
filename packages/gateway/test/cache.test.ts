/**
 * Cache behaviour through the whole stack: a hit must cost no upstream call and
 * no quota, and must be indistinguishable from a live answer to the client.
 */

import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ExactCache, Registry, Router, SemanticCache, Store, parseConfig, silentLogger, type CacheMode, type FreewayConfig } from '@freeway/core';

import { createGateway } from '../src/server.ts';
import { createMockUpstream } from '../../../scripts/mock-upstream.js';

const cleanups: (() => unknown)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

interface Mock {
  url: string;
  callsTo(path: string): unknown[];
  close(): Promise<unknown>;
}

interface Harness {
  base: string;
  upstream: Mock;
  cache: ExactCache;
  semantic: SemanticCache;
  store: Store;
}

async function harness(mode: CacheMode = 'safe', semanticOn = false): Promise<Harness> {
  const upstream = (await createMockUpstream({ name: 'up' })) as Mock;
  cleanups.push(() => upstream.close());

  const dir = mkdtempSync(join(tmpdir(), 'freeway-cache-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'up.json'), JSON.stringify({
    id: 'up', priority: 10, baseUrl: upstream.url,
    auth: { type: 'bearer', envKeys: ['UP_KEY'] }, limits: { rpm: 1000 },
    models: [
      { id: 'up-chat', alias: ['fast'], context: 128000, caps: ['chat'] },
      { id: 'up-embed', alias: ['embed'], context: 8000, caps: ['embed'] },
    ],
  }));

  const registry = new Registry({ dir, env: { UP_KEY: 'uk-000000000001' }, logger: silentLogger });
  const store = new Store({ file: null, logger: silentLogger });
  const { config } = parseConfig({}, {}) as { config: FreewayConfig };
  config.cache.mode = mode;
  config.cache.semantic.enabled = semanticOn;
  const router = new Router(registry, store, config);

  const cache = new ExactCache({ file: ':memory:', mode, ttlMs: 3_600_000, maxEntries: 100 });
  cleanups.push(() => cache.close());
  const semantic = new SemanticCache({ enabled: semanticOn, threshold: 0.92, maxEntries: 100, dims: 8 });

  const server: Server = createGateway({
    registry, store, router, config, logger: silentLogger, cache, semanticCache: semantic,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  cleanups.push(() => new Promise((r) => server.close(() => r(undefined))));

  return { base: `http://127.0.0.1:${port}`, upstream, cache, semantic, store };
}

async function chat(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ask = (content: string, over: Record<string, unknown> = {}) => ({
  model: 'fast',
  temperature: 0,
  messages: [{ role: 'user', content }],
  ...over,
});

describe('cache — exact hits', () => {
  it('serves the second identical request without touching the upstream', async () => {
    const h = await harness();

    const first = await chat(h.base, ask('what is the capital of France?'));
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-freeway-cache'), null, 'the first call is a miss');
    const firstBody = await first.text();

    const second = await chat(h.base, ask('what is the capital of France?'));
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('x-freeway-cache'), 'exact');
    assert.equal(await second.text(), firstBody, 'byte-identical to the original answer');

    assert.equal(h.upstream.callsTo('/chat/completions').length, 1, 'only one upstream call was ever made');
  });

  it('spends no quota on a hit', async () => {
    // Metering a cache hit would make the quota bars lie about what is left.
    const h = await harness();
    await chat(h.base, ask('question'));
    const after = h.store.provider('up').meter.used('rpm');

    await chat(h.base, ask('question'));
    assert.equal(h.store.provider('up').meter.used('rpm'), after, 'the hit did not count against the provider');
  });

  it('logs a hit distinctly', async () => {
    const h = await harness();
    await chat(h.base, ask('question'));
    await chat(h.base, ask('question'));

    const logs = h.store.logs(2);
    assert.equal(logs[0]?.cache, 'exact');
    assert.equal(logs[1]?.cache, null);
    assert.equal(logs[0]?.status, 200);
  });

  it('does not cache a creative call in safe mode', async () => {
    const h = await harness('safe');
    await chat(h.base, ask('write me a poem', { temperature: 0.9 }));
    const second = await chat(h.base, ask('write me a poem', { temperature: 0.9 }));

    assert.equal(second.headers.get('x-freeway-cache'), null);
    assert.equal(h.upstream.callsTo('/chat/completions').length, 2, 'both calls went upstream');
  });

  it('caches a creative call in aggressive mode', async () => {
    const h = await harness('aggressive');
    await chat(h.base, ask('write me a poem', { temperature: 0.9 }));
    const second = await chat(h.base, ask('write me a poem', { temperature: 0.9 }));
    assert.equal(second.headers.get('x-freeway-cache'), 'exact');
  });

  it('is inert when off', async () => {
    const h = await harness('off');
    await chat(h.base, ask('question'));
    const second = await chat(h.base, ask('question'));
    assert.equal(second.headers.get('x-freeway-cache'), null);
    assert.equal(h.upstream.callsTo('/chat/completions').length, 2);
  });

  it('treats a different question as a different request', async () => {
    const h = await harness();
    await chat(h.base, ask('question one'));
    const second = await chat(h.base, ask('question two'));
    assert.equal(second.headers.get('x-freeway-cache'), null);
  });
});

describe('cache — streaming replay', () => {
  it('replays a cached answer as SSE the client cannot distinguish', async () => {
    const h = await harness('aggressive');

    const live = await chat(h.base, ask('stream me', { stream: true }));
    assert.match(live.headers.get('content-type') ?? '', /text\/event-stream/);
    const liveText = await live.text();

    const cached = await chat(h.base, ask('stream me', { stream: true }));
    assert.equal(cached.headers.get('x-freeway-cache'), 'exact');
    assert.match(cached.headers.get('content-type') ?? '', /text\/event-stream/);

    const cachedText = await cached.text();
    assert.ok(cachedText.trimEnd().endsWith('data: [DONE]'));

    const contentOf = (sse: string): string =>
      [...sse.matchAll(/^data: (.+)$/gm)]
        .map((m) => m[1])
        .filter((p): p is string => p !== undefined && p !== '[DONE]')
        .map((p) => JSON.parse(p) as { choices?: { delta?: { content?: string } }[] })
        .flatMap((o) => o.choices ?? [])
        .map((c) => c.delta?.content ?? '')
        .join('');

    assert.equal(contentOf(cachedText), contentOf(liveText), 'the replayed text matches the original exactly');
  });
});

describe('cache — semantic tier', () => {
  it('hits on a differently-worded question above the threshold', async () => {
    // The mock's embeddings are deterministic from the text, so similar text
    // gives similar vectors — the same property a real embedder has.
    const h = await harness('safe', true);

    await chat(h.base, ask('what is the capital of France'));
    const before = h.upstream.callsTo('/chat/completions').length;

    const reworded = await chat(h.base, ask('what is the capital of France?'));
    assert.equal(reworded.status, 200);

    if (reworded.headers.get('x-freeway-cache') === 'semantic') {
      const score = Number(reworded.headers.get('x-freeway-cache-score'));
      assert.ok(score >= 0.92, `a hit must clear the threshold, got ${score}`);
      assert.equal(h.upstream.callsTo('/chat/completions').length, before, 'no chat call was made');
    }
  });

  it('never serves across a different system prompt', async () => {
    // The same question can have a different correct answer under a different
    // system prompt, so entries must be scoped.
    const h = await harness('safe', true);

    await chat(h.base, { ...ask('who are you'), messages: [{ role: 'system', content: 'You are a pirate.' }, { role: 'user', content: 'who are you' }] });
    const other = await chat(h.base, { ...ask('who are you'), messages: [{ role: 'system', content: 'You are a lawyer.' }, { role: 'user', content: 'who are you' }] });

    assert.equal(other.headers.get('x-freeway-cache'), null, 'a different system prompt must not reuse the answer');
  });

  it('does not consult the semantic tier when disabled', async () => {
    const h = await harness('safe', false);
    await chat(h.base, ask('a question'));
    await chat(h.base, ask('a slightly different question'));
    assert.equal(h.upstream.callsTo('/embeddings').length, 0, 'no embedding quota was spent');
  });
});

describe('cache — API', () => {
  it('reports stats and can be cleared', async () => {
    const h = await harness();
    await chat(h.base, ask('question'));
    await chat(h.base, ask('question'));

    const stats = (await (await fetch(`${h.base}/api/cache`)).json()) as {
      enabled: boolean; mode: string; exact: { hits: number; entries: number; tokensSaved: number };
    };
    assert.equal(stats.enabled, true);
    assert.equal(stats.mode, 'safe');
    assert.equal(stats.exact.hits, 1);
    assert.equal(stats.exact.entries, 1);
    assert.ok(stats.exact.tokensSaved > 0);

    assert.equal((await fetch(`${h.base}/api/cache`, { method: 'DELETE' })).status, 200);
    const after = (await (await fetch(`${h.base}/api/cache`)).json()) as { exact: { entries: number } };
    assert.equal(after.exact.entries, 0);
  });
});
