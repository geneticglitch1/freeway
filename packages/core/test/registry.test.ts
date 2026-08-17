import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { Registry } from '../src/registry.ts';
import { silentLogger } from '../src/util.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Write a throwaway providers/ directory. Values may be raw strings for bad JSON. */
function providerDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'freeway-reg-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}

const MINIMAL = {
  id: 'demo',
  baseUrl: 'https://api.demo.test/v1',
  auth: { type: 'bearer', envKeys: ['DEMO_KEY'] },
  models: [{ id: 'demo-small', alias: ['fast'], context: 8000, caps: ['chat'] }],
};

function make(dir: string, env: Record<string, string | undefined>): Registry {
  return new Registry({ dir, env, logger: silentLogger });
}

describe('Registry — loading', () => {
  it('loads a valid provider file', () => {
    const reg = make(providerDir({ 'demo.json': MINIMAL }), { DEMO_KEY: 'sk-abcdefghijklmnop' });
    const p = reg.get('demo');
    assert.ok(p);
    assert.equal(p.configured, true);
    assert.equal(p.configError, null);
    assert.equal(p.models.length, 1);
    assert.equal(p.models[0]?.ref, 'demo/demo-small');
  });

  it('skips files starting with an underscore', () => {
    // The JSON Schema lives in providers/ alongside the real files.
    const reg = make(
      providerDir({ 'demo.json': MINIMAL, '_schema.json': { $id: 'schema', type: 'object' } }),
      { DEMO_KEY: 'sk-abcdefghijklmnop' },
    );
    assert.deepEqual(reg.all().map((p) => p.id), ['demo']);
    assert.equal(reg.issues().length, 0, 'skipped file must not produce an issue');
  });

  it('skips a malformed JSON file without throwing, and keeps its neighbours', () => {
    const dir = providerDir({ 'demo.json': MINIMAL, 'broken.json': '{ "id": "broken", oops }' });
    let reg: Registry | undefined;
    assert.doesNotThrow(() => {
      reg = make(dir, { DEMO_KEY: 'sk-abcdefghijklmnop' });
    });
    assert.ok(reg);
    assert.deepEqual(reg.all().map((p) => p.id), ['demo'], 'valid provider still loads');

    const issue = reg.issues().find((i) => i.file === 'broken.json');
    assert.ok(issue);
    assert.equal(issue.level, 'error');
    assert.match(issue.message, /invalid JSON/);
  });

  it('reports the exact field path when a spec violates the schema', () => {
    const reg = make(
      providerDir({ 'bad.json': { id: 'bad', baseUrl: 'https://x.test', auth: { type: 'bearer', envKeys: ['K'] }, limits: { rpm: 'lots' } } }),
      { K: 'k' },
    );
    assert.equal(reg.get('bad'), undefined, 'invalid provider is not loaded');
    const issue = reg.issues()[0];
    assert.ok(issue);
    assert.match(issue.message, /limits\.rpm/);
  });

  it('warns about a misspelled field instead of silently ignoring it', () => {
    // `baseURL` vs `baseUrl` is the single worst failure mode of a JSON format.
    const reg = make(
      providerDir({ 'typo.json': { ...MINIMAL, id: 'typo', baseURL: 'https://oops.test' } }),
      { DEMO_KEY: 'k1234567890abc' },
    );
    const warning = reg.issues().find((i) => i.level === 'warning');
    assert.ok(warning);
    assert.match(warning.message, /baseURL/);
    assert.match(warning.message, /did you mean "baseUrl"/);
  });

  it('rejects two files claiming the same provider id', () => {
    const reg = make(
      providerDir({ 'a.json': MINIMAL, 'b.json': { ...MINIMAL, baseUrl: 'https://other.test/v1' } }),
      { DEMO_KEY: 'k1234567890abc' },
    );
    assert.equal(reg.all().length, 1);
    assert.ok(reg.issues().some((i) => /duplicate provider id/.test(i.message)));
  });

  it('survives a providers directory that does not exist', () => {
    assert.doesNotThrow(() => {
      const reg = new Registry({ dir: join(tmpdir(), 'freeway-does-not-exist-xyz'), env: {}, logger: silentLogger });
      assert.equal(reg.all().length, 0);
    });
  });
});

describe('Registry — environment interpolation', () => {
  it('resolves ${ENV_VAR} inside baseUrl', () => {
    // This is the Cloudflare case: the account id lives in the URL, and it must
    // stay pure data rather than becoming a special case in TypeScript.
    const reg = make(
      providerDir({
        'cf.json': {
          id: 'cf',
          baseUrl: 'https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/v1',
          auth: { type: 'bearer', envKeys: ['CF_TOKEN'] },
          models: [{ id: '@cf/meta/llama-3.1-8b-instruct' }],
        },
      }),
      { CF_ACCOUNT: 'acct123', CF_TOKEN: 'tok-abcdefghijkl' },
    );
    const p = reg.get('cf');
    assert.ok(p);
    assert.equal(p.baseUrl, 'https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1');
    assert.equal(p.configured, true);
  });

  it('resolves ${ENV_VAR} inside headers', () => {
    const reg = make(
      providerDir({ 'h.json': { ...MINIMAL, id: 'h', headers: { 'x-account': '${ACCT}', 'x-static': 'always' } } }),
      { DEMO_KEY: 'k1234567890abc', ACCT: 'a-42' },
    );
    const p = reg.get('h');
    assert.ok(p);
    assert.deepEqual(p.headers, { 'x-account': 'a-42', 'x-static': 'always' });
  });

  it('names the missing variable rather than failing silently', () => {
    const reg = make(
      providerDir({
        'cf.json': {
          id: 'cf',
          baseUrl: 'https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/v1',
          auth: { type: 'bearer', envKeys: ['CF_TOKEN'] },
          models: [{ id: 'm' }],
        },
      }),
      { CF_TOKEN: 'tok-abcdefghijkl' },
    );
    const p = reg.get('cf');
    assert.ok(p);
    assert.equal(p.configured, false);
    assert.equal(p.configError, 'missing environment variable: CF_ACCOUNT');
  });

  it('lists every missing variable at once', () => {
    const reg = make(
      providerDir({
        'multi.json': {
          id: 'multi',
          baseUrl: 'https://${REGION}.api.test/${VERSION}',
          auth: { type: 'bearer', envKeys: ['K'] },
          models: [{ id: 'm' }],
        },
      }),
      { K: 'k1234567890abc' },
    );
    assert.equal(reg.get('multi')?.configError, 'missing environment variables: REGION, VERSION');
  });
});

describe('Registry — key pools', () => {
  it('splits one comma-separated env var into a pool', () => {
    // This has to work from a plain `docker run -e`, so commas are the grammar.
    const reg = make(providerDir({ 'demo.json': MINIMAL }), {
      DEMO_KEY: 'sk-aaaaaaaaaaaa,sk-bbbbbbbbbbbb , sk-cccccccccccc',
    });
    const p = reg.get('demo');
    assert.ok(p);
    assert.equal(p.keys.length, 3);
    assert.deepEqual(p.keys.map((k) => k.value), ['sk-aaaaaaaaaaaa', 'sk-bbbbbbbbbbbb', 'sk-cccccccccccc']);
    assert.deepEqual(p.keys.map((k) => k.id), ['demo#0', 'demo#1', 'demo#2']);
  });

  it('pools keys across several env vars in declaration order', () => {
    const reg = make(
      providerDir({ 'demo.json': { ...MINIMAL, auth: { type: 'bearer', envKeys: ['DEMO_KEY', 'DEMO_KEY_2'] } } }),
      { DEMO_KEY: 'sk-first-000000', DEMO_KEY_2: 'sk-second-00000,sk-third-000000' },
    );
    const p = reg.get('demo');
    assert.ok(p);
    assert.equal(p.keys.length, 3);
    assert.deepEqual(p.keys.map((k) => k.source), ['DEMO_KEY', 'DEMO_KEY_2', 'DEMO_KEY_2']);
  });

  it('ignores blanks and duplicates', () => {
    const reg = make(providerDir({ 'demo.json': MINIMAL }), {
      DEMO_KEY: 'sk-aaaaaaaaaaaa,,  ,sk-aaaaaaaaaaaa,sk-bbbbbbbbbbbb',
    });
    assert.equal(reg.get('demo')?.keys.length, 2);
  });

  it('masks every key and never exposes the raw value in the mask', () => {
    const reg = make(providerDir({ 'demo.json': MINIMAL }), { DEMO_KEY: 'sk-supersecret-value-1234' });
    const key = reg.get('demo')?.keys[0];
    assert.ok(key);
    assert.equal(key.masked, 'sk-s…1234');
    assert.ok(!key.masked.includes('supersecret'));
  });

  it('says which env var to set when no key is found', () => {
    const reg = make(
      providerDir({ 'demo.json': { ...MINIMAL, auth: { type: 'bearer', envKeys: ['DEMO_KEY', 'DEMO_KEY_2'] } } }),
      {},
    );
    const p = reg.get('demo');
    assert.ok(p);
    assert.equal(p.configured, false);
    assert.equal(p.configError, 'no API key found (set one of: DEMO_KEY, DEMO_KEY_2)');
  });

  it('treats a keyless provider as configured', () => {
    const reg = make(
      providerDir({ 'local.json': { id: 'local', baseUrl: 'http://localhost:11434/v1', auth: { type: 'none' }, models: [{ id: 'llama3' }] } }),
      {},
    );
    const p = reg.get('local');
    assert.ok(p);
    assert.equal(p.configured, true);
    assert.equal(p.keys.length, 0);
  });

  it('accepts runtime keys but lets env vars win', () => {
    const dir = providerDir({ 'demo.json': MINIMAL });
    const reg = new Registry({
      dir,
      env: { DEMO_KEY: 'sk-from-env-0000' },
      logger: silentLogger,
      extraKeys: { demo: 'sk-from-paste-00' },
    });
    const keys = reg.get('demo')?.keys ?? [];
    assert.equal(keys.length, 2);
    assert.equal(keys[0]?.source, 'DEMO_KEY', 'env key is tried first');
    assert.equal(keys[1]?.source, 'runtime');
  });
});

describe('Registry — selection surface', () => {
  const CATALOG = {
    'ready.json': {
      id: 'ready',
      priority: 10,
      baseUrl: 'https://ready.test/v1',
      auth: { type: 'bearer', envKeys: ['READY_KEY'] },
      models: [
        { id: 'ready-fast', alias: ['fast'], caps: ['chat'] },
        { id: 'ready-off', alias: ['fast'], caps: ['chat'], enabled: false },
      ],
    },
    'nokey.json': {
      id: 'nokey',
      priority: 20,
      baseUrl: 'https://nokey.test/v1',
      auth: { type: 'bearer', envKeys: ['NOKEY_KEY'] },
      models: [{ id: 'nokey-model', alias: ['fast'] }],
    },
  };

  it('usable() excludes providers with no key', () => {
    const reg = make(providerDir(CATALOG), { READY_KEY: 'k1234567890abc' });
    assert.deepEqual(reg.usable().map((p) => p.id), ['ready']);
    assert.equal(reg.all().length, 2, 'unconfigured provider still appears for the dashboard');
  });

  it('usable() excludes a disabled provider, and the toggle survives reload', () => {
    const reg = make(providerDir(CATALOG), { READY_KEY: 'k1234567890abc' });
    assert.equal(reg.setEnabled('ready', false), true);
    assert.deepEqual(reg.usable().map((p) => p.id), []);

    reg.reload();
    assert.equal(reg.get('ready')?.enabled, false, 'a dashboard toggle is not undone by re-reading disk');
  });

  it('collects aliases from enabled models only', () => {
    const reg = make(providerDir(CATALOG), { READY_KEY: 'k1234567890abc', NOKEY_KEY: 'k1234567890abc' });
    const fast = reg.aliases().get('fast');
    assert.ok(fast);
    assert.deepEqual(fast.map((m) => m.ref), ['ready/ready-fast', 'nokey/nokey-model']);
  });

  it('orders providers by priority', () => {
    const reg = make(providerDir(CATALOG), { READY_KEY: 'k1234567890abc', NOKEY_KEY: 'k1234567890abc' });
    assert.deepEqual(reg.all().map((p) => p.id), ['ready', 'nokey']);
  });
});

describe('Registry — shipped provider files', () => {
  const dir = join(import.meta.dirname, '..', '..', '..', 'providers');

  it('loads the real catalog with no errors', () => {
    const reg = new Registry({ dir, env: {}, logger: silentLogger });
    const errors = reg.issues().filter((i) => i.level === 'error');
    assert.deepEqual(errors, [], 'every shipped provider file must parse');
    assert.ok(reg.all().length >= 2);
  });

  it('renders unconfigured providers as advice, not as a crash', () => {
    const reg = new Registry({ dir, env: {}, logger: silentLogger });
    const mistral = reg.get('mistral');
    assert.ok(mistral);
    assert.equal(mistral.configured, false);
    assert.equal(mistral.configError, 'no API key found (set one of: MISTRAL_API_KEY, MISTRAL_API_KEY_2)');

    const cf = reg.get('cloudflare');
    assert.ok(cf);
    assert.equal(cf.configError, 'missing environment variable: CLOUDFLARE_ACCOUNT_ID');
  });

  it('lights cloudflare up once both variables are present', () => {
    const reg = new Registry({
      dir,
      env: { CLOUDFLARE_ACCOUNT_ID: 'acct-1', CLOUDFLARE_API_TOKEN: 'cf-token-abcdefgh' },
      logger: silentLogger,
    });
    const cf = reg.get('cloudflare');
    assert.ok(cf);
    assert.equal(cf.configured, true);
    assert.equal(cf.baseUrl, 'https://api.cloudflare.com/client/v4/accounts/acct-1/ai/v1');
    assert.ok(cf.models.some((m) => m.spec.id.includes('/')), 'cloudflare model ids contain slashes');
  });
});
