/**
 * Probe bundle for src/main/instances.ts.
 *
 * instances.ts pulls in `store`, which imports `electron`. As with the store
 * probe, `electron` is aliased to a stub whose `app.getPath` points at a temp
 * sandbox so the real persistence and migration code runs under plain Node.
 *
 * `FLAME_GAME_DIR` decides the data root, so the suite can point it at a
 * throwaway directory and exercise the real migration path.
 */
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = process.env.FLAME_PROBE_DIR ?? path.join(root, 'dist/test-sandbox');
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(sandbox, { recursive: true });

fs.writeFileSync(
  path.join(sandbox, 'electron-stub.js'),
  `export const app = {
  getPath: (name) => ${JSON.stringify(sandbox)},
  getVersion: () => '0.1.0',
};
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('enc:' + s),
  decryptString: (b) => b.toString().replace(/^enc:/, ''),
};
`,
);

await build({
  entryPoints: [path.join(root, 'src/main/instances.ts')],
  outfile: path.join(root, 'dist/main/instances-probe.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  logLevel: 'error',
  alias: { electron: path.join(sandbox, 'electron-stub.js') },
});

console.log('instances probe -> dist/main/instances-probe.mjs');