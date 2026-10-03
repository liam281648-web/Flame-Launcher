import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import type { VersionEntry } from '../../shared/types';
import { download, getJson } from '../http';
import { ensureDir, dataRoot, sha1Of } from '../fsutil';

export const MANIFEST_URL =
  'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';

interface ManifestVersion {
  id: string;
  type: string;
  url: string;
  time: string;
  releaseTime: string;
  sha1?: string;
}

export interface VersionManifest {
  latest: { release: string; snapshot: string };
  versions: ManifestVersion[];
}

function cacheFile(): string {
  // Packaged apps may run from an unwritable cwd — keep the cache in userData.
  try {
    if (app?.getPath) return path.join(app.getPath('userData'), 'cache-manifest.json');
  } catch {
    /* app not ready yet */
  }
  return path.join(process.cwd(), 'cache-manifest.json');
}

let memory: { manifest: VersionManifest; fetchedAt: number } | null = null;
const TTL = 1000 * 60 * 60;

export async function fetchManifest(force = false): Promise<VersionManifest> {
  if (!force && memory && Date.now() - memory.fetchedAt < TTL) return memory.manifest;

  try {
    const cachedRaw = fs.existsSync(cacheFile()) ? fs.readFileSync(cacheFile(), 'utf8') : null;
    if (!force && cachedRaw) {
      const parsed = JSON.parse(cachedRaw) as { fetchedAt: number; manifest: VersionManifest };
      if (Date.now() - parsed.fetchedAt < TTL) {
        memory = { manifest: parsed.manifest, fetchedAt: parsed.fetchedAt };
        return parsed.manifest;
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const manifest = await getJson<VersionManifest>(MANIFEST_URL);
    memory = { manifest, fetchedAt: Date.now() };
    fs.writeFile(cacheFile(), JSON.stringify({ fetchedAt: Date.now(), manifest }), () => undefined);
    return manifest;
  } catch (err) {
    if (memory) return memory.manifest;
    if (fs.existsSync(cacheFile())) {
      try {
        const parsed = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) as {
          manifest: VersionManifest;
        };
        return parsed.manifest;
      } catch {
        /* fall through */
      }
    }
    throw err;
  }
}

export async function listVersions(installDir = dataRoot()): Promise<VersionEntry[]> {
  const manifest = await fetchManifest();
  const entries: VersionEntry[] = manifest.versions.map((v) => ({
    id: v.id,
    channel: (['release', 'snapshot', 'old_beta', 'old_alpha'].includes(v.type)
      ? v.type
      : 'release') as VersionEntry['channel'],
    releaseTime: v.releaseTime ?? null,
    installed: fs.existsSync(path.join(installDir, 'versions', v.id, `${v.id}.jar`)),
  }));

  const rank: Record<string, number> = { release: 0, snapshot: 1, old_beta: 2, old_alpha: 3 };
  return entries.sort((a, b) => {
    const r = rank[a.channel] - rank[b.channel];
    if (r !== 0) return r;
    return (b.releaseTime ?? '').localeCompare(a.releaseTime ?? '');
  });
}

export interface ResolvedVersion {
  id: string;
  json: any;
  jsonPath: string;
  clientJar: string;
  dir: string;
}

export async function resolveVersion(
  versionId: string,
  installDir = dataRoot(),
  onStage?: (label: string, current: number, total: number) => void,
): Promise<ResolvedVersion> {
  const manifest = await fetchManifest();
  const meta = manifest.versions.find((v) => v.id === versionId);
  if (!meta) throw new Error(`Version "${versionId}" is not in the Mojang manifest.`);

  const dir = ensureDir(path.join(installDir, 'versions', versionId));
  const jsonPath = path.join(dir, `${versionId}.json`);
  const clientJar = path.join(dir, `${versionId}.jar`);

  onStage?.('Version metadata', 0, 1);
  await download(meta.url, jsonPath, { sha1: meta.sha1 });
  onStage?.('Version metadata', 1, 1);

  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (json.inheritsFrom) {
    throw new Error(
      `Custom/loader version "${versionId}" inherits from ${json.inheritsFrom}. Only vanilla versions are supported in this build.`,
    );
  }

  const client = json.downloads?.client;
  if (client?.url) {
    onStage?.('Game client', 0, 1);
    await download(client.url, clientJar, { sha1: client.sha1, timeoutMs: 600000 });
    onStage?.('Game client', 1, 1);
  } else if (!fs.existsSync(clientJar)) {
    throw new Error(`No client jar download URL for ${versionId}.`);
  }

  return { id: versionId, json, jsonPath, clientJar, dir };
}

export function platformOs(): 'windows' | 'osx' | 'linux' {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'osx';
  return 'linux';
}

export type RuleFeatures = Record<string, boolean | undefined>;

export function rulesAllow(rules: any[] | undefined, features: RuleFeatures = {}): boolean {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    let match = true;
    if (rule.os) {
      if (rule.os.name !== platformOs()) match = false;
      if (match && rule.os.version) {
        try {
          if (!new RegExp(rule.os.version).test(os.release())) match = false;
        } catch {
          /* ignore malformed version regex */
        }
      }
    }
    if (match && rule.features) {
      for (const [key, expected] of Object.entries(rule.features)) {
        if (Boolean(features[key]) !== Boolean(expected)) match = false;
      }
    }
    if (match) allowed = rule.action === 'allow';
  }
  return allowed;
}

export function verifySha1(file: string, expected?: string): boolean {
  if (!expected) return fs.existsSync(file);
  if (!fs.existsSync(file)) return false;
  try {
    return sha1Of(fs.readFileSync(file)) === expected.toLowerCase();
  } catch {
    return false;
  }
}
