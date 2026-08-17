import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ExactCache, cacheKey, isCacheable, replayAsStream } from '../src/cache/exact.ts';
import { SemanticCache, queryTextOf, systemPromptOf } from '../src/cache/semantic.ts';

const opts = { file: ':memory:', mode: 'safe' as const, ttlMs: 3_600_000, maxEntries: 100 };
const body = (over: Record<string, unknown> = {}) => ({
  model: 'auto',
  messages: [{ role: 'user', content: 'what is the capital of France?' }],
  temperature: 0,
  ...over,
});

describe('cacheKey — what counts as the same request', () => {
  it('is stable regardless of key order', () => {
    const a = cacheKey('auto', { temperature: 0, messages: [{ role: 'user', content: 'hi' }] });
    const b = cacheKey('auto', { messages: [{ role: 'user', content: 'hi' }], temperature: 0 });
    assert.equal(a, b);
  });

  it('changes when anything that affects the answer changes', () => {
    const base = cacheKey('auto', body());
    assert.notEqual(base, cacheKey('auto', body({ temperature: 0.5 })));
    assert.notEqual(base, cacheKey('auto', body({ max_tokens: 10 })));
    assert.notEqual(base, cacheKey('auto', body({ messages: [{ role: 'user', content: 'different' }] })));
    assert.notEqual(base, cacheKey('auto', body({ response_format: { type: 'json_object' } })));
  });

  it('ignores fields that cannot change the answer', () => {
    assert.equal(cacheKey('auto', body()), cacheKey('auto', body({ user: 'alice', metadata: { trace: 'x' } })));
  });

  it('keys on the resolution, so two aliases for the same models share an entry', () => {
    assert.equal(cacheKey('alias:fast', body()), cacheKey('alias:fast', body()));
    assert.notEqual(cacheKey('alias:fast', body()), cacheKey('pin:groq/llama', body()));
  });
});

describe('isCacheable — safe mode only caches deterministic calls', () => {
  it('caches temperature 0', () => {
    assert.equal(isCacheable('safe', body({ temperature: 0 })), true);
    assert.equal(isCacheable('safe', body({ temperature: 0.1 })), true);
  });

  it('refuses a creative call', () => {
    // Replaying a temperature 0.9 answer turns a creative endpoint into a
    // broken record, which is worse than not caching at all.
    assert.equal(isCacheable('safe', body({ temperature: 0.9 })), false);
    assert.equal(isCacheable('safe', body({ temperature: undefined })), false, 'the provider default is not deterministic');
  });

  it('caches anything with an explicit seed', () => {
    assert.equal(isCacheable('safe', body({ temperature: 1, seed: 42 })), true);
  });

  it('aggressive caches everything, off caches nothing', () => {
    assert.equal(isCacheable('aggressive', body({ temperature: 1.5 })), true);
    assert.equal(isCacheable('off', body({ temperature: 0 })), false);
  });

  it('leaves streams alone unless asked', () => {
    assert.equal(isCacheable('safe', body({ stream: true })), false);
    assert.equal(isCacheable('aggressive', body({ stream: true })), true);
  });
});

describe('ExactCache', () => {
  it('returns what it stored', () => {
    const cache = new ExactCache(opts);
    cache.put('k1', '{"answer":"Paris"}', 'mistral', 'mistral-small', 10, 5);

    const hit = cache.get('k1');
    assert.equal(hit?.body, '{"answer":"Paris"}');
    assert.equal(hit?.providerId, 'mistral');
    assert.equal(hit?.tokensOut, 5);
    cache.close();
  });

  it('misses on an unknown key', () => {
    const cache = new ExactCache(opts);
    assert.equal(cache.get('nope'), null);
    assert.equal(cache.stats().misses, 1);
    cache.close();
  });

  it('expires entries past their TTL', () => {
    const cache = new ExactCache({ ...opts, ttlMs: 1000 });
    const past = Date.now() - 5000;
    cache.put('k1', '{}', 'p', 'm', 1, 1, past);
    assert.equal(cache.get('k1'), null, 'a stale answer is worse than none');
    cache.close();
  });

  it('evicts least-recently-used once full', () => {
    const cache = new ExactCache({ ...opts, maxEntries: 3 });
    for (let i = 0; i < 3; i++) cache.put(`k${i}`, '{}', 'p', 'm', 1, 1);
    cache.get('k0'); // k0 becomes most recent, k1 the oldest
    cache.put('k3', '{}', 'p', 'm', 1, 1);

    assert.ok(cache.get('k0'), 'the recently used entry survived');
    assert.equal(cache.get('k1'), null, 'the least recently used was evicted');
    cache.close();
  });

  it('tracks the tokens it saved', () => {
    const cache = new ExactCache(opts);
    cache.put('k1', '{}', 'p', 'm', 100, 50);
    cache.get('k1');
    cache.get('k1');

    const stats = cache.stats();
    assert.equal(stats.hits, 2);
    assert.equal(stats.tokensSaved, 300);
    assert.equal(stats.hitRate, 1);
    cache.close();
  });

  it('stores nothing at all when off', () => {
    const cache = new ExactCache({ ...opts, mode: 'off' });
    cache.put('k1', '{}', 'p', 'm', 1, 1);
    assert.equal(cache.get('k1'), null);
    cache.close();
  });
});

describe('replayAsStream — a hit must be indistinguishable from a live call', () => {
  const completion = JSON.stringify({
    id: 'chatcmpl-1',
    model: 'mistral-small',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Paris is the capital of France.' } }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  });

  it('emits well-formed SSE ending in [DONE]', () => {
    const sse = replayAsStream(completion);
    assert.match(sse, /^data: /m);
    assert.ok(sse.trimEnd().endsWith('data: [DONE]'));
  });

  it('reassembles to exactly the cached text', () => {
    const content = [...replayAsStream(completion).matchAll(/^data: (.+)$/gm)]
      .map((m) => m[1])
      .filter((p): p is string => p !== undefined && p !== '[DONE]')
      .map((p) => JSON.parse(p) as { choices?: { delta?: { content?: string } }[] })
      .flatMap((o) => o.choices ?? [])
      .map((c) => c.delta?.content ?? '')
      .join('');
    assert.equal(content, 'Paris is the capital of France.');
  });

  it('carries the usage block through', () => {
    assert.match(replayAsStream(completion), /"usage":\{"prompt_tokens":10/);
  });

  it('degrades to a bare [DONE] on unparseable input', () => {
    assert.equal(replayAsStream('not json'), 'data: [DONE]\n\n');
  });
});

// ---------------------------------------------------------------------------

/** Deterministic unit-ish vector, so similarity is predictable in tests. */
function vec(seed: number, dims = 8): number[] {
  return Array.from({ length: dims }, (_, i) => Math.sin(seed + i * 0.7));
}

describe('SemanticCache', () => {
  const make = (over = {}) => new SemanticCache({ enabled: true, threshold: 0.92, maxEntries: 100, dims: 8, ...over });

  it('matches a near-identical vector above the threshold', () => {
    const cache = make();
    const v = vec(1);
    cache.add(v, 'key-1', 'scope-a', 'what is the capital of France?');

    const hit = cache.search(v, 'scope-a');
    assert.ok(hit, 'an identical vector must hit');
    assert.equal(hit.entry.cacheKey, 'key-1');
    assert.ok(hit.score > 0.99);
  });

  it('misses when similarity falls below the threshold', () => {
    const cache = make();
    cache.add(vec(1), 'key-1', 'scope-a', 'q1');
    assert.equal(cache.search(vec(50), 'scope-a'), null, 'an unrelated question must not hit');
  });

  it('never crosses scopes', () => {
    // A different system prompt can make the same question have a different
    // correct answer, so entries are partitioned rather than compared globally.
    const cache = make();
    const v = vec(1);
    cache.add(v, 'key-1', 'pirate-prompt', 'who are you?');
    assert.equal(cache.search(v, 'lawyer-prompt'), null);
    assert.ok(cache.search(v, 'pirate-prompt'));
  });

  it('derives a scope from resolution and system prompt', () => {
    const a = SemanticCache.scopeOf('alias:fast', 'You are a pirate.');
    const b = SemanticCache.scopeOf('alias:fast', 'You are a lawyer.');
    const c = SemanticCache.scopeOf('alias:fast', 'You are a pirate.');
    assert.notEqual(a, b);
    assert.equal(a, c, 'the same inputs must give the same scope');
  });

  it('respects the TTL', () => {
    const cache = make({ ttlMs: 1000 });
    const v = vec(1);
    cache.add(v, 'key-1', 'scope-a', 'q', Date.now() - 5000);
    assert.equal(cache.search(v, 'scope-a'), null);
  });

  it('does nothing when disabled', () => {
    const cache = new SemanticCache({ enabled: false, threshold: 0.9, maxEntries: 10, dims: 8 });
    cache.add(vec(1), 'k', 's', 'q');
    assert.equal(cache.search(vec(1), 's'), null);
  });

  it('remembers a recent miss so the same text is not re-embedded', () => {
    // Every miss costs an embedding call against real quota.
    const cache = make();
    assert.equal(cache.recentlyMissed('s', 'q'), false);
    cache.noteMiss('s', 'q');
    assert.equal(cache.recentlyMissed('s', 'q'), true);
    assert.equal(cache.recentlyMissed('s', 'other'), false);
  });

  it('stays within its memory budget', () => {
    const cache = new SemanticCache({ enabled: true, threshold: 0.92, maxEntries: 5000, dims: 1024 });
    const stats = cache.stats();
    assert.equal(stats.bytes, 5000 * 1024 * 4);
    assert.ok(stats.bytes < 25 * 1024 * 1024, 'roughly 20MB, no vector database required');
  });

  it('adopts the provider’s embedding width on first use', () => {
    // bge-large is 1024, bge-small is 384; guessing wrong wastes the slab.
    const cache = new SemanticCache({ enabled: true, threshold: 0.9, maxEntries: 10, dims: 1024 });
    cache.add(vec(1, 384), 'k', 's', 'q');
    assert.equal(cache.stats().dims, 384);
    assert.ok(cache.search(vec(1, 384), 's'));
  });
});

describe('semantic cache helpers', () => {
  it('keys on the newest user turn', () => {
    assert.equal(
      queryTextOf([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'second' },
      ]),
      'second',
    );
  });

  it('flattens a multi-part user turn', () => {
    assert.equal(queryTextOf([{ role: 'user', content: [{ type: 'text', text: 'describe this' }] }]), 'describe this');
  });

  it('collects the system prompt', () => {
    assert.equal(systemPromptOf([{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }]), 'be terse');
  });
});
