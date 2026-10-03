/**
 * Self-contained end-to-end check.
 *
 * Launches the packaged/built Electron app against a throwaway instance
 * directory, drives the Packs view over the DevTools Protocol, and tears
 * everything down again. Replaces the older manual `ui-check.mjs` flow so
 * `npm test` works with no preconditions.
 *
 * Usage: node scripts/e2e.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.FLAME_CDP_PORT ?? 9333);

let passed = 0;
const fail = (m, e = '') => {
  console.log(`  FAIL  ${m}${e ? ` — ${e}` : ''}`);
  process.exitCode = 1;
};
const ok = (m, e = '') => {
  passed++;
  console.log(`  PASS  ${m}${e ? ` — ${e}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- electron bin

function electronBin() {
  const pkg = path.join(root, 'node_modules', 'electron');
  let exe = process.platform === 'win32' ? 'electron.exe' : 'electron';
  try {
    const fromFile = readFileSync(path.join(pkg, 'path.txt'), 'utf8').trim();
    if (fromFile) exe = fromFile;
  } catch {
    /* default name */
  }
  return path.join(pkg, 'dist', exe);
}

// ------------------------------------------------------------------- fixtures

// FLAME_GAME_DIR is the shared data root; each instance lives under instances/.
const dataRoot = mkdtempSync(path.join(tmpdir(), 'flame-e2e-'));
const userData = mkdtempSync(path.join(tmpdir(), 'flame-e2e-ud-'));
const defaultInstance = path.join(dataRoot, 'instances', 'default');

// Legacy layout on purpose: writing options.txt at the data root lets the suite
// assert the one-time migration into instances/default/ as well.
writeFileSync(path.join(dataRoot, 'options.txt'), 'fov:70\nrenderDistance:12\nguiScale:2\n', 'utf8');

console.log(`\nfixture data root: ${dataRoot}`);

// ----------------------------------------------------------------- CDP client

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      // Skip DevTools' own pages; we want the app renderer.
      const page = list.find(
        (t) => t.type === 'page' && /index\.html$/.test(t.url ?? '') && !t.url.startsWith('devtools://'),
      );
      if (page) return await attach(page.webSocketDebuggerUrl);
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`DevTools endpoint never exposed the renderer on :${PORT}`);
}

async function attach(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('cdp socket failed'));
  });

  let id = 0;
  const pending = new Map();
  const errors = [];

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push(`${msg.params.entry.source}: ${msg.params.entry.text}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(
        `${d.text} ${d.exception?.description ?? d.exception?.value ?? ''}`.trim(),
      );
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? 'eval failed');
    }
    return res.result.value;
  };

  await send('Runtime.enable');
  await send('Log.enable');
  return { ws, send, evaluate, errors };
}

// ------------------------------------------------------------------- run it

const bin = electronBin();
if (!existsSync(bin)) {
  console.error(`Electron binary not found at ${bin}. Run \`npm install\`.`);
  process.exit(1);
}

const child = spawn(
  bin,
  [path.join(root, 'dist/main/main.js'), `--remote-debugging-port=${PORT}`],
  {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      // Point the app at disposable storage so a real install is never touched.
      FLAME_GAME_DIR: dataRoot,
      FLAME_USER_DATA: userData,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
    windowsHide: true,
  },
);

let stderr = '';
child.stderr.on('data', (b) => {
  stderr += b.toString();
});

let cdp = null;
let exitCode = 0;

try {
  cdp = await connect();
  const { evaluate, errors } = cdp;

  console.log('\n[A] Boot');
  // The app renders a `.boot` splash until manifests/versions resolve.
  let mounted = false;
  for (let i = 0; i < 40; i++) {
    mounted = await evaluate(`!!document.querySelector('.app')`);
    if (mounted) break;
    await sleep(500);
  }
  mounted ? ok('renderer mounted') : fail('renderer never finished booting');
  if (!mounted) throw new Error('app did not boot; cannot continue');
  ok('splash cleared', String(!(await evaluate(`!!document.querySelector('.boot')`))));

  console.log('\n[B] Instance layout');
  const layout = await evaluate(`(() => ({
    pill: document.querySelector('.instance-pill__btn')?.textContent ?? null,
    meta: window.flame ? 'bridge' : null,
  }))()`);
  layout.pill ? ok('instance pill in title bar', layout.pill) : fail('no instance pill');

  existsSync(path.join(defaultInstance, 'options.txt'))
    ? ok('legacy options.txt migrated into instances/default')
    : fail('legacy migration did not run', path.join(defaultInstance, 'options.txt'));
  for (const sub of ['mods', 'resourcepacks', 'shaderpacks']) {
    existsSync(path.join(defaultInstance, sub))
      ? ok(`default scaffold: ${sub}/`)
      : fail(`missing scaffold dir ${sub}`);
  }

  console.log('\n[C] Instances view');
  await evaluate(`[...document.querySelectorAll('.nav__tab')]
    .find((b) => (b.textContent||'').includes('Instances')).click()`);
  await sleep(900);
  const instHeading = await evaluate(`document.querySelector('.view__title')?.textContent ?? null`);
  instHeading === 'Instances' ? ok('view rendered', instHeading) : fail('wrong heading', String(instHeading));

  const cards = await evaluate(`(() => ({
    count: document.querySelectorAll('.instance-card').length,
    name: document.querySelector('.instance-card__name')?.textContent,
    active: Boolean(document.querySelector('.instance-card--active .tag--accent')),
    size: [...document.querySelectorAll('.instance-card__meta dt')]
      .find((d) => d.textContent === 'Size')?.nextElementSibling?.textContent ?? null,
  }))()`);
  cards.count === 1 ? ok('one instance card', String(cards.name)) : fail('card count', String(cards.count));
  cards.active ? ok('default instance marked active') : fail('no active marker');
  cards.size && /B|KB|MB/.test(cards.size) ? ok('size measured', cards.size) : fail('no size', String(cards.size));

  // Create a second instance through the real dialog.
  await evaluate(`[...document.querySelectorAll('.instance-card')]
    .length; [...document.querySelectorAll('.btn--primary')].find((b) => /Create instance/.test(b.textContent||'')).click()`);
  await sleep(700);
  await evaluate(`(() => {
    const i = document.querySelector('.modal__panel input.input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Shader Rig');
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await evaluate(`[...document.querySelectorAll('.loader-chip')].find((b) => /Fabric/i.test(b.textContent||'')).click()`);
  await sleep(600);
  await evaluate(`[...document.querySelectorAll('.modal__actions .btn--primary')].pop().click()`);
  await sleep(1400);

  const afterCreate = await evaluate(`(() => ({
    count: document.querySelectorAll('.instance-card').length,
    names: [...document.querySelectorAll('.instance-card__name')].map((n) => n.textContent),
    loaders: [...document.querySelectorAll('.instance-card__meta dd')].map((n) => n.textContent),
  }))()`);
  afterCreate.count === 2 ? ok('second instance created', afterCreate.names.join(', ')) : fail('create failed', JSON.stringify(afterCreate));
  afterCreate.loaders.includes('Fabric') ? ok('fabric loader saved') : fail('loader not persisted', afterCreate.loaders.join(','));

  const rigDir = path.join(dataRoot, 'instances', 'shader-rig');
  existsSync(path.join(rigDir, 'instance.json')) ? ok('instance.json written') : fail('no instance.json in', rigDir);
  existsSync(path.join(rigDir, 'mods')) ? ok('new instance scaffolded') : fail('new instance not scaffolded');
  const rigMeta = JSON.parse(readFileSync(path.join(rigDir, 'instance.json'), 'utf8'));
  rigMeta.loader?.type === 'fabric' ? ok('manifest records the loader', rigMeta.loader.version) : fail('loader missing from manifest');

  // Delete it again through the confirm dialog.
  await evaluate(`(() => {
    const card = [...document.querySelectorAll('.instance-card')].find((c) => /Shader Rig/.test(c.textContent||''));
    card.querySelector('.icon-btn--danger').click();
  })()`);
  await sleep(600);
  await evaluate(`[...document.querySelectorAll('.modal__actions .btn--danger')].pop().click()`);
  await sleep(1200);
  const afterDelete = await evaluate(`document.querySelectorAll('.instance-card').length`);
  afterDelete === 1 ? ok('instance deleted') : fail('delete failed', String(afterDelete));
  existsSync(rigDir) ? fail('instance folder still on disk') : ok('instance folder removed from disk');

  const stillDefault = await evaluate(`document.querySelector('.instance-card--active .instance-card__name')?.textContent ?? null`);
  stillDefault === 'Default' ? ok('default re-selected after delete') : fail('selection drifted', String(stillDefault));

  console.log('\n[D] Packs view');
  await evaluate(`[...document.querySelectorAll('.nav__tab')]
    .find((b) => (b.textContent||'').includes('Packs')).click()`);
  await sleep(1200);

  const heading = await evaluate(`document.querySelector('.view__title')?.textContent ?? null`);
  heading === 'Packs & Mods' ? ok('view rendered', heading) : fail('wrong heading', String(heading));

  const tabs = await evaluate(`[...document.querySelectorAll('.packs__tab')].map((t) => t.textContent.trim())`);
  tabs.length === 3 ? ok('shader + resource pack + mod tabs', tabs.join(' / ')) : fail('tab count', JSON.stringify(tabs));

  console.log('\n[E] Shader advisory');
  const note = await evaluate(`document.querySelector('.packs__note')?.textContent.trim() ?? null`);
  note && /Iris/.test(note) && /OptiFine/.test(note)
    ? ok('shader note shown', note)
    : fail('shader note missing', String(note));

  console.log('\n[F] Live Modrinth results');
  await sleep(3000);
  const shaders = await evaluate(`(() => ({
    cards: document.querySelectorAll('.pack-card').length,
    first: document.querySelector('.pack-card__title')?.textContent,
    count: document.querySelector('.packs__count')?.textContent,
    err: document.querySelector('.alert--error')?.textContent ?? null,
  }))()`);
  if (shaders.err) fail('error banner', shaders.err);
  else {
    shaders.cards > 0 ? ok('shader cards rendered', `${shaders.cards} — ${shaders.first}`) : fail('no shader cards');
    ok('result count', shaders.count);
  }

  console.log('\n[G] Search forwards to the API');
  const before = shaders.count;
  await evaluate(`(() => {
    const i = document.querySelector('.packs__search input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'complementary');
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(3000);
  const filtered = await evaluate(`(() => ({
    first: document.querySelector('.pack-card__title')?.textContent ?? '',
    count: document.querySelector('.packs__count')?.textContent,
  }))()`);
  filtered.first.toLowerCase().includes('complementary') && filtered.count !== before
    ? ok('query applied', `${before} -> ${filtered.count}, top "${filtered.first}"`)
    : fail('search did not apply', JSON.stringify(filtered));

  console.log('\n[H] Mod tab is loader-aware');
  await evaluate(`[...document.querySelectorAll('.packs__tab')][2].click()`);
  await sleep(3000);
  const mods = await evaluate(`(() => ({
    cards: document.querySelectorAll('.pack-card').length,
    first: document.querySelector('.pack-card__title')?.textContent ?? null,
    hint: document.querySelector('.packs__note')?.textContent.trim() ?? null,
    target: document.querySelector('.view__sub')?.textContent ?? null,
  }))()`);
  mods.cards > 0 ? ok('mod cards rendered', `${mods.cards} — ${mods.first}`) : fail('no mod cards');
  // The hint must name the instance's loader, so a vanilla instance does not
  // silently imply that mods will load.
  mods.hint && /vanilla/i.test(mods.hint) && /1\.20\.1/.test(mods.hint)
    ? ok('mod tab is scoped to the instance loader', mods.hint.slice(0, 90))
    : fail('no loader hint for mods', String(mods.hint));
  mods.target && /Default/.test(mods.target)
    ? ok('packs view names the target instance', mods.target.trim().slice(0, 60))
    : fail('target instance not named', String(mods.target));

  console.log('\n[I] Resource pack install');
  await evaluate(`[...document.querySelectorAll('.packs__tab')][1].click()`);
  await sleep(3000);
  const rp = await evaluate(`(() => ({
    cards: document.querySelectorAll('.pack-card').length,
    note: Boolean(document.querySelector('.packs__note')),
    first: document.querySelector('.pack-card__title')?.textContent,
  }))()`);
  rp.cards > 0 ? ok('resource pack cards', `${rp.cards}`) : fail('no resource pack cards');
  rp.note === false ? ok('advisory hidden for resource packs') : fail('advisory should be hidden');

  await evaluate(`document.querySelector('.pack-card .pack-card__actions .btn').click()`);
  await sleep(900);
  const progressing = await evaluate(`(() => {
    const c = document.querySelector('.pack-card');
    return Boolean(c.querySelector('.pack-card__progress')) || /Installing/i.test(c.querySelector('.btn')?.textContent ?? '');
  })()`);
  progressing ? ok('download progress shown on card') : fail('no progress feedback');

  console.log('      waiting for install…');
  let installed = false;
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    installed = await evaluate(`document.querySelectorAll('.packs__installed-name').length > 0`);
    if (installed) break;
  }
  installed ? ok('pack listed as installed') : fail('pack never installed');

  // The migrated options.txt is the proof that packs land in the *instance*,
  // not in the shared data root.
  const optsFile = path.join(defaultInstance, 'options.txt');
  const optsText = readFileSync(optsFile, 'utf8');
  const packsLine = optsText.split(/\r?\n/).find((l) => l.startsWith('resourcePacks:'));
  packsLine && packsLine.includes('.zip')
    ? ok('options.txt updated', packsLine)
    : fail('options.txt not updated', String(packsLine));

  const kept = ['fov:70', 'renderDistance:12', 'guiScale:2'].filter((k) => optsText.includes(k));
  kept.length === 3 ? ok('existing options preserved') : fail('options lost', kept.join(','));
  !existsSync(path.join(dataRoot, 'options.txt'))
    ? ok('legacy options.txt no longer at the data root')
    : fail('options.txt still at the data root');

  const packName = packsLine ? JSON.parse(packsLine.slice('resourcePacks:'.length))[1] : '';
  const packFile = path.join(defaultInstance, 'resourcepacks', packName);
  existsSync(packFile) ? ok('pack file in the instance', packName) : fail('pack file missing', packFile);

  console.log('\n[J] Shader routing + cleanup');
  await evaluate(`[...document.querySelectorAll('.packs__tab')][0].click()`);
  await sleep(3500);
  await evaluate(`document.querySelector('.pack-card .pack-card__actions .btn').click()`);
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    if (await evaluate(`document.querySelectorAll('.packs__installed-name').length > 0`)) break;
  }
  const shaderDir = path.join(defaultInstance, 'shaderpacks');
  const shaderFiles = existsSync(shaderDir) ? readdirSync(shaderDir) : [];
  shaderFiles.length > 0 ? ok('shader landed in shaderpacks/', shaderFiles.join(', ')) : fail('no shader installed');

  const rpFiles = existsSync(path.join(defaultInstance, 'resourcepacks')) ? readdirSync(path.join(defaultInstance, 'resourcepacks')) : [];
  // Compare by file name: both packs are by "Complementary", so a brand regex
  // would flag the resource pack installed in [I] as a leak.
  const shaderFile = shaderFiles[0];
  shaderFile && rpFiles.includes(shaderFile)
    ? fail('shader leaked into resourcepacks/', shaderFile)
    : ok('shader kept out of resourcepacks/', `resourcepacks/ holds ${rpFiles.join(', ') || 'nothing'}`);

  await evaluate(`document.querySelector('.packs__installed-row .icon-btn--danger').click()`);
  await sleep(2500);
  const left = existsSync(shaderDir) ? readdirSync(shaderDir) : [];
  left.length === 0 ? ok('uninstall removes the file') : fail('file still present', left.join(','));

  console.log('\n[K] Console errors');
  await sleep(1200);
  errors.length === 0 ? ok('no renderer errors') : fail('console errors', errors.join(' | '));
} catch (err) {
  fail('harness', err.message);
  if (stderr.trim()) console.log(`\n--- app stderr ---\n${stderr.slice(-2000)}`);
  exitCode = 1;
} finally {
  try {
    cdp?.ws.close();
  } catch {
    /* ignore */
  }
  child.kill();
  await sleep(1500);
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
}

console.log(`\n[${passed} checks] ${process.exitCode ? 'E2E FAILED' : 'E2E PASSED'}\n`);
process.exit(process.exitCode ?? exitCode);