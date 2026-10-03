import path from 'node:path';
import fs from 'node:fs';
import type {
  InstalledPack,
  PackKind,
  PackProject,
  PackSearchPage,
  PackSearchQuery,
  PackVersion,
  PackVersionFile,
} from '../shared/types';
import { PACK_FOLDER, PACK_KINDS } from '../shared/types';
import { download, getJson } from './http';
import { ensureDir } from './fsutil';
import { activeInstance, instanceDir } from './instances';
import { forgetPackMeta, getPackMeta, packMetaKey, prunePackMeta, recordPackMeta } from './packmeta';
import { readActiveShader, readEnabledPacks, writeActiveShader, writeEnabledPacks } from './launcher/packs';

/**
 * Modrinth v2 API. Unauthenticated by design — the public rate limit is 300
 * requests/minute, which is far more than a launcher browsing pages needs.
 */
const API = 'https://api.modrinth.com/v2';

const SEARCH_LIMIT_MAX = 100;

/**
 * Where a pack operation applies: one instance's directory plus its id, which
 * scopes the metadata side-car. Both are needed because the directory alone is
 * not a safe key — the id is what the renderer and the side-car agree on.
 */
export interface PackTarget {
  instanceId: string;
  /** Absolute instance directory; the game sees this as `--gameDir`. */
  dir: string;
}

/** Resolves the active instance into a pack target. */
export function activeTarget(): PackTarget {
  const meta = activeInstance();
  return { instanceId: meta.id, dir: instanceDir(meta.id) };
}

/** Resolves any instance id into a pack target, validating the id first. */
export function targetFor(instanceId: string): PackTarget {
  return { instanceId, dir: instanceDir(instanceId) };
}

interface RawHit {
  project_id: string;
  slug: string;
  project_type: string;
  title: string;
  description: string;
  icon_url: string | null;
  downloads: number;
  follows: number;
  date_modified: string;
  author?: string;
  author_id?: string;
}

interface RawSearchResponse {
  hits: RawHit[];
  offset: number;
  limit: number;
  total_hits: number;
}

interface RawFile {
  filename: string;
  size: number;
  url: string;
  hashes?: { sha1?: string; sha512?: string };
}

interface RawProjectVersion {
  id: string;
  version_number: string;
  name: string;
  date_published: string;
  version_type: string;
  game_versions: string[];
  loaders: string[];
  files: RawFile[];
}

/** Modrinth indexes snapshots under names like `23w31a`, which never match a MC version. */
function isSnapshot(versionId: string): boolean {
  return /^\d{2,3}w\d{2}[a-z]$/.test(versionId);
}

interface RawProject {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  icon_url: string | null;
  downloads: number;
  follows: number;
  date_modified: string;
  author?: string;
  author_id?: string;
  project_type: string;
}

/**
 * Fetches one project's metadata. Search hits carry a trimmed-down shape, so
 * this is what gives a freshly installed pack its real title, icon and author.
 */
export async function fetchProject(projectId: string, kind: PackKind): Promise<PackProject> {
  const data = await getJson<RawProject>(
    `${API}/project/${encodeURIComponent(projectId)}`,
  );
  return toProject(
    {
      project_id: data.project_id,
      slug: data.slug,
      project_type: data.project_type,
      title: data.title,
      description: data.description ?? '',
      author: data.author,
      author_id: data.author_id,
      icon_url: data.icon_url,
      downloads: data.downloads ?? 0,
      follows: data.follows ?? 0,
      date_modified: data.date_modified,
    },
    // Trust the caller's kind: a project id is unambiguous but the response is
    // not guaranteed to carry the type on every endpoint.
    kind,
  );
}

function toProject(hit: RawHit, kind: PackKind): PackProject {
  return {
    id: hit.project_id,
    slug: hit.slug,
    kind,
    title: hit.title,
    description: hit.description,
    author: hit.author ?? hit.author_id ?? 'Unknown',
    iconUrl: hit.icon_url,
    downloads: hit.downloads ?? 0,
    follows: hit.follows ?? 0,
    updatedAt: hit.date_modified,
    url: `https://modrinth.com/project/${hit.slug}`,
  };
}

/** Modrinth's `categories:` value for a Flame loader type. */
const LOADER_CATEGORY: Record<string, string> = {
  fabric: 'fabric',
  forge: 'forge',
  neoforge: 'neoforge',
  quilt: 'quilt',
};

export async function searchProjects(query: PackSearchQuery): Promise<PackSearchPage> {
  const limit = Math.min(Math.max(1, query.limit || 24), SEARCH_LIMIT_MAX);
  const offset = Math.max(0, query.offset || 0);

  const facets: string[][] = [[`project_type:${query.kind}`]];
  if (query.mcVersion && !isSnapshot(query.mcVersion)) {
    facets.push([`versions:${query.mcVersion}`]);
  }
  if (query.kind === 'mod') {
    // Mods genuinely need the right loader, unlike packs, so they are the one
    // kind where a loader facet is both safe and necessary.
    const category = query.loader ? LOADER_CATEGORY[query.loader.toLowerCase()] : undefined;
    if (category) facets.push([`categories:${category}`]);
  }
  // No loader facet for shader/resource packs: Modrinth tags those with loaders
  // inconsistently and a facet here would hide perfectly loadable plain zips.
  // Filtering by project type plus supported game version is the reliable
  // intersection there.

  const params = new URLSearchParams();
  if (query.query.trim()) params.set('query', query.query.trim());
  params.set('facets', JSON.stringify(facets));
  params.set('index', 'relevance');
  params.set('limit', String(limit));
  params.set('offset', String(offset));

  const data = await getJson<RawSearchResponse>(`${API}/search?${params.toString()}`);

  return {
    projects: (data.hits ?? []).map((hit) => toProject(hit, query.kind)),
    totalHits: data.total_hits ?? 0,
    offset: data.offset ?? offset,
    limit: data.limit ?? limit,
    versionExcluded: Boolean(query.mcVersion) && isSnapshot(query.mcVersion),
  };
}

function toFile(file: RawFile | undefined): PackVersionFile | null {
  if (!file?.url || !file.filename) return null;
  return {
    url: file.url,
    filename: file.filename,
    size: file.size ?? 0,
    sha1: file.hashes?.sha1 ?? null,
  };
}

/**
 * Lists a project's downloadable versions, newest first. When `mcVersion` is set
 * the returned versions are already narrowed to builds declaring support for it.
 */
export async function listProjectVersions(
  projectId: string,
  mcVersion = '',
): Promise<PackVersion[]> {
  const data = await getJson<RawProjectVersion[]>(
    `${API}/project/${encodeURIComponent(projectId)}/version`,
  );

  const wantGameVersion = Boolean(mcVersion) && !isSnapshot(mcVersion);

  const versions = (data ?? [])
    .filter((v) => !wantGameVersion || v.game_versions?.includes(mcVersion))
    // OptiFine builds ship as "shader" too; keep only real pack archives.
    .filter((v) => (v.files ?? []).some((f) => /\.(zip|jar|mcmeta)$/i.test(f.filename)))
    .map<PackVersion>((v) => ({
      id: v.id,
      versionNumber: v.version_number,
      name: v.name,
      datePublished: v.date_published ?? null,
      file: toFile((v.files ?? [])[0]),
    }))
    .filter((v) => v.file !== null);

  versions.sort((a, b) => (b.datePublished ?? '').localeCompare(a.datePublished ?? ''));
  return versions;
}

/**
 * Picks the version to install: the newest build matching `mcVersion`, falling
 * back to the newest build overall when nothing declares that version (common
 * for packs that cover every release via a single file).
 */
export async function resolveInstallVersion(
  projectId: string,
  mcVersion = '',
): Promise<PackVersion> {
  const matching = await listProjectVersions(projectId, mcVersion);
  if (matching.length > 0) return matching[0];

  const all = await listProjectVersions(projectId, '');
  if (all.length > 0) return all[0];

  throw new Error('This project has no downloadable pack files.');
}

export function packDirFor(kind: PackKind, target: PackTarget): string {
  return path.join(target.dir, PACK_FOLDER[kind]);
}

/** Strips characters that are illegal or awkward in file names on any platform. */
function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

/**
 * Turns an installed file name into something a person would recognise, used
 * only when no Modrinth metadata was captured (a pack dropped into the folder
 * by hand, or one installed before this feature existed).
 *
 * `complementary-reimagined-r4.5` -> `Complementary Reimagined`
 */
export function titleFromFileName(fileName: string): string {
  const stem = path.basename(fileName, path.extname(fileName));
  const withoutVersion = stem.replace(/[-_](?:v?\d[\w.]*)$/, '');
  const words = (withoutVersion || stem).replace(/[-_]+/g, ' ').trim();
  if (!words) return stem;
  return words
    .split(' ')
    .map((w) => (w.length <= 2 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

// ------------------------------------------------------- mod enable/disable

/**
 * Suffix that disables a mod. Fabric, Forge, NeoForge and Quilt all skip any
 * jar whose name ends with it, which makes it the one convention that works
 * across every loader — and unlike `options.txt`, it applies to mods.
 */
const DISABLED_SUFFIX = '.disabled';

/** The name the UI and callers use: always without the disable suffix. */
export function canonicalPackName(fileName: string): string {
  return fileName.toLowerCase().endsWith(DISABLED_SUFFIX)
    ? fileName.slice(0, -DISABLED_SUFFIX.length)
    : fileName;
}

function packAccepts(kind: PackKind, fileName: string): boolean {
  const name = kind === 'mod' ? canonicalPackName(fileName) : fileName;
  return /\.(zip|jar|mcmeta)$/i.test(name);
}

export interface InstallOptions {
  onProgress: (received: number, total: number) => void;
  /** Enable the pack after a successful install. */
  enable?: boolean;
  mcVersion?: string;
  /**
   * Metadata from the search result the user clicked. Skipping the extra
   * `/project` round trip; `installProject` fetches it when absent.
   */
  project?: PackProject;
}

/**
 * Downloads a Modrinth project into the instance's pack folder. Files land
 * under `<instance>/<packFolder>/<slug>-<version>.<ext>` so re-installs of a
 * different version don't clobber the old copy, and the project's friendly
 * metadata is recorded alongside for the Installed list.
 */
export async function installProject(
  kind: PackKind,
  projectId: string,
  opts: InstallOptions,
  target: PackTarget,
): Promise<InstalledPack> {
  const version = await resolveInstallVersion(projectId, opts.mcVersion ?? '');
  const file = version.file;
  if (!file) throw new Error('This project has no downloadable pack files.');

  // Only reach for the network when the caller didn't already have the project.
  const project = opts.project ?? (await fetchProject(projectId, kind));

  const dir = ensureDir(packDirFor(kind, target));

  const ext = path.extname(file.filename) || (kind === 'mod' ? '.jar' : '.zip');
  // Prefer the slug: it is the readable name (`complementary-reimagined`)
  // whereas the base62 project id (`sog3m6vs`) is meaningless on disk.
  const stem = safeFileName(`${project.slug || projectId}-${version.versionNumber}`);
  // A re-install must replace any previously disabled copy too, or the old
  // `.disabled` jar would keep shadowing the new one.
  for (const stale of [stem + ext, stem + ext + DISABLED_SUFFIX]) {
    try {
      fs.unlinkSync(path.join(dir, stale));
    } catch {
      /* not there */
    }
  }
  const target_file = path.join(dir, `${stem}${ext}`);

  // `download` verifies sha1 and writes atomically, so a partial file is never left behind.
  await download(file.url, target_file, {
    sha1: file.sha1 ?? undefined,
    onProgress: opts.onProgress,
    timeoutMs: 300000,
  });

  const stat = fs.statSync(target_file);
  const fileName = path.basename(target_file);

  recordPackMeta(target.instanceId, kind, fileName, {
    projectId: project.id,
    title: project.title || titleFromFileName(fileName),
    version: version.versionNumber,
    iconUrl: project.iconUrl,
    mcVersion: opts.mcVersion || null,
    managed: false,
  });

  const enabled = opts.enable ?? true;
  if (enabled) {
    if (kind === 'resourcepack') writeEnabledPacks(target.dir, fileName, true);
    // Mods are enabled by simply not carrying the `.disabled` suffix, which the
    // fresh download already guarantees.
  }

  return {
    kind,
    fileName,
    path: target_file,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    enabled,
    title: project.title || titleFromFileName(fileName),
    projectId: project.id,
    version: version.versionNumber,
    iconUrl: project.iconUrl,
    mcVersion: opts.mcVersion || null,
    managed: false,
  };
}

function isPackEnabled(kind: PackKind, fileName: string, target: PackTarget): boolean {
  if (kind === 'resourcepack') return readEnabledPacks(target.dir).includes(fileName);
  if (kind === 'shader') return readActiveShader(target.dir) === fileName;
  // A mod is disabled exactly when its canonical name carries the suffix.
  const dir = packDirFor(kind, target);
  return !fs.existsSync(path.join(dir, `${fileName}${DISABLED_SUFFIX}`));
}

/**
 * Keys of every pack file still present on disk, across every instance and all
 * three pack folders. `prunePackMeta` needs the whole set: passing only the
 * folder being listed would look like the other kinds' packs had been deleted,
 * and passing only one instance would wipe the others' titles.
 */
function livePackMetaKeys(): Set<string> {
  const alive = new Set<string>();
  const targets = [activeTarget()];
  try {
    for (const name of fs.readdirSync(path.dirname(activeTarget().dir), { withFileTypes: true })) {
      if (!name.isDirectory() || !isValidInstanceDirName(name.name)) continue;
      targets.push(targetFor(name.name));
    }
  } catch {
    /* fall back to the active instance only */
  }

  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.instanceId)) continue;
    seen.add(target.instanceId);
    for (const kind of PACK_KINDS) {
      let entries: string[];
      try {
        entries = fs.readdirSync(packDirFor(kind, target));
      } catch {
        continue;
      }
      for (const entry of entries) {
        alive.add(packMetaKey(target.instanceId, kind, canonicalPackName(entry)));
      }
    }
  }
  return alive;
}

function isValidInstanceDirName(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9._-]{0,47}[a-z0-9])?$/.test(name);
}

export function listInstalled(kind: PackKind, target: PackTarget): InstalledPack[] {
  const dir = packDirFor(kind, target);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const packs: InstalledPack[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    // The menu theme is the launcher's own; Settings owns it, not this list.
    if (kind === 'resourcepack' && canonicalPackName(entry) === 'flame-menu.zip') continue;
    if (!packAccepts(kind, entry)) continue;

    const fileName = canonicalPackName(entry);
    const meta = getPackMeta(target.instanceId, kind, fileName);
    packs.push({
      kind,
      fileName,
      path: full,
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      enabled: isPackEnabled(kind, fileName, target),
      title: meta?.title ?? titleFromFileName(fileName),
      projectId: meta?.projectId ?? null,
      version: meta?.version ?? null,
      iconUrl: meta?.iconUrl ?? null,
      mcVersion: meta?.mcVersion ?? null,
      managed: meta?.managed ?? false,
    });
  }

  prunePackMeta(livePackMetaKeys());
  return packs.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/** Deletes both the enabled and disabled copy of a mod. */
function unlinkPack(kind: PackKind, canonical: string, target: PackTarget): void {
  const dir = packDirFor(kind, target);
  for (const name of kind === 'mod' ? [canonical, `${canonical}${DISABLED_SUFFIX}`] : [canonical]) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      /* already gone */
    }
  }
}

export function removeInstalled(
  kind: PackKind,
  fileName: string,
  target: PackTarget,
): InstalledPack[] {
  // Reject anything that isn't a bare file name so the renderer can't walk out.
  const safe = canonicalPackName(path.basename(fileName));
  if (safe !== canonicalPackName(fileName)) throw new Error('Invalid pack file name.');
  if (kind === 'resourcepack' && safe === 'flame-menu.zip') {
    throw new Error('The Flame menu theme is managed automatically.');
  }

  unlinkPack(kind, safe, target);

  if (kind === 'resourcepack') writeEnabledPacks(target.dir, safe, false);
  else if (kind === 'shader') writeActiveShader(target.dir, null);
  forgetPackMeta(target.instanceId, kind, safe);
  return listInstalled(kind, target);
}

export function setPackEnabled(
  kind: PackKind,
  fileName: string,
  enabled: boolean,
  target: PackTarget,
): InstalledPack[] {
  const safe = canonicalPackName(path.basename(fileName));
  if (safe !== canonicalPackName(fileName)) throw new Error('Invalid pack file name.');
  if (kind === 'resourcepack' && safe === 'flame-menu.zip') {
    throw new Error('The Flame menu theme is managed automatically.');
  }

  const dir = packDirFor(kind, target);
  const enabledPath = path.join(dir, safe);
  const disabledPath = `${enabledPath}${DISABLED_SUFFIX}`;

  if (kind === 'mod') {
    // Renaming between the two forms is the whole enable/disable mechanism for
    // mods; it also keeps whichever copy exists rather than re-downloading.
    const from = enabled ? disabledPath : enabledPath;
    const to = enabled ? enabledPath : disabledPath;
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      try {
        fs.renameSync(from, to);
      } catch (err) {
        throw new Error(
          `Could not ${enabled ? 'enable' : 'disable'} ${safe}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  } else if (kind === 'resourcepack') {
    writeEnabledPacks(target.dir, safe, enabled);
  }
  // Minecraft only honours one shader at a time, so `shaderPack:` is a single
  // value — disabling clears it rather than tracking a list.
  else writeActiveShader(target.dir, enabled ? safe : null);

  return listInstalled(kind, target);
}