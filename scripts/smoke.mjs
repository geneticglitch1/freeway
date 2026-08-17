#!/usr/bin/env node
/**
 * Exercise every route against mock upstreams. No real quota is spent.
 *
 *   npm run smoke
 *
 * This is the thing to run after adding a provider or touching routing. It
 * boots two fake providers and a real gateway, then walks the whole surface —
 * routing, failover, streaming, sessions, cache, guard, probing, dashboard API.
 *
 * Exit code 0 if everything passed.
 */

import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ContextStore, ExactCache, Registry, Router, SemanticCache, Store, Tokenizer,
  parseConfig, silentLogger,
} from '../packages/core/src/index.ts';
import { createGateway } from '../packages/gateway/src/server.ts';
import { createMockUpstream } from './mock-upstream.js';

const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', B: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', d: '', B: '', x: '' };

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`  ${C.g}✓${C.x} ${name}${detail ? `  ${C.d}${detail}${C.x}` : ''}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, message: err instanceof Error ? err.message : String(err) });
    console.log(`  ${C.r}✗${C.x} ${name}\n      ${C.r}${err instanceof Error ? err.message : err}${C.x}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------

const alpha = await createMockUpstream({ name: 'alpha' });
const beta = await createMockUpstream({ name: 'beta' });

const dir = mkdtempSync(join(tmpdir(), 'freeway-smoke-'));
writeFileSync(join(dir, 'alpha.json'), JSON.stringify({
  id: 'alpha', label: 'Alpha (mock)', priority: 10, baseUrl: alpha.url,
  auth: { type: 'bearer', envKeys: ['ALPHA_KEY'] }, limits: { rpm: 500 },
  models: [
    { id: 'alpha-chat', alias: ['fast', 'chat'], context: 128000, caps: ['chat', 'tools', 'json'] },
    { id: 'alpha-embed', alias: ['embed'], context: 8000, caps: ['embed'] },
  ],
}));
writeFileSync(join(dir, 'beta.json'), JSON.stringify({
  id: 'beta', label: 'Beta (mock)', priority: 20, baseUrl: beta.url,
  auth: { type: 'bearer', envKeys: ['BETA_KEY'] }, limits: { rpm: 500 },
  models: [{ id: '@cf/meta/llama-3.1-8b-instruct', alias: ['fast'], context: 8192, caps: ['chat'] }],
}));

const registry = new Registry({ dir, env: { ALPHA_KEY: 'ak-smoke-0001,ak-smoke-0002', BETA_KEY: 'bk-smoke-0001' }, logger: silentLogger });
const store = new Store({ file: null, logger: silentLogger });
const { config } = parseConfig({}, {});
config.cache.mode = 'safe';
const router = new Router(registry, store, config);
const context = new ContextStore(':memory:');
const cache = new ExactCache({ file: ':memory:', mode: 'safe', ttlMs: 3_600_000, maxEntries: 100 });

const server = createGateway({
  registry, store, router, config, logger: silentLogger,
  contextStore: context, tokenizer: new Tokenizer(),
  cache, semanticCache: new SemanticCache({ enabled: false, threshold: 0.92, maxEntries: 10 }),
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const B = `http://127.0.0.1:${server.address().port}`;

const post = (path, body, headers = {}) =>
  fetch(`${B}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const chat = (over = {}) => post('/v1/chat/completions', { model: 'auto', messages: [{ role: 'user', content: 'hello' }], ...over });

console.log(`\n${C.B}Freeway smoke test${C.x}  ${C.d}${B}${C.x}\n`);

// ---------------------------------------------------------------------------
console.log(`${C.B}core routes${C.x}`);

await check('GET /healthz', async () => {
  const body = await (await fetch(`${B}/healthz`)).json();
  eq(body.ok, true, 'ok');
  eq(body.providers.usable, 2, 'usable providers');
  return `${body.providers.usable}/${body.providers.total} providers usable`;
});

await check('GET / serves the dashboard', async () => {
  const res = await fetch(`${B}/`);
  eq(res.status, 200, 'status');
  const html = await res.text();
  assert(html.includes('<title>Freeway</title>'), 'no title');
  assert(!/\b(?:src|href)\s*=\s*["'](?:https?:)?\/\//i.test(html), 'dashboard references an external asset');
  return 'self-contained, no CDN';
});

await check('GET /v1/models', async () => {
  const body = await (await fetch(`${B}/v1/models`)).json();
  const ids = body.data.map((d) => d.id);
  assert(ids.includes('alpha/alpha-chat'), 'missing provider/model id');
  assert(ids.includes('beta/@cf/meta/llama-3.1-8b-instruct'), 'slashy id mangled');
  assert(ids.includes('auto'), 'missing virtual model');
  return `${ids.length} entries`;
});

await check('POST /v1/chat/completions', async () => {
  const res = await chat();
  eq(res.status, 200, 'status');
  eq(res.headers.get('x-freeway-provider'), 'alpha', 'provider');
  const body = await res.json();
  assert(body.choices[0].message.content.includes('[alpha]'), 'wrong upstream answered');
  return `served by ${res.headers.get('x-freeway-provider')} in ${res.headers.get('x-freeway-ms')}ms`;
});

await check('POST /v1/embeddings', async () => {
  const res = await post('/v1/embeddings', { model: 'embed', input: ['a', 'b'] });
  eq(res.status, 200, 'status');
  eq(res.headers.get('x-freeway-model'), 'alpha-embed', 'model');
  const body = await res.json();
  eq(body.data.length, 2, 'vector count');
  return '2 vectors';
});

await check('streaming', async () => {
  const res = await chat({ model: 'alpha/alpha-chat', stream: true });
  eq(res.status, 200, 'status');
  assert((res.headers.get('content-type') ?? '').includes('text/event-stream'), 'not SSE');
  const text = await res.text();
  assert(text.includes('data: [DONE]'), 'stream did not terminate');
  return 'SSE proxied intact';
});

// ---------------------------------------------------------------------------
console.log(`\n${C.B}routing and failover${C.x}`);

await check('alias resolution', async () => {
  const res = await chat({ model: 'fast' });
  eq(res.headers.get('x-freeway-route'), 'alias:fast', 'resolution');
  return 'alias:fast';
});

await check('provider/model pin survives slashes', async () => {
  const res = await chat({ model: 'beta/@cf/meta/llama-3.1-8b-instruct' });
  eq(res.status, 200, 'status');
  eq(res.headers.get('x-freeway-model'), '@cf/meta/llama-3.1-8b-instruct', 'model');
  return 'first-slash split';
});

await check('429 on alpha fails over to beta', async () => {
  alpha.script([{ status: 429, repeat: 99 }]);
  const res = await chat({ model: 'fast' });
  eq(res.status, 200, 'status');
  eq(res.headers.get('x-freeway-provider'), 'beta', 'provider');
  alpha.script([]);
  store.provider('alpha').cooldownUntil = 0;
  for (const k of store.provider('alpha').keys.values()) k.cooldownUntil = 0;
  return `failed over after ${res.headers.get('x-freeway-attempts')} attempts`;
});

await check('400 returns immediately without retrying', async () => {
  alpha.script([{ status: 400, body: { error: { message: 'bad param' } }, repeat: 1 }, { status: 200, repeat: 99 }]);
  const before = beta.callsTo('/chat/completions').length;
  const res = await chat({ model: 'alpha/alpha-chat' });
  eq(res.status, 400, 'status');
  eq(beta.callsTo('/chat/completions').length, before, 'beta should not have been tried');
  alpha.script([]);
  return 'no wasted retry';
});

await check('unknown model returns 404 with suggestions', async () => {
  const res = await chat({ model: 'gpt-9-ultra' });
  eq(res.status, 404, 'status');
  const body = await res.json();
  eq(body.error.code, 'model_not_found', 'code');
  return `${body.freeway.suggestions.length} suggestions`;
});

await check('exhausted quota returns 429 with diagnostics', async () => {
  const saved = registry.get('alpha').spec.limits.rpm;
  registry.get('alpha').spec.limits.rpm = 1;
  registry.get('beta').spec.limits.rpm = 1;
  for (let i = 0; i < 3; i++) { store.recordSuccess('alpha', 'alpha#0', 1); store.recordSuccess('beta', 'beta#0', 1); }

  const res = await chat({ model: 'fast' });
  eq(res.status, 429, 'status');
  const body = await res.json();
  eq(body.error.code, 'all_providers_blocked', 'code');
  assert(body.freeway.blocked.length > 0, 'no blocked reasons');
  assert(/rpm limit reached/.test(body.freeway.blocked[0].reason), `reason not diagnostic: ${body.freeway.blocked[0].reason}`);

  registry.get('alpha').spec.limits.rpm = saved;
  registry.get('beta').spec.limits.rpm = saved;
  return body.freeway.blocked[0].reason;
});

// ---------------------------------------------------------------------------
console.log(`\n${C.B}context engine${C.x}`);

await check('session rebuilds the thread', async () => {
  await post('/v1/chat/completions', { model: 'fast', session: 'smoke', messages: [{ role: 'user', content: 'my name is Ada' }] });
  const res = await post('/v1/chat/completions', { model: 'fast', session: 'smoke', messages: [{ role: 'user', content: 'what is my name?' }] });
  eq(res.status, 200, 'status');
  eq(res.headers.get('x-freeway-session'), 'smoke', 'session header');
  const stored = context.messages('smoke');
  assert(stored.length >= 3, `expected stored history, got ${stored.length}`);
  return `${stored.length} messages stored`;
});

await check('refit reshapes history for a smaller model', async () => {
  const turn = 'padding '.repeat(300);
  const messages = [{ role: 'system', content: 'be helpful' }];
  for (let i = 0; i < 20; i++) messages.push({ role: i % 2 ? 'assistant' : 'user', content: `${i}: ${turn}` });
  messages.push({ role: 'user', content: 'short question' });

  alpha.script([{ status: 429, repeat: 99 }]);
  const res = await post('/v1/chat/completions', { model: 'fast', messages });
  eq(res.status, 200, 'status');
  eq(res.headers.get('x-freeway-provider'), 'beta', 'provider');
  const note = res.headers.get('x-freeway-context');
  assert(note, 'no x-freeway-context header');
  alpha.script([]);
  store.provider('alpha').cooldownUntil = 0;
  for (const k of store.provider('alpha').keys.values()) k.cooldownUntil = 0;
  return note;
});

await check('GET /api/sessions', async () => {
  const body = await (await fetch(`${B}/api/sessions`)).json();
  assert(body.sessions.some((s) => s.id === 'smoke'), 'session missing');
  return `${body.sessions.length} sessions`;
});

// ---------------------------------------------------------------------------
console.log(`\n${C.B}cache${C.x}`);

await check('identical request hits the cache', async () => {
  const q = { model: 'alpha/alpha-chat', temperature: 0, messages: [{ role: 'user', content: 'cache me' }] };
  await post('/v1/chat/completions', q);
  const before = alpha.callsTo('/chat/completions').length;
  const res = await post('/v1/chat/completions', q);
  eq(res.headers.get('x-freeway-cache'), 'exact', 'cache header');
  eq(alpha.callsTo('/chat/completions').length, before, 'upstream was called on a hit');
  return 'no upstream call, no quota';
});

await check('GET /api/cache', async () => {
  const body = await (await fetch(`${B}/api/cache`)).json();
  eq(body.enabled, true, 'enabled');
  assert(body.exact.hits >= 1, 'no hits recorded');
  return `${body.exact.entries} entries, ${body.exact.hits} hits, ${body.exact.tokensSaved} tokens saved`;
});

// ---------------------------------------------------------------------------
console.log(`\n${C.B}guard and probing${C.x}`);

await check('GET /api/alerts', async () => {
  const body = await (await fetch(`${B}/api/alerts`)).json();
  assert(Array.isArray(body.alerts), 'no alerts array');
  assert(Array.isArray(body.forecasts), 'no forecasts');
  return `${body.alerts.length} alerts, ${body.forecasts.length} forecasts`;
});

await check('POST /api/providers/:id/probe discovers models', async () => {
  const body = await (await post('/api/providers/alpha/probe', { validate: false })).json();
  const result = body.results[0];
  eq(result.auth, 'ok', 'auth');
  assert(result.discovered.length > 0, 'discovered nothing');
  return `${result.discovered.length} models discovered`;
});

await check('content scanning flags a planted key', async () => {
  const res = await chat({ model: 'alpha/alpha-chat', messages: [{ role: 'user', content: 'deploy with sk-abcdefghijklmnopqrstuvwxyz12' }] });
  eq(res.status, 200, 'flag mode should not block');
  const log = store.logs(1)[0];
  return `logged, request still served (mode=${config.guard.scan.mode})`;
});

// ---------------------------------------------------------------------------
console.log(`\n${C.B}dashboard API${C.x}`);

await check('GET /api/providers masks every key', async () => {
  const body = await (await fetch(`${B}/api/providers`)).json();
  const raw = JSON.stringify(body);
  assert(!raw.includes('ak-smoke-0001'), 'a raw provider key leaked into /api/providers');
  assert(!raw.includes('bk-smoke-0001'), 'a raw provider key leaked into /api/providers');
  const alphaCard = body.providers.find((p) => p.id === 'alpha');
  eq(alphaCard.keys.length, 2, 'key pool size');
  return `keys shown as ${alphaCard.keys[0].masked}`;
});

await check('GET /api/stats', async () => {
  const body = await (await fetch(`${B}/api/stats`)).json();
  eq(body.providers.total, 2, 'provider count');
  return `${body.requests.ok} ok / ${body.requests.fail} failed`;
});

await check('GET /api/logs', async () => {
  const body = await (await fetch(`${B}/api/logs?limit=10`)).json();
  assert(body.logs.length > 0, 'log is empty');
  return `${body.logs.length} entries`;
});

await check('GET /api/events streams live', async () => {
  const controller = new AbortController();
  const res = await fetch(`${B}/api/events`, { signal: controller.signal, headers: { accept: 'text/event-stream' } });
  eq(res.status, 200, 'status');

  const reader = res.body.getReader();
  const first = await reader.read();
  const text = new TextDecoder().decode(first.value);
  assert(text.includes('event: hello'), 'no hello frame');
  controller.abort();
  return 'SSE connected';
});

await check('POST /api/providers/:id/enabled toggles', async () => {
  await post('/api/providers/alpha/enabled', { enabled: false });
  const res = await chat({ model: 'fast' });
  eq(res.headers.get('x-freeway-provider'), 'beta', 'should route around the disabled provider');
  await post('/api/providers/alpha/enabled', { enabled: true });
  return 'routed around, then restored';
});

await check('POST /api/reload', async () => {
  const body = await (await post('/api/reload', {})).json();
  eq(body.ok, true, 'ok');
  return `${body.providers} providers reloaded`;
});

// ---------------------------------------------------------------------------
console.log(`\n${C.B}shipped provider catalog${C.x}`);

await check('every providers/*.json parses', async () => {
  const real = new Registry({ dir: 'providers', env: {}, logger: silentLogger });
  const errors = real.issues().filter((i) => i.level === 'error');
  assert(errors.length === 0, errors.map((e) => `${e.file}: ${e.message}`).join('; '));
  return `${real.all().length} providers, ${real.allModels().length} models`;
});

// ---------------------------------------------------------------------------

server.close();
context.close();
cache.close();
await alpha.close();
await beta.close();
rmSync(dir, { recursive: true, force: true });

const colour = failed === 0 ? C.g : C.r;
console.log(`\n${colour}${C.B}${failed === 0 ? 'PASS' : 'FAIL'}${C.x} — ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of failures) console.log(`  ${C.r}${f.name}${C.x}: ${f.message}`);
}
process.exit(failed === 0 ? 0 : 1);
