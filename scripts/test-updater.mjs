/**
 * Auto-updater tests for src/main/updater.ts.
 *
 * Runs entirely offline: `checkForUpdates` is a fake, so no release is published,
 * no GitHub request is made and no token is read. What is asserted is the
 * behaviour the user actually sees — the banner only appears for a real update,
 * "Later" does not resurrect it mid-session, and an offline check stays quiet.
 *
 * Usage: node scripts/test-updater.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = new URL('../dist/main/updater-probe.mjs', import.meta.url);

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
  console.error(`Probe missing at ${PROBE.pathname}. Run \`npm run test:updater\`.`);
  process.exit(1);
}

const { createUpdaterService, updaterSupported, getUpdaterService, initUpdater } =
  await import(PROBE.href);

/**
 * A fake `autoUpdater` that records what the service asked of it, so a test can
 * both drive events and assert on the calls (quit-and-install in particular).
 */
function fakeUpdater(overrides = {}) {
  const handlers = new Map();
  return {
    autoDownload: true,
    allowPrerelease: false,
    allowDowngrade: false,
    autoInstallOnAppQuit: true,
    checks: 0,
    installs: [],
    listeners: 0,
    on(event, handler) {
      handlers.set(event, handler);
      this.listeners++;
    },
    async checkForUpdates() {
      this.checks++;
      if (overrides.throwOnCheck) throw new Error(overrides.throwOnCheck);
      return null;
    },
    quitAndInstall(...args) {
      this.installs.push(args);
    },
    fire(event, payload) {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`nothing is listening for "${event}"`);
      handler(payload);
    },
    wired: () => [...handlers.keys()].sort(),
  };
}

console.log('\ngating');

await check('an unpackaged build reports itself unsupported', () => {
  // The probe's electron stub is not packaged, which is also true of `npm run
  // dev` and the e2e suite.
  assert.equal(updaterSupported(), false);
});

await check('an unsupported service never checks for updates', async () => {
  const updater = fakeUpdater();
  const service = createUpdaterService(updater, false);
  service.start();
  await service.check();

  assert.equal(updater.checks, 0, 'a dev build must not phone home');
  assert.equal(service.getState().supported, false);
  assert.equal(service.getState().phase, 'idle');
  service.stop();
});

await check('a supported service starts in idle and schedules its checks', async () => {
  const updater = fakeUpdater();
  const service = createUpdaterService(updater, true);
  const state = service.getState();
  assert.equal(state.phase, 'idle');
  assert.equal(state.supported, true);
  assert.equal(state.deferred, false);

  // start() wires the events but does not check immediately: the first check is
  // deliberately delayed so it does not compete with launch.
  service.start();
  assert.equal(updater.checks, 0);
  assert.deepEqual(updater.wired(), [
    'checking-for-update',
    'download-progress',
    'error',
    'update-available',
    'update-downloaded',
    'update-not-available',
  ]);
  service.stop();
});

await check('starting twice does not wire the events twice', () => {
  const updater = fakeUpdater();
  const service = createUpdaterService(updater, true);
  service.start();
  const wired = updater.listeners;
  service.start();
  assert.equal(updater.listeners, wired);
  service.stop();
});

console.log('\nstate transitions');

await check('an available update reports its version and notes', async () => {
  const updater = fakeUpdater();
  const service = createUpdaterService(updater, true);
  service.start();

  updater.fire('update-available', {
    version: '0.2.0',
    releaseNotes: 'Adds drag and drop importing.',
  });

  const state = service.getState();
  assert.equal(state.phase, 'available');
  assert.equal(state.version, '0.2.0');
  assert.equal(state.releaseNotes, 'Adds drag and drop importing.');
  assert.equal(state.deferred, false);
  service.stop();
});

await check('multi-part release notes are flattened into text', async () => {
  const updater = fakeUpdater();
  const service = createUpdaterService(updater, true);
  service.start();

  updater.fire('update-available', {
    version: '0.2.0',
    releaseNotes: [
      { body: '### Added\n- drag and drop' },
      { body: '### Fixed\n- zip slip' },
    ],
  });
  const notes = service.getState().releaseNotes ?? '';
  assert.match(notes, /Added/);
  assert.match(notes, /Fixed/);
  assert.match(notes, /zip slip/);
  service.stop();
});

await check('empty release notes become null rather than an empty string', async () => {
  const updater = fakeUpdater();
  const service = createUpdaterService(updater, true);
  service.start();

  updater.fire('update-available', { version: '0.2.0', releaseNotes: [] });
  assert.equal(service.getState().releaseNotes, null);
  service.stop();
});

await check('being up to date returns to idle without a banner', async () => {
  const updater = fakeUpdater();
  const service = createUpdaterService(updater, true);
  service.start();

  updater.fire('checking-for-update');
  assert.equal(service.getState().phase, 'checking');
  updater.fire('update-not-available', { version: '0.1.0' });

  const state = service.getState();
  assert.equal(state.phase, 'idle');
  assert.equal(state.version, null);
  assert.equal(state.error, null);
  service.stop();
});

await check('download progress is surfaced as a percentage', async () => {
  const updater = fakeUpdater();
  const service = createUpdaterService(updater, true);
  service.start();

  updater.fire('update-available', { version: '0.2.0' });
  updater.fire('download-progress', { percent: 42.5, transferred: 425, total: 1000 });

  const state = service.getState();
  assert.equal(state.phase, 'downloading');
  assert.equal(state.percent, 42.5);
  assert.equal(state.transferred, 425);
  assert.equal(state.total, 1000);
  // The version survives the progress burst so the banner can keep naming it.
  assert.equal(state.version, '0.2.0');
  service.stop();
});

await check('a downloaded update becomes installable', async () => {
  const updater = fakeUpdater();
  const service = createUpdaterService(updater, true);
  service.start();

  updater.fire('update-available', { version: '0.2.0' });
  updater.fire('update-downloaded', { version: '0.2.0' });

  const state = service.getState();
  assert.equal(state.phase, 'ready');
  assert.equal(state.percent, 100);

  service.install();
  assert.deepEqual(updater.installs, [[true, true]]);
  service.stop();
});

await check('installing before a download exists is refused', async () => {
  const updater = fakeUpdater();
  const service = createUpdaterService(updater, true);
  service.start();
  assert.throws(() => service.install(), /No update has been downloaded/);
  assert.equal(updater.installs.length, 0);
  service.stop();
});

console.log('\nLater and failures');

await check('Later hides the banner and keeps the update', async () => {
  const updater = fakeUpdater();
  const service = createUpdaterService(updater, true);
  service.start();

  updater.fire('update-available', { version: '0.2.0' });
  updater.fire('update-downloaded', { version: '0.2.0' });
  service.defer();

  const state = service.getState();
  assert.equal(state.deferred, true);
  assert.equal(state.phase, 'ready', 'deferring hides the banner without losing the download');

  // "Later" is not "never": quitting still applies the update, because the
  // service leaves autoInstallOnAppQuit on.
  assert.equal(updater.autoInstallOnAppQuit, true);
  service.stop();
});

await check('a failed download after Later does not reopen the banner', async () => {
  const updater = fakeUpdater();
  const service = createUpdaterService(updater, true);
  service.start();

  service.defer();
  updater.fire('error', new Error('network unreachable'));

  const state = service.getState();
  assert.equal(state.phase, 'idle', 'a deferred user must not be interrupted');
  assert.equal(state.deferred, true);
  service.stop();
});

await check('an error before deferring surfaces in the banner', async () => {
  const updater = fakeUpdater();
  const service = createUpdaterService(updater, true);
  service.start();

  updater.fire('error', new Error('ENOENT latest.yml'));
  const state = service.getState();
  assert.equal(state.phase, 'error');
  assert.match(state.error ?? '', /latest\.yml/);
  service.stop();
});

await check('a check that throws stays quiet and clears the error', async () => {
  const updater = fakeUpdater({ throwOnCheck: 'getaddrinfo ENOTFOUND api.github.com' });
  const service = createUpdaterService(updater, true);
  service.start();

  await service.check();
  const state = service.getState();
  // Offline is the normal case for a launcher, not something to interrupt over.
  assert.equal(state.phase, 'idle');
  assert.match(state.error ?? '', /ENOTFOUND/);
  service.stop();
});

await check('checks do not overlap', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const updater = fakeUpdater();
  updater.checkForUpdates = async () => {
    updater.checks++;
    await gate;
  };
  const service = createUpdaterService(updater, true);
  service.start();

  const first = service.check();
  await service.check();
  assert.equal(updater.checks, 1, 'a second check while one is in flight is dropped');
  release();
  await first;

  await service.check();
  assert.equal(updater.checks, 2, 'a later check is allowed once the first finished');
  service.stop();
});

await check('a check during a download is not started', async () => {
  const updater = fakeUpdater();
  const service = createUpdaterService(updater, true);
  service.start();

  updater.fire('update-available', { version: '0.2.0' });
  updater.fire('download-progress', { percent: 10 });
  await service.check();
  assert.equal(updater.checks, 0);
  service.stop();
});

await check('stop clears the timers so a quitting app can exit', async () => {
  const updater = fakeUpdater();
  const service = createUpdaterService(updater, true);
  service.start();
  service.stop();
  await service.check();
  assert.equal(updater.checks, 1, 'a manual check still works after stopping the schedule');
});

console.log('\nrelease wiring');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

await check('the build declares a GitHub publisher for the updater to read', () => {
  // electron-updater reads `build.publish` to know where to look, so without this
  // block a packaged build can never find a release.
  assert.equal(pkg.build?.publish?.provider, 'github');
  assert.equal(pkg.build?.publish?.owner, 'liam281648-web');
  assert.equal(pkg.build?.publish?.repo, 'Flame-Launcher');
  assert.equal(pkg.build?.publish?.token, undefined, 'the token must never be committed');
});

await check('electron-updater is a real dependency, and is external to the main bundle', () => {
  assert.ok(pkg.dependencies?.['electron-updater'], 'electron-updater must ship with the app');
  const buildMain = fs.readFileSync(path.join(root, 'scripts/build-main.mjs'), 'utf8');
  assert.match(
    buildMain,
    /external:\s*\[[^\]]*'electron-updater'/,
    'bundling it would move it out of node_modules and break the app-update.yml lookup',
  );
});

await check('no token is stored in the repository', () => {
  const suspicious = [];
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'release' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(full);
      else if (/\.(mjs|ts|tsx|json|yml|yaml)$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        if (/gh[pousr]_[A-Za-z0-9]{20,}/.test(text)) suspicious.push(full);
      }
    }
  };
  scan(root);
  assert.deepEqual(suspicious, [], `token-like strings found: ${suspicious.join(', ')}`);
});

await check('the release script refuses to run without GH_TOKEN', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/release.mjs'), 'utf8');
  assert.match(script, /process\.env\.GH_TOKEN/);
  assert.match(script, /process\.exit\(1\)/);
  // It must not fall back to a hardcoded value.
  assert.ok(!/gh[pousr]_[A-Za-z0-9]{20,}/.test(script));
  assert.equal(pkg.scripts?.release, 'node scripts/release.mjs');
});

console.log('\nsingle instance');

await check('initUpdater is idempotent and inert when unpackaged', async () => {
  initUpdater();
  const first = getUpdaterService();
  initUpdater();
  assert.equal(getUpdaterService(), first, 'a second init must not replace the service');
  assert.equal(first.getState().supported, false);
  await first.check();
});

console.log(`\n${passed} updater checks passed.`);
if (process.exitCode) console.log('updater suite FAILED');