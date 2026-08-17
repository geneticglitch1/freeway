# Freeway — notes for whoever works on this next

Self-hosted, OpenAI-compatible gateway in front of free-tier LLM providers.
One endpoint, automatic failover, live quota visibility, and no real provider
key ever leaving the box.

## The one rule

**Providers are data, not code.** Adding a provider is one JSON file in
`providers/` plus one env var. It must never require a TypeScript edit.

If you are adding a provider, read **[docs/ADDING-A-PROVIDER.md](docs/ADDING-A-PROVIDER.md)**
and use the tools — do not hand-write the file:

```bash
node scripts/new-provider.mjs <id> --url <baseUrl> --env <ENV_VAR>
node scripts/verify-provider.mjs <id>            # your feedback loop; --json for machine output
```

The schema is the contract: [`providers/_schema.json`](providers/_schema.json).

## Layout

```
packages/core/      registry, meter, store, router, guard, context, cache, probe
packages/gateway/   node:http server + public/index.html dashboard
packages/sdk/       @freeway/sdk client
providers/          the registry — one JSON file per provider, _-prefixed files skipped
scripts/            mock-upstream.js, verify-provider.mjs, new-provider.mjs
```

## Hard constraints

- **Node 22+, TypeScript, ESM, npm workspaces. Zero runtime dependencies.**
  Dev deps are `typescript` and `@types/node` only. If you think you need a
  runtime dep, stop and ask.
- **No TypeScript parameter properties.** `constructor(private readonly x: T)`
  throws `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` under Node's strip-only type
  stripping, which is how the tests and `verify-provider.mjs` run `.ts` sources
  directly. Declare fields, assign in the constructor.
- `strict` + `noUncheckedIndexedAccess`: indexing returns `T | undefined`. Guard
  or `?? fallback`; never `!`. No `any` without a comment justifying it.
- Tests are `node:test` only. Run them against `scripts/mock-upstream.js`, never
  a real provider.
- **Never log a key.** Everything goes through `mask()` in `packages/core/src/util.ts`.
  There are tests asserting raw keys cannot appear in errors or `/api/*`.
- Comments explain *why*. Skip comments that restate the code.

## Things that look wrong but are deliberate

- **`null` limits.** `null` means "unknown or unlimited" and beats a guessed
  number, because the guard layer overwrites nulls with values observed from
  upstream rate-limit headers. A wrong number never self-corrects. Mistral ships
  with null `rps`/`tpm` because Mistral stopped publishing them.
- **Day and month limits are calendar windows, not rolling.** Free tiers reset
  at 00:00 UTC. A rolling 24h window would block for hours after quota refilled.
- **Model ids are split on the *first* slash only.** `cloudflare/@cf/meta/llama-3.1-8b-instruct`
  is provider `cloudflare`, model `@cf/meta/llama-3.1-8b-instruct`.
- **Failover commits after 200 headers, before piping the body.** Once a byte of
  a stream reaches the client you cannot fail over, so the commit point sits
  exactly there.
- **A 400 is never retried and benches nothing.** It fails identically everywhere.
  A 401/403/429 benches the *key*; a 5xx or network error benches the *provider*.
- **Per-model credit rates, not one per provider.** Output tokens cost ~8x input
  and a 70B ~10x an 8B, so a single flat number is wrong by an order of magnitude.

## Commands

```bash
npm run build                       # tsc --build, must be clean
npm test                            # node:test across all workspaces
npm run smoke                       # gateway against the mock upstream, every route
node scripts/mock-upstream.js --port 9101 --name alpha   # a fake provider you control
```

## Where things live

| Want to change… | File |
|---|---|
| provider file format | `packages/core/src/spec.ts` + `providers/_schema.json` |
| quota accounting | `packages/core/src/meter.ts` |
| which provider serves a request | `packages/core/src/router.ts` |
| failover / streaming behaviour | `packages/gateway/src/proxy.ts` |
| routes | `packages/gateway/src/server.ts` |
| the dashboard | `packages/gateway/public/index.html` (one file, no build step, no CDN) |
