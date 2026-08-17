import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { parseConfig } from '../src/config.ts';
import { Registry } from '../src/registry.ts';
import { Router } from '../src/router.ts';
import { Store } from '../src/store.ts';
import type { FreewayConfig, Strategy } from '../src/types.ts';
import { silentLogger } from '../src/util.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Two providers with overlapping aliases, a two-key pool, a Cloudflare-shaped
 * slashy model id, and models with differing caps and context windows.
 */
const FIXTURES = {
  'alpha.json': {
    id: 'alpha',
    priority: 10,
    baseUrl: 'https://alpha.test/v1',
    auth: { type: 'bearer', envKeys: ['ALPHA_KEY'] },
    limits: { rpm: 10 },
    models: [
      { id: 'alpha-chat', alias: ['fast'], context: 128000, caps: ['chat', 'tools', 'json'], priority: 10 },
      { id: 'alpha-tiny', alias: [], context: 4096, caps: ['chat'], priority: 20 },
      { id: 'alpha-embed', alias: ['embed'], context: 8000, caps: ['embed'], priority: 10 },
    ],
  },
  'beta.json': {
    id: 'beta',
    priority: 20,
    baseUrl: 'https://beta.test/v1',
    auth: { type: 'bearer', envKeys: ['BETA_KEY'] },
    limits: { rpm: 10 },
    models: [
      { id: '@cf/meta/llama-3.1-8b-instruct', alias: ['fast'], context: 8192, caps: ['chat'], priority: 10 },
      { id: 'beta-vision', alias: [], context: 32000, caps: ['chat', 'vision'], priority: 20 },
    ],
  },
};

interface Harness {
  registry: Registry;
  store: Store;
  router: Router;
  config: FreewayConfig;
}

function harness(overrides: Partial<FreewayConfig> = {}, env?: Record<string, string | undefined>): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'freeway-router-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(FIXTURES)) writeFileSync(join(dir, name), JSON.stringify(body));

  const registry = new Registry({
    dir,
    env: env ?? { ALPHA_KEY: 'ak-000000000001,ak-000000000002', BETA_KEY: 'bk-000000000001' },
    logger: silentLogger,
  });
  const store = new Store({ file: null, logger: silentLogger });
  const { config } = parseConfig({}, {});
  Object.assign(config, overrides);
  return { registry, store, router: new Router(registry, store, config), config };
}

function refs(result: { candidates: { model: { ref: string } }[] }): string[] {
  return [...new Set(result.candidates.map((c) => c.model.ref))];
}

describe('Router — model string resolution', () => {
  it('1. auto returns every chat model and excludes embeddings', () => {
    const { router } = harness();
    const r = router.route({ model: 'auto' });
    assert.equal(r.resolution, 'auto');
    assert.equal(r.matched, true);
    assert.ok(refs(r).includes('alpha/alpha-chat'));
    assert.ok(!refs(r).includes('alpha/alpha-embed'), 'embedding models never serve chat');
  });

  it('1. treats an empty model string as auto', () => {
    const { router } = harness();
    assert.equal(router.route({ model: '' }).resolution, 'auto');
    assert.equal(router.route({ model: 'freeway' }).resolution, 'auto');
  });

  it('2. pins provider/model, splitting on the FIRST slash only', () => {
    // A Cloudflare id has two more slashes of its own; naive splitting breaks it.
    const { router } = harness();
    const r = router.route({ model: 'beta/@cf/meta/llama-3.1-8b-instruct' });
    assert.equal(r.matched, true);
    assert.equal(r.resolution, 'pin:beta/@cf/meta/llama-3.1-8b-instruct');
    assert.deepEqual(refs(r), ['beta/@cf/meta/llama-3.1-8b-instruct']);
  });

  it('2. pins a whole provider with provider/*', () => {
    const { router } = harness();
    const r = router.route({ model: 'alpha/*' });
    assert.equal(r.resolution, 'pin:alpha/*');
    assert.deepEqual(refs(r).sort(), ['alpha/alpha-chat', 'alpha/alpha-tiny']);
  });

  it('2. an unknown model under a known provider does not match', () => {
    const { router } = harness();
    const r = router.route({ model: 'alpha/no-such-model' });
    assert.equal(r.matched, false);
  });

  it('3. config aliases beat registry aliases', () => {
    const { router } = harness({ aliases: { fast: 'beta/beta-vision' } });
    const r = router.route({ model: 'fast' });
    assert.equal(r.resolution, 'alias:fast->beta/beta-vision');
    assert.deepEqual(refs(r), ['beta/beta-vision']);
  });

  it('keeps every resolution string safe to put in an HTTP header', () => {
    // `resolution` is served as x-freeway-route. A non-latin-1 character here
    // makes writeHead throw and turns a good response into a 500 — which is
    // exactly what a Unicode arrow in this string used to do.
    const { router } = harness({ aliases: { fast: 'beta/beta-vision', missing: 'nope/nope' } });
    for (const model of ['auto', 'fast', 'missing', 'alpha/*', 'alpha-tiny', 'llama-3.1-8b', 'no-such-model']) {
      const { resolution } = router.route({ model });
      assert.ok(/^[\x20-\x7E]*$/.test(resolution), `resolution "${resolution}" for "${model}" is not header-safe`);
    }
  });

  it('4. a registry alias collects every model that declares it', () => {
    const { router } = harness();
    const r = router.route({ model: 'fast' });
    assert.equal(r.resolution, 'alias:fast');
    assert.deepEqual(refs(r).sort(), ['alpha/alpha-chat', 'beta/@cf/meta/llama-3.1-8b-instruct']);
  });

  it('5. matches an exact upstream model id across providers', () => {
    const { router } = harness();
    const r = router.route({ model: 'alpha-tiny' });
    assert.equal(r.resolution, 'model:alpha-tiny');
    assert.deepEqual(refs(r), ['alpha/alpha-tiny']);
  });

  it('6. fuzzy substring finds a slashy id from its bare name', () => {
    const { router } = harness();
    const r = router.route({ model: 'llama-3.1-8b' });
    assert.equal(r.resolution, 'fuzzy:llama-3.1-8b');
    assert.deepEqual(refs(r), ['beta/@cf/meta/llama-3.1-8b-instruct']);
  });

  it('reports no match with suggestions rather than guessing', () => {
    const { router } = harness();
    const r = router.route({ model: 'alpha-chatt' });
    // Close enough to be a typo, so it fuzzily matches nothing but suggests.
    if (!r.matched) {
      assert.ok(r.suggestions.includes('alpha/alpha-chat'), `expected a suggestion, got ${r.suggestions.join(',')}`);
    }
  });

  it('suggests the closest ids for a wholly unknown model', () => {
    const { router } = harness();
    const r = router.route({ model: 'gpt-4o' });
    assert.equal(r.matched, false);
    assert.equal(r.candidates.length, 0);
  });

  it('routes embeddings to embedding models only', () => {
    const { router } = harness();
    const r = router.route({ model: 'auto', embedding: true });
    assert.deepEqual(refs(r), ['alpha/alpha-embed']);
  });
});

describe('Router — capability and context filtering', () => {
  it('blocks a model that lacks a required capability, and says which', () => {
    const { router } = harness();
    const r = router.route({ model: 'fast', requiredCaps: ['tools'] });
    assert.deepEqual(refs(r), ['alpha/alpha-chat']);

    const blocked = r.blocked.find((b) => b.modelId === '@cf/meta/llama-3.1-8b-instruct');
    assert.ok(blocked);
    assert.equal(blocked.reason, 'missing capability: tools');
  });

  it('blocks a model whose window is too small, with both numbers', () => {
    const { router } = harness();
    const r = router.route({ model: 'alpha/*', minContext: 32000 });
    assert.deepEqual(refs(r), ['alpha/alpha-chat']);

    const blocked = r.blocked.find((b) => b.modelId === 'alpha-tiny');
    assert.ok(blocked);
    assert.equal(blocked.reason, 'context window 4096 < required 32000');
  });

  it('refuses to promise a context window it does not know', () => {
    const { router, registry } = harness();
    const m = registry.get('alpha')?.models.find((x) => x.spec.id === 'alpha-tiny');
    assert.ok(m);
    m.spec.context = null;

    const r = router.route({ model: 'alpha/alpha-tiny', minContext: 1000 });
    assert.equal(r.candidates.length, 0);
    assert.match(r.blocked[0]?.reason ?? '', /context window unknown/);
  });

  it('blocks an unconfigured provider with the env var to set', () => {
    const { router } = harness({}, { ALPHA_KEY: 'ak-000000000001' });
    const r = router.route({ model: 'fast' });
    const blocked = r.blocked.find((b) => b.providerId === 'beta');
    assert.ok(blocked);
    assert.equal(blocked.reason, 'provider not configured: no API key found (set one of: BETA_KEY)');
  });

  it('blocks a disabled provider', () => {
    const { router, registry } = harness();
    registry.setEnabled('beta', false);
    const r = router.route({ model: 'fast' });
    assert.deepEqual(refs(r), ['alpha/alpha-chat']);
    assert.ok(r.blocked.some((b) => b.providerId === 'beta' && b.reason === 'provider disabled'));
  });
});

describe('Router — quota and cooldown', () => {
  it('moves a quota-exhausted provider into blocked with a diagnostic reason', () => {
    const { router, store } = harness();
    for (let i = 0; i < 10; i++) store.recordSuccess('alpha', 'alpha#0', 10);

    const r = router.route({ model: 'fast' });
    assert.deepEqual(refs(r), ['beta/@cf/meta/llama-3.1-8b-instruct'], 'failed over to the other provider');

    const blocked = r.blocked.find((b) => b.providerId === 'alpha');
    assert.ok(blocked);
    assert.match(blocked.reason, /rpm limit reached \(10\/10 last 60s\)/);
    assert.ok((blocked.retryAfterMs ?? 0) > 0, 'tells the caller when to come back');
  });

  it('a 429 benches one key but the pool stays viable', () => {
    const { router, store } = harness();
    store.recordFailure('alpha', 'alpha#0', { status: 429, message: 'rate limited' });

    const r = router.route({ model: 'alpha/alpha-chat' });
    const keys = r.candidates.map((c) => c.key.id);
    assert.ok(keys.includes('alpha#1'), 'the healthy key is still offered');
    assert.ok(!keys.includes('alpha#0'), 'the benched key is not');
    assert.equal(r.blocked.length, 0, 'the provider is not blocked at all');
  });

  it('reports every key when the whole pool is down, with masked ids', () => {
    const { router, store } = harness();
    store.recordFailure('alpha', 'alpha#0', { status: 429, message: 'rate limited' });
    store.recordFailure('alpha', 'alpha#1', { status: 401, message: 'unauthorized' });

    const r = router.route({ model: 'alpha/alpha-chat' });
    assert.equal(r.candidates.length, 0);
    const blocked = r.blocked[0];
    assert.ok(blocked);
    assert.match(blocked.reason, /all 2 keys unavailable/);
    assert.match(blocked.reason, /ak-0…0001/, 'keys appear masked, never raw');
    assert.ok(!blocked.reason.includes('ak-000000000001'), 'the raw key must never leak into an error');
  });

  it('a 503 benches the provider and routing moves on', () => {
    const { router, store } = harness();
    store.recordFailure('alpha', 'alpha#0', { status: 503, message: '503 from upstream' });

    const r = router.route({ model: 'fast' });
    assert.deepEqual(refs(r), ['beta/@cf/meta/llama-3.1-8b-instruct']);

    const blocked = r.blocked.find((b) => b.providerId === 'alpha');
    assert.ok(blocked);
    assert.match(blocked.reason, /provider cooling down for \d+s: 503 from upstream/);
  });

  it('leaves the whole blocked list as the error message when nothing is viable', () => {
    const { router, store } = harness();
    store.recordFailure('alpha', 'alpha#0', { status: 503, message: '503 from upstream' });
    store.recordFailure('beta', 'beta#0', { status: 503, message: 'connection reset' });

    const r = router.route({ model: 'fast' });
    assert.equal(r.matched, true, 'the model string was understood');
    assert.equal(r.candidates.length, 0, 'but nothing can serve it');
    assert.equal(r.blocked.length, 2);
    for (const b of r.blocked) assert.ok(b.reason.length > 20, `reason must be diagnostic, got "${b.reason}"`);
  });
});

describe('Router — strategies', () => {
  function order(strategy: Strategy, prep?: (h: Harness) => void): string[] {
    const h = harness({ strategy });
    prep?.(h);
    return refs(h.router.route({ model: 'fast' }));
  }

  it('priority follows provider then model priority', () => {
    assert.deepEqual(order('priority'), ['alpha/alpha-chat', 'beta/@cf/meta/llama-3.1-8b-instruct']);
  });

  it('least-used prefers the provider with the emptier window', () => {
    const result = order('least-used', ({ store }) => {
      for (let i = 0; i < 5; i++) store.recordSuccess('alpha', 'alpha#0', 10);
    });
    assert.deepEqual(result, ['beta/@cf/meta/llama-3.1-8b-instruct', 'alpha/alpha-chat']);
  });

  it('fastest prefers the lower EWMA latency', () => {
    const result = order('fastest', ({ store }) => {
      store.recordSuccess('alpha', 'alpha#0', 900);
      store.recordSuccess('beta', 'beta#0', 40);
    });
    assert.deepEqual(result, ['beta/@cf/meta/llama-3.1-8b-instruct', 'alpha/alpha-chat']);
  });

  it('fastest samples an untried provider rather than starving it', () => {
    // Optimistic initialisation: never-tried providers must get a chance to earn
    // a latency number, or the first provider measured wins forever.
    const result = order('fastest', ({ store }) => {
      store.recordSuccess('alpha', 'alpha#0', 900);
    });
    assert.equal(result[0], 'beta/@cf/meta/llama-3.1-8b-instruct');
  });

  it('round-robin rotates the head of the list between calls', () => {
    const h = harness({ strategy: 'round-robin' });
    const first = refs(h.router.route({ model: 'fast' }))[0];
    const second = refs(h.router.route({ model: 'fast' }))[0];
    assert.notEqual(first, second, 'consecutive calls should not hit the same provider');
  });

  it('rotates keys within a pool', () => {
    const h = harness();
    const first = h.router.route({ model: 'alpha/alpha-chat' }).candidates[0]?.key.id;
    const second = h.router.route({ model: 'alpha/alpha-chat' }).candidates[0]?.key.id;
    assert.notEqual(first, second, 'a pool should spread load, not hammer key #0');
  });
});

describe('Router — real shipped catalog', () => {
  const dir = join(import.meta.dirname, '..', '..', '..', 'providers');

  function real(env: Record<string, string | undefined>): Router {
    const registry = new Registry({ dir, env, logger: silentLogger });
    const store = new Store({ file: null, logger: silentLogger });
    const { config } = parseConfig({}, {});
    return new Router(registry, store, config);
  }

  it('pins a real Cloudflare model id without mangling the slashes', () => {
    const router = real({ CLOUDFLARE_ACCOUNT_ID: 'a1', CLOUDFLARE_API_TOKEN: 'cf-abcdefghijkl' });
    const r = router.route({ model: 'cloudflare/@cf/meta/llama-3.1-8b-instruct' });
    assert.equal(r.matched, true);
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0]?.model.spec.id, '@cf/meta/llama-3.1-8b-instruct');
  });

  it('tells you exactly what to set when nothing is configured', () => {
    const router = real({});
    const r = router.route({ model: 'auto' });
    assert.equal(r.matched, true);
    assert.equal(r.candidates.length, 0);
    const reasons = r.blocked.map((b) => b.reason);
    assert.ok(reasons.some((x) => /MISTRAL_API_KEY/.test(x)));
    assert.ok(reasons.some((x) => /CLOUDFLARE_ACCOUNT_ID/.test(x)));
  });
});
