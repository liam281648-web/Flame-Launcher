import fs from 'node:fs';
import path from 'node:path';
import { getJson } from './http';
import { store } from './store';
import {
  assertInside,
  dataRoot,
  ensureDir,
  readJsonFile,
  writeJsonAtomic,
} from './fsutil';
import type {
  InstanceDraft,
  InstanceInfo,
  InstanceLoader,
  InstanceLoaderType,
  InstanceMeta,
  InstancePatch,
  InstanceSizeInfo,
  LoaderAvailability,
} from '../shared/types';
import { LOADER_LABEL, PROVISIONED_LOADERS } from '../shared/types';

/** File that holds one instance's metadata, inside that instance's folder. */
export const INSTANCE_MANIFEST = 'instance.json';

/** Subdirectories every instance gets. The game creates the rest on first run. */
const SCAFFOLD_DIRS = [
  'mods',
  'resourcepacks',
  'shaderpacks',
  'config',
  'saves',
  'screenshots',
  'texturepacks',
];

/**
 * The instance a fresh install starts with.
 *
 * An earlier build kept everything — versions, libraries, assets, mods and
 * worlds — directly in the data folder. That content is migrated into this
 * instance on first run so an existing install keeps its worlds and mods.
 */
export const DEFAULT_INSTANCE_ID = 'default';

/**
 * Data-folder entries that belong to a game directory rather than the shared
 * cache. Anything not listed here (`assets/`, `libraries/`, `versions/`,
 * `runtimes/`, `flame.config.json`, …) stays put, which is what keeps the
 * migration from re-downloading assets.
 */
const LEGACY_GAME_ENTRIES = [
  ...SCAFFOLD_DIRS,
  'options.txt',
  'servers.dat',
  'usercache.json',
  'usernamecache.json',
  'launcher_profiles.json',
  'launcher_accounts.json',
  'banned-players.json',
  'banned-ips.json',
  'whitelist.json',
  'permissions.json',
  'flame',
  'logs',
  'crash-reports',
  'replays',
  'advancements',
  'stats',
  'datapacks',
  'defaultconfigs',
];

// ------------------------------------------------------------------- layout

export function instancesRoot(): string {
  return path.join(dataRoot(), 'instances');
}

/**
 * Instance ids become directory names, so they are restricted to a slug that
 * cannot escape its parent or collide with the filesystem's own conventions.
 * Rejecting rather than sanitising keeps a round trip lossless: the id shown in
 * the UI is exactly the folder on disk.
 */
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,47}[a-z0-9])?$/;

export function isValidInstanceId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id) && !id.includes('..');
}

/**
 * Absolute directory for `id`, with traversal refused.
 *
 * Every write and delete goes through here, so the id validation plus the
 * `assertInside` re-check are deliberately redundant: the pattern rejects the
 * obvious cases at the edge, and `assertInside` catches anything that slipped
 * through a future refactor.
 */
export function instanceDir(id: string): string {
  if (!isValidInstanceId(id)) {
    throw new Error(`"${String(id)}" is not a valid instance id.`);
  }
  const root = instancesRoot();
  return assertInside(root, path.join(root, id));
}

export function instanceManifestPath(id: string): string {
  return path.join(instanceDir(id), INSTANCE_MANIFEST);
}

// ------------------------------------------------------------------- reading

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asLoader(value: unknown): InstanceLoader {
  const raw = (value ?? {}) as Partial<InstanceLoader>;
  const type = raw.type;
  const known: InstanceLoaderType[] = ['vanilla', 'fabric', 'forge', 'neoforge', 'quilt'];
  return {
    type: known.includes(type as InstanceLoaderType) ? (type as InstanceLoaderType) : 'vanilla',
    version: asString(raw.version),
  };
}

/**
 * Coerces an `instance.json` into a complete record.
 *
 * Anything unrecognised falls back to a sane default rather than failing the
 * whole listing — one corrupt file must not hide every other instance.
 */
function toMeta(raw: unknown, id: string): InstanceMeta {
  const src = (raw ?? {}) as Record<string, unknown>;
  const created = typeof src.created === 'number' && src.created > 0 ? src.created : Date.now();
  const loader = asLoader(src.loader);
  return {
    id,
    name: asString(src.name, id) || id,
    icon: typeof src.icon === 'string' && src.icon ? src.icon : null,
    gameVersion: asString(src.gameVersion, '1.20.1') || '1.20.1',
    // A loader version without a loader type is meaningless; vanilla never has one.
    loader: loader.type === 'vanilla' ? { type: 'vanilla', version: '' } : loader,
    created,
    lastPlayed:
      typeof src.lastPlayed === 'number' && src.lastPlayed > 0 ? src.lastPlayed : null,
  };
}

export function readInstance(id: string): InstanceMeta | null {
  if (!isValidInstanceId(id)) return null;
  const raw = readJsonFile<unknown>(instanceManifestPath(id));
  if (!raw) return null;
  return toMeta(raw, id);
}

export function writeInstance(meta: InstanceMeta): InstanceMeta {
  const file = instanceManifestPath(meta.id);
  writeJsonAtomic(file, {
    id: meta.id,
    name: meta.name,
    icon: meta.icon,
    gameVersion: meta.gameVersion,
    loader: meta.loader,
    created: meta.created,
    lastPlayed: meta.lastPlayed,
  });
  return meta;
}

/** Every directory under `instances/` that carries an `instance.json`. */
export function listInstances(): InstanceInfo[] {
  ensureDir(instancesRoot());

  let ids: string[];
  try {
    ids = fs.readdirSync(instancesRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const out: InstanceInfo[] = [];
  for (const id of ids) {
    const meta = readInstance(id);
    if (!meta) continue;
    out.push({ ...meta, path: instanceDir(id) });
  }

  // Most recently played first; never-played instances fall back to newest.
  out.sort((a, b) => {
    const left = a.lastPlayed ?? 0;
    const right = b.lastPlayed ?? 0;
    if (left !== right) return right - left;
    return b.created - a.created;
  });
  return out;
}

// ------------------------------------------------------------------ scaffold

export function scaffoldInstance(id: string): string {
  const dir = instanceDir(id);
  ensureDir(dir);
  for (const sub of SCAFFOLD_DIRS) ensureDir(path.join(dir, sub));
  return dir;
}

/**
 * Creates `instance.json` if it is missing, leaving an existing one untouched.
 * A folder that already has a manifest is a real instance; one without is a
 * leftover from a failed create and is adopted rather than duplicated.
 *
 * Adoption also runs the scaffold, so every instance in the UI has the folders
 * its pack/shader/mod views list even if it was never launched.
 */
function ensureManifest(id: string, seed?: Partial<InstanceMeta>): InstanceMeta {
  const existing = readInstance(id);
  if (existing) return existing;
  scaffoldInstance(id);
  return writeInstance(
    toMeta(
      {
        name: id,
        gameVersion: '1.20.1',
        loader: { type: 'vanilla', version: '' },
        created: Date.now(),
        lastPlayed: null,
        icon: null,
        ...seed,
      },
      id,
    ),
  );
}

function hasLegacyGameContent(root: string): boolean {
  return LEGACY_GAME_ENTRIES.some((entry) => fs.existsSync(path.join(root, entry)));
}

/**
 * Moves pre-instance game data into `instances/default/`.
 *
 * Runs once, guarded by the absence of `instances/`. Failures are logged and
 * ignored rather than thrown: a locked world folder must not stop the launcher
 * from starting, and the data is left in place where it is still reachable.
 */
function migrateLegacyData(root: string): void {
  if (!hasLegacyGameContent(root)) return;

  const target = instanceDir(DEFAULT_INSTANCE_ID);
  ensureDir(target);

  for (const entry of LEGACY_GAME_ENTRIES) {
    const from = path.join(root, entry);
    if (!fs.existsSync(from)) continue;
    const to = path.join(target, entry);
    if (fs.existsSync(to)) continue;
    try {
      fs.renameSync(from, to);
    } catch (err) {
      console.error(`[instances] could not move ${entry} into the default instance`, err);
    }
  }
  console.log(`[instances] migrated existing game data into ${target}`);
}

/**
 * Guarantees `instances/` exists and holds at least the default instance.
 * Safe to call on every startup: it is idempotent and cheap once migrated.
 */
export function ensureInstancesRoot(): void {
  const root = instancesRoot();
  const fresh = !fs.existsSync(root);
  ensureDir(root);
  if (fresh) migrateLegacyData(dataRoot());
  ensureManifest(DEFAULT_INSTANCE_ID, { name: 'Default' });
}

// ------------------------------------------------------------- id derivation

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48)
    .replace(/[-.]+$/g, '');
  return slug;
}

/** Appends `-2`, `-3`, … until the id is free. */
function uniqueId(base: string): string {
  if (!fs.existsSync(instanceDir(base))) return base;
  for (let n = 2; n < 500; n++) {
    const candidate = `${base}-${n}`;
    if (!fs.existsSync(instanceDir(candidate))) return candidate;
  }
  throw new Error(`Could not find a free instance id for "${base}".`);
}

// -------------------------------------------------------------------- active

export function activeInstanceId(): string {
  const ids = listInstances();
  const stored = store.getActiveInstanceId();
  if (stored && ids.some((i) => i.id === stored)) return stored;
  const fallback = ids[0]?.id ?? DEFAULT_INSTANCE_ID;
  if (stored !== fallback) store.setActiveInstanceId(fallback);
  return fallback;
}

export function setActiveInstance(id: string): InstanceMeta {
  // Throws for unknown or malformed ids, which the renderer turns into a toast.
  instanceDir(id);
  const meta = readInstance(id);
  if (!meta) throw new Error(`Instance "${id}" does not exist.`);
  store.setActiveInstanceId(id);
  return meta;
}

/** The active instance's folder — the value passed to the game as `--gameDir`. */
export function activeInstanceDir(): string {
  return instanceDir(activeInstanceId());
}

export function activeInstance(): InstanceMeta {
  const id = activeInstanceId();
  return readInstance(id) ?? ensureManifest(id);
}

/** Resolves an instance's folder, falling back to the active one. */
export function resolveInstanceDir(id?: string | null): { id: string; dir: string } {
  if (!id) {
    const meta = activeInstance();
    return { id: meta.id, dir: instanceDir(meta.id) };
  }
  return { id, dir: instanceDir(id) };
}

// --------------------------------------------------------------------- CRUD

export function createInstance(draft: InstanceDraft): InstanceInfo {
  const name = draft.name.trim();
  if (!name) throw new Error('Give the instance a name.');
  const gameVersion = draft.gameVersion.trim();
  if (!gameVersion) throw new Error('Choose a Minecraft version.');

  const loader: InstanceLoader = {
    type: draft.loader?.type ?? 'vanilla',
    version: draft.loader?.type === 'vanilla' ? '' : (draft.loader?.version ?? '').trim(),
  };

  const requested = draft.id?.trim() ? slugify(draft.id.trim()) : slugify(name);
  const base = requested || 'instance';
  const id = uniqueId(base);

  // `uniqueId` guarantees the folder is free, so the metadata can be written
  // directly rather than going through the adopt-an-existing-folder path.
  const meta: InstanceMeta = {
    id,
    name,
    icon: draft.icon ?? null,
    gameVersion,
    loader,
    created: Date.now(),
    lastPlayed: null,
  };
  writeInstance(meta);

  scaffoldInstance(id);
  // A new instance starts with a stock options.txt so the mod/shader toggles
  // have a file to edit instead of creating one on first write.
  try {
    fs.writeFileSync(
      path.join(instanceDir(id), 'options.txt'),
      'version:auto\nresourcePacks:["vanilla"]\nshaderPack:"none"\n',
      'utf8',
    );
  } catch (err) {
    console.error(`[instances] could not seed options.txt for ${id}`, err);
  }

  store.setActiveInstanceId(id);
  return { ...meta, path: instanceDir(id) };
}

export function updateInstance(id: string, patch: InstancePatch): InstanceInfo[] {
  const existing = readInstance(id);
  if (!existing) throw new Error(`Instance "${id}" does not exist.`);

  const next: InstanceMeta = { ...existing };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error('The instance name cannot be empty.');
    next.name = name;
  }
  if (patch.icon !== undefined) next.icon = patch.icon || null;
  if (patch.gameVersion !== undefined) {
    const version = patch.gameVersion.trim();
    if (!version) throw new Error('Choose a Minecraft version.');
    next.gameVersion = version;
  }
  if (patch.loader !== undefined) {
    next.loader = {
      type: patch.loader.type,
      version: patch.loader.type === 'vanilla' ? '' : patch.loader.version.trim(),
    };
  }

  writeInstance(next);
  return listInstances();
}

/** Convenience wrapper for the rename flow; `update` already accepts a name. */
export function renameInstance(id: string, name: string): InstanceInfo[] {
  return updateInstance(id, { name });
}

/**
 * Records a successful launch. Called from the launcher once the process is
 * confirmed running rather than on request, so the timestamp means "played",
 * not "clicked play".
 */
export function setInstanceLastPlayed(id: string, at = Date.now()): void {
  const existing = readInstance(id);
  if (!existing) return;
  writeInstance({ ...existing, lastPlayed: at });
}

export function removeInstance(id: string): InstanceInfo[] {
  if (!isValidInstanceId(id)) throw new Error(`"${id}" is not a valid instance id.`);
  const dir = instanceDir(id);
  if (!fs.existsSync(dir)) throw new Error(`Instance "${id}" does not exist.`);

  // Confirm the manifest matches too, so a stray folder under instances/ can
  // never be deleted by accident on the strength of its name alone.
  if (!readInstance(id)) {
    throw new Error(`"${id}" has no ${INSTANCE_MANIFEST}; refusing to delete it.`);
  }

  fs.rmSync(dir, { recursive: true, force: true });

  if (activeInstanceIdSafe() === id) {
    // The deleted instance is gone, so re-running the startup path is what
    // guarantees a replacement: `listInstances()` decides which one wins, and a
    // last instance deletion leaves `default/` freshly scaffolded behind it.
    const next = listInstances()[0]?.id ?? DEFAULT_INSTANCE_ID;
    ensureManifest(next, { name: next === DEFAULT_INSTANCE_ID ? 'Default' : undefined });
    scaffoldInstance(next);
    store.setActiveInstanceId(next);
  }
  return listInstances();
}

/** `activeInstanceId()` without the write-back side effect, for teardown paths. */
function activeInstanceIdSafe(): string | null {
  return store.getActiveInstanceId();
}

export function touchInstance(id: string, patch?: InstancePatch): void {
  const existing = readInstance(id);
  if (!existing) return;
  writeInstance({
    ...existing,
    ...(patch?.name !== undefined ? { name: patch.name.trim() || existing.name } : {}),
    ...(patch?.gameVersion !== undefined ? { gameVersion: patch.gameVersion.trim() || existing.gameVersion } : {}),
    ...(patch?.icon !== undefined ? { icon: patch.icon || null } : {}),
    ...(patch?.loader !== undefined ? { loader: patch.loader } : {}),
    lastPlayed: Date.now(),
  });
}

// ---------------------------------------------------------------- loaders

const FABRIC_META = 'https://meta.fabricmc.net/v2';

/**
 * Loader builds published for one Minecraft version.
 *
 * Only Fabric is queried: it is the one loader this build assembles at launch.
 * The others report `supported: false` with no versions rather than a plausible
 * but unactionable list, so the create dialog cannot imply they will be applied.
 */
export async function loaderAvailability(
  type: InstanceLoaderType,
  mcVersion: string,
): Promise<LoaderAvailability> {
  const label = LOADER_LABEL[type] ?? type;

  if (type === 'vanilla') {
    return {
      type,
      supported: true,
      versions: [],
      note: 'No loader — the game runs exactly as Mojang ships it.',
    };
  }

  if (type !== 'fabric') {
    return {
      type,
      supported: false,
      versions: [],
      note:
        `${label} is saved on the instance and used to filter Mods, but this build does not ` +
        'install it at launch yet. The instance will start as vanilla.',
    };
  }

  if (!mcVersion) {
    return {
      type,
      supported: true,
      versions: [],
      note: 'Pick a Minecraft version to see the published Fabric builds.',
    };
  }

  try {
    const profiles = await getJson<unknown[]>(
      `${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}`,
    );
    const versions: string[] = [];
    const seen = new Set<string>();
    if (Array.isArray(profiles)) {
      for (const entry of profiles) {
        const version = (entry as { loader?: { version?: unknown } })?.loader?.version;
        if (typeof version === 'string' && version && !seen.has(version)) {
          seen.add(version);
          versions.push(version);
        }
      }
    }
    return {
      type,
      supported: true,
      versions,
      note: versions.length
        ? `${versions.length} Fabric builds published for ${mcVersion}. Flame installs the loader at launch.`
        : `Fabric has no published build for ${mcVersion}.`,
    };
  } catch (err) {
    return {
      type,
      supported: true,
      versions: [],
      note: `Could not reach the Fabric meta service (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
}

/** Loaders this build can actually install at launch. */
export function isProvisioned(type: InstanceLoaderType): boolean {
  return PROVISIONED_LOADERS.includes(type);
}

// --------------------------------------------------------------------- size

/**
 * Recursive size of an instance directory.
 *
 * Symlinks are counted but never followed: an instance folder is user-writable
 * and a link pointing at, say, `C:\` would otherwise turn a size readout into a
 * multi-minute walk over the whole disk.
 */
export function instanceSize(id: string): InstanceSizeInfo {
  const root = instanceDir(id);
  let bytes = 0;
  let files = 0;

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      // Counted but never followed: a link pointing at a drive root would
      // otherwise turn a size readout into a walk over the whole disk.
      if (entry.isSymbolicLink()) {
        files++;
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        bytes += fs.statSync(full).size;
        files++;
      } catch {
        /* vanished between readdir and stat */
      }
    }
  };

  walk(root);
  return { bytes, files };
}