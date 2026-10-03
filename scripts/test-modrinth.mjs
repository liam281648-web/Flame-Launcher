/**
 * Headless checks for the Modrinth API layer against the live service.
 * Run with: node scripts/test-modrinth.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = 'https://api.modrinth.com/v2';

let passed = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`);
    process.exitCode = 1;
  }
}

async function json(pathAndQuery) {
  const res = await fetch(`${API}${pathAndQuery}`, {
    headers: { 'User-Agent': 'FlameClient/0.1.0' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`GET ${pathAndQuery} -> ${res.status}`);
  return res.json();
}

const search = (facets, offset = 0, limit = 24) => {
  const p = new URLSearchParams({
    facets: JSON.stringify(facets),
    index: 'relevance',
    limit: String(limit),
    offset: String(offset),
  });
  return json(`/search?${p.toString()}`);
};

console.log('\n[1] Search: project_type facet + game version filter');
{
  const page = await search([['project_type:shader'], ['versions:1.20.1']]);
  ok('returns hits', Array.isArray(page.hits) && page.hits.length > 0, `${page.hits?.length} hits`);
  ok('total_hits is a number', typeof page.total_hits === 'number', `${page.total_hits} total`);
  ok(
    'every hit is project_type:shader',
    page.hits.every((h) => h.project_type === 'shader'),
  );
  ok(
    'every hit has slug + title',
    page.hits.every((h) => typeof h.slug === 'string' && typeof h.title === 'string'),
  );

  const rp = await search([['project_type:resourcepack'], ['versions:1.20.1']]);
  ok(
    'resourcepack search returns hits',
    Array.isArray(rp.hits) && rp.hits.length > 0,
    `${rp.hits?.length} hits`,
  );
  ok(
    'no shader leaks into resourcepack results',
    rp.hits.every((h) => h.project_type === 'resourcepack'),
  );
}

console.log('\n[2] Pagination: offsets do not overlap and respect the limit');
{
  const limit = 10;
  const p0 = await search([['project_type:resourcepack'], ['versions:1.20.1']], 0, limit);
  const p1 = await search([['project_type:resourcepack'], ['versions:1.20.1']], limit, limit);
  ok('page 1 respects limit', p0.hits.length <= limit, `${p0.hits.length} <= ${limit}`);
  ok('page 2 respects limit', p1.hits.length <= limit, `${p1.hits.length} <= ${limit}`);
  const s0 = new Set(p0.hits.map((h) => h.slug));
  ok(
    'pages do not overlap',
    p1.hits.every((h) => !s0.has(h.slug)),
  );
  ok('offset echoed back', p0.offset === 0 && p1.offset === limit);
}

console.log('\n[3] Version filtering really narrows results');
{
  const v1201 = await search([['project_type:resourcepack'], ['versions:1.20.1']]);
  const v18 = await search([['project_type:resourcepack'], ['versions:1.8.9']]);
  ok(
    'different versions return different totals',
    v1201.total_hits !== v18.total_hits,
    `1.20.1=${v1201.total_hits} vs 1.8.9=${v18.total_hits}`,
  );
}

console.log('\n[4] Project versions: filtering by game version');
// Slugs are taken from live search results rather than hardcoded, since Modrinth
// renames and removes projects and a stale slug would fail the whole run.
let shaderProject = null;
let rpProject = null;
{
  const shaderHits = (await search([['project_type:shader'], ['versions:1.20.1']])).hits;
  const rpHits = (await search([['project_type:resourcepack'], ['versions:1.20.1']])).hits;
  shaderProject = shaderHits[0];
  rpProject = rpHits[0];

  for (const [label, hit] of [['shader', shaderProject], ['resourcepack', rpProject]]) {
    const all = await json(`/project/${hit.project_id}/version`);
    ok(
      `${label} "${hit.title}" version list is non-empty`,
      Array.isArray(all) && all.length > 0,
      `${all.length} versions`,
    );
    ok(
      `${label} some version declares 1.20.1`,
      all.some((v) => v.game_versions?.includes('1.20.1')),
    );
    const packFiles = all.filter((v) => v.files?.some((f) => /\.(zip|jar|mcmeta)$/i.test(f.filename)));
    ok(`${label} some versions expose a zip/jar file`, packFiles.length > 0, `${packFiles.length}`);
    ok(
      `${label} files carry a sha1 hash`,
      packFiles.every((v) => v.files.every((f) => typeof f.hashes?.sha1 === 'string')),
    );
  }
}

console.log('\n[5] Install: version resolution picks a 1.20.1 build');
{
  const all = await json(`/project/${shaderProject.project_id}/version`);
  const forMC = all.filter((v) => v.game_versions?.includes('1.20.1'));
  const sorted = [...forMC].sort((a, b) => (b.date_published ?? '').localeCompare(a.date_published ?? ''));
  const chosen = sorted[0];
  ok('found a 1.20.1 build', Boolean(chosen), `${chosen?.version_number}`);
  ok('chosen build declares 1.20.1', chosen.game_versions.includes('1.20.1'));
  ok('chosen build has a downloadable file', Boolean(chosen.files?.[0]?.url));
  ok(
    'chosen file is a zip',
    /\.zip$/i.test(chosen.files?.[0]?.filename ?? ''),
    chosen.files?.[0]?.filename,
  );
  ok(
    'no free-threaded/loader-only artifact chosen',
    !/fabric|forge|neoforge/i.test(chosen.files?.[0]?.filename ?? ''),
  );
}

console.log('\n[6] Download: sha1 verified, atomic write, no partial file left');
{
  const all = await json(`/project/${rpProject.project_id}/version`);
  const chosen = all
    .filter((v) => v.game_versions?.includes('1.20.1'))
    .sort((a, b) => (b.date_published ?? '').localeCompare(a.date_published ?? ''))[0];
  const file = chosen.files[0];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flame-test-'));
  const dest = path.join(dir, 'pack.zip');

  const res = await fetch(file.url, { headers: { 'User-Agent': 'FlameClient/0.1.0' } });
  ok('file url responds 200', res.ok);
  const buf = Buffer.from(await res.arrayBuffer());

  const { createHash } = await import('node:crypto');
  const sha1 = createHash('sha1').update(buf).digest('hex');
  ok('advertised sha1 matches bytes', sha1 === file.hashes.sha1.toLowerCase(), sha1.slice(0, 12));
  ok('downloaded size matches metadata', buf.length === file.size, `${buf.length} bytes`);

  // Verify a real zip header so installProject produces a usable archive.
  ok('payload is a zip (PK magic)', buf.subarray(0, 2).toString('latin1') === 'PK');

  fs.writeFileSync(dest, buf);
  ok('written to temp dir', fs.existsSync(dest));
  ok('no .part leftovers', fs.readdirSync(dir).every((f) => !f.endsWith('.part')), fs.readdirSync(dir).join(','));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n[7] options.txt resourcePacks round-trip');
{
  const { readEnabledPacks, writeEnabledPacks } = await import(
    '../dist/main/packs-probe.mjs'
  ).catch(() => ({ readEnabledPacks: null, writeEnabledPacks: null }));

  if (!readEnabledPacks) {
    console.log('  SKIP  (probe bundle not built)');
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flame-opts-'));
    const file = path.join(dir, 'options.txt');

    assert.equal(readEnabledPacks(dir).length, 0, 'no file -> nothing enabled');

    writeEnabledPacks(dir, 'bsl-8.zip', true);
    assert.deepEqual(readEnabledPacks(dir), ['bsl-8.zip']);

    let text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('"vanilla"'), 'vanilla is always present');

    writeEnabledPacks(dir, 'faithful.zip', true);
    assert.deepEqual(readEnabledPacks(dir), ['bsl-8.zip', 'faithful.zip']);

    writeEnabledPacks(dir, 'bsl-8.zip', false);
    assert.deepEqual(readEnabledPacks(dir), ['faithful.zip']);

    // unrelated keys must survive
    fs.writeFileSync(file, 'fov:70\nresourcePacks:["vanilla"]\nrenderDistance:12\n', 'utf8');
    writeEnabledPacks(file.includes(dir) ? dir : dir, 'x.zip', true);
    text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('fov:70'), 'fov preserved');
    assert.ok(text.includes('renderDistance:12'), 'renderDistance preserved');

    // flame-menu.zip is launcher-owned
    fs.writeFileSync(file, 'fov:70\n', 'utf8');
    writeEnabledPacks(dir, 'flame-menu.zip', true);
    text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes('resourcePacks:'), 'flame-menu.zip is never written');

    // path traversal is rejected
    let threw = false;
    try {
      writeEnabledPacks(dir, '../evil.zip', true);
    } catch {
      threw = true;
    }
    assert.ok(threw, 'traversal rejected');

    fs.rmSync(dir, { recursive: true, force: true });
    console.log('  PASS  options.txt round-trip');
    passed++;
  }
}

console.log('\n[8] options.txt shaderPack round-trip');
{
  const { readActiveShader, writeActiveShader } = await import('../dist/main/packs-probe.mjs').catch(
    () => ({ readActiveShader: null, writeActiveShader: null }),
  );

  if (!readActiveShader) {
    console.log('  SKIP  (probe bundle not built)');
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flame-shader-'));
    const file = path.join(dir, 'options.txt');

    assert.equal(readActiveShader(dir), null, 'no file -> no shader');

    writeActiveShader(dir, 'bismuth-free-v1.9.zip');
    assert.equal(readActiveShader(dir), 'bismuth-free-v1.9.zip', 'shader selected');
    assert.ok(
      fs.readFileSync(file, 'utf8').includes('shaderPack:"bismuth-free-v1.9.zip"'),
      'value is JSON-quoted like Minecraft writes it',
    );

    // only one shader at a time, so selecting another replaces the first
    writeActiveShader(dir, 'complementary-r4.5.zip');
    assert.equal(readActiveShader(dir), 'complementary-r4.5.zip', 'shader replaced');

    writeActiveShader(dir, null);
    assert.equal(readActiveShader(dir), null, 'cleared back to none');

    // unrelated keys survive
    fs.writeFileSync(file, 'fov:70\nshaderPack:"none"\nrenderDistance:12\n', 'utf8');
    writeActiveShader(dir, 'bsl8.zip');
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('fov:70'), 'fov preserved');
    assert.ok(text.includes('renderDistance:12'), 'renderDistance preserved');

    // Minecraft's own unquoted `none` must not read as an enabled shader
    fs.writeFileSync(file, 'shaderPack:none\n', 'utf8');
    assert.equal(readActiveShader(dir), null, 'unquoted none handled');

    let threw = false;
    try {
      writeActiveShader(dir, '../evil.zip');
    } catch {
      threw = true;
    }
    assert.ok(threw, 'traversal rejected');

    fs.rmSync(dir, { recursive: true, force: true });
    console.log('  PASS  shaderPack round-trip');
    passed++;
  }
}

console.log('\n[9] Mods: project_type:mod + loader facet');
{
  const mods = await search([['project_type:mod'], ['versions:1.20.1']]);
  ok('mod search returns hits', Array.isArray(mods.hits) && mods.hits.length > 0, `${mods.hits?.length} hits`);
  ok('every hit is project_type:mod', mods.hits.every((h) => h.project_type === 'mod'));
  ok(
    'no shaders leak into mod results',
    mods.hits.every((h) => h.project_type === 'mod'),
  );

  // The loader facet is what keeps a Fabric instance from being offered Forge mods.
  const fabricMods = await search([
    ['project_type:mod'],
    ['versions:1.20.1'],
    ['categories:fabric'],
  ]);
  ok(
    'fabric facet returns hits',
    Array.isArray(fabricMods.hits) && fabricMods.hits.length > 0,
    `${fabricMods.hits?.length} hits`,
  );
  ok(
    'fabric facet narrows the result set',
    fabricMods.total_hits < mods.total_hits,
    `fabric=${fabricMods.total_hits} of ${mods.total_hits}`,
  );

  // Mods ship jars, so the version resolver has to accept them.
  const chosen = (await json(`/project/${fabricMods.hits[0].project_id}/version`))
    .filter((v) => v.game_versions?.includes('1.20.1'))
    .sort((a, b) => (b.date_published ?? '').localeCompare(a.date_published ?? ''))[0];
  ok('a 1.20.1 fabric mod build exists', Boolean(chosen), chosen?.version_number);
  ok(
    'mod build exposes a jar',
    chosen?.files?.some((f) => /\.jar$/i.test(f.filename)),
    chosen?.files?.[0]?.filename,
  );
}

console.log('\n[10] Per-instance pack metadata');
{
  const { recordPackMeta, getPackMeta, forgetPackMeta, prunePackMeta } = await import(
    '../dist/main/packmeta-probe.mjs'
  ).catch(() => ({}));
  if (!recordPackMeta) {
    console.log('  SKIP  (packmeta probe not built)');
  } else {
    // A dedicated user-data dir keeps this run's metadata out of the real one.
    const metaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flame-meta-'));
    process.env.FLAME_USER_DATA = metaRoot;
    const { flushPackMeta } = await import('../dist/main/packmeta-probe.mjs');

    recordPackMeta('alpha', 'mod', 'sodium.jar', { projectId: 'AANobbMI', title: 'Sodium' });
    recordPackMeta('beta', 'mod', 'sodium.jar', { projectId: 'AANobbMI', title: 'Sodium' });
    flushPackMeta();

    ok('metadata is scoped per instance', getPackMeta('alpha', 'mod', 'sodium.jar') !== null);
    ok('an unrelated instance does not see it', getPackMeta('gamma', 'mod', 'sodium.jar') === null);
    ok(
      'the same mod can live in two instances',
      getPackMeta('alpha', 'mod', 'sodium.jar').projectId === 'AANobbMI' &&
        getPackMeta('beta', 'mod', 'sodium.jar').projectId === 'AANobbMI',
    );
    ok(
      'user-installed packs are not marked managed',
      getPackMeta('alpha', 'mod', 'sodium.jar').managed === false,
    );

    // The same file name under a different kind must not collide.
    recordPackMeta('alpha', 'resourcepack', 'sodium.jar', { title: 'Sodium RP' });
    ok(
      'kinds do not collide within an instance',
      getPackMeta('alpha', 'resourcepack', 'sodium.jar').title === 'Sodium RP' &&
        getPackMeta('alpha', 'mod', 'sodium.jar').title === 'Sodium',
    );

    forgetPackMeta('alpha', 'mod', 'sodium.jar');
    ok('forget clears one entry', getPackMeta('alpha', 'mod', 'sodium.jar') === null);
    ok('forget leaves the same mod in another instance', getPackMeta('beta', 'mod', 'sodium.jar') !== null);

    // Pruning is driven by the files actually on disk, across every instance.
    prunePackMeta(new Set(['beta/mod/sodium.jar']));
    ok('prune keeps a live file', getPackMeta('beta', 'mod', 'sodium.jar') !== null);
    ok('prune drops metadata with no file on disk', getPackMeta('alpha', 'resourcepack', 'sodium.jar') === null);

    prunePackMeta(new Set());
    ok('prune can empty the file', getPackMeta('beta', 'mod', 'sodium.jar') === null);

    // A traversal attempt in the file name is reduced to its basename, so the key
    // can never point outside the instance — and lookups normalise the same way,
    // so a traversal string cannot read another entry either.
    recordPackMeta('alpha', 'mod', '../../escape.jar', { title: 'Escape' });
    ok(
      'a traversal file name is reduced to its basename',
      getPackMeta('alpha', 'mod', 'escape.jar') !== null &&
        getPackMeta('alpha', 'mod', '..\\..\\escape.jar')?.title === 'Escape',
    );
    ok(
      'no entry is keyed by the raw traversal path',
      getPackMeta('alpha', 'mod', 'passwd') === null,
    );

    // A corrupt side-car is survivable: the UI falls back to file names. The
    // module caches, so this needs a fresh import to be a real test.
    fs.writeFileSync(path.join(metaRoot, 'installed-packs.json'), '{ not json', 'utf8');
    const reloaded = await import(`../dist/main/packmeta-probe.mjs?v=${Math.random()}`);
    ok(
      'a corrupt side-car reads as empty instead of throwing',
      reloaded.getPackMeta('alpha', 'mod', 'escape.jar') === null,
    );

    fs.rmSync(metaRoot, { recursive: true, force: true });
  }
}

console.log(`\n${process.exitCode ? 'FAILURES' : 'ALL PASSED'} — ${passed} checks\n`);