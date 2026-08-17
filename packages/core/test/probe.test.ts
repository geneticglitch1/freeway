import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { extractByPath, limitDrift, observedLimitsFrom, parseDuration, probeKey } from '../src/probe.ts';
import { EMPTY_LIMITS, type KeyRef, type LimitSpec, type ResolvedProvider } from '../src/types.ts';

describe('extractByPath — non-OpenAI response shapes stay a JSON edit', () => {
  it('reads the OpenAI envelope', () => {
    const body = { object: 'list', data: [{ id: 'a' }, { id: 'b' }] };
    assert.deepEqual(extractByPath(body, 'data[].id'), ['a', 'b']);
  });

  it('reads a bare array (GitHub Models)', () => {
    assert.deepEqual(extractByPath([{ id: 'x' }, { id: 'y' }], '[].id'), ['x', 'y']);
  });

  it('reads an alternative key name', () => {
    assert.deepEqual(extractByPath({ models: [{ name: 'm1' }] }, 'models[].name'), ['m1']);
  });

  it('reads a nested envelope', () => {
    assert.deepEqual(extractByPath({ result: [{ name: 'r1' }, { name: 'r2' }] }, 'result[].name'), ['r1', 'r2']);
  });

  it('returns nothing rather than throwing on a mismatch', () => {
    assert.deepEqual(extractByPath({ data: [{ id: 'a' }] }, 'models[].name'), []);
    assert.deepEqual(extractByPath(null, 'data[].id'), []);
    assert.deepEqual(extractByPath({ data: 'not-an-array' }, 'data[].id'), []);
  });

  it('drops non-string entries', () => {
    assert.deepEqual(extractByPath({ data: [{ id: 'a' }, { id: 42 }, {}] }, 'data[].id'), ['a']);
  });
});

describe('parseDuration', () => {
  it('handles the formats providers actually send', () => {
    assert.equal(parseDuration('60'), 60_000);
    assert.equal(parseDuration('1s'), 1000);
    assert.equal(parseDuration('500ms'), 500);
    assert.equal(parseDuration('2m'), 120_000);
    assert.equal(parseDuration('6m0s'), 360_000);
    assert.equal(parseDuration('1h'), 3_600_000);
    assert.equal(parseDuration('nonsense'), null);
  });
});

describe('observedLimitsFrom — learning real limits from headers', () => {
  const h = (o: Record<string, string>) => new Headers(o);

  it('reads explicitly windowed headers (Cerebras style)', () => {
    const limits = observedLimitsFrom(h({
      'x-ratelimit-limit-requests-day': '14400',
      'x-ratelimit-limit-tokens-minute': '60000',
    }));
    assert.equal(limits.rpd, 14400);
    assert.equal(limits.tpm, 60000);
  });

  it('infers the window from a reset duration (OpenAI/Groq style)', () => {
    const limits = observedLimitsFrom(h({
      'x-ratelimit-limit-requests': '30',
      'x-ratelimit-reset-requests': '60s',
      'x-ratelimit-limit-tokens': '6000',
      'x-ratelimit-reset-tokens': '60s',
    }));
    assert.equal(limits.rpm, 30);
    assert.equal(limits.tpm, 6000);
  });

  it('maps a day-long reset to a daily limit', () => {
    const limits = observedLimitsFrom(h({ 'x-ratelimit-limit-requests': '1500', 'x-ratelimit-reset-requests': '24h' }));
    assert.equal(limits.rpd, 1500);
    assert.equal(limits.rpm, undefined);
  });

  it('assumes per-minute when no reset is given, which is the conservative read', () => {
    // Guessing "per day" here would let a burst straight through.
    assert.equal(observedLimitsFrom(h({ 'x-ratelimit-limit-requests': '20' })).rpm, 20);
  });

  it('reads the IETF draft headers', () => {
    assert.equal(observedLimitsFrom(h({ 'ratelimit-limit': '100', 'ratelimit-reset': '60' })).rpm, 100);
  });

  it('returns nothing when a provider says nothing', () => {
    assert.deepEqual(observedLimitsFrom(h({ 'content-type': 'application/json' })), {});
  });

  it('ignores nonsense values', () => {
    assert.deepEqual(observedLimitsFrom(h({ 'x-ratelimit-limit-requests': 'unlimited' })), {});
    assert.deepEqual(observedLimitsFrom(h({ 'x-ratelimit-limit-requests-day': '0' })), {});
  });
});

describe('limitDrift — catching a silently downgraded key', () => {
  const declared: LimitSpec = { ...EMPTY_LIMITS, rpm: 60, tpm: 40000 };

  it('flags a limit the file did not know about', () => {
    const drift = limitDrift(declared, { rpd: 1000 });
    assert.deepEqual(drift, [{ key: 'rpd', declared: null, observed: 1000 }]);
  });

  it('flags a meaningful disagreement', () => {
    // This is what a tier downgrade looks like from the outside.
    const drift = limitDrift(declared, { rpm: 30 });
    assert.deepEqual(drift, [{ key: 'rpm', declared: 60, observed: 30 }]);
  });

  it('tolerates rounding noise', () => {
    assert.deepEqual(limitDrift(declared, { rpm: 59 }), []);
  });

  it('says nothing when they agree', () => {
    assert.deepEqual(limitDrift(declared, { rpm: 60, tpm: 40000 }), []);
  });
});

// ---------------------------------------------------------------------------

function fakeProvider(overrides: Partial<ResolvedProvider['spec']> = {}): ResolvedProvider {
  const spec = {
    id: 'acme', label: 'Acme', docs: null, console: null, enabled: true, priority: 50,
    adapter: 'openai' as const, baseUrl: 'https://api.acme.test/v1',
    auth: { type: 'bearer' as const, header: null, query: null, envKeys: ['ACME_KEY'], prefix: null },
    limits: { ...EMPTY_LIMITS }, limitsSource: 'unverified' as const, verifiedOn: null,
    modelsEndpoint: '/models', modelsPath: 'data[].id', dropParams: [], headers: {}, notes: null,
    models: [{ id: 'acme-chat', label: 'Acme Chat', alias: [], context: 8000, caps: ['chat' as const], priority: 50, enabled: true, maxOutput: null, credits: null }],
    ...overrides,
  };
  return {
    spec, id: spec.id, label: spec.label, enabled: true, baseUrl: spec.baseUrl,
    headers: {}, keys: [], configured: true, configError: null,
    models: spec.models.map((m) => ({ spec: m, providerId: spec.id, ref: `${spec.id}/${m.id}` })),
  };
}

const KEY: KeyRef = { id: 'acme#0', providerId: 'acme', index: 0, value: 'sk-secret-value', masked: 'sk-s…alue', source: 'ACME_KEY' };

describe('probeKey', () => {
  it('discovers models and observes limits in one pass', async () => {
    const provider = fakeProvider();
    const result = await probeKey(provider, KEY, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: [{ id: 'acme-chat' }, { id: 'acme-turbo' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-ratelimit-limit-requests': '60', 'x-ratelimit-reset-requests': '60s' },
        }),
    });

    assert.equal(result.auth, 'ok');
    assert.deepEqual(result.discovered, ['acme-chat', 'acme-turbo']);
    assert.equal(result.observedLimits.rpm, 60);
    // Declared first, then ids only the API knows about.
    assert.deepEqual(result.models.map((m) => m.id), ['acme-chat', 'acme-turbo']);
    assert.equal(result.models[1]?.discovered, true, 'acme-turbo is not in the file yet');
  });

  it('sends the credential the way the spec says', async () => {
    let seen: Record<string, string> = {};
    const provider = fakeProvider({
      auth: { type: 'header', header: 'x-api-key', query: null, envKeys: ['ACME_KEY'], prefix: null },
    });
    await probeKey(provider, KEY, {
      fetchImpl: async (_url, init) => {
        seen = (init?.headers ?? {}) as Record<string, string>;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
    });
    assert.equal(seen['x-api-key'], 'sk-secret-value');
    assert.equal(seen['authorization'], undefined);
  });

  it('puts a query-param credential in the URL', async () => {
    let url = '';
    const provider = fakeProvider({ auth: { type: 'query', header: null, query: 'key', envKeys: ['ACME_KEY'], prefix: null } });
    await probeKey(provider, KEY, {
      fetchImpl: async (u) => {
        url = String(u);
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
    });
    assert.match(url, /[?&]key=sk-secret-value/);
  });

  it('classifies a rejected credential', async () => {
    const result = await probeKey(fakeProvider(), KEY, {
      fetchImpl: async () => new Response('nope', { status: 401 }),
    });
    assert.equal(result.auth, 'invalid');
    assert.match(result.errors[0] ?? '', /GET \/models → 401/);
  });

  it('says so when modelsPath matches nothing, rather than reporting zero models', async () => {
    const result = await probeKey(fakeProvider(), KEY, {
      fetchImpl: async () => new Response(JSON.stringify({ result: [{ name: 'a' }] }), { status: 200 }),
    });
    assert.equal(result.auth, 'ok');
    assert.equal(result.discovered.length, 0);
    assert.match(result.errors[0] ?? '', /modelsPath "data\[\]\.id" matched nothing/);
  });

  it('skips discovery when the provider has no catalog endpoint', async () => {
    let called = 0;
    const provider = fakeProvider({ modelsEndpoint: null });
    const result = await probeKey(provider, KEY, {
      fetchImpl: async () => {
        called += 1;
        return new Response('{}', { status: 200 });
      },
    });
    assert.equal(called, 0, 'no request is made when modelsEndpoint is null');
    assert.deepEqual(result.models.map((m) => m.id), ['acme-chat']);
  });

  it('validates each model when asked, and classifies the answers', async () => {
    const provider = fakeProvider();
    const result = await probeKey(provider, KEY, {
      validateModels: true,
      fetchImpl: async (url, init) => {
        if (init?.method !== 'POST') {
          return new Response(JSON.stringify({ data: [{ id: 'acme-chat' }, { id: 'gone' }] }), { status: 200 });
        }
        const body = JSON.parse(String(init.body)) as { model: string };
        if (body.model === 'gone') return new Response('no such model', { status: 404 });
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      },
    });

    const byId = Object.fromEntries(result.models.map((m) => [m.id, m.status]));
    assert.equal(byId['acme-chat'], 'ok');
    assert.equal(byId['gone'], 'unknown-model');
  });

  it('distinguishes "the id is real" from "the id serves chat"', async () => {
    // A 400 proves the model exists but not that it takes a chat body — which
    // is exactly what an OCR or text-to-speech model does. Reporting that as
    // `ok` is how `auto` ends up routing a conversation into a TTS endpoint.
    const result = await probeKey(fakeProvider({ modelsEndpoint: null }), KEY, {
      validateModels: true,
      fetchImpl: async () => new Response('Invalid model: not-a-chat-model', { status: 400 }),
    });
    assert.equal(result.models[0]?.status, 'exists');
    assert.notEqual(result.models[0]?.status, 'ok');
  });

  it('probes a discovered embeddings model with an embeddings body', async () => {
    // Sending a chat body to an embeddings model just makes it look broken.
    const paths: string[] = [];
    await probeKey(fakeProvider(), KEY, {
      validateModels: true,
      fetchImpl: async (url, init) => {
        if (init?.method !== 'POST') return new Response(JSON.stringify({ data: [{ id: 'acme-embed-v2' }] }), { status: 200 });
        paths.push(new URL(String(url)).pathname);
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
    });
    assert.ok(paths.some((p) => p.endsWith('/embeddings')), `expected an /embeddings probe, got ${paths.join(', ')}`);
  });

  it('survives an unreachable provider', async () => {
    const result = await probeKey(fakeProvider(), KEY, {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    assert.equal(result.auth, 'unreachable');
    assert.match(result.errors[0] ?? '', /ECONNREFUSED/);
  });

  it('never puts the raw key in its result', async () => {
    const result = await probeKey(fakeProvider(), KEY, {
      fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    });
    assert.ok(!JSON.stringify(result).includes('sk-secret-value'));
    assert.equal(result.keyMasked, 'sk-s…alue');
  });
});
