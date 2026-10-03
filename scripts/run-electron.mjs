import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Spawn the real binary: Node >=18.20 refuses to spawn `.cmd` shims directly (EINVAL).
function resolveElectron() {
  const pkg = path.join(root, 'node_modules', 'electron');
  let exe = process.platform === 'win32' ? 'electron.exe' : 'electron';
  try {
    // path.txt holds the executable name relative to the package's `dist` folder.
    const fromFile = fs.readFileSync(path.join(pkg, 'path.txt'), 'utf8').trim();
    if (fromFile) exe = fromFile;
  } catch {
    /* use the default name */
  }
  return path.join(pkg, 'dist', exe);
}

const bin = resolveElectron();
if (!fs.existsSync(bin)) {
  console.error('[electron] binary not found. Run `npm install` first.');
  process.exit(1);
}

const child = spawn(bin, [path.join(root, 'dist/main/main.js')], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
  },
  windowsHide: false,
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
