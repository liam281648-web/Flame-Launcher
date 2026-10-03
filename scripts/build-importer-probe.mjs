/**
 * Probe bundle for src/main/importer.ts.
 *
 * The importer reaches `modrinth` and `packmeta` for folder and metadata
 * helpers, and those pull in `store`, which imports `electron`. As with the
 * instances probe, `electron` is aliased to a stub whose `app.getPath` points at
 * a temp sandbox so the real classification, extraction and metadata code runs
 * under plain Node.
 *
 * `FLAME_GAME_DIR` decides the data root, so the suite can point it at a
 * throwaway directory and exercise the real instance layout.
 */
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = path.join(root, 'dist/test-sandbox');
fs.mkdirSync(sandbox, { recursive: true });

const stub = path.join(sandbox, 'electron-stub.js');
fs.writeFileSync(
  stub,
  `export const app = {
  getPath: () => ${JSON.stringify(sandbox)},
  getVersion: () => '0.1.0',
  isPackaged: false,
};
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('enc:' + s),
  decryptString: (b) => b.toString().replace(/^enc:/, ''),
};
`,
);

// The importer only exports its own surface, but the suite also needs the
// instance helpers it is built on (to build a target) and `listInstalled` (to
// assert the UI sees what was imported). Re-exporting them from a synthetic
// entry keeps the test driving the real modules rather than a copy.
const ENTRY = `
export * from './importer';
export { createInstance, ensureInstancesRoot, instanceDir } from './instances';
export { listInstalled, targetFor } from './modrinth';
`;

await build({
  stdin: {
    contents: ENTRY,
    resolveDir: path.join(root, 'src/main'),
    loader: 'ts',
  },
  outfile: path.join(root, 'dist/main/importer-probe.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  logLevel: 'error',
  // adm-zip reaches for `fs`/`zlib` through a runtime `require`, which ESM output
  // cannot satisfy. It stays external and Node resolves it from node_modules.
  external: ['adm-zip'],
  alias: { electron: stub },
});

console.log('importer probe -> dist/main/importer-probe.mjs');