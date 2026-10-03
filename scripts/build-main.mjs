import { build, context } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  // electron-updater must stay external: it reads `app-update.yml` from the
  // packaged resources relative to `__dirname`, so bundling it would move the
  // module out of `node_modules` and break the lookup. electron-builder ships
  // production dependencies into the asar, so requiring it still resolves.
  external: ['electron', 'electron-updater'],
  absWorkingDir: root,
};

const targets = [
  {
    entryPoints: [path.join(root, 'src/main/main.ts')],
    outfile: path.join(root, 'dist/main/main.js'),
  },
  {
    entryPoints: [path.join(root, 'src/main/preload.ts')],
    outfile: path.join(root, 'dist/main/preload.js'),
  },
];

async function run() {
  if (watch) {
    const ctxs = await Promise.all(targets.map((t) => context({ ...common, ...t })));
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('[main] watching…');
  } else {
    await Promise.all(targets.map((t) => build({ ...common, ...t })));
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
