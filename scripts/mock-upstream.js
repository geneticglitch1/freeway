/**
 * A fake OpenAI-compatible provider you control completely.
 *
 * This is the most valuable thing in the repo: it means routing, failover,
 * streaming, quota and key-pool behaviour can all be tested without spending a
 * single token of real free-tier quota. Every test from Phase 3 onward points
 * at one of these instead of a real provider.
 *
 * Usage as a library:
 *   const mock = await createMockUpstream({ name: 'alpha' });
 *   mock.script([{ status: 429, headers: { 'retry-after': '2' } }, { status: 200 }]);
 *   // ... point a provider's baseUrl at mock.url ...
 *   mock.close();
 *
 * Usage as a standalone server (for `npm run smoke`):
 *   node scripts/mock-upstream.js --port 9001 --name alpha
 */

import { createServer } from 'node:http';
import { once } from 'node:events';

/**
 * @typedef {object} ScriptStep
 * @property {number}  [status]      HTTP status to return. Default 200.
 * @property {Record<string,string>} [headers] Extra response headers (rate-limit headers go here).
 * @property {unknown} [body]        Body override. Default: a plausible OpenAI response.
 * @property {number}  [delayMs]     Artificial latency before responding.
 * @property {boolean} [dropUsage]   Omit the `usage` block, to exercise the estimator fallback.
 * @property {boolean} [hang]        Never respond, to exercise client timeouts.
 * @property {string}  [content]     Assistant text to return.
 * @property {number}  [repeat]      How many requests this step covers. Default 1; Infinity for the tail.
 */

/**
 * @typedef {object} MockOptions
 * @property {string}  [name]        Shows up in responses and logs, so failover is legible.
 * @property {number}  [port]        0 picks a free port.
 * @property {string}  [host]
 * @property {ScriptStep[]} [script] Consumed in order; the last step repeats forever.
 * @property {Record<string, ScriptStep>} [keys] Per-API-key overrides, keyed by the bearer token.
 * @property {string[]} [models]     Ids returned from GET /models.
 * @property {number}  [latencyMs]   Baseline latency for every response.
 */

const DEFAULT_MODELS = ['mock-small', 'mock-large', '@mock/vendor/slashy-model'];

export async function createMockUpstream(options = {}) {
  const name = options.name ?? 'mock';
  const baseLatency = options.latencyMs ?? 0;

  /** @type {ScriptStep[]} */
  let script = options.script ? [...options.script] : [];
  let stepIndex = 0;
  let stepUses = 0;

  /** @type {Record<string, ScriptStep>} */
  let keyOverrides = { ...(options.keys ?? {}) };
  let models = options.models ? [...options.models] : [...DEFAULT_MODELS];

  /** @type {{ path: string, method: string, body: any, key: string|null, headers: Record<string,string>, at: number }[]} */
  const calls = [];

  /** Pull the next scripted step, honouring `repeat`. The final step sticks. */
  function nextStep() {
    if (script.length === 0) return {};
    const step = script[Math.min(stepIndex, script.length - 1)];
    const repeat = step.repeat ?? 1;
    stepUses += 1;
    if (stepUses >= repeat && stepIndex < script.length - 1) {
      stepIndex += 1;
      stepUses = 0;
    }
    return step;
  }

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname.replace(/\/v1(?=\/|$)/, '') || '/';
      const auth = req.headers.authorization;
      const key = typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '') : null;

      let body = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }

      calls.push({
        path,
        method: req.method ?? 'GET',
        body,
        key,
        headers: /** @type {Record<string,string>} */ (Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]))),
        at: Date.now(),
      });

      // A control plane, so a running mock can be re-scripted mid-test.
      if (path === '/__control' && req.method === 'POST') {
        if (body && typeof body === 'object') {
          if (Array.isArray(body.script)) {
            script = body.script;
            stepIndex = 0;
            stepUses = 0;
          }
          if (body.keys) keyOverrides = body.keys;
          if (Array.isArray(body.models)) models = body.models;
          if (body.reset) calls.length = 0;
        }
        return send(res, 200, {}, { ok: true });
      }

      if (path === '/__calls') return send(res, 200, {}, { calls });

      // A per-key override wins over the script — that is how "one key in the
      // pool is revoked while the others work" gets tested.
      const step = (key !== null && keyOverrides[key]) || nextStep();

      const delay = step.delayMs ?? baseLatency;
      if (delay > 0) await sleep(delay);
      if (step.hang) return; // never responds; the client's AbortController must fire

      const status = step.status ?? 200;
      const headers = { ...(step.headers ?? {}) };

      if (path === '/models' && req.method === 'GET') {
        if (status !== 200) return send(res, status, headers, step.body ?? errorBody(status, name));
        return send(res, 200, headers, { object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: name })) });
      }

      if (status !== 200) {
        return send(res, status, headers, step.body ?? errorBody(status, name));
      }

      if (path === '/embeddings') {
        const input = Array.isArray(body?.input) ? body.input : [body?.input ?? ''];
        return send(res, 200, headers, {
          object: 'list',
          model: body?.model ?? 'mock-embed',
          data: input.map((text, i) => ({ object: 'embedding', index: i, embedding: fakeEmbedding(String(text)) })),
          usage: step.dropUsage ? undefined : { prompt_tokens: estimate(input.join(' ')), total_tokens: estimate(input.join(' ')) },
        });
      }

      if (path === '/chat/completions') {
        const prompt = messagesToText(body?.messages);
        const content = step.content ?? `[${name}] ${prompt.slice(-120)}`;
        const usage = step.dropUsage
          ? undefined
          : { prompt_tokens: estimate(prompt), completion_tokens: estimate(content), total_tokens: estimate(prompt) + estimate(content) };

        if (body?.stream) return streamChat(res, { name, model: body?.model ?? 'mock', content, usage, headers });
        return send(res, 200, headers, {
          id: `chatcmpl-${name}-${calls.length}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body?.model ?? 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage,
        });
      }

      return send(res, 404, {}, { error: { message: `mock upstream has no route ${path}`, type: 'invalid_request_error' } });
    });
  });

  server.listen(options.port ?? 0, options.host ?? '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    name,
    port,
    url: `http://127.0.0.1:${port}/v1`,
    calls,
    /** Replace the script and rewind. */
    script(steps) {
      script = [...steps];
      stepIndex = 0;
      stepUses = 0;
    },
    setKeys(k) {
      keyOverrides = { ...k };
    },
    setModels(m) {
      models = [...m];
    },
    reset() {
      calls.length = 0;
      stepIndex = 0;
      stepUses = 0;
    },
    /** Requests seen on a given path. */
    callsTo(path) {
      return calls.filter((c) => c.path === path);
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

// ---------------------------------------------------------------------------

function send(res, status, headers, body) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/**
 * Emit an SSE stream shaped like OpenAI's, including the trailing usage-only
 * chunk that real providers send last. Token accounting depends on finding it.
 */
function streamChat(res, { name, model, content, usage, headers }) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...headers,
  });

  const id = `chatcmpl-${name}-stream`;
  const created = Math.floor(Date.now() / 1000);
  const frame = (delta, finish = null) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

  res.write(frame({ role: 'assistant' }));
  // Deliberately chunked mid-word so the gateway's line buffering is exercised.
  for (const piece of chunkString(content, 7)) res.write(frame({ content: piece }));
  res.write(frame({}, 'stop'));

  if (usage) {
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function chunkString(s, size) {
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.length > 0 ? out : [''];
}

function messagesToText(messages) {
  if (!Array.isArray(messages)) return '';
  return messages
    .map((m) => {
      if (typeof m?.content === 'string') return m.content;
      if (Array.isArray(m?.content)) return m.content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join(' ');
      return '';
    })
    .join('\n');
}

function estimate(text) {
  return Math.max(1, Math.ceil(String(text).length / 4));
}

/** Deterministic pseudo-embedding, so semantic-cache tests are reproducible. */
function fakeEmbedding(text, dims = 8) {
  const v = new Array(dims).fill(0);
  for (let i = 0; i < text.length; i++) v[i % dims] += text.charCodeAt(i);
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

function errorBody(status, name) {
  const type = status === 429 ? 'rate_limit_exceeded' : status >= 500 ? 'server_error' : 'invalid_request_error';
  return { error: { message: `[${name}] mock upstream returned ${status}`, type, code: status } };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Standalone mode
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const arg = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
  };
  const mock = await createMockUpstream({
    name: arg('--name', 'mock'),
    port: Number(arg('--port', '0')),
    latencyMs: Number(arg('--latency', '0')),
  });
  console.log(`mock upstream "${mock.name}" listening on ${mock.url}`);
  console.log(`  control: POST ${mock.url.replace('/v1', '')}/__control  {"script":[{"status":429}]}`);
  process.on('SIGINT', () => {
    mock.close().then(() => process.exit(0));
  });
}
