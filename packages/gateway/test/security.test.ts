/**
 * Regression tests for the security sweep.
 *
 * Each of these encodes a vulnerability that was real, so a future refactor
 * cannot quietly reintroduce it.
 */

import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ContextStore, ExactCache, Registry, Router, Store, Tokenizer, parseConfig, silentLogger, type FreewayConfig } from '@freeway/core';

import { createGateway } from '../src/server.ts';
import { createMockUpstream } from '../../../scripts/mock-upstream.js';

const cleanups: (() => unknown)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

interface Mock { url: string; close(): Promise<unknown> }

interface Harness {
  base: string;
  context: ContextStore;
  dataDir: string;
}

async function harness(over: Partial<FreewayConfig> = {}): Promise<Harness> {
  const upstream = (await createMockUpstream({ name: 'up' })) as Mock;
  cleanups.push(() => upstream.close());

  const dir = mkdtempSync(join(tmpdir(), 'freeway-sec-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'freeway-sec-data-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => rmSync(dataDir, { recursive: true, force: true }));

  writeFileSync(join(dir, 'up.json'), JSON.stringify({
    id: 'up', priority: 10, baseUrl: upstream.url,
    auth: { type: 'bearer', envKeys: ['UP_KEY'] }, limits: { rpm: 1000 },
    models: [{ id: 'up-chat', alias: ['fast'], context: 128000, caps: ['chat'] }],
  }));

  const registry = new Registry({ dir, env: { UP_KEY: 'uk-000000000001' }, logger: silentLogger });
  const store = new Store({ file: null, logger: silentLogger });
  const { config } = parseConfig({}, {});
  Object.assign(config, over);
  const router = new Router(registry, store, config);

  const context = new ContextStore(join(dataDir, 'freeway.db'));
  const cache = new ExactCache({ file: join(dataDir, 'cache.db'), mode: 'safe', ttlMs: 3_600_000, maxEntries: 50 });
  cleanups.push(() => context.close(), () => cache.close());

  const server: Server = createGateway({
    registry, store, router, config, logger: silentLogger,
    contextStore: context, tokenizer: new Tokenizer(), cache,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  cleanups.push(() => new Promise((r) => server.close(() => r(undefined))));

  return { base: `http://127.0.0.1:${port}`, context, dataDir };
}

const APP = 'fw-app-key';
const ADMIN = 'fw-admin-key';
const authed = (key: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${key}` });

// ---------------------------------------------------------------------------

describe('C1 — an inference key is not an admin key', () => {
  const cfg = { keys: [APP], adminKey: ADMIN, host: '0.0.0.0' };

  it('refuses an app key on every /api route', async () => {
    const h = await harness(cfg);
    const routes: [string, string][] = [
      ['GET', '/api/providers'], ['GET', '/api/logs'], ['GET', '/api/sessions'],
      ['GET', '/api/alerts'], ['GET', '/api/cache'], ['GET', '/api/stats'], ['GET', '/api/events'],
      ['POST', '/api/reload'], ['POST', '/api/providers/up/enabled'],
      ['POST', '/api/providers/up/key'], ['POST', '/api/providers/up/probe'],
      ['DELETE', '/api/cache'],
    ];

    for (const [method, path] of routes) {
      const res = await fetch(`${h.base}${path}`, { method, headers: authed(APP), ...(method === 'GET' ? {} : { body: '{}' }) });
      assert.equal(res.status, 403, `${method} ${path} should be forbidden to an app key`);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'admin_required');
    }
  });

  it('still lets the app key do inference', async () => {
    const h = await harness(cfg);
    const res = await fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST', headers: authed(APP),
      body: JSON.stringify({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
  });

  it('lets the admin key through', async () => {
    const h = await harness(cfg);
    assert.equal((await fetch(`${h.base}/api/stats`, { headers: authed(ADMIN) })).status, 200);
  });

  it('refuses /api entirely on a public bind with no admin key', async () => {
    // Otherwise an exposed gateway with only inference keys hands them the box.
    const h = await harness({ keys: [APP], adminKey: null, host: '0.0.0.0' });
    const res = await fetch(`${h.base}/api/logs`, { headers: authed(APP) });
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { error: { message: string } }).error.message, /FREEWAY_ADMIN_KEY/);
  });

  it('stays convenient on loopback with no admin key', async () => {
    const h = await harness({ keys: [APP], adminKey: null, host: '127.0.0.1' });
    assert.equal((await fetch(`${h.base}/api/stats`, { headers: authed(APP) })).status, 200);
  });
});

describe('C2 — CORS is an allowlist, never a wildcard', () => {
  it('sends no CORS headers by default', async () => {
    const h = await harness({ keys: [APP] });
    const res = await fetch(`${h.base}/v1/models`, { headers: { ...authed(APP), origin: 'https://evil.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  it('refuses an origin that is not on the list', async () => {
    const h = await harness({ keys: [APP], corsOrigins: ['https://app.example'] });
    const res = await fetch(`${h.base}/v1/models`, { headers: { ...authed(APP), origin: 'https://evil.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  it('echoes only a listed origin, and varies on it', async () => {
    const h = await harness({ keys: [APP], corsOrigins: ['https://app.example'] });
    const res = await fetch(`${h.base}/v1/models`, { headers: { ...authed(APP), origin: 'https://app.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example');
    assert.match(res.headers.get('vary') ?? '', /Origin/);
  });

  it('rejects "*" in configuration rather than honouring it', () => {
    const { config, issues } = parseConfig({ corsOrigins: ['*', 'https://ok.example'] }, {});
    assert.deepEqual(config.corsOrigins, ['https://ok.example']);
    assert.ok(issues.some((i) => i.path === 'corsOrigins'));
  });
});

describe('C3 — sessions belong to the key that made them', () => {
  it('refuses to read another key’s session', async () => {
    const h = await harness({ keys: [APP, 'fw-other-key'], adminKey: ADMIN });

    await fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST', headers: authed(APP),
      body: JSON.stringify({ model: 'fast', session: 'private', messages: [{ role: 'user', content: 'my bank pin is 1234' }] }),
    });

    const res = await fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST', headers: authed('fw-other-key'),
      body: JSON.stringify({ model: 'fast', session: 'private', messages: [{ role: 'user', content: 'what did I say?' }] }),
    });

    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'session_forbidden');
  });

  it('lets the owner continue its own session', async () => {
    const h = await harness({ keys: [APP], adminKey: ADMIN });
    const body = (content: string) => JSON.stringify({ model: 'fast', session: 'mine', messages: [{ role: 'user', content }] });

    assert.equal((await fetch(`${h.base}/v1/chat/completions`, { method: 'POST', headers: authed(APP), body: body('one') })).status, 200);
    assert.equal((await fetch(`${h.base}/v1/chat/completions`, { method: 'POST', headers: authed(APP), body: body('two') })).status, 200);
    assert.equal(h.context.messages('mine').length, 4);
  });

  it('records the owner, masked', async () => {
    const h = await harness({ keys: [APP], adminKey: ADMIN });
    await fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST', headers: authed(APP),
      body: JSON.stringify({ model: 'fast', session: 'owned', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const owner = h.context.info('owned')?.owner;
    assert.ok(owner, 'session should be claimed');
    assert.ok(!owner.includes('app-key'), 'the owner must be a mask, not the key');
  });
});

describe('H2 — live log subscriptions are capped', () => {
  it('refuses beyond the cap instead of accumulating listeners', async () => {
    const h = await harness();
    const controllers: AbortController[] = [];
    let refused = 0;

    for (let i = 0; i < 20; i++) {
      const controller = new AbortController();
      controllers.push(controller);
      const res = await fetch(`${h.base}/api/events`, { signal: controller.signal });
      if (res.status === 503) {
        refused += 1;
        break;
      }
      // Start reading so the subscription actually registers server-side.
      void res.body?.getReader().read();
    }
    for (const c of controllers) c.abort();
    assert.ok(refused > 0, 'an unbounded number of subscribers was accepted');
  });
});

describe('H3 — response headers cannot be poisoned by input', () => {
  it('survives a session id full of illegal header bytes', async () => {
    // These used to reach writeHead raw and throw, turning a good response
    // into a remote 500.
    const h = await harness();
    for (const id of ['sess\r\nX-Injected: yes', 'sess→arrow', 'sess null']) {
      const res = await fetch(`${h.base}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fast', session: id, messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(res.status, 200, `session id ${JSON.stringify(id)} should not break the response`);
      assert.equal(res.headers.get('x-injected'), null, 'no header was injected');
    }
  });
});

describe('M1 — data at rest is not world-readable', () => {
  it('creates the sqlite files 0600', async () => {
    const h = await harness();
    await fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fast', session: 's', temperature: 0, messages: [{ role: 'user', content: 'hi' }] }),
    });

    for (const file of ['freeway.db', 'cache.db']) {
      const mode = statSync(join(h.dataDir, file)).mode & 0o777;
      assert.equal(mode, 0o600, `${file} is 0${mode.toString(8)}, expected 0600`);
    }
  });
});

describe('M2 — key comparison leaks neither content nor length', () => {
  it('rejects keys of every length identically', async () => {
    const h = await harness({ keys: ['fw-the-real-key-abcdefghijk'] });
    for (const wrong of ['x', 'fw-', 'fw-the-real-key-abcdefghij', 'fw-the-real-key-abcdefghijkX', 'x'.repeat(500)]) {
      const res = await fetch(`${h.base}/v1/models`, { headers: { authorization: `Bearer ${wrong}` } });
      assert.equal(res.status, 401, `"${wrong.slice(0, 12)}…" should be rejected`);
    }
    assert.equal((await fetch(`${h.base}/v1/models`, { headers: authed('fw-the-real-key-abcdefghijk') })).status, 200);
  });
});

describe('still no way to reach a raw provider key', () => {
  it('keeps provider keys out of every admin response', async () => {
    const h = await harness({ keys: [APP], adminKey: ADMIN });
    for (const path of ['/api/providers', '/api/stats', '/api/logs', '/api/alerts']) {
      const text = await (await fetch(`${h.base}${path}`, { headers: authed(ADMIN) })).text();
      assert.ok(!text.includes('uk-000000000001'), `${path} leaked a provider key`);
    }
  });
});
