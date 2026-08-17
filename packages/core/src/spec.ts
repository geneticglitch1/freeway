/**
 * Parse and normalize one `providers/*.json` file.
 *
 * Errors carry the exact field path that is wrong. This is the first feedback
 * signal a person — or an agent — gets when adding a provider, and it is the
 * only thing standing between "drop in a JSON file" and "read the source to
 * find out why it did nothing". Unknown fields are reported as warnings rather
 * than ignored, because a silent typo like `baseURL` is the worst failure mode
 * this format has.
 */

import {
  CAPS,
  EMPTY_LIMITS,
  LIMIT_KEYS,
  isCap,
  type AuthSpec,
  type AuthType,
  type Cap,
  type CreditCost,
  type LimitSpec,
  type LimitsSource,
  type ModelSpec,
  type ProviderSpec,
} from './types.ts';

export interface SpecIssue {
  path: string;
  message: string;
}

export type SpecParse =
  | { ok: true; spec: ProviderSpec; warnings: SpecIssue[] }
  | { ok: false; errors: SpecIssue[]; warnings: SpecIssue[] };

const AUTH_TYPES: readonly AuthType[] = ['bearer', 'header', 'query', 'none'];
const LIMITS_SOURCES: readonly LimitsSource[] = ['docs', 'observed', 'unverified'];

const PROVIDER_FIELDS = new Set([
  'id', 'label', 'docs', 'console', 'enabled', 'priority', 'adapter', 'baseUrl',
  'auth', 'limits', 'limitsSource', 'verifiedOn', 'modelsEndpoint', 'modelsPath',
  'dropParams', 'headers', 'notes', 'models', '$schema',
]);
const MODEL_FIELDS = new Set(['id', 'label', 'alias', 'context', 'caps', 'priority', 'enabled', 'maxOutput', 'credits']);
const CREDIT_FIELDS = new Set(['perMTokIn', 'perMTokOut']);
const AUTH_FIELDS = new Set(['type', 'header', 'query', 'envKeys', 'prefix']);

class Issues {
  readonly errors: SpecIssue[] = [];
  readonly warnings: SpecIssue[] = [];
  error(path: string, message: string): void {
    this.errors.push({ path, message });
  }
  warn(path: string, message: string): void {
    this.warnings.push({ path, message });
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkUnknown(obj: Record<string, unknown>, allowed: Set<string>, base: string, iss: Issues): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      const near = [...allowed].find((a) => a.toLowerCase() === k.toLowerCase());
      iss.warn(`${base}${k}`, near ? `unknown field — did you mean "${near}"?` : 'unknown field (ignored)');
    }
  }
}

function str(v: unknown, path: string, iss: Issues, fallback: string | null = null): string | null {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'string') {
    iss.error(path, `expected a string, got ${typeof v}`);
    return fallback;
  }
  return v;
}

function bool(v: unknown, path: string, iss: Issues, fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') {
    iss.error(path, `expected true or false, got ${typeof v}`);
    return fallback;
  }
  return v;
}

function num(v: unknown, path: string, iss: Issues, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    iss.error(path, `expected a number, got ${typeof v}`);
    return fallback;
  }
  return v;
}

/** Limits are `number | null`, where null explicitly means unknown/unlimited. */
function limitNum(v: unknown, path: string, iss: Issues): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    iss.error(path, `expected a positive number or null, got ${typeof v}`);
    return null;
  }
  if (v <= 0) {
    iss.error(path, `expected a positive number or null, got ${v} — use null for "unknown or unlimited"`);
    return null;
  }
  return v;
}

function strArray(v: unknown, path: string, iss: Issues): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    iss.error(path, `expected an array of strings, got ${typeof v}`);
    return [];
  }
  const out: string[] = [];
  v.forEach((item, i) => {
    if (typeof item !== 'string') iss.error(`${path}[${i}]`, `expected a string, got ${typeof item}`);
    else out.push(item);
  });
  return out;
}

function parseAuth(v: unknown, iss: Issues): AuthSpec {
  const auth: AuthSpec = { type: 'bearer', header: null, query: null, envKeys: [], prefix: null };
  if (v === undefined || v === null) {
    iss.error('auth', 'required — declare how the provider authenticates');
    return auth;
  }
  if (!isRecord(v)) {
    iss.error('auth', `expected an object, got ${Array.isArray(v) ? 'array' : typeof v}`);
    return auth;
  }
  checkUnknown(v, AUTH_FIELDS, 'auth.', iss);

  const type = str(v['type'], 'auth.type', iss, 'bearer');
  if (type !== null && !(AUTH_TYPES as readonly string[]).includes(type)) {
    iss.error('auth.type', `must be one of ${AUTH_TYPES.join(' | ')}, got "${type}"`);
  } else if (type !== null) {
    auth.type = type as AuthType;
  }

  auth.header = str(v['header'], 'auth.header', iss);
  auth.query = str(v['query'], 'auth.query', iss);
  auth.prefix = str(v['prefix'], 'auth.prefix', iss);
  auth.envKeys = strArray(v['envKeys'], 'auth.envKeys', iss);

  if (auth.type === 'header' && !auth.header) {
    iss.error('auth.header', 'required when auth.type is "header" — name the header, e.g. "x-api-key"');
  }
  if (auth.type === 'query' && !auth.query) {
    iss.error('auth.query', 'required when auth.type is "query" — name the query param, e.g. "key"');
  }
  if (auth.type !== 'none' && auth.envKeys.length === 0) {
    iss.error('auth.envKeys', 'required unless auth.type is "none" — list at least one env var to read the key from');
  }
  return auth;
}

function parseLimits(v: unknown, iss: Issues): LimitSpec {
  const limits: LimitSpec = { ...EMPTY_LIMITS };
  if (v === undefined || v === null) return limits;
  if (!isRecord(v)) {
    iss.error('limits', `expected an object, got ${Array.isArray(v) ? 'array' : typeof v}`);
    return limits;
  }
  const allowed = new Set<string>([...LIMIT_KEYS, 'creditsPerRequest']);
  checkUnknown(v, allowed, 'limits.', iss);

  for (const key of LIMIT_KEYS) limits[key] = limitNum(v[key], `limits.${key}`, iss);
  limits.creditsPerRequest = limitNum(v['creditsPerRequest'], 'limits.creditsPerRequest', iss);
  return limits;
}

function parseModel(v: unknown, i: number, iss: Issues): ModelSpec | null {
  const path = `models[${i}]`;
  if (!isRecord(v)) {
    iss.error(path, `expected an object, got ${Array.isArray(v) ? 'array' : typeof v}`);
    return null;
  }
  checkUnknown(v, MODEL_FIELDS, `${path}.`, iss);

  const id = str(v['id'], `${path}.id`, iss);
  if (!id) {
    iss.error(`${path}.id`, 'required — the upstream model id, exactly as the provider spells it');
    return null;
  }

  const caps: Cap[] = [];
  const rawCaps = v['caps'];
  if (rawCaps !== undefined && rawCaps !== null) {
    if (!Array.isArray(rawCaps)) {
      iss.error(`${path}.caps`, `expected an array, got ${typeof rawCaps}`);
    } else {
      rawCaps.forEach((c, ci) => {
        if (isCap(c)) caps.push(c);
        // Forward compatible: an unrecognised capability is dropped, not fatal,
        // so a newer provider file still loads on an older gateway.
        else iss.warn(`${path}.caps[${ci}]`, `unknown capability "${String(c)}" (dropped). Known: ${CAPS.join(', ')}`);
      });
    }
  }
  if (caps.length === 0) caps.push('chat');

  let credits: CreditCost | null = null;
  const rawCredits = v['credits'];
  if (rawCredits !== undefined && rawCredits !== null) {
    if (!isRecord(rawCredits)) {
      iss.error(`${path}.credits`, `expected an object, got ${typeof rawCredits}`);
    } else {
      checkUnknown(rawCredits, CREDIT_FIELDS, `${path}.credits.`, iss);
      credits = {
        perMTokIn: limitNum(rawCredits['perMTokIn'], `${path}.credits.perMTokIn`, iss),
        perMTokOut: limitNum(rawCredits['perMTokOut'], `${path}.credits.perMTokOut`, iss),
      };
    }
  }

  return {
    id,
    label: str(v['label'], `${path}.label`, iss, id) ?? id,
    alias: strArray(v['alias'], `${path}.alias`, iss),
    context: limitNum(v['context'], `${path}.context`, iss),
    caps,
    priority: num(v['priority'], `${path}.priority`, iss, 50),
    enabled: bool(v['enabled'], `${path}.enabled`, iss, true),
    maxOutput: limitNum(v['maxOutput'], `${path}.maxOutput`, iss),
    credits,
  };
}

export function parseProviderSpec(raw: unknown): SpecParse {
  const iss = new Issues();

  if (!isRecord(raw)) {
    iss.error('', `expected a JSON object, got ${Array.isArray(raw) ? 'array' : typeof raw}`);
    return { ok: false, errors: iss.errors, warnings: iss.warnings };
  }
  checkUnknown(raw, PROVIDER_FIELDS, '', iss);

  const id = str(raw['id'], 'id', iss);
  if (!id) {
    iss.error('id', 'required — a short lowercase slug, e.g. "groq"');
  } else if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    iss.error('id', `must be lowercase letters, digits and dashes, got "${id}"`);
  }

  const baseUrl = str(raw['baseUrl'], 'baseUrl', iss);
  if (!baseUrl) {
    iss.error('baseUrl', 'required — the OpenAI-compatible base, e.g. "https://api.groq.com/openai/v1"');
  }

  const adapter = str(raw['adapter'], 'adapter', iss, 'openai') ?? 'openai';
  if (adapter !== 'openai') {
    iss.error('adapter', `only "openai" is implemented, got "${adapter}"`);
  }

  const auth = parseAuth(raw['auth'], iss);
  const limits = parseLimits(raw['limits'], iss);

  const limitsSourceRaw = str(raw['limitsSource'], 'limitsSource', iss, 'unverified') ?? 'unverified';
  if (!(LIMITS_SOURCES as readonly string[]).includes(limitsSourceRaw)) {
    iss.error('limitsSource', `must be one of ${LIMITS_SOURCES.join(' | ')}, got "${limitsSourceRaw}"`);
  }

  const headers: Record<string, string> = {};
  const rawHeaders = raw['headers'];
  if (rawHeaders !== undefined && rawHeaders !== null) {
    if (!isRecord(rawHeaders)) {
      iss.error('headers', `expected an object of string values, got ${typeof rawHeaders}`);
    } else {
      for (const [k, val] of Object.entries(rawHeaders)) {
        if (typeof val !== 'string') iss.error(`headers.${k}`, `expected a string, got ${typeof val}`);
        else headers[k] = val;
      }
    }
  }

  const models: ModelSpec[] = [];
  const rawModels = raw['models'];
  if (rawModels !== undefined && rawModels !== null) {
    if (!Array.isArray(rawModels)) {
      iss.error('models', `expected an array, got ${typeof rawModels}`);
    } else {
      const seen = new Set<string>();
      rawModels.forEach((m, i) => {
        const parsed = parseModel(m, i, iss);
        if (!parsed) return;
        if (seen.has(parsed.id)) {
          iss.error(`models[${i}].id`, `duplicate model id "${parsed.id}"`);
          return;
        }
        seen.add(parsed.id);
        models.push(parsed);
      });
    }
  }

  if (iss.errors.length > 0) return { ok: false, errors: iss.errors, warnings: iss.warnings };

  const spec: ProviderSpec = {
    id: id as string,
    label: str(raw['label'], 'label', iss, id) ?? (id as string),
    docs: str(raw['docs'], 'docs', iss),
    console: str(raw['console'], 'console', iss),
    enabled: bool(raw['enabled'], 'enabled', iss, true),
    priority: num(raw['priority'], 'priority', iss, 50),
    adapter: 'openai',
    baseUrl: baseUrl as string,
    auth,
    limits,
    limitsSource: limitsSourceRaw as LimitsSource,
    verifiedOn: str(raw['verifiedOn'], 'verifiedOn', iss),
    modelsEndpoint: raw['modelsEndpoint'] === null ? null : (str(raw['modelsEndpoint'], 'modelsEndpoint', iss, '/models') ?? '/models'),
    modelsPath: str(raw['modelsPath'], 'modelsPath', iss, 'data[].id') ?? 'data[].id',
    dropParams: strArray(raw['dropParams'], 'dropParams', iss),
    headers,
    notes: str(raw['notes'], 'notes', iss),
    models,
  };

  return { ok: true, spec, warnings: iss.warnings };
}

export function formatIssues(issues: SpecIssue[]): string {
  return issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
}
