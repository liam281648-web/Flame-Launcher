import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { store } from './store';

/**
 * Launcher data folder.
 *
 * Holds the shared, version-keyed caches (`assets/`, `libraries/`, `versions/`)
 * alongside `instances/`. Sharing the caches across instances is the whole point
 * of keeping them at this level: two instances on different Minecraft versions
 * still reuse every common library, and the several hundred MB of game assets
 * are stored exactly once.
 *
 * Per-instance game data (mods, packs, saves, `options.txt`) never lives here —
 * it lives in `instances/<id>/`, which the game receives as `--gameDir`.
 */
export function dataRoot(): string {
  // Test hook used by the e2e suite so installs never touch a real instance.
  const override = process.env.FLAME_GAME_DIR;
  if (override) return override;
  const custom = store.getSettings().gameDir?.trim();
  if (custom) return custom;
  return path.join(process.env.APPDATA ?? appDataFallback(), '.minecraft');
}

function appDataFallback(): string {
  return path.join(process.env.HOME ?? process.env.USERPROFILE ?? '.', 'AppData', 'Roaming');
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function sha1Of(buf: Buffer): string {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/** `.mrpack` indexes publish sha512; Modrinth's search API only publishes sha1. */
export function sha512Of(buf: Buffer): string {
  return crypto.createHash('sha512').update(buf).digest('hex');
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Serialises `value` to `file` without ever leaving a half-written document
 * behind: the JSON goes to a sibling temp file which is then renamed over the
 * target. A crash or a full disk therefore leaves the previous contents intact
 * rather than a truncated file that the next read would have to salvage.
 *
 * `fs.renameSync` is atomic within a volume on both NTFS and POSIX, and the temp
 * file is always created in the destination directory so the rename cannot
 * cross a filesystem boundary.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  // Unique per write so two concurrent saves cannot clobber each other's temp.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* the temp file is best-effort cleanup */
    }
    throw err;
  }
}

/** Reads and parses a JSON file, returning null when missing or unreadable. */
export function readJsonFile<T>(file: string): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  // Editors on Windows happily prepend a BOM, which JSON.parse rejects outright.
  const cleaned = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!cleaned.trim()) return null;
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

/**
 * Resolves `child` and asserts it really lives inside `parent`.
 *
 * Guards path traversal for anything driven by a renderer-supplied id: the
 * string checks alone are not enough because a symlinked directory inside the
 * parent can still point elsewhere, so the real path is compared too when both
 * sides exist. Throws rather than returning a bad path, because every caller
 * goes on to delete or write.
 */
export function assertInside(parent: string, child: string): string {
  const resolved = path.resolve(child);
  const rel = path.relative(path.resolve(parent), resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to touch "${resolved}" — outside ${parent}`);
  }

  // `realpathSync` throws when the leaf does not exist yet, which is the normal
  // case while creating an instance. Resolve the deepest existing ancestor and
  // confirm the remainder stays inside.
  let probe = resolved;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(probe) : fs.realpathSync(probe);
      const realRel = path.relative(fs.realpathSync(path.resolve(parent)), path.join(real, ...tail));
      if (realRel === '' || realRel.startsWith('..') || path.isAbsolute(realRel)) {
        throw new Error(`Refusing to touch "${resolved}" — resolves outside ${parent}`);
      }
      return resolved;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Refusing to touch')) throw err;
      const parentDir = path.dirname(probe);
      if (parentDir === probe) return resolved;
      tail.unshift(path.basename(probe));
      probe = parentDir;
    }
  }
}