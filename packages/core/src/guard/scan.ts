/**
 * Heuristic scanning of request bodies for secrets, PII and prompt injection.
 *
 * Regex only, no ML — this is a tripwire, not a guarantee, and it says so. The
 * useful case is catching yourself: an app that accidentally interpolates an
 * API key or a customer's card number into a prompt and ships it to a free-tier
 * provider you have no contract with.
 *
 * Findings never store the matched value. A scanner that logs the secret it
 * found has done more damage than the thing it was watching for.
 */

export type ScanCategory = 'secret' | 'pii' | 'injection';
export type ScanMode = 'off' | 'flag' | 'block';

export interface Finding {
  category: ScanCategory;
  rule: string;
  /** Where in the body it was seen, e.g. `messages[2].content`. */
  path: string;
  /** Always redacted. The raw match is deliberately not retained. */
  sample: string;
  severity: 'low' | 'medium' | 'high';
}

export interface ScanResult {
  findings: Finding[];
  blocked: boolean;
}

interface Rule {
  category: ScanCategory;
  name: string;
  pattern: RegExp;
  severity: Finding['severity'];
  /** Extra check for patterns with a real validator, e.g. card numbers. */
  validate?: (match: string) => boolean;
}

const SECRET_RULES: Rule[] = [
  { category: 'secret', name: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, severity: 'high' },
  { category: 'secret', name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, severity: 'high' },
  { category: 'secret', name: 'groq-key', pattern: /\bgsk_[A-Za-z0-9]{20,}\b/g, severity: 'high' },
  { category: 'secret', name: 'google-key', pattern: /\bAIza[A-Za-z0-9_-]{30,}\b/g, severity: 'high' },
  { category: 'secret', name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, severity: 'high' },
  { category: 'secret', name: 'huggingface-token', pattern: /\bhf_[A-Za-z0-9]{30,}\b/g, severity: 'high' },
  { category: 'secret', name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, severity: 'high' },
  { category: 'secret', name: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, severity: 'high' },
  { category: 'secret', name: 'private-key-block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, severity: 'high' },
  { category: 'secret', name: 'bearer-header', pattern: /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}/gi, severity: 'medium' },
  { category: 'secret', name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, severity: 'medium' },
];

const PII_RULES: Rule[] = [
  { category: 'pii', name: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, severity: 'low' },
  {
    category: 'pii',
    name: 'credit-card',
    pattern: /\b(?:\d[ -]*?){13,19}\b/g,
    severity: 'high',
    // Without Luhn this fires on every order number and timestamp.
    validate: luhn,
  },
  { category: 'pii', name: 'us-ssn', pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g, severity: 'high' },
  { category: 'pii', name: 'iban', pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, severity: 'medium' },
];

const INJECTION_RULES: Rule[] = [
  { category: 'injection', name: 'ignore-instructions', pattern: /\bignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)\b/gi, severity: 'medium' },
  { category: 'injection', name: 'disregard-instructions', pattern: /\bdisregard\s+(?:all\s+)?(?:previous|prior|above)\s+\w+/gi, severity: 'medium' },
  { category: 'injection', name: 'reveal-system-prompt', pattern: /\b(?:reveal|print|repeat|show|output)\s+(?:your\s+|the\s+)?(?:system\s+prompt|initial\s+instructions|rules)\b/gi, severity: 'medium' },
  { category: 'injection', name: 'role-marker', pattern: /(?:^|\n)\s*(?:<\|im_start\|>|<\|system\|>|\[INST\]|###\s*system\s*:)/gi, severity: 'medium' },
  { category: 'injection', name: 'developer-mode', pattern: /\b(?:developer|DAN|jailbreak|god)\s+mode\b/gi, severity: 'low' },
];

export interface ScanOptions {
  secrets?: boolean;
  pii?: boolean;
  injection?: boolean;
  mode?: ScanMode;
  maxFindings?: number;
}

/** Keep enough to recognise a finding, never enough to use it. */
function redact(match: string): string {
  if (match.length <= 8) return `${match.slice(0, 2)}…`;
  return `${match.slice(0, 4)}…${match.slice(-2)} (${match.length} chars)`;
}

function luhn(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function rulesFor(options: ScanOptions): Rule[] {
  const rules: Rule[] = [];
  if (options.secrets !== false) rules.push(...SECRET_RULES);
  if (options.pii !== false) rules.push(...PII_RULES);
  if (options.injection !== false) rules.push(...INJECTION_RULES);
  return rules;
}

export function scanText(text: string, path: string, options: ScanOptions = {}): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const rule of rulesFor(options)) {
    // Regexes are module-level and `g`-flagged, so lastIndex must be reset or
    // consecutive scans skip matches unpredictably.
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const value = match[0];
      if (rule.validate && !rule.validate(value)) continue;
      const dedupe = `${rule.name}:${path}:${value}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      findings.push({ category: rule.category, rule: rule.name, path, sample: redact(value), severity: rule.severity });
    }
  }
  return findings;
}

/** Walk a chat/embeddings body and scan every string a user could have put there. */
export function scanBody(body: unknown, options: ScanOptions = {}): ScanResult {
  const mode = options.mode ?? 'flag';
  if (mode === 'off') return { findings: [], blocked: false };

  const max = options.maxFindings ?? 25;
  const findings: Finding[] = [];

  const walk = (value: unknown, path: string): void => {
    if (findings.length >= max) return;
    if (typeof value === 'string') {
      findings.push(...scanText(value, path, options));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
    }
  };

  walk(body, '');

  const trimmed = findings.slice(0, max);
  // Only a high-severity finding is worth failing a request over; blocking on a
  // stray email address would make `block` mode unusable.
  const blocked = mode === 'block' && trimmed.some((f) => f.severity === 'high');
  return { findings: trimmed, blocked };
}

/**
 * Last line of defence: a provider key must never reach a client.
 *
 * Compares against real key values, so it lives behind the same boundary as the
 * registry and its result contains only masks.
 */
export function containsAnyKey(text: string, keys: { value: string; masked: string }[]): string[] {
  const hits: string[] = [];
  for (const key of keys) {
    if (key.value.length >= 8 && text.includes(key.value)) hits.push(key.masked);
  }
  return hits;
}
