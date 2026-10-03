/** Builds the ESM probe bundles the script tests import. */
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(root, 'src/main/launcher/packs.ts')],
  outfile: path.join(root, 'dist/main/packs-probe.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  external: ['electron'],
  logLevel: 'error',
});

// packmeta reaches for `app.getPath`, but FLAME_USER_DATA wins over it, so a
// stub is enough to make the module loadable under plain Node.
const sandbox = path.join(root, 'dist/test-sandbox');
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