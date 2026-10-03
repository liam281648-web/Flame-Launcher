/**
 * Probe bundle for src/main/updater.ts.
 *
 * The updater is pure state machine plus a thin `app.isPackaged` gate, so the
 * only thing Node cannot provide is the `electron` import. Aliasing it to a stub
 * with `isPackaged: false` lets the suite drive the packaged/unpackaged decision
 * and every event transition with a fake `autoUpdater`.
 *
 * No network and no GH_TOKEN: `checkForUpdates` is supplied by the test.
 */
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = path.join(root, 'dist/test-sandbox');
fs.mkdirSync(sandbox, { recursive: true });

const stub = path.join(sandbox, 'electron-stub-updater.js');
fs.writeFileSync(
  stub,
  `export const app = {
  getPath: () => ${JSON.stringify(sandbox)},
  getVersion: () => '0.1.0',
  isPackaged: false,
};
export const ipcMain = { on() {}, handle() {}, removeHandler() {} };
`,
);

await build({
  entryPoints: [path.join(root, 'src/main/updater.ts')],
  outfile: path.join(root, 'dist/main/updater-probe.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  logLevel: 'error',
  alias: { electron: stub },
});

console.log('updater probe -> dist/main/updater-probe.mjs');