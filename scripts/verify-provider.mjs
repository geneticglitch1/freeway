#!/usr/bin/env node
/**
 * Check a provider file against the live API and print a verdict.
 *
 *   node scripts/verify-provider.mjs groq
 *   node scripts/verify-provider.mjs groq --validate     # also send 1-token probes
 *
 * This is the feedback loop. A person — or an agent — adding a provider they
 * have never seen before should be able to run this, read the output, edit the
 * JSON, and run it again until it says PASS, without reading any TypeScript.
 *
 * Exit codes: 0 pass, 1 fail, 2 usage error.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { Registry } from '../packages/core/src/registry.ts';
import { probeKey, limitDrift } from '../packages/core/src/probe.ts';

// The gateway reads .env at startup; this tool has to as well, or it reports
// "no API key found" for a provider that is actually configured.
loadDotEnv('.env');
function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = t.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
const validate = args.includes('--validate');
const json = args.includes('--json');
const apply = args.includes('--apply');

if (!id) {
  console.error(`
Usage: node scripts/verify-provider.mjs <id> [--validate] [--json]

  --validate   send a 1-token request per model to see which the key can reach.
               Costs real quota. Without it, only discovery and auth are checked.
  --apply      write the result back into providers/<id>.json. With --validate
               it keeps ONLY the models your key can actually reach, which is
               how you find out what a free tier really gives you.
  --json       machine-readable output.
`);
  process.exit(2);
}

const C = process.stdout.isTTY && !json
  ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[34m', d: '\x1b[2m', B: '\x1b[1m', x: '\x1b[0m' }
  : { r: '', g: '', y: '', b: '', d: '', B: '', x: '' };

const log = (...a) => { if (!json) console.log(...a); };
const pass = (m) => log(`  ${C.g}✓${C.x} ${m}`);
const warn = (m) => log(`  ${C.y}!${C.x} ${m}`);
const fail = (m) => log(`  ${C.r}✗${C.x} ${m}`);

const problems = [];
const warnings = [];

// ---- 1. does the file parse against the schema? ---------------------------

const silent = { info() {}, warn() {}, error() {} };
const registry = new Registry({ dir: 'providers', env: process.env, logger: silent });

log(`\n${C.B}Verifying provider "${id}"${C.x}\n`);
log(`${C.B}1. file${C.x}`);

const fileIssues = registry.issues().filter((i) => i.providerId === id || i.file === `${id}.json`);
for (const issue of fileIssues) {
  if (issue.level === 'error') { fail(issue.message); problems.push(issue.message); }
  else { warn(issue.message); warnings.push(issue.message); }
}

const provider = registry.get(id);
if (!provider) {
  fail(`providers/${id}.json did not load — fix the errors above`);
  if (fileIssues.length === 0) fail(`no such file: providers/${id}.json`);
  finish();
}
pass(`providers/${id}.json parses`);
pass(`${provider.models.length} model${provider.models.length === 1 ? '' : 's'} declared, adapter=${provider.spec.adapter}`);

// ---- 2. environment --------------------------------------------------------

log(`\n${C.B}2. environment${C.x}`);
if (!provider.configured) {
  fail(provider.configError);
  problems.push(provider.configError);
  finish();
}
pass(`baseUrl resolves to ${provider.baseUrl}`);
pass(
  provider.spec.auth.type === 'none'
    ? 'no credential required (auth.type: none)'
    : `${provider.keys.length} key${provider.keys.length === 1 ? '' : 's'} in the pool: ${provider.keys.map((k) => `${k.masked} (${k.source})`).join(', ')}`,
);

// ---- 3. live probe ---------------------------------------------------------

log(`\n${C.B}3. live probe${C.x}${validate ? '' : `  ${C.d}(add --validate to test each model)${C.x}`}`);

const key = provider.keys[0] ?? { id: `${id}#none`, providerId: id, index: 0, value: '', masked: '—', source: 'none' };
const result = await probeKey(provider, key, { validateModels: validate, maxModels: 80, concurrency: 2 });

const authOk = result.auth === 'ok';
if (authOk) pass(`auth accepted (${result.ms}ms)`);
else {
  const msg = `auth ${result.auth}${result.errors.length ? ` — ${result.errors[0]}` : ''}`;
  fail(msg);
  problems.push(msg);
}

if (provider.spec.modelsEndpoint === null) {
  warn('discovery disabled (modelsEndpoint: null) — the declared model list is all there is');
} else if (result.discovered.length > 0) {
  pass(`discovery found ${result.discovered.length} models via ${provider.spec.modelsEndpoint} → ${provider.spec.modelsPath}`);
  const declared = provider.models.map((m) => m.spec.id);
  const missing = result.discovered.filter((m) => !declared.includes(m));
  const stale = declared.filter((m) => !result.discovered.includes(m));

  if (stale.length > 0) {
    warn(`declared but NOT offered by the API: ${stale.join(', ')}`);
    warnings.push(`stale model ids: ${stale.join(', ')}`);
  }
  if (missing.length > 0) {
    log(`  ${C.d}${missing.length} available ids are not in the file (see the suggestion below)${C.x}`);
  }
} else if (result.errors.length > 0) {
  fail(result.errors.join('; '));
  problems.push(result.errors[0]);
}

if (validate && result.models.length > 0) {
  const ok = result.models.filter((m) => m.status === 'ok');
  const bad = result.models.filter((m) => m.status !== 'ok' && m.status !== 'undiscovered');
  pass(`${ok.length}/${result.models.length} models answered`);
  for (const m of bad) {
    warn(`${m.id} → ${m.status}${m.error ? ` (${m.error.slice(0, 80)})` : ''}`);
    warnings.push(`${m.id}: ${m.status}`);
  }
}

// ---- 4. observed limits ----------------------------------------------------

log(`\n${C.B}4. limits${C.x}`);
const observed = result.observedLimits;
const observedKeys = Object.keys(observed);

if (observedKeys.length === 0) {
  warn('the provider sent no rate-limit headers — declared limits cannot be checked against reality');
} else {
  pass(`observed from response headers: ${observedKeys.map((k) => `${k}=${observed[k]}`).join(', ')}`);
  const drift = limitDrift(provider.spec.limits, observed);
  for (const d of drift) {
    if (d.declared === null) {
      log(`  ${C.b}+${C.x} ${d.key}: file says null, provider reports ${d.observed} — consider recording it`);
    } else {
      warn(`${d.key}: file says ${d.declared}, provider reports ${d.observed}`);
      warnings.push(`${d.key} drift: ${d.declared} → ${d.observed}`);
    }
  }
}

if (provider.spec.limitsSource === 'unverified' && observedKeys.length > 0) {
  log(`  ${C.d}limitsSource is "unverified"; the observed values above could make it "observed"${C.x}`);
}

// ---- 5. suggestion ---------------------------------------------------------

const suggestion = buildSuggestion();
if (suggestion && !apply) {
  log(`\n${C.B}5. suggested edits${C.x}${C.d}  (re-run with --apply to write these)${C.x}`);
  log(`${C.d}${JSON.stringify(suggestion, null, 2).split('\n').map((l) => `  ${l}`).join('\n')}${C.x}`);
}

if (apply) applyToFile();

finish();

/**
 * Write what the live API reported back into the provider file.
 *
 * With --validate this is the answer to "which of these 55 models does my free
 * key actually get?": every id is probed and only the ones that answered are
 * kept. Existing aliases, caps and context windows are preserved — those encode
 * judgement the API cannot tell us.
 */
function applyToFile() {
  const path = `providers/${id}.json`;
  const file = JSON.parse(readFileSync(path, 'utf8'));
  const before = file.models.length;

  const existing = new Map(file.models.map((m) => [m.id, m]));
  const reachable = validate
    ? new Set(result.models.filter((m) => m.status === 'ok').map((m) => m.id))
    : new Set([...existing.keys(), ...result.discovered]);

  // Keep a declared model the probe could not reach only when we never asked;
  // a validated miss is real evidence it does not work on this tier.
  const kept = [];
  const dropped = [];
  for (const [mid, model] of existing) {
    if (reachable.has(mid)) kept.push(model);
    else if (validate) dropped.push(mid);
    else kept.push(model);
  }

  const added = [];
  const skipped = [];
  if (validate) {
    for (const m of result.models) {
      if (existing.has(m.id)) continue;

      // Only a 200 to an actual chat completion proves a chat capability. A 400
      // ('exists') means the id is real but rejected a chat body — that is what
      // an OCR or text-to-speech model does, and tagging it "chat" would let
      // `auto` route a conversation into a transcription endpoint.
      if (m.status !== 'ok') {
        if (m.status === 'exists') skipped.push(m.id);
        continue;
      }
      const caps = capsFor(m.id);
      if (caps === null) { skipped.push(m.id); continue; }

      kept.push({ id: m.id, label: m.id, alias: [], caps, context: null, priority: 50 });
      added.push(m.id);
    }
  }

  file.models = kept;
  if (Object.keys(observed).length > 0) {
    file.limits = { ...file.limits, ...observed };
    file.limitsSource = 'observed';
  }
  file.verifiedOn = new Date().toISOString().slice(0, 10);

  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);

  log(`\n${C.B}5. applied to ${path}${C.x}`);
  log(`  ${C.g}✓${C.x} ${before} models -> ${kept.length}`);
  if (added.length > 0) log(`  ${C.b}+${C.x} added ${added.length}: ${added.slice(0, 8).join(', ')}${added.length > 8 ? '…' : ''}`);
  if (dropped.length > 0) log(`  ${C.y}-${C.x} removed ${dropped.length} your key cannot reach: ${dropped.join(', ')}`);
  if (skipped.length > 0) log(`  ${C.d}skipped ${skipped.length} non-chat ids (ocr/audio/moderation/unproven): ${skipped.slice(0, 6).join(', ')}${skipped.length > 6 ? '…' : ''}${C.x}`);
  if (!validate) log(`  ${C.d}run with --validate too, to keep only what your key can actually reach${C.x}`);
  log(`  ${C.d}review aliases/caps/context by hand — the API cannot report those${C.x}`);
}

// ---------------------------------------------------------------------------

function buildSuggestion() {
  const out = {};
  const declared = provider.models.map((m) => m.spec.id);
  const missing = result.discovered.filter((m) => !declared.includes(m));

  if (missing.length > 0) {
    out.models = missing.slice(0, 12).map((mid) => ({
      id: mid,
      // Capability guesses from the id are a starting point, not an answer.
      caps: /embed/i.test(mid) ? ['embed'] : ['chat'],
      context: null,
      alias: [],
    }));
  }
  if (Object.keys(observed).length > 0) {
    out.limits = { ...provider.spec.limits, ...observed };
    out.limitsSource = 'observed';
    out.verifiedOn = new Date().toISOString().slice(0, 10);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Guess capabilities from an id. Returns null for model families that are not
 * chat or embeddings at all, so they are left out of the file entirely rather
 * than mislabelled.
 */
function capsFor(modelId) {
  const m = modelId.toLowerCase();
  if (/(^|[-/])(embed|embedding)/.test(m)) return ['embed'];
  // Audio, vision-to-text, and safety endpoints share the chat URL but do not
  // take a chat body.
  if (/ocr|tts|transcribe|voxtral|whisper|moderation|rerank|guard|shield/.test(m)) return null;

  const caps = ['chat'];
  if (/code|codestral|devstral|fim/.test(m)) caps.push('code');
  if (/magistral|reason|think|-r1|qwq/.test(m)) caps.push('reasoning');
  return caps;
}

function finish() {
  const verdict = problems.length === 0 ? 'PASS' : 'FAIL';

  if (json) {
    console.log(JSON.stringify({ id, verdict, problems, warnings, probe: typeof result === 'undefined' ? null : result }, null, 2));
  } else {
    const colour = problems.length === 0 ? C.g : C.r;
    log(`\n${colour}${C.B}${verdict}${C.x} — ${problems.length} problem${problems.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}\n`);
  }
  process.exit(problems.length === 0 ? 0 : 1);
}
