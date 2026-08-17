# Exposing Freeway safely

The gateway holds every provider key you own. Treat it as a credential store
that happens to speak OpenAI, not as a stateless proxy.

## Before you expose it

```bash
# 1. Inference keys — one per app, so you can revoke them individually.
node -e "console.log('fw-'+crypto.randomUUID())"

# 2. Admin key — separate, and never given to an app.
node -e "console.log('fw-admin-'+crypto.randomUUID())"
```

```bash
FREEWAY_KEYS=fw-app-one,fw-app-two      # inference only: /v1/*
FREEWAY_ADMIN_KEY=fw-admin-…            # everything: /api/*
FREEWAY_CORS_ORIGINS=                   # leave empty unless a browser app needs it
```

Then put it behind TLS. Freeway speaks plain HTTP by design — terminate with
Caddy, nginx or a tunnel. A virtual key sent over cleartext to a remote host is
a virtual key you have published.

## The permission model

| Credential | Reaches | Notes |
|---|---|---|
| none | `/healthz`, `/` | dashboard shell only; it still needs a key for data |
| `FREEWAY_KEYS` entry | `/v1/*` | inference only — **cannot** read sessions or touch config |
| `FREEWAY_ADMIN_KEY` | `/v1/*` and `/api/*` | reads stored conversations, writes provider keys |

`/api/*` is administrative in full: it reads conversation history, writes
provider credentials to disk, spends quota via probes, and can disable
providers. An app key must never reach it, which is why the roles are split.

With **no** admin key configured, `/api/*` is allowed on loopback (where you are
the only caller) and refused entirely on any other interface.

## Defaults that change when you expose it

Binding a non-loopback address turns on inbound limits automatically, because
`null` everywhere is only safe when the caller can only be you:

| | default on `0.0.0.0` |
|---|---|
| per key | 120 req/min, 8 concurrent |
| per IP | 240 req/min, 16 concurrent |

Override in `freeway.config.json` under `guard`. Tighten them if one app is
meant to be small.

Two failsafes you cannot turn off: the gateway **refuses to bind** a public
interface with no `FREEWAY_KEYS`, and the runtime key-paste endpoint refuses to
accept credentials over a non-loopback socket without an admin key.

## What is protected

- **Provider keys never leave the process.** Masked in logs, `/api/*`, the
  dashboard and error bodies; tests assert a raw key cannot appear in any of them.
- **Sessions are owned.** A session is claimed by a fingerprint of the key that
  created it; another key gets `403 session_forbidden`.
- **CORS is an allowlist.** Empty by default, `*` rejected in config.
- **Caller identity is a hash, not a mask.** Masks are lossy and two keys can
  render identically — that must never decide authorization.
- **Constant-time key comparison** over hashes, so neither content nor length
  is observable by timing.
- **Data at rest is 0600**: `keys.json`, `freeway.db` (conversations),
  `cache.db` (responses).
- **Live-log subscriptions are capped** at 16 concurrent.

## What is not protected — decide for yourself

- **No TLS.** Terminate it in front.
- **The cache is shared across keys.** Two keys asking the same question share an
  entry. Not a content leak, but `x-freeway-cache: exact` reveals that *someone*
  asked it before. Set `cache.mode: "off"` if that matters.
- **`/healthz` is unauthenticated** and reports provider counts and uptime.
- **Content scanning is `flag`, not `block`.** It records secrets and PII found
  in prompts rather than refusing them. Set `guard.scan.mode: "block"` to refuse
  on high-severity findings.
- **Prompts and replies go to third-party free tiers.** Nothing here changes
  what those providers do with them. Do not send anything through a free tier
  that you would not be comfortable handing to that vendor.
- **The probe endpoint amplifies.** One admin request can trigger dozens of
  upstream calls against a provider.

## Reviewed and found clean

SQL injection (all statements are prepared with bound parameters) · dashboard
XSS (every interpolation escaped) · SSRF (`baseUrl` comes from disk, never from
a request) · prototype pollution · path traversal (ids are database keys, never
paths) · header injection (all header values sanitised to printable ASCII).

## If a key leaks

1. Remove it from `FREEWAY_KEYS` and restart. Sessions owned by it become
   unreachable rather than exposed.
2. If it was the **admin** key, assume every provider key was readable — rotate
   them at each provider, not just here.
3. `data/usage.json` and the dashboard log show what it spent.
