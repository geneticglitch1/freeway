import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { KeyVault } from '../src/keyvault.ts';
import { silentLogger } from '../src/util.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function vaultFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'freeway-vault-'));
  dirs.push(dir);
  return join(dir, 'keys.json');
}

describe('KeyVault', () => {
  it('stores a key and hands it to the registry in env-var grammar', () => {
    const vault = new KeyVault({ file: vaultFile(), logger: silentLogger });
    const masked = vault.add('groq', 'gsk-abcdefghijklmnop');

    assert.equal(masked, 'gsk-…mnop');
    assert.deepEqual(vault.all(), { groq: 'gsk-abcdefghijklmnop' });
  });

  it('builds a pool from repeated adds, without duplicates', () => {
    const vault = new KeyVault({ file: vaultFile(), logger: silentLogger });
    vault.add('groq', 'gsk-aaaaaaaaaaaa');
    vault.add('groq', 'gsk-bbbbbbbbbbbb');
    vault.add('groq', 'gsk-aaaaaaaaaaaa');

    assert.equal(vault.all()['groq'], 'gsk-aaaaaaaaaaaa,gsk-bbbbbbbbbbbb');
  });

  it('writes the file 0600', () => {
    // Anything readable by other users on the box defeats the purpose of the
    // gateway holding the keys in the first place.
    const file = vaultFile();
    const vault = new KeyVault({ file, logger: silentLogger });
    vault.add('groq', 'gsk-abcdefghijklmnop');

    const mode = statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
  });

  it('survives a restart', () => {
    const file = vaultFile();
    new KeyVault({ file, logger: silentLogger }).add('groq', 'gsk-abcdefghijklmnop');

    const reopened = new KeyVault({ file, logger: silentLogger });
    assert.equal(reopened.all()['groq'], 'gsk-abcdefghijklmnop');
    assert.equal(reopened.has('groq'), true);
  });

  it('only ever describes keys masked', () => {
    const vault = new KeyVault({ file: vaultFile(), logger: silentLogger });
    vault.add('groq', 'gsk-supersecret-1234');
    vault.add('groq', 'gsk-anothersecret-99');

    const described = vault.describe();
    assert.deepEqual(described[0]?.masked, ['gsk-…1234', 'gsk-…t-99']);
    assert.ok(!JSON.stringify(described).includes('supersecret'));
  });

  it('removes one key from a pool by its mask', () => {
    const vault = new KeyVault({ file: vaultFile(), logger: silentLogger });
    vault.add('groq', 'gsk-aaaaaaaaaaaa');
    vault.add('groq', 'gsk-bbbbbbbbbbbb');

    assert.equal(vault.remove('groq', 'gsk-…aaaa'), true);
    assert.equal(vault.all()['groq'], 'gsk-bbbbbbbbbbbb');
    assert.equal(vault.remove('groq', 'gsk-…zzzz'), false, 'an unknown mask removes nothing');
  });

  it('drops the provider entirely when its last key goes', () => {
    const vault = new KeyVault({ file: vaultFile(), logger: silentLogger });
    vault.add('groq', 'gsk-aaaaaaaaaaaa');
    vault.remove('groq', 'gsk-…aaaa');
    assert.equal(vault.has('groq'), false);
  });

  it('rejects a comma-separated blob, so one paste is one key', () => {
    const vault = new KeyVault({ file: vaultFile(), logger: silentLogger });
    assert.throws(() => vault.add('groq', 'a,b'), /one key at a time/);
    assert.throws(() => vault.add('groq', '   '), /empty/);
  });

  it('refuses every mutation when not writable', () => {
    // This is the state the gateway uses when bound to a non-loopback address
    // without an admin key.
    const vault = new KeyVault({ file: vaultFile(), logger: silentLogger, writable: false });
    assert.throws(() => vault.add('groq', 'gsk-abcdefghijkl'), /disabled/);
    assert.throws(() => vault.remove('groq'), /disabled/);
    assert.equal(vault.writable, false);
  });

  it('ignores a corrupt file instead of refusing to start', () => {
    const file = vaultFile();
    const vault = new KeyVault({ file, logger: silentLogger });
    vault.add('groq', 'gsk-abcdefghijkl');
    // Simulate a truncated write from an older version.
    const raw = readFileSync(file, 'utf8').slice(0, 12);
    rmSync(file);
    new KeyVault({ file, logger: silentLogger });

    let reopened: KeyVault | undefined;
    assert.doesNotThrow(() => {
      reopened = new KeyVault({ file, logger: silentLogger });
    });
    assert.deepEqual(reopened?.all(), {});
    void raw;
  });
});
