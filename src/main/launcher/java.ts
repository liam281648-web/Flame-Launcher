import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { JavaInfo } from '../../shared/types';

function parseVersion(raw: string): JavaInfo | null {
  const m = raw.match(/version\s+"([^"]+)"/) ?? raw.match(/version\s+(\S+)/);
  if (!m) return null;
  const ver = m[1];
  const parts = ver.split('.');
  let major = Number(parts[0]);
  if (parts[0] === '1' && parts[1]) major = Number(parts[1]);
  if (!Number.isFinite(major)) return null;
  return { path: '', version: ver, major };
}

export function probeJava(binPath: string): JavaInfo | null {
  try {
    // `java -version` prints to stderr, so combine both streams before parsing.
    const res = spawnSync(binPath, ['-version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    });
    if (res.error || res.status !== 0) return null;
    const info = parseVersion(`${res.stderr ?? ''}\n${res.stdout ?? ''}`);
    if (info) info.path = binPath;
    return info;
  } catch {
    return null;
  }
}

function javaExecutable(dir: string): string {
  return path.join(dir, process.platform === 'win32' ? 'java.exe' : 'java');
}

function collectCandidates(explicit?: string): string[] {
  const out = new Set<string>();

  if (explicit?.trim()) out.add(explicit.trim());

  if (process.env.JAVA_HOME) out.add(javaExecutable(path.join(process.env.JAVA_HOME, 'bin')));

  if (process.platform === 'win32') {
    try {
      const where = execFileSync('where', ['java'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      });
      for (const line of where.split(/\r?\n/)) if (line.trim()) out.add(line.trim());
    } catch {
      /* not on PATH */
    }

    const roots = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs'),
      process.env.USERPROFILE,
    ].filter(Boolean) as string[];

    const jdkRoots = [
      'Java',
      'Eclipse Adoptium',
      'Microsoft',
      'Zulu',
      'Amazon Corretto',
      'BellSoft',
      'SapMachine',
      'Semeru',
    ];
    for (const root of roots) {
      for (const sub of jdkRoots) {
        const base = path.join(root, sub);
        if (!fs.existsSync(base)) continue;
        try {
          for (const entry of fs.readdirSync(base)) {
            out.add(javaExecutable(path.join(base, entry)));
          }
        } catch {
          /* unreadable */
        }
      }
      const jdks = path.join(root, '.jdks');
      if (fs.existsSync(jdks)) {
        try {
          for (const entry of fs.readdirSync(jdks)) out.add(javaExecutable(path.join(jdks, entry)));
        } catch {
          /* ignore */
        }
      }
    }
  } else {
    const standard = [
      '/usr/bin/java',
      '/usr/local/bin/java',
      '/Library/Java/JavaVirtualMachines',
      `${process.env.HOME ?? ''}/.sdkman/candidates/java/current/bin/java`,
      `${process.env.HOME ?? ''}/.jdks`,
    ];
    for (const p of standard) {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        try {
          for (const entry of fs.readdirSync(p)) out.add(javaExecutable(path.join(p, entry)));
        } catch {
          /* ignore */
        }
      } else {
        out.add(p);
      }
    }
  }

  return [...out];
}

/** Finds the newest usable JVM, preferring an explicit path when one is configured. */
export function detectJava(explicit?: string): JavaInfo | null {
  if (explicit?.trim()) {
    const probe = probeJava(explicit.trim());
    if (probe) return probe;
  }

  const found: JavaInfo[] = [];
  for (const candidate of collectCandidates()) {
    const info = probeJava(candidate);
    if (info) found.push(info);
  }
  if (found.length === 0) return null;
  found.sort((a, b) => b.major - a.major);
  return found[0];
}
