/**
 * Builds the probe bundles the test scripts import, then runs them.
 * Usage: node scripts/run-tests.mjs [--skip-e2e]
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skipE2e = process.argv.includes('--skip-e2e');

function run(label, cmd, args, env = {}) {
  console.log(`\n${'='.repeat(64)}\n${label}\n${'='.repeat(64)}`);
  const res = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  });
  return res.status ?? 1;
}

let status = 0;

// ---- static checks
status |= run('TypeScript', 'npm', ['run', 'typecheck']);

// ---- probe bundles
status |= run('Build probes', 'node', ['scripts/build-packs-probe.mjs']);
status |= run('Build store probe', 'node', ['scripts/build-store-probe.mjs']);
status |= run('Build instances probe', 'node', ['scripts/build-instances-probe.mjs']);
status |= run('Build importer probe', 'node', ['scripts/build-importer-probe.mjs']);
status |= run('Build updater probe', 'node', ['scripts/build-updater-probe.mjs']);

if (status !== 0) {
  console.error('\nStatic checks failed �?" skipping runtime suites.\n');
  process.exit(status);
}

// ---- config durability
status |= run('Config durability', 'node', ['scripts/test-store.mjs']);

// ---- instance manager
status |= run('Instance manager', 'node', ['scripts/test-instances.mjs']);

// ---- Modrinth API contract
status |= run('Modrinth API', 'node', ['scripts/test-modrinth.mjs']);

// ---- drag-and-drop importing (loopback HTTP only, no external network)
status |= run('Importer', 'node', ['scripts/test-importer.mjs']);

// ---- auto-update state machine (fake updater, no token and no network)
status |= run('Updater', 'node', ['scripts/test-updater.mjs']);

if (skipE2e) {
  console.log('\n[e2e] skipped (--skip-e2e)');
} else {
  const probe = path.join(root, 'dist/main/main.js');
  if (!existsSync(probe)) {
    console.error('\n[e2e] dist/main/main.js missing — run `npm run build` first.');
    status = 1;
  } else {
    status |= run('Electron end-to-end', 'node', ['scripts/e2e.mjs']);
  }
}

console.log(`\n${'='.repeat(64)}`);
console.log(status === 0 ? 'ALL SUITES PASSED' : 'SOME SUITES FAILED');
console.log('='.repeat(64));
process.exit(status);