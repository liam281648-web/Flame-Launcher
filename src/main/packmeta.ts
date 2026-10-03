import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { PackKind } from '../shared/types';

/**
 * Friendly metadata for packs Flame installed from Modrinth.
 *
 * The pack files themselves are named after the project slug so they stay
 * recognisable on disk, but that says nothing about the pack's real title, icon
 * or version. Modrinth is not a reliable source for that after the fact (a pack
 * can be renamed or unpublished), so the values are captured once at install
 * time and kept in a small side-car file next to the launcher config.
 *
 * Entries are keyed by instance: two instances can legitimately hold the same
 * archive (e.g. the same shader in a 1.20 pack and a 1.8 pack), and deleting it
 * from one must not erase the other's title.
 */
export interface PackMetaEntry {
  projectId: string | null;
  /** Human-readable project title, e.g. `Complementary Reimagined`. */
  title: string;
  /** Published version string, e.g. `r4.5`. */
  version: string | null;
  iconUrl: string | null;
  /** Minecraft version the build was resolved for. */
  mcVersion: string | null;
  installedAt: number;
  /** True for files Flame installs and repairs itself. */
  managed: boolean;
}

interface PackMetaFile {
  version: 1;
  entries: Record<string, PackMetaEntry>;
}

const EMPTY: PackMetaFile = { version: 1, entries: {} };

let cache: PackMetaFile | null = null;
let saveTimer: NodeJS.Timeout | null = null;

function metaPath(): string {
  // Same test hook as the config store so e2e runs never touch real user data.
  const override = process.env.FLAME_USER_DATA;
  const base = override ? override : app.getPath('userData');
  return path.join(base, 'installed-packs.json');
}

/** Metadata is keyed by instance, then kind, then file name: the same archive can be all three. */
export function packMetaKey(instanceId: string, kind: PackKind, fileName: string): string {
  return `${instanceId}/${kind}/${path.basename(fileName)}`;
}

function isEntry(value: unknown): value is PackMetaEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return typeof e.title === 'string' && e.title.length > 0;
}

function parse(raw: string): PackMetaFile {
  const cleaned = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!cleaned.trim()) return { version: 1, entries: {} };

  try {
    const parsed = JSON.parse(cleaned) as Partial<PackMetaFile>;
    const entries: Record<string, PackMetaEntry> = {};
    for (const [key, value] of Object.entries(parsed.entries ?? {})) {
      if (isEntry(value)) entries[key] = value;
    }
    return { version: 1, entries };
  } catch (err) {
    // Losing display names is survivable — the UI falls back to the file name.
    console.error('[packmeta] could not parse installed-packs.json', err);
    return { version: 1, entries: {} };
  }
}

function load(): PackMetaFile {
  if (cache) return cache;
  try {
    const file = metaPath();
    cache = fs.existsSync(file) ? parse(fs.readFileSync(file, 'utf8')) : { version: 1, entries: {} };
  } catch (err) {
    console.error('[packmeta] could not read installed-packs.json', err);
    cache = { version: 1, entries: {} };
  }
  return cache;
}

function flush(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    const file = metaPath();
    const tmp = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(load(), null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[packmeta] failed to persist installed-packs.json', err);
  }
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 250);
}

export function getPackMeta(instanceId: string, kind: PackKind, fileName: string): PackMetaEntry | null {
  return load().entries[packMetaKey(instanceId, kind, fileName)] ?? null;
}

export function recordPackMeta(
  instanceId: string,
  kind: PackKind,
  fileName: string,
  meta: Omit<PackMetaEntry, 'installedAt'> & { installedAt?: number },
): void {
  const entries = load().entries;
  entries[packMetaKey(instanceId, kind, fileName)] = {
    projectId: meta.projectId ?? null,
    title: meta.title,
    version: meta.version ?? null,
    iconUrl: meta.iconUrl ?? null,
    mcVersion: meta.mcVersion ?? null,
    managed: meta.managed ?? false,
    installedAt: meta.installedAt ?? Date.now(),
  };
  scheduleSave();
}

export function forgetPackMeta(instanceId: string, kind: PackKind, fileName: string): void {
  const entries = load().entries;
  if (delete entries[packMetaKey(instanceId, kind, fileName)]) scheduleSave();
}

/**
 * Drops entries for files that are no longer on disk. Without this the file
 * grows forever and a user who deleted a pack from the folder keeps seeing a
 * title in memory.
 *
 * `alive` must cover every instance and both pack folders of each: passing only
 * the folder being listed would look like the other kinds' packs had gone.
 */
export function prunePackMeta(alive: Set<string>): void {
  const entries = load().entries;
  let changed = false;
  for (const key of Object.keys(entries)) {
    if (!alive.has(key)) {
      delete entries[key];
      changed = true;
    }
  }
  if (changed) scheduleSave();
}

export function flushPackMeta(): void {
  flush();
}