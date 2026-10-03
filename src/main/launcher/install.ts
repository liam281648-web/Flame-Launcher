import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { download, mapLimit } from '../http';
import { dataRoot, ensureDir } from '../fsutil';
import { platformOs, resolveVersion, rulesAllow, type ResolvedVersion } from './manifest';

export interface InstallProgress {
  stage: 'version' | 'client' | 'libraries' | 'natives' | 'assets' | 'logging' | 'done';
  label: string;
  current: number;
  total: number;
}

export interface InstallResult extends ResolvedVersion {
  librariesDir: string;
  classpath: string[];
  nativesDir: string;
  assetsDir: string;
  loggingConfigPath?: string;
}

function libraryPath(lib: any): string | null {
  return lib?.downloads?.artifact?.path ?? null;
}

function nativeClassifier(lib: any): string | null {
  const natives = lib?.natives as Record<string, string> | undefined;
  if (!natives) return null;
  const os = platformOs();
  const key = natives[os];
  if (!key) return null;
  const classifiers = lib?.downloads?.classifiers ?? {};
  const withArch = key.replace('${arch}', '64');
  if (classifiers[withArch]) return withArch;
  if (classifiers[key]) return key;
  const alt = Object.keys(classifiers).find(
    (k) => k.includes(`natives-${os}`) && !k.includes('javadoc'),
  );
  return alt ?? null;
}

/**
 * Minecraft 1.19+ ships natives as their own Maven coordinate with a fourth
 * segment (`org.lwjgl:lwjgl:3.4.3:natives-windows`) instead of a
 * `downloads.classifiers` entry or a `natives` block. Mojang already filters
 * those entries by `os` rule, so anything that survived `rulesAllow` is the
 * right platform and must be unpacked into nativesDir.
 */
function nativeCoordinate(lib: any): boolean {
  const parts = String(lib?.name ?? '').split(':');
  return parts.length >= 4 && /natives/i.test(parts[3]);
}

function extractNatives(jarPath: string, dest: string): void {
  const zip = new AdmZip(jarPath);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;
    if (name.startsWith('META-INF/')) continue;
    if (!/\.(so|dll|dylib|jnilib|jar)$/i.test(name)) continue;
    // Natives jars nest the shared library under `windows/x64/org/lwjgl/…`;
    // java.library.path only searches the root, so flatten them.
    const target = path.join(dest, path.basename(name));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
  }
}

/**
 * Downloads everything the vanilla client needs into the *shared* cache root:
 * `versions/`, `libraries/`, `assets/` and the natives. None of it is instance
 * specific, so a second instance on the same Minecraft version costs nothing —
 * it only needs its own game directory, which holds no downloaded data.
 */
export async function installVersion(
  versionId: string,
  onProgress: (p: InstallProgress) => void,
  installDir = dataRoot(),
): Promise<InstallResult> {
  const resolved = await resolveVersion(versionId, installDir, (label, current, total) =>
    onProgress({
      stage: label === 'Game client' ? 'client' : 'version',
      label,
      current,
      total,
    }),
  );
  const json = resolved.json;

  const librariesDir = path.join(installDir, 'libraries');
  const nativesDir = ensureDir(path.join(resolved.dir, 'natives'));
  const assetsDir = path.join(installDir, 'assets');

  const classpath: string[] = [];
  const libs: any[] = Array.isArray(json.libraries) ? json.libraries : [];

  onProgress({ stage: 'libraries', label: 'Libraries', current: 0, total: libs.length });
  let done = 0;
  await mapLimit(libs, 16, async (lib) => {
    try {
      if (rulesAllow(lib.rules)) {
        const rel = libraryPath(lib);
        if (rel) {
          const dest = path.join(librariesDir, rel);
          const url = lib.downloads.artifact.url;
          if (url) await download(url, dest, { sha1: lib.downloads.artifact.sha1 });
          else if (!fs.existsSync(dest)) throw new Error(`No mirror for ${lib.name}`);
          classpath.push(dest);

          // Modern natives live in the artifact itself and must also be
          // unpacked, or the game dies on `UnsatisfiedLinkError` before the
          // window ever opens.
          if (nativeCoordinate(lib) && fs.existsSync(dest)) {
            try {
              extractNatives(dest, nativesDir);
            } catch (err) {
              console.warn('[install] native extract failed for', lib.name, err);
            }
          }
        }

        const classifier = nativeClassifier(lib);
        if (classifier && lib.downloads.classifiers[classifier]) {
          const meta = lib.downloads.classifiers[classifier];
          const dest = path.join(librariesDir, meta.path);
          if (meta.url) await download(meta.url, dest, { sha1: meta.sha1 });
          try {
            if (fs.existsSync(dest)) extractNatives(dest, nativesDir);
          } catch (err) {
            console.warn('[install] native extract failed for', lib.name, err);
          }
        }
      }
    } catch (err) {
      console.warn('[install] library failed', lib?.name, err);
      throw err;
    } finally {
      done++;
      onProgress({ stage: 'libraries', label: 'Libraries', current: done, total: libs.length });
    }
  });

  classpath.push(resolved.clientJar);

  // --- assets -------------------------------------------------------------
  const assetIndexId: string = json.assetIndex?.id ?? json.assets ?? 'legacy';
  const assetIndexUrl: string | undefined = json.assetIndex?.url;
  const indexFile = path.join(assetsDir, 'indexes', `${assetIndexId}.json`);

  if (assetIndexUrl && !fs.existsSync(indexFile)) {
    onProgress({ stage: 'assets', label: 'Asset index', current: 0, total: 1 });
    await download(assetIndexUrl, indexFile, { sha1: json.assetIndex.sha1, timeoutMs: 180000 });
    onProgress({ stage: 'assets', label: 'Asset index', current: 1, total: 1 });
  }

  let assetTotal = 0;
  let assetDone = 0;
  if (fs.existsSync(indexFile)) {
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as {
      objects?: Record<string, { hash: string; size: number }>;
    };
    const objects = Object.values(index.objects ?? {});
    assetTotal = objects.length;
    const missing = objects.filter((o) => {
      const p = path.join(assetsDir, 'objects', o.hash.slice(0, 2), o.hash);
      try {
        return !fs.existsSync(p) || fs.statSync(p).size !== o.size;
      } catch {
        return true;
      }
    });
    onProgress({ stage: 'assets', label: 'Game assets', current: 0, total: assetTotal });
    await mapLimit(missing, 32, async (obj) => {
      const dest = path.join(assetsDir, 'objects', obj.hash.slice(0, 2), obj.hash);
      await download(`https://resources.download.minecraft.net/${obj.hash.slice(0, 2)}/${obj.hash}`, dest, {
        sha1: obj.hash,
        timeoutMs: 180000,
      });
      assetDone++;
      onProgress({
        stage: 'assets',
        label: 'Game assets',
        current: Math.min(assetDone + (assetTotal - missing.length), assetTotal),
        total: assetTotal,
      });
    });
  }

  // --- logging config ------------------------------------------------------
  let loggingConfigPath: string | undefined;
  const logging = json.logging?.client;
  if (logging?.file?.url) {
    onProgress({ stage: 'logging', label: 'Logging config', current: 0, total: 1 });
    const dest = path.join(assetsDir, 'log-configs', logging.file.id ?? 'client.xml');
    await download(logging.file.url, dest, { sha1: logging.file.sha1 });
    loggingConfigPath = dest;
    onProgress({ stage: 'logging', label: 'Logging config', current: 1, total: 1 });
  }

  onProgress({ stage: 'done', label: 'Ready', current: 1, total: 1 });

  return {
    ...resolved,
    librariesDir,
    classpath,
    nativesDir,
    assetsDir,
    loggingConfigPath,
  };
}

export function isInstalled(versionId: string, installDir = dataRoot()): boolean {
  return fs.existsSync(path.join(installDir, 'versions', versionId, `${versionId}.jar`));
}
