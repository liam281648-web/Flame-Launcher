/**
 * Instance manager tests for src/main/instances.ts.
 *
 * Exercises the real migration, scaffold, CRUD, active-selection, id-derivation,
 * traversal and sizing code under plain Node via the bundled probe.
 * Usage: node scripts/test-instances.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';

const PROBE = new URL('../dist/main/instances-probe.mjs', import.meta.url);

let passed = 0;
function ok(name, extra = '') {
  passed++;
  console.log(`  PASS  ${name}${extra ? ` \u2014 ${extra}` : ''}`);
}
function fail(name, extra = '') {
  console.log(`  FAIL  ${name}${extra ? ` \u2014 ${extra}` : ''}`);
  process.exitCode = 1;
}
async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err instanceof Error ? err.message.split('\n')[0] : String(err));
  }
}
async function throws(name, fn, re) {
  try {
    await fn();
    fail(name, 'expected a throw');
  } catch (err) {
    if (re && !re.test(err instanceof Error ? err.message : String(err))) {
      fail(name, `wrong message: ${err.message}`);
      return;
    }
    ok(name);
  }
}

if (!existsSync(PROBE)) {
  console.error(`Probe missing at ${PROBE.pathname}. Run \`npm run test:instances\`.`);
  process.exit(1);
}

/**
 * Each case gets a throwaway data root so migration and the stored active id
 * cannot leak between cases. The probe is re-imported with a cache-busting query
 * because `store` reads its config once per module instance.
 */
async function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flame-instances-'));
  process.env.FLAME_GAME_DIR = dir;
  const bust = `?v=${Math.random()}`;
  const mod = await import(`${PROBE.href}${bust}`);
  return { dir, ...mod };
}

console.log('\ninstance layout');

await check('a fresh data root gets one default instance', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  const list = t.listInstances();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'default');
  assert.equal(list[0].name, 'Default');
  assert.equal(list[0].gameVersion, '1.20.1');
  assert.equal(list[0].loader.type, 'vanilla');
  assert.equal(list[0].loader.version, '');
  assert.equal(list[0].lastPlayed, null);
  assert.equal(list[0].path, t.instanceDir('default'));
});

await check('every instance gets the scaffold directories', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  for (const sub of ['mods', 'resourcepacks', 'shaderpacks', 'config', 'saves']) {
    assert.ok(existsSync(path.join(t.instanceDir('default'), sub)), `missing ${sub}`);
  }
});

await check('ensureInstancesRoot is idempotent', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  t.writeInstance({ ...t.readInstance('default'), name: 'Kept' });
  t.ensureInstancesRoot();
  t.ensureInstancesRoot();
  const list = t.listInstances();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Kept');
});

console.log('\nlegacy migration');

await check('legacy game data moves into the default instance', async () => {
  const t = await fresh();
  fs.mkdirSync(path.join(t.dir, 'saves/world'), { recursive: true });
  fs.writeFileSync(path.join(t.dir, 'saves/world/level.dat'), 'level');
  fs.mkdirSync(path.join(t.dir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(t.dir, 'mods/old.jar'), 'jar');
  fs.writeFileSync(path.join(t.dir, 'options.txt'), 'version:auto\n');
  // Shared cache content must stay put.
  fs.mkdirSync(path.join(t.dir, 'versions/1.20.1'), { recursive: true });
  fs.writeFileSync(path.join(t.dir, 'versions/1.20.1/1.20.1.jar'), 'jar');
  fs.writeFileSync(path.join(t.dir, 'flame.config.json'), '{}');

  t.ensureInstancesRoot();

  const def = t.instanceDir('default');
  assert.ok(existsSync(path.join(def, 'saves/world/level.dat')), 'save not migrated');
  assert.ok(existsSync(path.join(def, 'mods/old.jar')), 'mod not migrated');
  assert.ok(existsSync(path.join(def, 'options.txt')), 'options.txt not migrated');
  assert.ok(!existsSync(path.join(t.dir, 'mods')), 'mods left in the data root');
  assert.ok(!existsSync(path.join(t.dir, 'saves')), 'saves left in the data root');
  assert.ok(existsSync(path.join(t.dir, 'versions/1.20.1/1.20.1.jar')), 'shared version moved');
  assert.ok(existsSync(path.join(t.dir, 'flame.config.json')), 'config moved');
});

await check('a second startup does not re-migrate or duplicate', async () => {
  const t = await fresh();
  fs.mkdirSync(path.join(t.dir, 'saves'), { recursive: true });
  fs.writeFileSync(path.join(t.dir, 'options.txt'), 'version:auto\n');
  t.ensureInstancesRoot();
  fs.writeFileSync(path.join(t.instanceDir('default'), 'options.txt'), 'version:edited\n');

  // Simulate a restart: a fresh module instance against the same data root.
  process.env.FLAME_GAME_DIR = t.dir;
  const again = await import(`${PROBE.href}?v=${Math.random()}`);
  again.ensureInstancesRoot();

  assert.equal(again.listInstances().length, 1);
  assert.equal(
    fs.readFileSync(path.join(again.instanceDir('default'), 'options.txt'), 'utf8'),
    'version:edited\n',
  );
  assert.ok(!existsSync(path.join(t.dir, 'options.txt')), 'options.txt reappeared in the data root');
});

await check('a folder without a manifest is ignored', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  // What a create interrupted halfway leaves behind: a folder with content but
  // no `instance.json`. It must not show up as a playable instance…
  fs.mkdirSync(path.join(t.instanceDir('leftover'), 'mods'), { recursive: true });
  fs.writeFileSync(path.join(t.instanceDir('leftover'), 'mods/keep.jar'), 'jar');

  t.ensureInstancesRoot();
  t.ensureInstancesRoot();

  assert.ok(
    !t.listInstances().some((i) => i.id === 'leftover'),
    'a manifest-less folder was listed as an instance',
  );
  // …and it must survive, since deleting user data on a guess is unacceptable.
  assert.ok(
    existsSync(path.join(t.instanceDir('leftover'), 'mods/keep.jar')),
    'a manifest-less folder was wiped',
  );
});

await check('legacy content is not migrated once instances/ exists', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  const other = t.createInstance({ name: 'Other', gameVersion: '1.20.1' });
  fs.mkdirSync(path.join(t.dir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(t.dir, 'mods/stray.jar'), 'jar');

  // Migration is guarded on the absence of `instances/`, so once the user has
  // instances a stray root-level folder is left strictly alone.
  t.ensureInstancesRoot();

  assert.ok(!existsSync(path.join(t.instanceDir('default'), 'mods/stray.jar')));
  assert.ok(!existsSync(path.join(t.instanceDir(other.id), 'mods/stray.jar')));
  assert.ok(existsSync(path.join(t.dir, 'mods/stray.jar')), 'stray content was deleted');
});

console.log('\ncreation and ids');

await check('a name becomes a slug id', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  const created = t.createInstance({ name: 'Skyblock 1.20.1!', gameVersion: '1.20.1' });
  assert.equal(created.id, 'skyblock-1.20.1');
  assert.equal(created.name, 'Skyblock 1.20.1!');
  assert.ok(existsSync(path.join(created.path, 'instance.json')));
  assert.ok(existsSync(path.join(created.path, 'options.txt')));
});

await check('duplicate names get a numeric suffix', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  assert.equal(t.createInstance({ name: 'Pack', gameVersion: '1.20.1' }).id, 'pack');
  assert.equal(t.createInstance({ name: 'Pack', gameVersion: '1.20.1' }).id, 'pack-2');
  assert.equal(t.createInstance({ name: 'Pack', gameVersion: '1.20.1' }).id, 'pack-3');
});

await check('accents are folded and long names are truncated', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  assert.equal(t.createInstance({ name: 'Crème Brûlée', gameVersion: '1.20.1' }).id, 'creme-brulee');
  const long = 'x'.repeat(80);
  const id = t.createInstance({ name: long, gameVersion: '1.20.1' }).id;
  assert.ok(id.length <= 48, `id too long: ${id.length}`);
  assert.ok(t.isValidInstanceId(id), `id not valid: ${id}`);
});

await check('a name that slugifies to nothing still yields an id', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  const created = t.createInstance({ name: '日本語', gameVersion: '1.20.1' });
  assert.ok(created.id.length > 0);
  assert.ok(t.isValidInstanceId(created.id));
});

await check('creating selects the new instance', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  const created = t.createInstance({ name: 'Fresh', gameVersion: '1.20.1' });
  assert.equal(t.activeInstanceId(), created.id);
  assert.equal(t.activeInstance().name, 'Fresh');
});

await check('loader version is kept and vanilla clears it', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  const fabric = t.createInstance({
    name: 'Modded',
    gameVersion: '1.20.1',
    loader: { type: 'fabric', version: '0.15.11' },
  });
  assert.deepEqual(t.readInstance(fabric.id).loader, { type: 'fabric', version: '0.15.11' });

  t.updateInstance(fabric.id, { loader: { type: 'vanilla', version: 'ignored' } });
  assert.deepEqual(t.readInstance(fabric.id).loader, { type: 'vanilla', version: '' });
});

await throws('creation refuses a blank name', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  t.createInstance({ name: '   ', gameVersion: '1.20.1' });
}, /name/i);

await throws('creation refuses a blank version', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  t.createInstance({ name: 'Blank', gameVersion: '  ' });
}, /version/i);

console.log('\ntraversal and validation');

await throws('instanceDir refuses a parent escape', async () => {
  const t = await fresh();
  t.instanceDir('../escape');
}, /not a valid instance id/i);

await throws('instanceDir refuses a nested path', async () => {
  const t = await fresh();
  t.instanceDir('a/b');
}, /not a valid instance id/i);

await throws('instanceDir refuses an absolute path', async () => {
  const t = await fresh();
  t.instanceDir('C:\\Windows');
}, /not a valid instance id/i);

await throws('instanceDir refuses a name that is only dots', async () => {
  const t = await fresh();
  t.instanceDir('..');
}, /not a valid instance id/i);

await throws('a long id is rejected rather than truncated', async () => {
  const t = await fresh();
  t.instanceDir('y'.repeat(60));
}, /not a valid instance id/i);

await check('valid ids are accepted', async () => {
  const t = await fresh();
  for (const id of ['default', 'a', 'skyblock-1', 'pack_2', 'my.instance', 'A1'.toLowerCase()]) {
    assert.ok(t.isValidInstanceId(id), `rejected ${id}`);
    assert.ok(t.instanceDir(id).startsWith(t.instancesRoot()));
  }
  for (const id of ['', '-leading', 'trailing-', 'UPPER', 'has space', 'a..b']) {
    assert.ok(!t.isValidInstanceId(id), `accepted ${id}`);
  }
});

console.log('\nupdate, rename and last played');

await check('rename changes only the name', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  const created = t.createInstance({
    name: 'Before',
    gameVersion: '1.20.1',
    loader: { type: 'fabric', version: '0.15.11' },
  });
  t.renameInstance(created.id, 'After');
  const meta = t.readInstance(created.id);
  assert.equal(meta.name, 'After');
  assert.equal(meta.gameVersion, '1.20.1');
  assert.deepEqual(meta.loader, { type: 'fabric', version: '0.15.11' });
  assert.equal(meta.id, created.id, 'id must not change on rename');
});

await check('lastPlayed sorts instances to the top', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  const a = t.createInstance({ name: 'A', gameVersion: '1.20.1' });
  const b = t.createInstance({ name: 'B', gameVersion: '1.20.1' });
  assert.equal(t.listInstances()[0].id, b.id, 'newest created should lead before any play');

  t.setInstanceLastPlayed(a.id, 1_000);
  assert.equal(t.listInstances()[0].id, a.id);
  assert.equal(t.readInstance(a.id).lastPlayed, 1_000);
  assert.equal(t.readInstance(b.id).lastPlayed, null);
});

await check('setInstanceLastPlayed ignores an unknown instance', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  t.setInstanceLastPlayed('nope', Date.now());
  assert.equal(t.listInstances().length, 1);
});

await throws('update refuses an empty name', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  t.updateInstance('default', { name: '  ' });
}, /name/i);

await throws('update refuses an unknown instance', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  t.updateInstance('ghost', { name: 'Ghost' });
}, /does not exist/i);

console.log('\ndeletion');

await check('deleting a non-active instance keeps the selection', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  const a = t.createInstance({ name: 'A', gameVersion: '1.20.1' });
  const b = t.createInstance({ name: 'B', gameVersion: '1.20.1' });
  assert.equal(t.activeInstanceId(), b.id);
  const list = t.removeInstance(a.id);
  assert.equal(t.activeInstanceId(), b.id);
  assert.ok(!list.some((i) => i.id === a.id));
  assert.ok(!existsSync(t.instanceDir(a.id)));
});

await check('deleting the active instance falls back to another', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  const a = t.createInstance({ name: 'A', gameVersion: '1.20.1' });
  const b = t.createInstance({ name: 'B', gameVersion: '1.20.1' });
  t.setActiveInstance(b.id);
  t.removeInstance(b.id);
  assert.equal(t.activeInstanceId(), a.id);
});

await check('deleting the last instance recreates a default', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  const only = t.createInstance({ name: 'Only', gameVersion: '1.20.1' });
  t.setActiveInstance('default');
  const list = t.removeInstance(only.id);
  assert.deepEqual(list.map((i) => i.id), ['default']);
  assert.equal(t.activeInstanceId(), 'default');
  assert.ok(existsSync(path.join(t.instanceDir('default'), 'mods')));
  assert.equal(t.readInstance('default').name, 'Default');
});

await throws('deleting a folder without a manifest is refused', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  fs.mkdirSync(t.instanceDir('stray'), { recursive: true });
  t.removeInstance('stray');
}, /refusing to delete/i);

await throws('deleting an unknown instance is refused', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  t.removeInstance('ghost');
}, /does not exist/i);

console.log('\nactive selection');

await check('the active instance is persisted', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  t.createInstance({ name: 'Chosen', gameVersion: '1.20.1' });
  t.setActiveInstance('default');
  // The store debounces its config write; a restart is only meaningful once it lands.
  await new Promise((resolve) => setTimeout(resolve, 400));

  const restart = await import(`${PROBE.href}?v=${Math.random()}`);
  assert.equal(restart.activeInstanceId(), 'default');
});

await check('a stale stored id falls back to a real instance', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  t.createInstance({ name: 'Kept', gameVersion: '1.20.1' });
  // Point the store at an instance that no longer exists.
  t.removeInstance(t.activeInstanceId());
  const id = t.activeInstanceId();
  assert.ok(t.readInstance(id), `fallback ${id} is not a real instance`);
});

await throws('setActiveInstance rejects an unknown id', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  t.setActiveInstance('ghost');
}, /does not exist/i);

await check('resolveInstanceDir defaults to the active instance', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  const created = t.createInstance({ name: 'Active', gameVersion: '1.20.1' });
  assert.deepEqual(t.resolveInstanceDir(), { id: created.id, dir: created.path });
  assert.deepEqual(t.resolveInstanceDir('default'), {
    id: 'default',
    dir: t.instanceDir('default'),
  });
});

console.log('\nsizing');

await check('size sums nested files', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  const before = t.instanceSize('default');
  fs.writeFileSync(path.join(t.instanceDir('default'), 'options.txt'), 'x'.repeat(10));
  fs.mkdirSync(path.join(t.instanceDir('default'), 'mods'), { recursive: true });
  fs.writeFileSync(path.join(t.instanceDir('default'), 'mods/a.jar'), 'y'.repeat(90));

  const size = t.instanceSize('default');
  // Compared as a delta: `instance.json` and the scaffold are already on disk.
  assert.equal(size.bytes - before.bytes, 100);
  assert.equal(size.files - before.files, 2);
});

await check('size does not follow symlinks out of the instance', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  fs.writeFileSync(path.join(t.dir, 'huge.bin'), 'z'.repeat(4096));
  try {
    fs.symlinkSync(path.join(t.dir, 'huge.bin'), path.join(t.instanceDir('default'), 'link.bin'));
  } catch {
    ok('size does not follow symlinks out of the instance (skipped: no symlink privilege)');
    return;
  }
  const size = t.instanceSize('default');
  assert.ok(size.bytes < 4096, `symlink target was followed: ${size.bytes} bytes`);
});

await check('size survives a missing directory', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  assert.equal(t.instanceSize('ghost').bytes, 0);
});

console.log('\nloaders');

await check('vanilla is always supported', async () => {
  const t = await fresh();
  const availability = await t.loaderAvailability('vanilla', '1.20.1');
  assert.equal(availability.supported, true);
  assert.deepEqual(availability.versions, []);
});

await check('unsupported loaders report no versions', async () => {
  const t = await fresh();
  for (const type of ['forge', 'neoforge', 'quilt']) {
    const availability = await t.loaderAvailability(type, '1.20.1');
    assert.equal(availability.supported, false, `${type} claimed support`);
    assert.deepEqual(availability.versions, [], `${type} offered versions`);
    assert.match(availability.note, /vanilla/i, `${type} note should mention the vanilla fallback`);
  }
});

await check('isProvisioned matches the shared loader list', async () => {
  const t = await fresh();
  assert.equal(t.isProvisioned('vanilla'), true);
  assert.equal(t.isProvisioned('fabric'), true);
  for (const type of ['forge', 'neoforge', 'quilt']) {
    assert.equal(t.isProvisioned(type), false, `${type} should not be provisioned`);
  }
});

console.log('\nmetadata recovery');

await check('a corrupt manifest is skipped, not fatal', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  const good = t.createInstance({ name: 'Good', gameVersion: '1.20.1' });
  fs.mkdirSync(t.instanceDir('broken'), { recursive: true });
  fs.writeFileSync(path.join(t.instanceDir('broken'), 'instance.json'), '{ not json');

  const list = t.listInstances();
  assert.ok(list.some((i) => i.id === good.id), 'a corrupt manifest hid the healthy instances');
  assert.ok(!list.some((i) => i.id === 'broken'), 'corrupt instance was listed');
});

await check('partial metadata is coerced to defaults', async () => {
  const t = await fresh();
  t.ensureInstancesRoot();
  fs.mkdirSync(t.instanceDir('partial'), { recursive: true });
  fs.writeFileSync(
    path.join(t.instanceDir('partial'), 'instance.json'),
    JSON.stringify({ name: '', gameVersion: '', loader: { type: 'bogus', version: 7 } }),
  );
  const meta = t.readInstance('partial');
  assert.equal(meta.name, 'partial');
  assert.equal(meta.gameVersion, '1.20.1');
  assert.deepEqual(meta.loader, { type: 'vanilla', version: '' });
  assert.ok(meta.created > 0);
  assert.equal(meta.lastPlayed, null);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);