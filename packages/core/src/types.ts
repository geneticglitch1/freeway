/**
 * The shapes every other module agrees on.
 *
 * Two families live here:
 *  - `*Spec` types describe what an author writes in `providers/*.json`. They are
 *    normalized (defaults applied, `${ENV}` resolved) by the registry.
 *  - `Resolved*` types describe the runtime view the router and gateway consume.
 *
 * Values that a provider genuinely may not publish are `null`, never `undefined`.
 * `null` means "unknown or unlimited" and the meter treats it as unmetered, so an
 * honest null is always safer than a guessed number.
 */

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export const CAPS = [
  'chat',
  'tools',
  'json',
  'vision',
  'reasoning',
  'embed',
  'code',
  'long-context',
] as const;

export type Cap = (typeof CAPS)[number];

export function isCap(v: unknown): v is Cap {
  return typeof v === 'string' && (CAPS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export type AuthType = 'bearer' | 'header' | 'query' | 'none';

export interface AuthSpec {
  type: AuthType;
  /** Header name when `type === 'header'` (e.g. `x-api-key`). */
  header: string | null;
  /** Query parameter name when `type === 'query'` (e.g. `key`). */
  query: string | null;
  /**
   * Env vars to read keys from, in order. A single var may hold several
   * comma-separated keys — that is the key pool, and it has to work from a
   * plain Docker `-e` with no extra syntax.
   */
  envKeys: string[];
  /** Overrides the `Bearer ` prefix for providers that want something else. */
  prefix: string | null;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export type LimitKey = 'rps' | 'rpm' | 'rpd' | 'tpm' | 'tpd' | 'tpmo' | 'creditsPerDay';

/** Which counter a limit reads from. Requests, tokens and credits move independently. */
export type CounterFamily = 'req' | 'tok' | 'cred';

/**
 * Rolling windows slide continuously; calendar windows snap to a UTC boundary.
 * This distinction is not pedantry — free tiers that reset "daily" reset at
 * 00:00 UTC, so a rolling 24h window would block for hours after the real quota
 * had already refilled.
 */
export type WindowKind = 'rolling' | 'calendar';

export type Period = 'second' | 'minute' | 'day' | 'month';

export interface LimitDef {
  key: LimitKey;
  family: CounterFamily;
  kind: WindowKind;
  period: Period;
  /** Window length for rolling windows; nominal period length for calendar ones. */
  windowMs: number;
  /** Bucket count for rolling windows. Finer buckets = less boundary burst. */
  slots: number;
  /** Human label the dashboard prints under a quota bar. */
  label: string;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

/**
 * The meter iterates this table rather than branching per limit, so adding a new
 * limit type is a one-line change here and nothing else.
 */
export const LIMIT_DEFS: readonly LimitDef[] = [
  { key: 'rps', family: 'req', kind: 'rolling', period: 'second', windowMs: SECOND, slots: 10, label: 'last 1s' },
  { key: 'rpm', family: 'req', kind: 'rolling', period: 'minute', windowMs: MINUTE, slots: 60, label: 'last 60s' },
  { key: 'tpm', family: 'tok', kind: 'rolling', period: 'minute', windowMs: MINUTE, slots: 60, label: 'last 60s' },
  { key: 'rpd', family: 'req', kind: 'calendar', period: 'day', windowMs: DAY, slots: 1, label: 'today (UTC)' },
  { key: 'tpd', family: 'tok', kind: 'calendar', period: 'day', windowMs: DAY, slots: 1, label: 'today (UTC)' },
  { key: 'creditsPerDay', family: 'cred', kind: 'calendar', period: 'day', windowMs: DAY, slots: 1, label: 'today (UTC)' },
  { key: 'tpmo', family: 'tok', kind: 'calendar', period: 'month', windowMs: 30 * DAY, slots: 1, label: 'this month (UTC)' },
];

export const LIMIT_KEYS: readonly LimitKey[] = LIMIT_DEFS.map((d) => d.key);

export interface LimitSpec {
  rps: number | null;
  rpm: number | null;
  rpd: number | null;
  tpm: number | null;
  tpd: number | null;
  /** Tokens per month. */
  tpmo: number | null;
  /** Abstract metered unit — Cloudflare bills free Workers AI in "neurons". */
  creditsPerDay: number | null;
  /** Estimated credit cost of one request. Not a window; used to project spend. */
  creditsPerRequest: number | null;
}

export const EMPTY_LIMITS: LimitSpec = {
  rps: null,
  rpm: null,
  rpd: null,
  tpm: null,
  tpd: null,
  tpmo: null,
  creditsPerDay: null,
  creditsPerRequest: null,
};

/**
 * Where a limit number came from. The catalog ships providers whose published
 * limits could not be verified; the dashboard badges those, and the guard layer
 * overwrites them with `observed` values learned from upstream response headers.
 */
export type LimitsSource = 'docs' | 'observed' | 'unverified';

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/**
 * Cost in abstract credits per million tokens.
 *
 * Cloudflare's published neuron rates make it clear a flat per-request estimate
 * is not good enough: output tokens cost roughly 7-10x input tokens, and a 70B
 * model costs ~10x an 8B one. Llama 3.2-1b is 2,457 neurons per Mtok in and
 * 18,252 out, while Llama 3.1-70b is 26,668 / 204,805. Metering those with one
 * number per provider would be wrong by an order of magnitude either way.
 */
export interface CreditCost {
  perMTokIn: number | null;
  perMTokOut: number | null;
}

export interface ModelSpec {
  id: string;
  label: string;
  alias: string[];
  /** Context window in tokens. `null` when the provider does not publish it. */
  context: number | null;
  caps: Cap[];
  priority: number;
  enabled: boolean;
  /** Max output tokens, when constrained separately from context. */
  maxOutput: number | null;
  /** Per-model credit rates; falls back to `limits.creditsPerRequest`. */
  credits: CreditCost | null;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** Only `openai` is implemented; the field exists so a second adapter is additive. */
export type AdapterId = 'openai';

export interface ProviderSpec {
  id: string;
  label: string;
  docs: string | null;
  console: string | null;
  enabled: boolean;
  /** Lower is tried first. */
  priority: number;
  adapter: AdapterId;
  /** May contain `${ENV_VAR}` — resolved by the registry, not at call time. */
  baseUrl: string;
  auth: AuthSpec;
  limits: LimitSpec;
  limitsSource: LimitsSource;
  /** ISO date the limits above were last checked against provider docs. */
  verifiedOn: string | null;
  /** Path for live model discovery, relative to `baseUrl`. `null` disables it. */
  modelsEndpoint: string | null;
  /**
   * Where model ids live in the discovery response, e.g. `data[].id`. Keeps a
   * provider with a non-OpenAI response shape a pure-JSON addition.
   */
  modelsPath: string;
  /** Body params this provider rejects; stripped before forwarding. */
  dropParams: string[];
  /** Extra headers; values may contain `${ENV_VAR}`. */
  headers: Record<string, string>;
  notes: string | null;
  models: ModelSpec[];
}

// ---------------------------------------------------------------------------
// Resolved runtime view
// ---------------------------------------------------------------------------

/** A single API key drawn from the pool. `value` never leaves the process. */
export interface KeyRef {
  /** Stable id: `<providerId>#<index>`. Safe to log and to show in the UI. */
  id: string;
  providerId: string;
  index: number;
  value: string;
  /** `abcd…wxyz`. The only representation allowed outside the gateway. */
  masked: string;
  /** Which env var this key came from, for "set X" advice. */
  source: string;
}

export interface ResolvedModel {
  spec: ModelSpec;
  providerId: string;
  /** `provider/model` — the id clients pin against. */
  ref: string;
}

export interface ResolvedProvider {
  spec: ProviderSpec;
  id: string;
  label: string;
  enabled: boolean;
  /** `${ENV}` already substituted. Empty string when a var was missing. */
  baseUrl: string;
  headers: Record<string, string>;
  keys: KeyRef[];
  /** False when env is missing or no key was found. */
  configured: boolean;
  /**
   * Human-readable advice, not a stack trace. The dashboard renders this
   * verbatim, so it must read like "no API key found (set one of: FOO_KEY)".
   */
  configError: string | null;
  models: ResolvedModel[];
}

/** A provider+model+key triple the router is willing to try. */
export interface Candidate {
  provider: ResolvedProvider;
  model: ResolvedModel;
  key: KeyRef;
}

/** A provider+model pair the router rejected, with a specific reason. */
export interface Blocked {
  providerId: string;
  modelId: string;
  reason: string;
  retryAfterMs: number | null;
}

// ---------------------------------------------------------------------------
// Meter results
// ---------------------------------------------------------------------------

export interface MeterCheck {
  ok: boolean;
  /** Which limit stopped the request; `null` when `ok`. */
  blockedBy: LimitKey | null;
  /** How long until the blocking window has room again. */
  retryAfterMs: number | null;
  reason: string | null;
}

export interface MeterBar {
  key: LimitKey;
  used: number;
  limit: number;
  /** 0–100, clamped. */
  pct: number;
  window: string;
  /** Epoch ms when a calendar window resets; `null` for rolling windows. */
  resetsAt: number | null;
}

/** Serializable meter state, for `data/usage.json` round-tripping. */
export interface MeterSnapshot {
  rolling: Record<string, { slots: number[]; stamps: number[] }>;
  calendar: Record<string, { period: string; count: number }>;
}

// ---------------------------------------------------------------------------
// Config (shape declared now so later phases do not churn these types)
// ---------------------------------------------------------------------------

export type Strategy = 'priority' | 'round-robin' | 'least-used' | 'fastest';

export interface GuardConfig {
  /** Per-virtual-key inbound ceilings. Stops one app eating the whole free tier. */
  perKey: { rpm: number | null; tpm: number | null; rpd: number | null; concurrency: number | null };
  perIp: { rpm: number | null; concurrency: number | null };
  maxBodyBytes: number;
  maxMessages: number;
  scan: { mode: 'off' | 'flag' | 'block'; secrets: boolean; pii: boolean; injection: boolean };
  /** Overwrite unverified limits with values learned from upstream headers. */
  calibrate: boolean;
  keyHealthIntervalMs: number;
}

export interface ContextConfig {
  enabled: boolean;
  /** Turns kept verbatim at the tail before compaction considers them. */
  maxTurns: number;
  /** Tokens held back from the window for the model's own reply. */
  reserveOutputTokens: number;
  /** Model used for compaction summaries; resolved through the router like any other. */
  compactModel: string;
  /** Fraction of the window that triggers proactive compaction. */
  autoCompactAt: number;
}

export interface CacheConfig {
  /** `safe` caches only deterministic requests — caching a creative call is wrong. */
  mode: 'off' | 'safe' | 'aggressive';
  ttlMs: number;
  maxEntries: number;
  semantic: {
    enabled: boolean;
    /** Cosine similarity floor for a hit. 0.92 is the literature default. */
    threshold: number;
    model: string;
    maxEntries: number;
  };
}

export interface FreewayConfig {
  strategy: Strategy;
  maxAttempts: number;
  cooldownSeconds: number;
  timeoutMs: number;
  streamTimeoutMs: number;
  host: string;
  port: number;
  /**
   * Virtual `fw-` keys apps present. These grant **inference only** — `/v1/*`.
   * Empty = open, and the gateway then refuses to bind a non-loopback address.
   */
  keys: string[];
  /**
   * Full-access key: everything under `/api/*`, including reading stored
   * conversations and writing provider credentials. Required to expose the
   * gateway safely, because an app key must not be able to administer it.
   */
  adminKey: string | null;
  /**
   * Origins allowed to call the gateway from a browser. Empty means no CORS
   * headers at all, which is correct for the bundled dashboard (same-origin).
   * `*` is rejected: it would let any page you visit drive your gateway.
   */
  corsOrigins: string[];
  aliases: Record<string, string>;
  guard: GuardConfig;
  context: ContextConfig;
  cache: CacheConfig;
}
