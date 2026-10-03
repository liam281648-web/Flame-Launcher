import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ImportFileResult,
  ImportKind,
  ImportResult,
  InstalledPack,
  PackKind,
} from '../shared/types';
import { PACK_FOLDER } from '../shared/types';
import { assertInside, ensureDir } from './fsutil';
import { download, mapLimit } from './http';
import { packDirFor, titleFromFileName, type PackTarget } from './modrinth';
import { flushPackMeta, packMetaKey, recordPackMeta } from './packmeta';

/**
 * Drag-and-drop installer for packs and modpacks.
 *
 * Everything here treats the dropped file as untrusted: it is an arbitrary
 * archive the user picked out of a Downloads folder, so the extractor refuses
 * absolute paths, drive letters and `..` segments before touching the disk, and
 * every write is asserted to land inside the instance directory.
 *
 * Routing rules, in the order they are tried, because the containers overlap:
 *
 *  1. `.jar`  -> `mods/`
 *  2. `.mrpack` -> index is parsed, mods downloaded, `overrides/` extracted
 *  3. a zip with a `shaders/` folder -> `shaderpacks/`
 *  4. a zip with `pack.mcmeta` and no mod manifest -> `resourcepacks/`
 *  5. a bare instance backup (`mods/`, `resourcepacks/`, `config/`, …) -> routed
 *     entry by entry
 *
 * Shader detection has to precede resource-pack detection: shader packs ship a
 * `pack.mcmeta` too, so the reverse order files every shader as a texture pack.
 */

/** Extensions the drop overlay advertises. Anything else is rejected up front. */
export const IMPORT_EXTENSIONS = ['.jar', '.zip', '.mrpack'] as const;

/** Jar manifests that mark a zip as a mod rather than a resource pack. */
const MOD_MANIFESTS = [
  'fabric.mod.json',
  'quilt.mod.json',
  'mods.toml',
  'mcmod.info',
  'neoforge.mods.toml',
  'META-INF/mods.toml',
  'META-INF/neoforge.mods.toml',
];

/** Archive metadata that is never part of a pack. */
const JUNK = ['__MACOSX/', '.DS_Store', 'Thumbs.db'];

/**
 * Folders a bare instance backup is expected to carry. Anything else at the top
 * level is copied to the instance root, which is what `overrides/` does.
 *
 * Values are the destination folder names, which is what the path has to name;
 * `config` is not a `PackKind` because Flame never tracks it as a pack.
 */
const CONTAINER_ROUTES: Record<string, string> = {
  mods: PACK_FOLDER.mod,
  resourcepacks: PACK_FOLDER.resourcepack,
  shaderpacks: PACK_FOLDER.shader,
  config: 'config',
};

interface ZipShape {
  /** Has a `pack.mcmeta` at its root: resource packs and shader packs both do. */
  hasPackMcmeta: boolean;
  /** Has a loader manifest, so the zip is a mod and never a pack. */
  hasModManifest: boolean;
  /** Has a `shaders/` folder carrying actual GLSL. */
  hasShaders: boolean;
  /** Has a `modrinth.index.json`, i.e. it is a `.mrpack` in disguise. */
  hasModrinthIndex: boolean;
}

function entryPath(entry: AdmZip.IZipEntry): string {
  // Backslashes show up in zips produced by older Windows tools; normalising
  // here means the segment maths below only has to handle one separator.
  return entry.entryName.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Splits an archive path into its segments, dropping the `.` noise.
 * Returns an empty array for entries that cannot name a file, such as `.`.
 */
function segmentsOf(name: string): string[] {
  return name.split('/').filter((part) => part.length > 0 && part !== '.');
}

function isJunk(name: string): boolean {
  return JUNK.some((junk) => name === junk || name.startsWith(junk));
}

/**
 * Describes an archive well enough to decide where it belongs.
 *
 * Deliberately structural rather than name-based: a pack called
 * `resourcepacks.zip` containing shader GLSL is a shader pack.
 */
export function sniffZip(zip: AdmZip): ZipShape {
  const shape: ZipShape = {
    hasPackMcmeta: false,
    hasModManifest: false,
    hasShaders: false,
    hasModrinthIndex: false,
  };

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entryPath(entry);
    if (isJunk(name)) continue;
    const segments = segmentsOf(name);
    if (segments.length === 0) continue;

    if (segments[0].toLowerCase() === 'pack.mcmeta') shape.hasPackMcmeta = true;
    if (MOD_MANIFESTS.includes(name)) shape.hasModManifest = true;
    if (segments[0].toLowerCase() === 'modrinth.index.json') shape.hasModrinthIndex = true;

    // Shader packs sometimes wrap everything in a versioned top folder, so any
    // segment may be the `shaders` directory. `assets/` is excluded because
    // resource packs use it too, and a GLSL leaf is required so an unrelated
    // folder that happens to be called `shaders` is not mistaken for a pack.
    const shadersAt = segments.findIndex(
      (part) => part.toLowerCase() === 'shaders' && segments[0].toLowerCase() !== 'assets',
    );
    if (shadersAt !== -1) {
      const leaf = segments[segments.length - 1].toLowerCase();
      if (/\.(glsl|vsh|fsh|csh|vert|frag|geom|comp)$/.test(leaf)) shape.hasShaders = true;
    }
  }

  return shape;
}

/**
 * Maps a sniffed archive to the folder it installs as, or null when it is not a
 * pack and should be extracted as a backup instead.
 *
 * Only the two kinds Minecraft reads from inside a zip qualify. A `mods/`
 * container deliberately does not: a bundle of jars is a backup to unpack, and
 * copying the whole zip into `mods/` would leave Minecraft unable to load a
 * single mod in it. A loader manifest also disqualifies the archive, because a
 * mod's `pack.mcmeta` must never make it look like a texture pack.
 */
export function packKindOf(shape: ZipShape): PackKind | null {
  if (shape.hasModManifest) return null;
  if (shape.hasShaders) return 'shader';
  if (shape.hasPackMcmeta) return 'resourcepack';
  return null;
}

// ------------------------------------------------------------ path safety

/**
 * Turns an archive entry name into an absolute path under `root`, or throws.
 *
 * Three separate rejections matter here, because `path.join` silently repairs
 * most traversal attempts: `..` segments, POSIX-absolute names, and Windows
 * drive letters such as `C:\Windows\System32`. `assertInside` is the final
 * backstop and compares real paths, so a symlink planted earlier in the
 * extraction cannot be used to escape either.
 */
/**
 * True for entry names that name a location rather than a place under the
 * instance: POSIX-absolute (`/etc/x`, `//srv/x`) and Windows drive-letter paths.
 *
 * This runs on the raw entry name, before `remap` splits it into segments.
 * Splitting first would drop the leading slash and quietly turn `/etc/passwd`
 * into a relative path, which is worse than refusing it: the file would be
 * written inside the instance as if the attacker had asked for that.
 */
function isAbsoluteEntry(name: string): boolean {
  const normalized = name.replace(/\\/g, '/');
  return /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/');
}

/**
 * Turns an archive entry name into an absolute path under `root`, or throws.
 *
 * `path.join` silently repairs most traversal attempts, so `..` segments are
 * rejected outright and `assertInside` is the final backstop: it compares real
 * paths, so a symlink planted earlier in the extraction cannot be used to escape
 * either.
 */
function resolveEntry(root: string, name: string): string {
  if (isAbsoluteEntry(name)) {
    throw new Error(`Refusing absolute path in archive: ${name}`);
  }
  const normalized = name.replace(/\\/g, '/');
  const segments = segmentsOf(normalized);
  if (segments.some((part) => part === '..')) {
    throw new Error(`Refusing path traversal in archive: ${name}`);
  }
  if (segments.length === 0) {
    throw new Error(`Refusing empty archive entry: ${name}`);
  }
  return assertInside(root, path.join(root, ...segments));
}

/**
 * Writes every entry of `zip` beneath `destRoot`.
 *
 * `remap` decides where an entry belongs, which is what separates a shader pack
 * (kept as one archive) from a backup (torn into folders). Throwing from
 * `remap` aborts that one entry and is reported, so a single malicious path
 * cannot discard an otherwise good import.
 */
function extractEntries(
  zip: AdmZip,
  destRoot: string,
  remap: (segments: string[]) => string | null,
  written: string[],
  skipped: string[],
): void {
  for (const entry of zip.getEntries()) {
    const name = entryPath(entry);
    if (isJunk(name)) continue;

    let target: string;
    try {
      // Refused before `remap`, which would otherwise strip the leading slash.
      if (isAbsoluteEntry(name)) throw new Error(`Refusing absolute path in archive: ${name}`);
      const segments = segmentsOf(name);
      if (segments.length === 0) continue;
      const remapped = remap(segments);
      if (remapped === null) continue;
      target = resolveEntry(destRoot, remapped);
    } catch (err) {
      skipped.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    try {
      if (entry.isDirectory) {
        ensureDir(target);
        continue;
      }
      ensureDir(path.dirname(target));
      fs.writeFileSync(target, entry.getData());
      written.push(target);
    } catch (err) {
      skipped.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Copies `src` to `dest`, refusing when the two are the same file. */
function copyFileInto(src: string, dest: string): void {
  if (path.resolve(src) === path.resolve(dest)) {
    throw new Error('That file is already in this instance.');
  }
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

/**
 * Makes sure `dest` is the enabled copy.
 *
 * A mod is enabled by the *absence* of the `.disabled` suffix, so importing
 * `foo.jar` while `foo.jar.disabled` is present would leave the newly dropped
 * mod switched off. The stale copy is removed instead, matching what a
 * Modrinth install does.
 */
function clearDisabledCopy(dest: string): void {
  try {
    fs.unlinkSync(`${dest}.disabled`);
  } catch {
    /* nothing to clear */
  }
}

// ------------------------------------------------------------ .mrpack

interface MrpackFile {
  path: string;
  downloads: string[];
  hashes?: { sha1?: string; sha512?: string };
  /** `required` and `optional` are installed; `unsupported` is not. */
  env?: { client?: string };
}

interface MrpackIndex {
  name?: string;
  versionId?: string;
  summary?: string;
  files?: MrpackFile[];
  dependencies?: Record<string, string>;
}

function parseMrpackIndex(zip: AdmZip): MrpackIndex | null {
  const entry = zip.getEntry('modrinth.index.json');
  if (!entry) return null;
  try {
    return JSON.parse(entry.getData().toString('utf8')) as MrpackIndex;
  } catch {
    return null;
  }
}

/**
 * Installs a `.mrpack`: downloads every required file into its declared path
 * inside the instance and applies `overrides/` on top.
 *
 * The index's `path` is attacker-controlled in exactly the same way a zip entry
 * name is, so it goes through the same `resolveEntry` guard against the
 * instance root rather than being joined blindly.
 */
async function installModpack(
  zip: AdmZip,
  target: PackTarget,
  onProgress: (received: number, total: number) => void,
): Promise<{ written: string[]; skipped: string[] }> {
  const index = parseMrpackIndex(zip);
  if (!index) throw new Error('modrinth.index.json is missing or not valid JSON.');

  const root = ensureDir(target.dir);
  const written: string[] = [];
  const skipped: string[] = [];

  const files = (index.files ?? []).filter(
    (file) => (file.env?.client ?? 'required') !== 'unsupported',
  );

  // Modrinth publishes several mirrors per file; the first that answers wins.
  let done = 0;
  const results = await mapLimit(files, 4, async (file) => {
    // The path comes from the index, which is third-party data. Refusing one bad
    // entry must not discard the rest of the pack, so the guard lives here rather
    // than around the whole import.
    let dest: string;
    try {
      dest = resolveEntry(root, file.path);
    } catch (err) {
      return {
        ok: false as const,
        dest: '',
        source: file.path,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    ensureDir(path.dirname(dest));
    let lastError: unknown;
    for (const url of file.downloads ?? []) {
      try {
        await download(url, dest, {
          sha1: file.hashes?.sha1,
          sha512: file.hashes?.sha512,
          onProgress,
          timeoutMs: 300000,
        });
        clearDisabledCopy(dest);
        done++;
        onProgress(done, files.length);
        return { ok: true as const, dest, source: file.path };
      } catch (err) {
        lastError = err;
      }
    }
    return {
      ok: false as const,
      dest,
      source: file.path,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    };
  });

  for (const result of results) {
    if (result.ok) written.push(result.dest);
    else skipped.push(`${result.source}: ${result.error ?? 'download failed'}`);
  }

  // `overrides/` is the author-supplied local half of the pack: configs, options,
  // resource packs — whatever was not expressible as a download.
  extractEntries(
    zip,
    root,
    (segments) => {
      if (segments[0].toLowerCase() !== 'overrides') return null;
      return segments.slice(1).join('/');
    },
    written,
    skipped,
  );

  return { written, skipped };
}

// ------------------------------------------------------- archive routing

/**
 * Decides where one entry of a bare backup lands.
 *
 * A top-level `mods/`, `resourcepacks/`, `shaderpacks/` or `config/` folder is
 * honoured; everything else is copied to the instance root, which is what
 * `overrides/` does and what makes a `saves/` or `options.txt` survive.
 *
 * The result is resolved against the instance root, so it has to name the
 * destination folder as well as the file. Returning just the tail would quietly
 * flatten `mods/jei.jar` into the instance root and the game would never load it.
 */
function backupRoute(segments: string[]): string {
  const head = segments[0].toLowerCase();
  const route = CONTAINER_ROUTES[head];
  // A lone `mods/` entry is the directory itself, not a file inside it.
  if (route && segments.length > 1) {
    return [route, ...segments.slice(1)].join('/');
  }
  return segments.join('/');
}

/**
 * Writes a pack archive into its folder verbatim.
 *
 * Copying the original bytes is deliberate. A shader or resource pack is read
 * from inside the zip by Minecraft, never expanded onto disk by Flame, so the
 * archive's internal layout is not a traversal vector for us — and rewriting it
 * would strip the exact compression and comments the author shipped.
 */
function installPackArchive(
  kind: PackKind,
  fileName: string,
  source: string,
  target: PackTarget,
): string[] {
  const dir = ensureDir(packDirFor(kind, target));
  const dest = assertInside(dir, path.join(dir, fileName));
  copyFileInto(source, dest);
  clearDisabledCopy(dest);
  return [dest];
}

/** Per-file progress, attributed to the file that is actually moving. */
export interface ImportProgress {
  fileName: string;
  phase: 'queued' | 'working' | 'done' | 'error';
  /** Bytes for a `.mrpack` download, file count for an extraction. */
  current: number;
  total: number;
  detail: string | null;
  error: string | null;
}

export interface ImportOptions {
  /**
   * Progress callback. Fires per file rather than per drop, so a ten-file drag
   * never reports every modpack's bytes against the first file.
   */
  onProgress?: (progress: ImportProgress) => void;
}

/**
 * Imports one dropped file.
 *
 * Never throws: a failure is reported on the returned result so that a drop of
 * ten files reports eight successes and two reasons rather than one opaque error.
 */
export async function importFile(
  filePath: string,
  target: PackTarget,
  opts: ImportOptions = {},
): Promise<ImportFileResult> {
  const fileName = path.basename(filePath);
  const report = (progress: ImportProgress) => opts.onProgress?.(progress);
  const fail = (kind: ImportKind, error: unknown): ImportFileResult => {
    const message = error instanceof Error ? error.message : String(error);
    report({ fileName, phase: 'error', current: 0, total: 0, detail: null, error: message });
    return { fileName, kind, ok: false, error: message, detail: null, written: [] };
  };

  report({ fileName, phase: 'queued', current: 0, total: 0, detail: null, error: null });

  if (!fs.existsSync(filePath)) return fail('unsupported', 'File no longer exists.');

  const ext = path.extname(fileName).toLowerCase();
  if (!(IMPORT_EXTENSIONS as readonly string[]).includes(ext)) {
    return fail('unsupported', `${ext || 'That file type'} is not supported.`);
  }

  report({ fileName, phase: 'working', current: 0, total: 0, detail: null, error: null });

  try {
    if (ext === '.jar') {
      const dir = ensureDir(packDirFor('mod', target));
      const dest = assertInside(dir, path.join(dir, fileName));
      copyFileInto(filePath, dest);
      clearDisabledCopy(dest);
      return finish(fileName, 'mod', 'Mod installed', [dest], report);
    }

    const zip = new AdmZip(filePath);
    const shape = sniffZip(zip);
    const written: string[] = [];
    const skipped: string[] = [];

    // A `.mrpack` is a zip, so the extension alone is not proof; the index file
    // is. Renaming one to `.zip` must not turn it into an opaque folder dump.
    if (ext === '.mrpack' || shape.hasModrinthIndex) {
      const result = await installModpack(zip, target, (current, total) =>
        report({ fileName, phase: 'working', current, total, detail: null, error: null }),
      );
      written.push(...result.written);
      skipped.push(...result.skipped);
      return finish(fileName, 'modpack', describeWrites(written, skipped), written, report);
    }

    const kind = packKindOf(shape);
    if (kind) {
      written.push(...installPackArchive(kind, fileName, filePath, target));
      return finish(fileName, kind, describeWrites(written, skipped), written, report);
    }

    // Nothing recognised: treat it as a bare instance backup and route its
    // contents by folder, which is how people actually share modded instances.
    extractEntries(zip, ensureDir(target.dir), backupRoute, written, skipped);
    if (written.length === 0) {
      return fail('unsupported', 'Nothing importable was found inside this archive.');
    }
    return finish(fileName, 'archive', describeWrites(written, skipped), written, report);
  } catch (err) {
    const kind: ImportKind = ext === '.mrpack' ? 'modpack' : 'archive';
    return fail(kind, err);
  }
}

function finish(
  fileName: string,
  kind: ImportKind,
  detail: string,
  written: string[],
  report: (progress: ImportProgress) => void,
): ImportFileResult {
  report({
    fileName,
    phase: 'done',
    current: written.length,
    total: written.length,
    detail,
    error: null,
  });
  return { fileName, kind, ok: true, error: null, detail, written };
}

/** Summarises a multi-file extraction for the toast. */
function describeWrites(written: string[], skipped: string[]): string {
  const mods = written.filter((f) => path.basename(path.dirname(f)) === PACK_FOLDER.mod).length;
  const packs = written.filter((f) => path.basename(path.dirname(f)) === PACK_FOLDER.resourcepack).length;
  const shaders = written.filter((f) => path.basename(path.dirname(f)) === PACK_FOLDER.shader).length;
  const parts: string[] = [];
  if (mods) parts.push(`${mods} mod${mods === 1 ? '' : 's'}`);
  if (packs) parts.push(`${packs} resource pack${packs === 1 ? '' : 's'}`);
  if (shaders) parts.push(`${shaders} shader pack${shaders === 1 ? '' : 's'}`);
  if (!parts.length) parts.push(`${written.length} file${written.length === 1 ? '' : 's'}`);
  if (skipped.length) parts.push(`${skipped.length} skipped`);
  return parts.join(', ');
}

/**
 * Records display metadata for every pack an import created, so imported packs
 * show a real title in the Installed list instead of a raw file stem.
 *
 * `installed-packs.json` is flushed rather than left on its debounce timer: the
 * user is about to see this list, and a crash in the next few hundred
 * milliseconds should not lose the names.
 */
export function recordImportedPacks(
  target: PackTarget,
  written: string[],
  mcVersion: string | null = null,
): void {
  const seen = new Set<string>();

  for (const file of written) {
    const folder = path.basename(path.dirname(file));
    const kind = (Object.keys(PACK_FOLDER) as PackKind[]).find((k) => PACK_FOLDER[k] === folder);
    if (!kind) continue;
    if (path.extname(file).toLowerCase() !== (kind === 'mod' ? '.jar' : '.zip')) continue;

    const fileName = path.basename(file);
    const key = packMetaKey(target.instanceId, kind, fileName);
    if (seen.has(key)) continue;
    seen.add(key);

    // Managed stays false: Flame did not install this from Modrinth, so the
    // shader-engine repair pass must never try to overwrite it.
    recordPackMeta(target.instanceId, kind, fileName, {
      projectId: null,
      title: titleFromFileName(fileName),
      version: null,
      iconUrl: null,
      mcVersion,
      managed: false,
    });
  }

  flushPackMeta();
}

/**
 * Imports a whole drop, newest metadata first so the Installed list reflects it
 * immediately. Files are processed in order rather than in parallel: a modpack
 * download already saturates the link, and serial writes keep `recordImportedPacks`
 * from interleaving with another import's metadata pass.
 */
export async function importFiles(
  paths: string[],
  target: PackTarget,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const files: ImportFileResult[] = [];
  const written: string[] = [];

  for (const filePath of paths) {
    const result = await importFile(filePath, target, opts);
    files.push(result);
    written.push(...result.written);
  }

  recordImportedPacks(target, written);

  const touched = new Set<PackKind>();
  for (const file of written) {
    const folder = path.basename(path.dirname(file));
    const kind = (Object.keys(PACK_FOLDER) as PackKind[]).find((k) => PACK_FOLDER[k] === folder);
    if (kind) touched.add(kind);
  }

  return {
    instanceId: target.instanceId,
    files,
    touchedKinds: [...touched],
    added: summarizeAdded(files, written),
  };
}

function summarizeAdded(files: ImportFileResult[], written: string[]): InstalledPack[] {
  if (files.every((f) => !f.ok)) return [];
  const out: InstalledPack[] = [];
  for (const file of written) {
    const folder = path.basename(path.dirname(file));
    const kind = (Object.keys(PACK_FOLDER) as PackKind[]).find((k) => PACK_FOLDER[k] === folder);
    if (!kind) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    out.push({
      kind,
      fileName: path.basename(file),
      path: file,
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      // Nothing is auto-enabled: a dropped shader would otherwise hijack the
      // next launch, and an imported config is not a pack the user selected.
      enabled: false,
      title: titleFromFileName(path.basename(file)),
      projectId: null,
      version: null,
      iconUrl: null,
      mcVersion: null,
      managed: false,
    });
  }
  return out;
}