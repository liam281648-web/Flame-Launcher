/**
 * Probes for src/main/store.ts config-recovery logic.
 *
 * store.ts imports `electron`, so this bundle aliases `electron` to a small stub
 * that fakes `app.getPath` (pointing at a temp dir) and `safeStorage`. That lets
 * the real load/flush code run under plain Node.
 */
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Deterministic sandbox inside dist/ so test-store.mjs can find it without env setup.
const sandbox = process.env.FLAME_PROBE_DIR ?? path.join(root, 'dist/test-sandbox');
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(sandbox, { recursive: true });

fs.writeFileSync(
  path.join(sandbox, 'electron-stub.js'),
  `export const app = {
  getPath: (name) => ${JSON.stringify(sandbox)},
  getVersion: () => '0.1.0',
};
let next = 0;
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('enc:' + s),
  decryptString: (b) => b.toString().replace(/^enc:/, ''),
  __next: () => String(next++),
};
`,
);

await build({
  entryPoints: [path.join(root, 'src/main/store.ts')],
  outfile: path.join(root, 'dist/main/store-probe.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  logLevel: 'error',
  alias: { electron: path.join(sandbox, 'electron-stub.js') },
});

fs.writeFileSync(path.join(sandbox, '.keep'), 'ok');
console.log(`store probe -> dist/main/store-probe.mjs (sandbox: ${sandbox})`);