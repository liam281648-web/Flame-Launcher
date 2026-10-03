/**
 * Config durability tests for src/main/store.ts.
 *
 * Runs the real load/flush logic under Node via a stubbed `electron` module.
 * Usage: node scripts/test-store.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { existsSync } from 'node:fs';

const CONFIG = 'flame.config.json';

let passed = 0;
function ok(name, extra = '') {
  passed++;
  console.log(`  PASS  ${name}${extra ? ` — ${extra}` : ''}`);
}
function fail(name, extra = '') {
  console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`);
  process.exitCode = 1;
}
function check(name, fn) {
  try {
    fn();
    ok(name);
  } catch (err) {
    fail(name, err.message.split('\n')[0]);
  }
}

/** Each case needs a fresh module instance because `store` caches on first read. */
async function loadStore() {
  const bust = `?v=${Math.random()}`;
  const mod = await import(`../dist/main/store-probe.mjs${bust}`);
  return mod;
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const dir = process.env.FLAME_PROBE_DIR ?? path.join(root, 'dist/test-sandbox');
if (!existsSync(dir)) {
  console.error(`Probe sandbox missing at ${dir}. Run \`npm run test:store\`.`);
  process.exit(1);
}
const cfgPath = path.join(dir, CONFIG);

function write(contents, encoding = 'utf8') {
  fs.writeFileSync(cfgPath, contents, encoding);
}
function readRaw() {
  return fs.readFileSync(cfgPath, 'utf8');
}
function corruptBackups() {
  return fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
}
function reset() {
  for (const f of fs.readdirSync(dir)) {
    if (f !== 'electron-stub.js' && f !== '.keep') {
      fs.rmSync(path.join(dir, f), { force: true });
    }
  }
}

console.log('\n[1] Clean round-trip');
{
  reset();
  const { store } = await loadStore();
  store.setSettings({ minMemMb: 2048, gameDir: 'D:/mc' });
  store.flush();

  const raw = readRaw();
  check('config written as valid JSON', () => JSON.parse(raw));
  check('settings persisted', () => {
    const p = JSON.parse(raw);
    assert.equal(p.settings.minMemMb, 2048);
    assert.equal(p.settings.gameDir, 'D:/mc');
  });
  check('defaults fill in unset fields', () => {
    const p = JSON.parse(raw);
    assert.equal(p.settings.maxMemMb, 4096, 'maxMemMb should default to 4096');
    assert.equal(typeof p.settings.closeOnLaunch, 'boolean');
  });
  check('no stray .tmp left behind', () => {
    assert.ok(!fs.existsSync(`${cfgPath}.tmp`), 'tmp file should be renamed away');
  });
  check('no corrupt backups for a clean write', () => assert.equal(corruptBackups().length, 0));
}

console.log('\n[2] UTF-8 BOM does not wipe settings');
{
  reset();
  const { store } = await loadStore();
  store.setSettings({ minMemMb: 3072, gameDir: 'C:/games/mc' });
  store.flush();

  // Re-introduce the BOM the way a Windows text editor would.
  const good = readRaw();
  write(`﻿${good}`);

  const reloaded = await loadStore();
  const settings = reloaded.store.getSettings();
  check('settings survive a BOM', () => {
    assert.equal(settings.minMemMb, 3072, `got ${settings.minMemMb}`);
    assert.equal(settings.gameDir, 'C:/games/mc');
  });
  reloaded.store.setSettings({ maxMemMb: 8192 });
  reloaded.store.flush();
  check('BOM is stripped on the next write', () => {
    assert.ok(!readRaw().startsWith('﻿'), 'BOM should be gone');
    assert.equal(JSON.parse(readRaw()).settings.minMemMb, 3072, 'recovered value should persist');
  });
  check('BOM was not treated as corruption', () => assert.equal(corruptBackups().length, 0));
}

console.log('\n[3] Accounts survive a syntax error');
{
  reset();
  const { store } = await loadStore();
  store.upsertAccount(
    { id: 'abc', type: 'offline', username: 'Steve', uuid: 'u-1', createdAt: 1, lastUsedAt: 2 },
    { refreshToken: 'rt-secret', accessToken: 'at-secret' },
  );
  store.flush();
  const good = readRaw();
  assert.ok(good.includes('Steve'), 'precondition: account was written');

  // Realistic crash-during-write: the final `}` never made it to disk.
  write(good.trimEnd().replace(/\}$/, ''));

  const reloaded = await loadStore();
  const accounts = reloaded.store.getAccounts();
  check('damaged file still yields the account', () => {
    assert.ok(accounts.length >= 1, `expected >=1 account, got ${accounts.length}`);
    assert.equal(accounts[0].username, 'Steve');
  });
  check('account secrets are still recoverable', () => {
    assert.equal(reloaded.store.getSecrets('abc')?.refreshToken, 'rt-secret');
  });
  check('settings are not reset to defaults', () => {
    assert.equal(reloaded.store.getSettings().maxMemMb, 4096);
  });
  check('damaged file was backed up', () => assert.ok(corruptBackups().length >= 1, corruptBackups().join(',')));
  check('backup contains the original bytes', () => {
    const bak = path.join(dir, corruptBackups()[0]);
    assert.ok(fs.readFileSync(bak, 'utf8').includes('Steve'), 'backup should hold the old data');
  });
  check('app recovers and rewrites a valid config', () => {
    reloaded.store.flush();
    JSON.parse(readRaw()); // must not throw
  });
}

console.log('\n[3b] Truncation at several offsets degrades gracefully');
{
  const offsets = [0.25, 0.5, 0.75, 0.9];
  for (const frac of offsets) {
    reset();
    const { store } = await loadStore();
    store.upsertAccount(
      { id: 't', type: 'offline', username: 'Trunc', uuid: 'u-5', createdAt: 1, lastUsedAt: 2 },
    );
    store.setSettings({ minMemMb: 8192 });
    store.flush();
    write(readRaw().slice(0, Math.floor(readRaw().length * frac)));

    const reloaded = await loadStore();
    check(`${Math.round(frac * 100)}% cut: loads without throwing`, () => {
      assert.ok(Array.isArray(reloaded.store.getAccounts()));
      assert.equal(typeof reloaded.store.getSettings().minMemMb, 'number');
    });
    check(`${Math.round(frac * 100)}% cut: original was preserved`, () => assert.ok(corruptBackups().length >= 1));
    check(`${Math.round(frac * 100)}% cut: rewrites valid JSON`, () => {
      reloaded.store.flush();
      JSON.parse(readRaw());
    });
  }
}

console.log('\n[3c] Complete elements of a truncated array are salvaged');
{
  reset();
  const { store } = await loadStore();
  for (const name of ['One', 'Two']) {
    store.upsertAccount({
      id: name,
      type: 'offline',
      username: name,
      uuid: `u-${name}`,
      createdAt: 1,
      lastUsedAt: 2,
    });
  }
  store.flush();

  // Cut inside the accounts array — the last complete element is the account
  // before the cut, which is exactly the crash-during-write case.
  const raw = readRaw();
  const cut = raw.indexOf('\n    {\n      "id": "Two"');
  write(raw.slice(0, cut === -1 ? raw.length : cut));

  const reloaded = await loadStore();
  const names = reloaded.store.getAccounts().map((a) => a.username);
  check('complete entries salvaged from a truncated array', () => {
    assert.deepEqual(names, ['One'], `got ${JSON.stringify(names)}`);
  });
  check('settings still intact alongside partial accounts', () => {
    assert.equal(reloaded.store.getSettings().maxMemMb, 4096);
  });
}

console.log('\n[4] Trailing-comma / stray-token damage');
for (const [label, mutate] of [
  ['trailing comma', (s) => s.replace(/\}\s*$/, '},')],
  ['truncated array', (s) => s.replace(/\[[^\]]*$/, '[{"id":"z"')],
  ['doubled comma', (s) => s.replace(/,(\s*[}\]])/, ',,$1')],
]) {
  reset();
  const { store } = await loadStore();
  store.upsertAccount(
    { id: 'k', type: 'offline', username: 'Alex', uuid: 'u-9', createdAt: 1, lastUsedAt: 2 },
  );
  store.flush();
  write(mutate(readRaw()));

  const reloaded = await loadStore();
  const accounts = reloaded.store.getAccounts();
  check(`${label}: accounts preserved`, () => {
    assert.ok(
      accounts.some((a) => a.username === 'Alex'),
      `lost accounts after ${label}: ${JSON.stringify(accounts)}`,
    );
  });
}

console.log('\n[5] Empty and non-object files');
{
  reset();
  write('');
  let reloaded = await loadStore();
  check('empty file falls back to defaults', () => {
    assert.equal(reloaded.store.getSettings().maxMemMb, 4096);
    assert.deepEqual(reloaded.store.getAccounts(), []);
  });
  check('empty file is backed up', () => assert.ok(corruptBackups().length >= 1));

  reset();
  write('   \n  ');
  reloaded = await loadStore();
  check('whitespace-only file is harmless', () => assert.deepEqual(reloaded.store.getAccounts(), []));

  reset();
  write('null');
  reloaded = await loadStore();
  check('literal null does not crash', () => assert.equal(reloaded.store.getSettings().minMemMb, 1024));

  reset();
  write('[1,2,3]');
  reloaded = await loadStore();
  check('array where object expected is tolerated', () => assert.deepEqual(reloaded.store.getAccounts(), []));

  reset();
  write('"just a string"');
  reloaded = await loadStore();
  check('scalar document is tolerated', () => assert.equal(reloaded.store.getSettings().minMemMb, 1024));
}

console.log('\n[6] Malformed secrets do not take down the config');
{
  reset();
  const { store } = await loadStore();
  store.upsertAccount(
    { id: 's1', type: 'microsoft', username: 'Bad', uuid: 'u-2', createdAt: 1, lastUsedAt: 2 },
    { accessToken: 'good-token' },
  );
  store.flush();

  // Corrupt one secret entry to garbage while leaving the rest valid.
  const doc = JSON.parse(readRaw());
  doc.secrets.s1 = 'enc:!!!not-base64!!!';
  write(JSON.stringify(doc, null, 2));

  const reloaded = await loadStore();
  check('other secrets survive one bad entry', () => {
    assert.ok(reloaded.store.getAccounts().length === 1, 'account should survive');
  });
  check('unreadable secret yields null rather than throwing', () => {
    const s = reloaded.store.getSecrets('s1');
    assert.ok(s === null || s.accessToken === undefined, `unexpected: ${JSON.stringify(s)}`);
  });
}

console.log('\n[7] Re-running salvage does not double-append');
{
  reset();
  const { store } = await loadStore();
  store.setSettings({ minMemMb: 4096 });
  store.upsertAccount({ id: 'd', type: 'offline', username: 'Dee', uuid: 'u-3', createdAt: 1, lastUsedAt: 2 });
  store.flush();

  write(`${readRaw()} TRAILING GARBAGE`);
  const reloaded = await loadStore();
  check('account recovered once', () => assert.equal(reloaded.store.getAccounts().length, 1));
  reloaded.store.flush();
  check('re-flush produces parseable JSON', () => JSON.parse(readRaw()));
  const third = await loadStore();
  check('second load is stable', () => {
    assert.equal(third.store.getAccounts().length, 1);
    assert.equal(third.store.getSettings().minMemMb, 4096);
  });
  check('a new corrupt backup was written each time damage was seen', () =>
    assert.ok(corruptBackups().length >= 1),
  );
}

reset();
console.log(`\n${process.exitCode ? 'STORE TESTS FAILED' : 'STORE TESTS PASSED'} — ${passed} checks\n`);