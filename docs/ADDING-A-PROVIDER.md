# Adding a provider

**You do not edit TypeScript to add a provider.** You write one JSON file and set
one environment variable. If you find yourself opening a `.ts` file, something
has gone wrong — see [When you think you need code](#when-you-think-you-need-code).

This document is written to be usable by a person or by an AI agent working
unattended, including for a provider nobody here has ever heard of.

---

## The 60-second version

```bash
node scripts/new-provider.mjs acme --url https://api.acme.ai/v1 --env ACME_API_KEY
export ACME_API_KEY=sk-...
node scripts/verify-provider.mjs acme
```

The verifier tells you what is wrong, what models it found, and what the real
rate limits are. Paste its suggestion into the file, run it again until it says
`PASS`, and the provider is live.

---

## The loop

```
  new-provider.mjs  ──▶  providers/acme.json  ──▶  verify-provider.mjs
                              ▲                            │
                              └────── paste suggestion ◀────┘
```

`verify-provider.mjs` is the feedback signal. It checks five things in order and
stops at the first that fails, so you always get one actionable problem rather
than a wall of noise:

| Step | Checks | Typical failure |
|---|---|---|
| 1. file | parses, matches the schema | `limits.rpm: expected a positive number or null` |
| 2. environment | `${ENV}` resolves, a key exists | `no API key found (set one of: ACME_API_KEY)` |
| 3. live probe | auth accepted, `/models` readable | `auth invalid — GET /models → 401` |
| 4. limits | headers vs declared limits | `rpm: file says 60, provider reports 30` |
| 5. suggestion | prints paste-ready JSON | — |

Flags: `--validate` also sends a one-token request per model (spends real quota,
tells you which models the key can genuinely reach). `--json` for machine output
— use this if you are an agent.

---

## The fields that actually matter

Everything else has a working default. Full contract:
[`providers/_schema.json`](../providers/_schema.json).

### `baseUrl` — with `${ENV_VAR}` interpolation

```jsonc
"baseUrl": "https://api.groq.com/openai/v1"

// Some providers put an account id in the path. Interpolation is why that
// stays data instead of becoming a special case in code:
"baseUrl": "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1"
```

A missing variable is not a crash. The provider renders on the dashboard as a
card reading `missing environment variable: CLOUDFLARE_ACCOUNT_ID`.

### `auth` — four shapes cover everything so far

```jsonc
{ "type": "bearer", "envKeys": ["ACME_API_KEY"] }                     // Authorization: Bearer <key>
{ "type": "header", "header": "x-api-key", "envKeys": ["ACME_KEY"] }  // a named header
{ "type": "query",  "query": "key",        "envKeys": ["ACME_KEY"] }  // ?key=<key>
{ "type": "none",   "envKeys": [] }                                   // local Ollama, no credential
{ "type": "bearer", "prefix": "", "envKeys": ["ACME_KEY"] }            // bare token, no "Bearer "
```

**Key pools.** One variable may hold several comma-separated keys:

```bash
ACME_API_KEY=sk-aaa,sk-bbb,sk-ccc
```

Quota is tracked **per key**. A 429 on one benches only that key and the request
retries on the next; a 5xx benches the whole provider because every key would
fail identically. Commas are the grammar precisely so this works from a plain
`docker run -e` with no extra syntax.

### `limits` — null is a real answer

```jsonc
"limits": { "rps": 1, "tpm": 500000, "tpmo": 1000000000 }
```

| Key | Window |
|---|---|
| `rps` `rpm` `tpm` | rolling |
| `rpd` `tpd` `creditsPerDay` | **calendar day, resets 00:00 UTC** |
| `tpmo` | **calendar month** |

> **Do not guess a number.** `null` means "unknown or unlimited" and is always
> the right answer when you have not verified it. The guard layer overwrites
> nulls with values read from the provider's own rate-limit response headers, so
> an honest null becomes accurate on its own. A wrong number does not — it
> silently misroutes, and nothing ever corrects it.

Set `"limitsSource": "unverified"` when you are unsure. The dashboard badges it
and everything still works. Mistral's file does exactly this, because Mistral
stopped publishing free-tier figures.

### `models` — a few verified beats a long guess

```jsonc
{
  "id": "acme-turbo",              // exactly as the provider spells it; slashes are fine
  "alias": ["fast", "cheap"],      // several providers sharing an alias is what enables failover
  "context": 128000,               // null if unpublished
  "caps": ["chat", "tools", "json"],
  "priority": 10,                  // lower is tried first
  "credits": { "perMTokIn": 2457, "perMTokOut": 18252 }  // only for credit-metered providers
}
```

`caps` drives routing and is not decorative:

| Cap | Effect |
|---|---|
| `chat` | eligible for `/v1/chat/completions` |
| `embed` | eligible for `/v1/embeddings` — and **never** for chat |
| `tools` | required when the request body has `tools` |
| `json` | required when `response_format.type` is `json_object` |
| `vision` | required when a message contains an image part |
| `reasoning` `code` `long-context` | informational, filterable in the dashboard |

Leave `models: []` and let discovery populate it. That is better than a stale
list — see `together.json` and `github-models.json`.

### `modelsPath` — for non-OpenAI response shapes

```jsonc
"modelsEndpoint": "/models",
"modelsPath": "data[].id"     // {"data":[{"id":"..."}]}   ← OpenAI standard
"modelsPath": "[].id"         // [{"id":"..."}]            ← GitHub Models
"modelsPath": "models[].name" // {"models":[{"name":...}]}
"modelsPath": "result[].name" // {"result":[{"name":...}]}
```

Set `"modelsEndpoint": null` when a provider has no catalog endpoint —
Cloudflare's OpenAI-compatible surface exposes `/chat/completions` and
`/embeddings` but not `/models`.

### `dropParams` — params a provider rejects

```jsonc
"dropParams": ["frequency_penalty", "presence_penalty"]
```

Find them empirically: send a request, read the 400, add the offending field.

---

## Worked example: a provider that does not exist

Say **Acme AI** offers a free tier. OpenAI-compatible, key in `x-api-key`,
account id in the URL, and a `/models` endpoint returning `{"result":[...]}`.

**1. Scaffold.**

```bash
node scripts/new-provider.mjs acme \
  --url 'https://api.acme.ai/v1/org/${ACME_ORG}' \
  --auth header --header x-api-key --env ACME_API_KEY
```

**2. Fix the response shape** in `providers/acme.json`:

```jsonc
"modelsPath": "result[].name"
```

**3. Verify.**

```bash
export ACME_API_KEY=sk-live-xxxx
export ACME_ORG=org_123
node scripts/verify-provider.mjs acme
```

```
1. file
  ✓ providers/acme.json parses
2. environment
  ✓ baseUrl resolves to https://api.acme.ai/v1/org/org_123
  ✓ 1 key in the pool: sk-l…xxxx (ACME_API_KEY)
3. live probe
  ✓ auth accepted (142ms)
  ✓ discovery found 3 models via /models → result[].name
4. limits
  ✓ observed from response headers: rpm=60, tpm=40000
  + rpm: file says null, provider reports 60 — consider recording it
5. suggested edits
  { "models": [...], "limits": {...}, "limitsSource": "observed" }

PASS — 0 problems, 0 warnings
```

**4. Paste the suggestion in**, add aliases and capabilities the verifier could
not know, and re-run with `--validate` to confirm each model really answers.

**5. Use it.** No restart needed:

```bash
curl -X POST localhost:8787/api/reload
curl localhost:8787/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"acme/acme-turbo","messages":[{"role":"user","content":"hi"}]}'
```

---

## Common failures

| Symptom | Cause |
|---|---|
| Provider missing from the dashboard entirely | filename starts with `_` (reserved), or the JSON failed to parse — check the red banner, it names the file and the syntax error |
| `unknown field — did you mean "baseUrl"?` | a typo like `baseURL`. Warnings are surfaced, never silently ignored |
| Card shows `no API key found` | env var unset, or set in a shell the gateway did not inherit |
| Card shows `missing environment variable: X` | a `${X}` in `baseUrl`/`headers` did not resolve. Pasting a key will not fix this |
| `modelsPath matched nothing` | wrong response shape — `curl` the endpoint and read it |
| Model never gets routed to | missing a required `cap`, or `context` too small for `minContext`. The 429 body's `blocked[]` says which |
| Everything 429s immediately | a limit is set too low. Set it to `null` and let calibration find the truth |

Every rejection reason appears in the `blocked` array of a 429 response and in
the dashboard. You should never have to guess why a provider was skipped.

---

## When you think you need code

Nearly always, you do not:

| "I need code because…" | Actually |
|---|---|
| the URL contains an account id | `${ENV_VAR}` in `baseUrl` |
| auth is a custom header | `auth.type: "header"` |
| the token has no `Bearer ` prefix | `auth.prefix: ""` |
| `/models` is shaped differently | `modelsPath` |
| there is no `/models` | `modelsEndpoint: null` |
| it rejects a parameter | `dropParams` |
| it needs an extra header | `headers: {}` (supports `${ENV}` too) |
| it bills in credits, not tokens | `limits.creditsPerDay` + per-model `credits` |
| I have several keys | comma-separate them in one env var |

A genuinely new **wire format** — not OpenAI-compatible at all — is the one case
that needs a new `adapter`. That field exists and is validated, but only
`"openai"` is implemented. Adding one is a real code change; everything above is not.

---

## Repo conventions that will bite you

- **No TypeScript parameter properties.** `constructor(private readonly x: T)`
  throws `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` under Node's strip-only type
  stripping. Declare fields explicitly and assign in the constructor.
- **Zero runtime dependencies.** Dev deps are `typescript` and `@types/node`.
  Stop and ask before adding anything.
- `noUncheckedIndexedAccess` is on: indexing returns `T | undefined`. Use guards
  or `?? fallback`, never `!`.
- Never log a key. Everything goes through `mask()` in
  [`packages/core/src/util.ts`](../packages/core/src/util.ts).
- Tests are `node:test`. Point them at `scripts/mock-upstream.js`, never at a
  real provider — that is what it is for.
