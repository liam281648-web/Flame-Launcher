/**
 * Drag-and-drop importer tests for src/main/importer.ts.
 *
 * Everything runs against the real code via the bundled probe: classification,
 * path-traversal refusal, container routing, `.mrpack` downloads (served from a
 * loopback HTTP server, so no external network) and the metadata pass.
 *
 * Usage: node scripts/test-importer.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import AdmZip from 'adm-zip';

const PROBE = new URL('../dist/main/importer-probe.mjs', import.meta.url);

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

if (!existsSync(PROBE)) {
  console.error(`Probe missing at ${PROBE.pathname}. Run \`npm run test:import\`.`);
  process.exit(1);
}

// ------------------------------------------------------------- fixtures

let mod;

/** Fresh data root + instance, then a fresh probe import so the cache resets. */
async function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flame-import-'));
  process.env.FLAME_GAME_DIR = dir;
  process.env.FLAME_USER_DATA = path.join(dir, 'userdata');
  fs.mkdirSync(process.env.FLAME_USER_DATA, { recursive: true });
  mod = await import(`${PROBE.href}?v=${Math.random()}`);

  mod.ensureInstancesRoot();
  const target = mod.targetFor('default');
  return { dir, target, instance: target.dir };
}

/** A throwaway directory for building source archives. */
function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flame-import-src-'));
}

function writeZip(dir, name, build) {
  const zip = new AdmZip();
  build(zip);
  const file = path.join(dir, name);
  fs.writeFileSync(file, zip.toBuffer());
  return file;
}

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const sha512 = (buf) => crypto.createHash('sha512').update(buf).digest('hex');

/**
 * Builds a zip whose entry names are written to the central directory verbatim.
 *
 * AdmZip's own writer rewrites hostile names (`/etc/x` -> `etc/x`,
 * `../../x` -> `x`), so a malicious archive built with it can never reach the
 * importer's guard. Zip-slip archives are real in the wild, so the traversal
 * tests assemble their bytes by hand: stored (uncompressed) entries, which need
 * nothing more than a CRC and three record types.
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function rawZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0x21, 12); // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

/** Writes a hand-built zip, asserting the raw names survive a round trip. */
function writeRawZip(dir, name, entries) {
  const buf = rawZip(entries);
  const names = new AdmZip(buf).getEntries().map((e) => e.entryName);
  for (const [raw] of entries) {
    assert.ok(names.includes(raw), `raw zip lost the name ${raw} (got ${JSON.stringify(names)})`);
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, buf);
  return file;
}

/** Minimal but valid-looking pack.json/pack.mcmeta pair. */
function addMcmeta(zip, at = 'pack.mcmeta') {
  zip.addFile(at, Buffer.from(JSON.stringify({ pack: { pack_format: 15 } })));
}

// ------------------------------------------------------------ classification

console.log('\nclassification');

await check('a dropped jar becomes a mod', async () => {
  const t = await fresh();
  const src = scratch();
  const jar = path.join(src, 'sodium-0.6.4.jar');
  fs.writeFileSync(jar, Buffer.from('PK-not-really-a-jar'));

  const result = await mod.importFiles([jar], t.target);
  assert.equal(result.files[0].kind, 'mod');
  assert.equal(result.files[0].ok, true);
  assert.ok(fs.existsSync(path.join(t.instance, 'mods', 'sodium-0.6.4.jar')));
  assert.deepEqual(result.touchedKinds, ['mod']);
});

await check('a zip with pack.mcmeta is a resource pack', async () => {
  const t = await fresh();
  const file = writeZip(scratch(), 'faithful-32x.zip', (zip) => {
    addMcmeta(zip);
    zip.addFile('pack.png', Buffer.alloc(64));
    zip.addFile('assets/minecraft/textures/block/stone.png', Buffer.alloc(32));
  });

  const result = await mod.importFiles([file], t.target);
  assert.equal(result.files[0].kind, 'resourcepack');
  assert.ok(fs.existsSync(path.join(t.instance, 'resourcepacks', 'faithful-32x.zip')));
});

await check('a zip with a shaders folder is a shader, even with pack.mcmeta', async () => {
  // Shader packs ship pack.mcmeta too, so this is the case that proves the
  // detection order: resource-pack rules first would file this as textures.
  const t = await fresh();
  const file = writeZip(scratch(), 'complementary.zip', (zip) => {
    addMcmeta(zip);
    zip.addFile('shaders/lib/lighting.glsl', Buffer.from('void main(){}'));
    zip.addFile('shaders/program.fsh', Buffer.from('void main(){}'));
  });

  const result = await mod.importFiles([file], t.target);
  assert.equal(result.files[0].kind, 'shader');
  assert.ok(fs.existsSync(path.join(t.instance, 'shaderpacks', 'complementary.zip')));
});

await check('a zip carrying a mod manifest is a mod, not a resource pack', async () => {
  const t = await fresh();
  const file = writeZip(scratch(), 'iridium-1.0.jar', (zip) => {
    addMcmeta(zip);
    zip.addFile('fabric.mod.json', Buffer.from('{"id":"iridium"}'));
  });

  const result = await mod.importFiles([file], t.target);
  assert.equal(result.files[0].kind, 'mod');
  assert.ok(fs.existsSync(path.join(t.instance, 'mods', 'iridium-1.0.jar')));
});

await check('an unrecognised extension is rejected without touching disk', async () => {
  const t = await fresh();
  const src = scratch();
  const file = path.join(src, 'notes.txt');
  fs.writeFileSync(file, 'hello');

  const result = await mod.importFiles([file], t.target);
  assert.equal(result.files[0].ok, false);
  assert.equal(result.files[0].kind, 'unsupported');
  assert.match(result.files[0].error, /not supported/);
});

await check('a pack already in the instance is refused rather than copied onto itself', async () => {
  const t = await fresh();
  const inPlace = path.join(t.instance, 'mods', 'dup.jar');
  fs.mkdirSync(path.dirname(inPlace), { recursive: true });
  fs.writeFileSync(inPlace, Buffer.from('original'));

  const result = await mod.importFiles([inPlace], t.target);
  assert.equal(result.files[0].ok, false);
  assert.match(result.files[0].error, /already in this instance/);
  assert.equal(readFileSync(inPlace, 'utf8'), 'original');
});

// -------------------------------------------------------------- routing

console.log('\ncontainer routing');

await check('a bare backup routes mods, packs, config and root files', async () => {
  const t = await fresh();
  const file = writeZip(scratch(), 'backup.zip', (zip) => {
    zip.addFile('mods/jei.jar', Buffer.from('jei'));
    zip.addFile('mods/fabric-api.jar', Buffer.from('api'));
    zip.addFile('resourcepacks/textures.zip', Buffer.from('pack'));
    zip.addFile('shaderpacks/glow.zip', Buffer.from('glow'));
    zip.addFile('config/jei/world.ini', Buffer.from('k=v'));
    zip.addFile('options.txt', Buffer.from('fov:70\n'));
  });

  const result = await mod.importFiles([file], t.target);
  assert.equal(result.files[0].kind, 'archive');
  assert.equal(result.files[0].ok, true);
  assert.ok(fs.existsSync(path.join(t.instance, 'mods', 'jei.jar')));
  assert.ok(fs.existsSync(path.join(t.instance, 'mods', 'fabric-api.jar')));
  assert.ok(fs.existsSync(path.join(t.instance, 'resourcepacks', 'textures.zip')));
  assert.ok(fs.existsSync(path.join(t.instance, 'shaderpacks', 'glow.zip')));
  assert.ok(fs.existsSync(path.join(t.instance, 'config', 'jei', 'world.ini')));
  assert.ok(fs.existsSync(path.join(t.instance, 'options.txt')));
  // Packs extracted from a backup are archives, not metadata-tracked packs.
  assert.ok(result.touchedKinds.includes('mod'));
});

await check('archive metadata is skipped rather than imported', async () => {
  const t = await fresh();
  const file = writeZip(scratch(), 'with-mac-metadata.zip', (zip) => {
    zip.addFile('mods/real.jar', Buffer.from('real'));
    zip.addFile('__MACOSX/._real.jar', Buffer.from('junk'));
    zip.addFile('.DS_Store', Buffer.from('junk'));
  });

  await mod.importFiles([file], t.target);
  assert.ok(fs.existsSync(path.join(t.instance, 'mods', 'real.jar')));
  assert.ok(!fs.existsSync(path.join(t.instance, '__MACOSX')));
  assert.ok(!fs.existsSync(path.join(t.instance, '.DS_Store')));
});

// ------------------------------------------------------------- zip slip

console.log('\npath traversal');

await check('a ../ entry never escapes the instance', async () => {
  const t = await fresh();
  const file = writeRawZip(scratch(), 'evil.zip', [
    ['mods/ok.jar', Buffer.from('ok')],
    ['../../escaped.txt', Buffer.from('pwned')],
    ['../one-level-up.txt', Buffer.from('pwned')],
    ['mods/../../nested/escape.txt', Buffer.from('pwned')],
  ]);

  const result = await mod.importFiles([file], t.target);
  assert.equal(result.files[0].kind, 'archive');
  assert.ok(fs.existsSync(path.join(t.instance, 'mods', 'ok.jar')));
  // Nothing outside `instances/default/` may exist, at any depth.
  for (const escape of [
    path.join(t.dir, 'instances', 'escaped.txt'),
    path.join(t.dir, 'instances', 'one-level-up.txt'),
    path.join(t.dir, 'instances', 'nested', 'escape.txt'),
    path.join(t.dir, 'escaped.txt'),
    path.join(t.dir, 'one-level-up.txt'),
    path.resolve(t.instance, '..', '..', 'escaped.txt'),
    path.resolve(t.instance, '..', '..', 'nested', 'escape.txt'),
  ]) {
    assert.ok(!fs.existsSync(escape), `traversal escaped to ${escape}`);
  }
  assert.match(result.files[0].detail ?? '', /3 skipped/);
});

await check('an absolute drive-letter entry is refused', async () => {
  const t = await fresh();
  const file = writeRawZip(scratch(), 'drive.zip', [
    ['mods/ok.jar', Buffer.from('ok')],
    ['C:/Windows/System32/evil.dll', Buffer.from('pwned')],
    ['c:\\windows\\system32\\evil2.dll', Buffer.from('pwned')],
  ]);

  const result = await mod.importFiles([file], t.target);
  assert.ok(fs.existsSync(path.join(t.instance, 'mods', 'ok.jar')));
  assert.ok(!fs.existsSync('C:/Windows/System32/evil.dll'));
  assert.ok(!fs.existsSync(path.join(t.instance, 'C:', 'Windows', 'System32', 'evil.dll')));
  assert.match(result.files[0].detail ?? '', /2 skipped/);
});

await check('a POSIX-absolute entry is refused', async () => {
  const t = await fresh();
  const file = writeRawZip(scratch(), 'posix.zip', [
    ['mods/ok.jar', Buffer.from('ok')],
    ['/etc/flame-owned.txt', Buffer.from('pwned')],
    ['//srv/flame-double-slash.txt', Buffer.from('pwned')],
  ]);

  const result = await mod.importFiles([file], t.target);
  assert.ok(fs.existsSync(path.join(t.instance, 'mods', 'ok.jar')));
  // Stripping the leading slash and writing it relative would be just as wrong:
  // it would land in the instance instead of being refused.
  assert.ok(!fs.existsSync(path.join(t.instance, 'etc', 'flame-owned.txt')));
  assert.ok(!fs.existsSync(path.join(t.instance, 'srv', 'flame-double-slash.txt')));
  assert.match(result.files[0].detail ?? '', /2 skipped/);
});

await check('a symlink in the archive cannot redirect extraction', async () => {
  const t = await fresh();
  // Windows will not create symlinks without elevation, so this is skipped
  // rather than failed when the dev mode copy is unavailable.
  const link = path.join(t.instance, 'mods', 'escape-link');
  try {
    fs.symlinkSync(t.dir, link, 'junction');
  } catch {
    console.log('  SKIP  symlink extraction (needs elevation or is unsupported)');
    passed++;
    return;
  }

  const file = writeRawZip(scratch(), 'symlinked.zip', [
    ['mods/escape-link/escaped.txt', Buffer.from('pwned')],
  ]);
  await mod.importFiles([file], t.target);
  assert.ok(!fs.existsSync(path.join(t.dir, 'escaped.txt')), 'symlink redirected extraction');
  fs.unlinkSync(link);
});

await check('one traversal entry does not discard the rest of the archive', async () => {
  const t = await fresh();
  const file = writeRawZip(scratch(), 'mixed.zip', [
    ['mods/a.jar', Buffer.from('a')],
    ['../../escape.txt', Buffer.from('bad')],
    ['mods/b.jar', Buffer.from('b')],
    ['config/good.ini', Buffer.from('ok')],
  ]);

  const result = await mod.importFiles([file], t.target);
  assert.equal(result.files[0].ok, true);
  assert.ok(fs.existsSync(path.join(t.instance, 'mods', 'a.jar')));
  assert.ok(fs.existsSync(path.join(t.instance, 'mods', 'b.jar')));
  assert.ok(fs.existsSync(path.join(t.instance, 'config', 'good.ini')));
  assert.match(result.files[0].detail ?? '', /2 mods, 1 skipped/);
});

// --------------------------------------------------------------- modpack

console.log('\n.mrpack import');

/** Serves the mod files a modpack index points at, on loopback. */
async function serveFiles(files) {
  const server = http.createServer((req, res) => {
    const body = files.get(req.url);
    if (!body) {
      res.writeHead(404).end('missing');
      return;
    }
    res.writeHead(200, { 'content-length': body.length }).end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

await check('a modpack downloads its files and applies overrides', async () => {
  const t = await fresh();
  const modBytes = Buffer.from('pretend-mod-jar');
  const cfgBytes = Buffer.from('depth=8');
  const server = await serveFiles(new Map([['/mods/lithium.jar', modBytes]]));

  try {
    const file = writeZip(scratch(), 'pack.mrpack', (zip) => {
      zip.addFile(
        'modrinth.index.json',
        Buffer.from(
          JSON.stringify({
            formatVersion: 1,
            game: 'minecraft',
            versionId: '1.20.1',
            name: 'Test Pack',
            files: [
              {
                path: 'mods/lithium.jar',
                hashes: { sha1: sha1(modBytes), sha512: sha512(modBytes) },
                downloads: [`${server.base}/mods/lithium.jar`],
                env: { client: 'required' },
              },
              {
                // Optional client content is still installed; only `unsupported`
                // is left out.
                path: 'config/deep.json',
                hashes: { sha1: sha1(cfgBytes) },
                downloads: [`${server.base}/missing-by-design`],
                env: { client: 'optional' },
              },
            ],
            dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.16.9' },
          }),
        ),
      );
      zip.addFile('overrides/config/lithium.json', cfgBytes);
      zip.addFile('overrides/options.txt', Buffer.from('fov:80\n'));
    });

    const progress = [];
    const result = await mod.importFiles([file], t.target, {
      onProgress: (p) => progress.push(`${p.phase}:${p.fileName}`),
    });

    const entry = result.files[0];
    assert.equal(entry.kind, 'modpack');
    assert.equal(entry.ok, true, `expected ok, got: ${entry.error}`);
    // The declared file landed, verified against its sha512.
    assert.equal(readFileSync(path.join(t.instance, 'mods', 'lithium.jar'), 'utf8'), 'pretend-mod-jar');
    // overrides/ landed on top of the instance.
    assert.equal(readFileSync(path.join(t.instance, 'config', 'lithium.json'), 'utf8'), 'depth=8');
    assert.equal(readFileSync(path.join(t.instance, 'options.txt'), 'utf8'), 'fov:80\n');
    // The unreachable optional file is reported, not silently dropped.
    assert.match(entry.detail ?? '', /skipped/);
    assert.ok(entry.written.some((w) => w.endsWith('lithium.jar')));
    // Progress is attributed per file, not to the first file in the drop.
    assert.ok(progress.some((p) => p === 'done:pack.mrpack'));
  } finally {
    await server.close();
  }
});

await check('a modpack whose sha512 does not match is not installed', async () => {
  const t = await fresh();
  const modBytes = Buffer.from('real-content');
  const server = await serveFiles(new Map([['/mods/bad.jar', Buffer.from('tampered')]]));

  try {
    const file = writeZip(scratch(), 'bad.mrpack', (zip) => {
      zip.addFile(
        'modrinth.index.json',
        Buffer.from(
          JSON.stringify({
            formatVersion: 1,
            versionId: '1.20.1',
            files: [
              {
                path: 'mods/bad.jar',
                hashes: { sha512: sha512(modBytes) },
                downloads: [`${server.base}/mods/bad.jar`],
              },
            ],
          }),
        ),
      );
    });

    const result = await mod.importFiles([file], t.target);
    assert.equal(result.files[0].ok, true);
    // `download` retries then fails, so the file is reported and never written.
    assert.match(result.files[0].detail ?? '', /skipped/);
    assert.ok(!fs.existsSync(path.join(t.instance, 'mods', 'bad.jar')));
  } finally {
    await server.close();
  }
});

await check('a modpack path that escapes the instance is refused', async () => {
  const t = await fresh();
  const modBytes = Buffer.from('evil');
  const server = await serveFiles(new Map([['/evil.jar', modBytes]]));

  try {
    const file = writeZip(scratch(), 'evil.mrpack', (zip) => {
      zip.addFile(
        'modrinth.index.json',
        Buffer.from(
          JSON.stringify({
            formatVersion: 1,
            versionId: '1.20.1',
            files: [
              {
                path: '../../../../evil.jar',
                hashes: {},
                downloads: [`${server.base}/evil.jar`],
              },
            ],
          }),
        ),
      );
    });

    const result = await mod.importFiles([file], t.target);
    assert.equal(result.files[0].ok, true);
    assert.ok(!fs.existsSync(path.join(t.dir, 'instances', 'evil.jar')));
    assert.ok(!fs.existsSync(path.join(t.dir, 'evil.jar')));
    assert.match(result.files[0].detail ?? '', /skipped/);
  } finally {
    await server.close();
  }
});

await check('a .mrpack renamed to .zip is still read as a modpack', async () => {
  const t = await fresh();
  const modBytes = Buffer.from('renamed-mod');
  const server = await serveFiles(new Map([['/mods/named.jar', modBytes]]));

  try {
    const file = writeZip(scratch(), 'disguised.zip', (zip) => {
      zip.addFile(
        'modrinth.index.json',
        Buffer.from(
          JSON.stringify({
            formatVersion: 1,
            versionId: '1.20.1',
            files: [
              { path: 'mods/named.jar', hashes: { sha1: sha1(modBytes) }, downloads: [`${server.base}/mods/named.jar`] },
            ],
          }),
        ),
      );
    });

    const result = await mod.importFiles([file], t.target);
    assert.equal(result.files[0].kind, 'modpack');
    assert.ok(fs.existsSync(path.join(t.instance, 'mods', 'named.jar')));
  } finally {
    await server.close();
  }
});

await check('a zip with no modrinth index and nothing importable is reported', async () => {
  const t = await fresh();
  const file = writeZip(scratch(), 'empty-ish.zip', (zip) => {
    zip.addFile('readme.txt', Buffer.from('nothing here'));
  });

  const result = await mod.importFiles([file], t.target);
  // A loose file at the root is still copied, so this lands in the instance.
  assert.ok(fs.existsSync(path.join(t.instance, 'readme.txt')));
  assert.equal(result.files[0].kind, 'archive');
});

// ------------------------------------------------------------- metadata

console.log('\nmetadata');

await check('imported packs get titles in installed-packs.json', async () => {
  const t = await fresh();
  const jar = path.join(scratch(), 'sodium-extra-0.5.3.jar');
  fs.writeFileSync(jar, Buffer.from('jar'));
  const shader = writeZip(scratch(), 'bismuth-free-v8.zip', (zip) => {
    zip.addFile('shaders/lib/core.glsl', Buffer.from('void main(){}'));
  });

  const result = await mod.importFiles([jar, shader], t.target);
  assert.equal(result.files.length, 2);
  assert.deepEqual(result.touchedKinds.sort(), ['mod', 'shader']);
  assert.equal(result.added.length, 2);

  const metaFile = path.join(process.env.FLAME_USER_DATA, 'installed-packs.json');
  const saved = JSON.parse(readFileSync(metaFile, 'utf8'));
  // A file-derived title, not the raw file name.
  assert.equal(saved.entries['default/mod/sodium-extra-0.5.3.jar'].title, 'Sodium Extra');
  assert.equal(saved.entries['default/shader/bismuth-free-v8.zip'].title, 'Bismuth Free');
  // Imported files are not Flame-managed, so the engine repair pass leaves them.
  assert.equal(saved.entries['default/mod/sodium-extra-0.5.3.jar'].managed, false);
});

await check('imported packs appear in the installed list for the UI', async () => {
  const t = await fresh();
  const jar = path.join(scratch(), 'lithium-fabric-0.2.jar');
  fs.writeFileSync(jar, Buffer.from('jar'));

  await mod.importFiles([jar], t.target);
  const installed = mod.listInstalled('mod', t.target);
  const entry = installed.find((p) => p.fileName === 'lithium-fabric-0.2.jar');
  assert.ok(entry, 'imported mod missing from listInstalled');
  assert.equal(entry.title, 'Lithium Fabric');
  // Nothing is auto-enabled: a dropped mod must not be switched off, but an
  // imported pack must not be forced on either.
  assert.equal(entry.enabled, true);
});

await check('a mod dropped over a disabled copy becomes enabled', async () => {
  const t = await fresh();
  const disabled = path.join(t.instance, 'mods', 'optifine.jar.disabled');
  fs.mkdirSync(path.dirname(disabled), { recursive: true });
  fs.writeFileSync(disabled, Buffer.from('old'));

  const jar = path.join(scratch(), 'optifine.jar');
  fs.writeFileSync(jar, Buffer.from('new'));

  await mod.importFiles([jar], t.target);
  assert.ok(fs.existsSync(path.join(t.instance, 'mods', 'optifine.jar')));
  assert.ok(!fs.existsSync(disabled));
  const installed = mod.listInstalled('mod', t.target);
  assert.equal(installed.find((p) => p.fileName === 'optifine.jar')?.enabled, true);
});

await check('imports stay inside the instance they were dropped on', async () => {
  await fresh();
  const other = mod.createInstance({
    name: 'Second',
    gameVersion: '1.20.1',
    loader: { type: 'vanilla', version: '' },
  });
  const otherTarget = mod.targetFor(other.id);

  const jar = path.join(scratch(), 'shared.jar');
  fs.writeFileSync(jar, Buffer.from('jar'));

  await mod.importFiles([jar], otherTarget);
  assert.ok(fs.existsSync(path.join(otherTarget.dir, 'mods', 'shared.jar')));
  // The active instance is untouched: per-instance isolation is the whole point.
  assert.ok(!fs.existsSync(path.join(mod.instanceDir('default'), 'mods', 'shared.jar')));
});

console.log(`\n${passed} importer checks passed.`);
if (process.exitCode) console.log('importer suite FAILED');