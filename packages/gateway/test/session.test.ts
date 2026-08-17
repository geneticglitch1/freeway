/**
 * End-to-end sessions: the client sends one message, the gateway rebuilds the
 * thread, and the thread survives a failover to a much smaller model.
 */

import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ContextStore, Registry, Router, Store, Tokenizer, parseConfig, silentLogger, type FreewayConfig } from '@freeway/core';

import { createGateway } from '../src/server.ts';
import { createMockUpstream } from '../../../scripts/mock-upstream.js';

const cleanups: (() => unknown)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

interface Mock {
  url: string;
  script(steps: unknown[]): void;
  callsTo(path: string): { body: { messages?: { role: string; content: string }[]; model?: string } }[];
  close(): Promise<unknown>;
}

interface Harness {
  base: string;
  big: Mock;
  small: Mock;
  context: ContextStore;
  store: Store;
}

/** `big` has a 128k window, `small` has 8k — the shape of the real scenario. */
async function harness(over: Partial<FreewayConfig> = {}): Promise<Harness> {
  const big = (await createMockUpstream({ name: 'big' })) as Mock;
  const small = (await createMockUpstream({ name: 'small' })) as Mock;
  cleanups.push(() => big.close(), () => small.close());

  const dir = mkdtempSync(join(tmpdir(), 'freeway-sess-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, 'big.json'), JSON.stringify({
    id: 'big', priority: 10, baseUrl: big.url,
    auth: { type: 'bearer', envKeys: ['BIG_KEY'] }, limits: { rpm: 100 },
    models: [{ id: 'big-chat', alias: ['fast'], context: 128000, caps: ['chat'] }],
  }));
  writeFileSync(join(dir, 'small.json'), JSON.stringify({
    id: 'small', priority: 20, baseUrl: small.url,
    auth: { type: 'bearer', envKeys: ['SMALL_KEY'] }, limits: { rpm: 100 },
    models: [{ id: 'small-chat', alias: ['fast'], context: 8192, caps: ['chat'] }],
  }));

  const registry = new Registry({ dir, env: { BIG_KEY: 'bk-000000000001', SMALL_KEY: 'sk-000000000001' }, logger: silentLogger });
  const store = new Store({ file: null, logger: silentLogger });
  const { config } = parseConfig({}, {});
  Object.assign(config, over);
  const router = new Router(registry, store, config);
  const context = new ContextStore(':memory:');
  cleanups.push(() => context.close());

  const server: Server = createGateway({
    registry, store, router, config, logger: silentLogger,
    contextStore: context, tokenizer: new Tokenizer(),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  cleanups.push(() => new Promise((r) => server.close(() => r(undefined))));

  return { base: `http://127.0.0.1:${port}`, big, small, context, store };
}

async function chat(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const say = (text: string) => ({ role: 'user', content: text });

describe('sessions — server-side conversation', () => {
  it('rebuilds the thread from just the new message', async () => {
    const h = await harness();

    await chat(h.base, { model: 'fast', session: 'thread-1', messages: [say('my name is Ada')] });
    const res = await chat(h.base, { model: 'fast', session: 'thread-1', messages: [say('what is my name?')] });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-freeway-session'), 'thread-1');

    // The upstream saw the whole conversation, not just the last line.
    const calls = h.big.callsTo('/chat/completions');
    const sent = calls[calls.length - 1]?.body.messages ?? [];
    assert.ok(sent.length >= 3, `expected rehydrated history, got ${sent.length} messages`);
    assert.ok(sent.some((m) => m.content.includes('my name is Ada')), 'the earlier turn was replayed');
  });

  it('strips `session` before forwarding — no provider ever sees it', async () => {
    const h = await harness();
    await chat(h.base, { model: 'fast', session: 'thread-2', messages: [say('hi')] });

    const body = h.big.callsTo('/chat/completions')[0]?.body as Record<string, unknown>;
    assert.equal(body['session'], undefined);
  });

  it('persists the assistant reply so the next turn sees it', async () => {
    const h = await harness();
    await chat(h.base, { model: 'fast', session: 'thread-3', messages: [say('hello')] });

    const stored = h.context.messages('thread-3');
    assert.deepEqual(stored.map((m) => m.role), ['user', 'assistant']);
    assert.match(stored[1]?.content ?? '', /\[big\]/);
  });

  it('keeps sessions isolated', async () => {
    const h = await harness();
    await chat(h.base, { model: 'fast', session: 'a', messages: [say('secret for A')] });
    await chat(h.base, { model: 'fast', session: 'b', messages: [say('secret for B')] });

    const calls = h.big.callsTo('/chat/completions');
    const forB = calls[calls.length - 1]?.body.messages ?? [];
    assert.ok(!forB.some((m) => m.content.includes('secret for A')), 'session A must not leak into session B');
  });

  it('behaves like a plain OpenAI endpoint with no session id', async () => {
    const h = await harness();
    const res = await chat(h.base, { model: 'fast', messages: [say('stateless please')] });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-freeway-session'), null);
    assert.equal(h.context.list().length, 0, 'nothing was stored');
  });
});

describe('sessions — surviving a failover to a smaller window', () => {
  it('compacts the history to fit the model that actually serves it', async () => {
    const h = await harness({ context: { enabled: true, maxTurns: 4, reserveOutputTokens: 512, compactModel: 'fast', autoCompactAt: 0.8 } });

    // Build a long thread on the 128k model.
    const long = 'This is a reasonably long turn about the project. '.repeat(120);
    for (let i = 0; i < 12; i++) {
      await chat(h.base, { model: 'fast', session: 'long', messages: [say(`turn ${i}: ${long}`)] });
    }

    const beforeCalls = h.big.callsTo('/chat/completions').length;
    const sentToBig = h.big.callsTo('/chat/completions')[beforeCalls - 1]?.body.messages ?? [];
    assert.ok(sentToBig.length > 5, 'the big model received the full history');

    // The big provider runs out; everything now has to go to the 8k model.
    h.big.script([{ status: 429, repeat: Infinity }]);

    const res = await chat(h.base, { model: 'fast', session: 'long', messages: [say('given all that, what should I do?')] });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-freeway-provider'), 'small', 'it failed over');

    const note = res.headers.get('x-freeway-context');
    assert.ok(note, 'the refit is reported on the response');
    assert.match(note, /refit=(window|compact|hard-truncate|drop-tool-noise)/);
    assert.match(note, /tokens=\d+->\d+/);

    // The reshaped history genuinely fits the smaller window.
    const smallCalls = h.small.callsTo('/chat/completions');
    const sentToSmall = smallCalls[smallCalls.length - 1]?.body.messages ?? [];
    const chars = sentToSmall.reduce((n, m) => n + String(m.content).length, 0);
    assert.ok(chars / 4 < 8192, `history must fit 8k, estimated ${Math.round(chars / 4)} tokens`);

    // And the newest question survived intact — that is the request itself.
    assert.ok(sentToSmall.some((m) => m.content.includes('given all that, what should I do?')));
  });

  it('reports a refit even without a session, so plain failover still fits', async () => {
    // A client that manages its own history still benefits: the array it sent
    // is reshaped for whichever model ends up serving the call.
    const h = await harness();
    h.big.script([{ status: 429, repeat: Infinity }]);

    const turn = 'padding '.repeat(300); // ~600 tokens each
    const messages = [{ role: 'system', content: 'be helpful' }];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `${i}: ${turn}` });
    }
    messages.push(say('and finally, a short question'));

    const res = await chat(h.base, { model: 'fast', messages });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-freeway-provider'), 'small');
    const note = res.headers.get('x-freeway-context');
    assert.ok(note, 'stateless requests are refit too');
    assert.ok(!note.includes('refit=passthrough'), `it genuinely had to reshape, got "${note}"`);

    const smallCalls = h.small.callsTo('/chat/completions');
    const sent = smallCalls[smallCalls.length - 1]?.body.messages ?? [];
    const chars = sent.reduce((n, m) => n + String(m.content).length, 0);
    assert.ok(chars / 4 < 8192, `must fit the 8k window, estimated ${Math.round(chars / 4)} tokens`);
    assert.ok(sent.some((m) => m.content.includes('and finally, a short question')), 'the actual request survived');
  });

  it('returns 413 when the newest message alone cannot fit', async () => {
    const h = await harness();
    // Only the 8k model is available, and the message needs far more than that.
    h.big.script([{ status: 429, repeat: Infinity }]);

    const huge = 'x'.repeat(200_000);
    const res = await chat(h.base, { model: 'fast', messages: [say(huge)] });

    assert.equal(res.status, 413);
    const body = (await res.json()) as { error: { code: string }; freeway: { required: number; available: number } };
    assert.equal(body.error.code, 'context_too_large');
    assert.ok(body.freeway.required > body.freeway.available);
  });
});

describe('sessions — API', () => {
  it('lists and inspects sessions, then deletes one', async () => {
    const h = await harness();
    await chat(h.base, { model: 'fast', session: 'inspect-me', messages: [say('hello there')] });

    const list = (await (await fetch(`${h.base}/api/sessions`)).json()) as { sessions: { id: string; messages: number }[] };
    assert.ok(list.sessions.some((s) => s.id === 'inspect-me'));

    const one = (await (await fetch(`${h.base}/api/sessions/inspect-me`)).json()) as { messages: { role: string }[] };
    assert.deepEqual(one.messages.map((m) => m.role), ['user', 'assistant']);

    const del = await fetch(`${h.base}/api/sessions/inspect-me`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal(h.context.info('inspect-me'), null);
  });

  it('404s an unknown session', async () => {
    const h = await harness();
    assert.equal((await fetch(`${h.base}/api/sessions/nope`)).status, 404);
  });
});
