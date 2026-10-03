import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { app } from 'electron';
import type { JavaInfo } from '../../shared/types';
import { USER_AGENT } from '../http';
import { probeJava } from './java';

export interface JavaInstallProgress {
  phase: 'downloading' | 'extracting' | 'done' | 'error';
  label: string;
  current: number;
  total: number;
  error?: string;
}

interface AdoptiumAsset {
  release_name: string;
  binary: {
    package: { name: string; link: string; size: number; checksum?: string };
  };
}

export const SUPPORTED_MAJORS = [8, 17, 21] as const;

function runtimesRoot(): string {
  return path.join(app.getPath('userData'), 'runtimes');
}

function javaExecutableIn(dir: string): string {
  return path.join(dir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
}

export function runtimeDirFor(major: number): string {
  return path.join(runtimesRoot(), `jdk-${major}`);
}

export function installedJava(major: number): JavaInfo | null {
  const exe = javaExecutableIn(runtimeDirFor(major));
  if (!fs.existsSync(exe)) return null;
  return probeJava(exe);
}

/** All Temurin runtimes previously installed by the launcher. */
export function listInstalledRuntimes(): JavaInfo[] {
  const root = runtimesRoot();
  const majors = new Set<number>(SUPPORTED_MAJORS);
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const match = entry.isDirectory() && /^jdk-(\d+)$/.exec(entry.name);
      if (match) majors.add(Number(match[1]));
    }
  } catch {
    /* nothing installed yet */
  }

  const out: JavaInfo[] = [];
  for (const major of majors) {
    const info = installedJava(major);
    if (info) out.push(info);
  }
  return out.sort((a, b) => b.major - a.major);
}

function adoptiumArch(): string {
  if (process.arch === 'arm64') return 'aarch64';
  if (process.arch === 'ia32') return 'x86';
  return 'x64';
}

function adoptiumOs(): string {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

async function resolveAsset(major: number): Promise<AdoptiumAsset> {
  const base =
    `https://api.adoptium.net/v3/assets/latest/${major}/hotspot` +
    `?architecture=${adoptiumArch()}&os=${adoptiumOs()}&vendor=eclipse`;

  // A JRE is ~45 MB versus ~200 MB for a full JDK, and the game only needs a
  // runtime — fall back to the JDK when no JRE build is published.
  for (const imageType of ['jre', 'jdk']) {
    const res = await fetch(`${base}&image_type=${imageType}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) continue;
    const assets = (await res.json()) as AdoptiumAsset[];
    const asset = assets.find((a) => a.binary?.package?.link);
    if (asset) return asset;
  }
  throw new Error(`No Temurin ${major} build for ${adoptiumOs()}/${adoptiumArch()}.`);
}

function extractArchive(archive: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  if (archive.endsWith('.zip')) {
    const zip = new AdmZip(archive);
    zip.extractAllTo(destDir, true);
    return;
  }
  // tar.gz (macOS / Linux): system tar is always present
  execFileSync('tar', ['-xzf', archive, '-C', destDir], { stdio: 'pipe', windowsHide: true });
}

/** Finds the extracted JDK root (the folder that contains bin/java). */
function findJdkRoot(dir: string): string | null {
  const exeName = process.platform === 'win32' ? 'java.exe' : 'java';
  const direct = javaExecutableIn(dir);
  if (fs.existsSync(direct)) return dir;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(dir, entry.name);
    if (fs.existsSync(path.join(candidate, 'bin', exeName))) return candidate;
  }
  return null;
}

async function download(url: string, dest: string, onProgress: (cur: number, total: number) => void): Promise<void> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(600000),
  });
  if (!res.ok || !res.body) throw new Error(`Java download failed (HTTP ${res.status}).`);

  const total = Number(res.headers.get('content-length') ?? 0);
  const tmp = `${dest}.part`;
  const chunks: Buffer[] = [];
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(Buffer.from(value));
      received += value.length;
      onProgress(received, total);
    }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(tmp, Buffer.concat(chunks));
  fs.renameSync(tmp, dest);
}

function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Downloads and unpacks an Eclipse Temurin JDK into the launcher's runtime
 * folder, then probes it. Returns the freshly installed JVM.
 */
export async function installJava(
  major: number,
  onProgress: (p: JavaInstallProgress) => void,
): Promise<JavaInfo> {
  const existing = installedJava(major);
  if (existing) {
    onProgress({ phase: 'done', label: `Java ${major} ready`, current: 1, total: 1 });
    return existing;
  }

  let asset: AdoptiumAsset;
  try {
    asset = await resolveAsset(major);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress({ phase: 'error', label: 'Catalog unreachable', current: 0, total: 1, error: message });
    throw new Error(message);
  }

  const archiveName = asset.binary.package.name;
  const archivePath = path.join(runtimesRoot(), 'downloads', archiveName);
  const archiveSize = asset.binary.package.size || 1;

  onProgress({
    phase: 'downloading',
    label: `Downloading Java ${major} (${(archiveSize / (1024 * 1024)).toFixed(0)} MB)`,
    current: 0,
    total: archiveSize,
  });

  try {
    await download(asset.binary.package.link, archivePath, (current, total) => {
      onProgress({
        phase: 'downloading',
        label: `Downloading Java ${major}`,
        current,
        total: total || archiveSize,
      });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress({ phase: 'error', label: 'Download failed', current: 0, total: 1, error: message });
    throw new Error(message);
  }

  onProgress({ phase: 'extracting', label: `Installing Java ${major}`, current: 0, total: 1 });

  const staging = path.join(runtimesRoot(), `.staging-${major}-${Date.now()}`);
  try {
    extractArchive(archivePath, staging);
    const jdkRoot = findJdkRoot(staging);
    if (!jdkRoot) throw new Error('Archive did not contain a JDK.');

    const finalDir = runtimeDirFor(major);
    removeDir(finalDir);
    fs.mkdirSync(path.dirname(finalDir), { recursive: true });
    fs.renameSync(jdkRoot, finalDir);

    if (process.platform !== 'win32') {
      for (const sub of fs.readdirSync(path.join(finalDir, 'bin'))) {
        try {
          fs.chmodSync(path.join(finalDir, 'bin', sub), 0o755);
        } catch {
          /* ignore */
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress({ phase: 'error', label: 'Install failed', current: 0, total: 1, error: message });
    throw new Error(message);
  } finally {
    removeDir(staging);
    try {
      if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
    } catch {
      /* keep cache on failure */
    }
  }

  const info = installedJava(major);
  if (!info) {
    const message = `Java ${major} was unpacked but could not be started.`;
    onProgress({ phase: 'error', label: 'Install failed', current: 0, total: 1, error: message });
    throw new Error(message);
  }

  onProgress({ phase: 'done', label: `Java ${major} installed`, current: 1, total: 1 });
  return info;
}

/** Non-blocking helper: install a runtime without failing the caller silently. */
export function installJavaInBackground(major: number): void {
  void installJava(major, () => undefined).catch(() => undefined);
}

/**
 * Resolves a JVM that satisfies `required`, downloading one when necessary.
 *
 * `maxMajor` bounds the search (pre-1.17 Minecraft only runs on Java 8–16),
 * so legacy versions get a matching runtime instead of the newest one.
 */
export async function ensureJava(
  required: number,
  maxMajor: number,
  preferred: JavaInfo | null,
  onProgress: (p: JavaInstallProgress) => void,
): Promise<JavaInfo> {
  const fits = (info: JavaInfo | null): info is JavaInfo =>
    Boolean(info && info.major >= required && info.major <= maxMajor);

  if (fits(preferred)) return preferred;

  const installed = listInstalledRuntimes()
    .filter(fits)
    .sort((a, b) => a.major - b.major); // closest match to the requirement
  if (installed.length > 0) {
    onProgress({
      phase: 'done',
      label: `Using Java ${installed[0].major}`,
      current: 1,
      total: 1,
    });
    return installed[0];
  }

  const target =
    SUPPORTED_MAJORS.find((m) => m >= required && m <= maxMajor) ??
    Math.min(maxMajor, Math.max(required, ...SUPPORTED_MAJORS));

  const cached = installedJava(target);
  if (cached) {
    onProgress({ phase: 'done', label: `Using Java ${cached.major}`, current: 1, total: 1 });
    return cached;
  }

  return installJava(target, onProgress);
}

export function spawnJavaVersion(javaPath: string): void {
  // Utility for diagnostics; intentionally fire-and-forget.
  try {
    const child = spawn(javaPath, ['-version'], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined);
  } catch {
    /* ignore */
  }
}
