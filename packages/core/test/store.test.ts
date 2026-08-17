import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { Store, classifyFailure } from '../src/store.ts';
import { silentLogger } from '../src/util.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'freeway-store-'));
  dirs.push(d);
  return d;
}

describe('classifyFailure', () => {
  it('blames the key for credential and rate-limit rejections', () => {
    // Another key in the pool may well succeed, so only that key is benched.
    for (const s of [401, 403, 429]) assert.equal(classifyFailure(s), 'key', `status ${s}`);
  });

  it('blames the provider for server and transport failures', () => {
    for (const s of [500, 502, 503, 504, 408]) assert.equal(classifyFailure(s), 'provider', `status ${s}`);
    assert.equal(classifyFailure(null), 'provider', 'network error');
  });

  it('blames neither for a malformed request', () => {
    // A 400 will fail identically everywhere; retrying it is pure waste.
    for (const s of [400, 404, 422]) assert.equal(classifyFailure(s), 'request', `status ${s}`);
  });
});

describe('Store — failure attribution', () => {
  it('a 429 benches one key and leaves the pool usable', () => {
    const store = new Store({ file: null, cooldownMs: 30_000, logger: silentLogger });
    const kind = store.recordFailure('mistral', 'mistral#0', { status: 429, message: 'rate limited' });

    assert.equal(kind, 'key');
    assert.equal(store.isKeyCooling('mistral', 'mistral#0'), true);
    assert.equal(store.isKeyCooling('mistral', 'mistral#1'), false, 'the other key is untouched');
    assert.equal(store.isProviderCooling('mistral'), false, 'the provider is fine');
    assert.equal(store.key('mistral', 'mistral#0').status, 'rate-limited');
  });

  it('a 503 benches the whole provider', () => {
    const store = new Store({ file: null, cooldownMs: 30_000, logger: silentLogger });
    const kind = store.recordFailure('groq', 'groq#0', { status: 503, message: '503 from upstream' });

    assert.equal(kind, 'provider');
    assert.equal(store.isProviderCooling('groq'), true);
    assert.equal(store.isKeyCooling('groq', 'groq#0'), false, 'the key is not at fault');
    assert.equal(store.provider('groq').lastError, '503 from upstream');
  });

  it('a 400 benches nothing at all', () => {
    const store = new Store({ file: null, logger: silentLogger });
    const kind = store.recordFailure('mistral', 'mistral#0', { status: 400, message: 'bad request' });

    assert.equal(kind, 'request');
    assert.equal(store.isProviderCooling('mistral'), false);
    assert.equal(store.isKeyCooling('mistral', 'mistral#0'), false);
    assert.equal(store.provider('mistral').fail, 1, 'still counted as a failure');
  });

  it('benches a rejected credential for far longer than a rate limit', () => {
    const store = new Store({ file: null, cooldownMs: 1000, logger: silentLogger });
    store.recordFailure('p', 'p#0', { status: 401, message: 'unauthorized' });
    store.recordFailure('p', 'p#1', { status: 429, message: 'slow down' });

    const invalid = store.key('p', 'p#0');
    const limited = store.key('p', 'p#1');
    assert.equal(invalid.status, 'invalid');
    assert.equal(limited.status, 'rate-limited');
    assert.ok(invalid.cooldownUntil > limited.cooldownUntil, 'a bad key stays benched much longer');
  });

  it('honours an upstream Retry-After over the configured cooldown', () => {
    const now = Date.UTC(2026, 0, 1);
    const store = new Store({ file: null, cooldownMs: 60_000, clock: () => now, logger: silentLogger });
    store.recordFailure('p', 'p#0', { status: 429, message: 'rate limited', retryAfterMs: 5_000 });
    assert.equal(store.key('p', 'p#0').cooldownUntil, now + 5_000);
  });

  it('a success clears the provider bench and revives the key', () => {
    const store = new Store({ file: null, logger: silentLogger });
    store.recordFailure('p', 'p#0', { status: 502, message: 'bad gateway' });
    assert.equal(store.isProviderCooling('p'), true);

    store.recordSuccess('p', 'p#0', 120);
    assert.equal(store.isProviderCooling('p'), false);
    assert.equal(store.key('p', 'p#0').status, 'ok');
    assert.equal(store.provider('p').lastError, null);
  });
});

describe('Store — accounting', () => {
  it('tracks EWMA latency rather than the last value', () => {
    const store = new Store({ file: null, logger: silentLogger });
    store.recordSuccess('p', 'p#0', 100);
    assert.equal(store.provider('p').latencyMs, 100, 'seeds on the first sample');

    store.recordSuccess('p', 'p#0', 200);
    const l = store.provider('p').latencyMs ?? 0;
    assert.ok(l > 100 && l < 200, `smoothed toward the new sample, got ${l}`);
  });

  it('meters both the provider and the individual key', () => {
    const store = new Store({ file: null, logger: silentLogger });
    store.recordSuccess('p', 'p#0', 10, 500);
    store.recordSuccess('p', 'p#1', 10, 300);

    assert.equal(store.provider('p').meter.used('tpm'), 800);
    assert.equal(store.key('p', 'p#0').meter.used('tpm'), 500);
    assert.equal(store.key('p', 'p#1').meter.used('tpm'), 300);
  });

  it('lands late stream tokens on both meters', () => {
    const store = new Store({ file: null, logger: silentLogger });
    store.recordSuccess('p', 'p#0', 10, 0);
    store.addTokens('p', 'p#0', 750);

    assert.equal(store.provider('p').meter.used('tpm'), 750);
    assert.equal(store.key('p', 'p#0').meter.used('tpm'), 750);
  });

  it('rotates the round-robin cursor', () => {
    const store = new Store({ file: null, logger: silentLogger });
    assert.equal(store.nextCursor('p'), 1);
    assert.equal(store.nextCursor('p'), 2);
    assert.equal(store.nextCursor('other'), 1, 'cursors are per provider');
  });
});

describe('Store — request log', () => {
  const entry = (i: number) => ({
    id: `r${i}`,
    at: i,
    requestedModel: 'auto',
    resolution: 'auto',
    providerId: 'p',
    modelId: 'm',
    keyId: 'p#0',
    attempts: [],
    status: 200,
    ms: 10,
    tokensIn: 1,
    tokensOut: 1,
    stream: false,
    cache: null,
    error: null,
  });

  it('returns entries newest first', () => {
    const store = new Store({ file: null, logSize: 10, logger: silentLogger });
    for (let i = 0; i < 3; i++) store.addLog(entry(i));
    assert.deepEqual(store.logs().map((e) => e.id), ['r2', 'r1', 'r0']);
  });

  it('is a ring buffer that never grows past its size', () => {
    const store = new Store({ file: null, logSize: 5, logger: silentLogger });
    for (let i = 0; i < 100; i++) store.addLog(entry(i));

    const logs = store.logs(1000);
    assert.equal(logs.length, 5, 'memory stays flat under sustained traffic');
    assert.deepEqual(logs.map((e) => e.id), ['r99', 'r98', 'r97', 'r96', 'r95']);
  });

  it('issues monotonic request ids', () => {
    const store = new Store({ file: null, logger: silentLogger });
    const a = store.nextRequestId();
    const b = store.nextRequestId();
    assert.notEqual(a, b);
  });
});

describe('Store — persistence', () => {
  it('round-trips meters and counts through a restart', () => {
    const dir = tmp();
    const file = join(dir, 'usage.json');

    const first = new Store({ file, logger: silentLogger });
    first.recordSuccess('mistral', 'mistral#0', 120, 4000);
    first.recordFailure('mistral', 'mistral#0', { status: 429, message: 'rate limited' });
    first.save();

    const second = new Store({ file, logger: silentLogger });
    assert.equal(second.provider('mistral').ok, 1);
    assert.equal(second.provider('mistral').fail, 1);
    // The whole point: a monthly counter must not silently reset on restart.
    assert.equal(second.provider('mistral').meter.used('tpmo'), 4000);
    assert.equal(second.key('mistral', 'mistral#0').meter.used('tpmo'), 4000);
  });

  it('writes atomically and leaves no temp files behind', () => {
    const dir = tmp();
    const file = join(dir, 'usage.json');
    const store = new Store({ file, logger: silentLogger });
    store.recordSuccess('p', 'p#0', 10, 5);
    store.save();

    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal((parsed as { version: number }).version, 1);
  });

  it('ignores a corrupt usage file instead of refusing to start', () => {
    const dir = tmp();
    const file = join(dir, 'usage.json');
    writeFileSync(file, '{ not json');

    let store: Store | undefined;
    assert.doesNotThrow(() => {
      store = new Store({ file, logger: silentLogger });
    });
    assert.equal(store?.provider('p').ok, 0);
  });

  it('ignores a usage file from a future version', () => {
    const dir = tmp();
    const file = join(dir, 'usage.json');
    writeFileSync(file, JSON.stringify({ version: 999, savedAt: 0, providers: { p: { ok: 5 } } }));

    const store = new Store({ file, logger: silentLogger });
    assert.equal(store.provider('p').ok, 0, 'unknown schema is discarded, not half-read');
  });

  it('does nothing when persistence is disabled', () => {
    const store = new Store({ file: null, logger: silentLogger });
    assert.doesNotThrow(() => store.save());
  });
});
