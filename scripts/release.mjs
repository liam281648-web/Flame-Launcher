/**
 * Builds a Windows installer and publishes it to GitHub Releases.
 *
 * Usage: npm run release
 *
 * The token is read from the GH_TOKEN environment variable and is deliberately
 * never read from, or written to, anything in the repository: electron-builder
 * needs `GH_TOKEN` in the environment, and CI supplies it as a secret. Passing it
 * as `--config.publish.token` would also work but makes it a process argument,
 * where it is visible to every other process on the machine and lands in shell
 * history.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(
  await import('node:fs/promises').then((fs) =>
    fs.readFile(path.join(root, 'package.json'), 'utf8'),
  ),
);
const publish = pkg.build?.publish ?? {};

if (!process.env.GH_TOKEN) {
  console.error(
    [
      '',
      '  GH_TOKEN is not set, so there is nothing to publish with.',
      '',
      '  In PowerShell:',
      '    $env:GH_TOKEN = "<your token>"',
      '',
      '  A fine-grained token needs only:',
      `    repository "${publish.owner}/${publish.repo}"  (Contents: read & write)`,
      '',
      '  Wanted scope: public repository, or none if the repo is private.',
      '  Do not commit the token — CI should provide it as a secret.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

if (publish.provider !== 'github' || !publish.owner || !publish.repo) {
  console.error('build.publish must name a GitHub owner and repo before releasing.');
  process.exit(1);
}

console.log(`\nPublishing to ${publish.owner}/${publish.repo} as a GitHub release.\n`);

/** Runs a command, inheriting stdio so build output streams to the terminal. */
function run(label, command, args) {
  console.log(`--- ${label}`);
  const res = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });
  if (res.status !== 0) {
    console.error(`\n${label} failed with exit code ${res.status}.`);
    process.exit(res.status ?? 1);
  }
}

// `npm run build` typechecks and produces `dist/`, which electron-builder packs.
// electron-builder does not run it on its own, so it is a separate step here.
run('build', 'npm', ['run', 'build']);
// Uploads the installer, its blockmap and the `latest.yml` manifest that the
// auto-updater reads to decide whether a newer build exists.
run('publish', 'electron-builder', ['--win', '--publish', 'always']);

console.log(`\nRelease ${pkg.version} published.`);