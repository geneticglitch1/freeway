#!/usr/bin/env node
/**
 * Scaffold a new provider file.
 *
 *   node scripts/new-provider.mjs groq --url https://api.groq.com/openai/v1 --env GROQ_API_KEY
 *
 * Writes providers/<id>.json with every field present and commented via the
 * `notes` field, then tells you to run the verifier. Nothing here touches
 * TypeScript, which is the whole point.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));

if (!id || args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node scripts/new-provider.mjs <id> [options]

  <id>                short lowercase slug, e.g. "groq"
  --url <baseUrl>     OpenAI-compatible base URL
  --env <VAR>         env var holding the key (default: <ID>_API_KEY)
  --auth <type>       bearer | header | query | none   (default: bearer)
  --header <name>     header name when --auth header
  --label <name>      display name
  --force             overwrite an existing file

Then:
  node scripts/verify-provider.mjs ${id ?? '<id>'}      # check it against the live API
`);
  process.exit(id ? 0 : 1);
}

if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  console.error(`error: id must be lowercase letters, digits and dashes — got "${id}"`);
  process.exit(1);
}

const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const envVar = flag('env', `${id.toUpperCase().replace(/-/g, '_')}_API_KEY`);
const authType = flag('auth', 'bearer');
const outPath = join('providers', `${id}.json`);

if (existsSync(outPath) && !args.includes('--force')) {
  console.error(`error: ${outPath} already exists (use --force to overwrite)`);
  process.exit(1);
}

const spec = {
  $schema: './_schema.json',
  id,
  label: flag('label', id.replace(/(^|-)(\w)/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase())),
  docs: null,
  console: null,
  enabled: true,
  priority: 50,
  adapter: 'openai',
  baseUrl: flag('url', 'https://api.example.com/v1'),
  auth: {
    type: authType,
    ...(authType === 'header' ? { header: flag('header', 'x-api-key') } : {}),
    ...(authType === 'query' ? { query: flag('query', 'key') } : {}),
    envKeys: authType === 'none' ? [] : [envVar],
  },
  // Leave these null until verified. A null is honest and the guard layer fills
  // it in from real response headers; a guessed number silently misroutes.
  limits: { rps: null, rpm: null, rpd: null, tpm: null, tpd: null, tpmo: null },
  limitsSource: 'unverified',
  verifiedOn: new Date().toISOString().slice(0, 10),
  modelsEndpoint: '/models',
  modelsPath: 'data[].id',
  dropParams: [],
  headers: {},
  notes: `TODO: signup friction, quirks, and why any number above is what it is. Run scripts/verify-provider.mjs ${id} to discover models and observe real limits.`,
  models: [],
};

writeFileSync(outPath, `${JSON.stringify(spec, null, 2)}\n`);

console.log(`created ${outPath}`);
console.log(`
next:
  1. export ${envVar}=<your key>
  2. node scripts/verify-provider.mjs ${id}
  3. paste the models the verifier found into "models", then re-run it
`);
