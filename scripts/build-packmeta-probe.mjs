/**
 * Probe bundle for src/main/packmeta.ts.
 *
 * packmeta imports `electron` only for `app.getPath('userData')`, and
 * `FLAME_USER_DATA` takes precedence over it, so the stub is a formality that
 * keeps the module loadable under plain Node.
 */
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = process.env.FLAME_PROBE_DIR ?? path.join(root, 'dist/test-sandbox');
fs.mkdirSync(sandbox, { recursive: true });

const stub = path.join(sandbox, 'electron-stub.js');
fs.writeFileSync(
  stub,
  `export const app = { getPath: () => ${JSON.stringify(sandbox)}, getVersion: () => '0.1.0' };
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('enc:' + s),
  decryptString: (b) => b.toString().replace(/^enc:/, ''),
};
`,
);

await build({
  entryPoints: [path.join(root, 'src/main/packmeta.ts')],
  outfile: path.join(root, 'dist/main/packmeta-probe.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  logLevel: 'error',
  alias: { electron: stub },
});

console.log('packmeta probe -> dist/main/packmeta-probe.mjs');