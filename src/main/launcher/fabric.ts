import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../fsutil';
import { download, getJson } from '../http';

/**
 * Fabric loader installation for instances that actually declare
 * `loader.type === 'fabric'`.
 *
 * This is deliberately separate from `shader-engine.ts`. The shader engine
 * provisions Fabric as a throwaway detail of launching vanilla with shaders
 * (Fabric jars go to the shared cache, mods go to a hidden per-version folder).
 * An instance whose whole identity is "1.20.1 + Fabric + these mods" needs the
 * opposite: a persistent loader the user can drop their own mods into, living
 * next to the instance's `mods/` folder.
 *
 * The layout is the one the official Fabric installer produces for an
 * "independent" (non-Minecraft-launcher-profile) setup:
 *
 *   <instance>/fabric.mod.json          marks this directory as a Fabric mod
 *   <instance>/.fabric/remappedJars/    placeholder output dir
 *   <instance>/libraries/net/fabricmc/… the loader, intermediary and Mixin jars
 *
 * Fabric resolves `fabric.modsFolder` against the game's working directory, so
 * leaving it unset gives the default `<gameDir>/mods` — exactly where the
 * Modrinth mod tab installs to.
 */

const FABRIC_META = 'https://meta.fabricmc.net/v2';
const FABRIC_MAVEN = 'https://maven.fabricmc.net';

/** Knot, the Fabric client entry point, same constant the shader engine uses. */
export const FABRIC_MAIN_CLASS = 'net.fabricmc.loader.impl.launch.knot.KnotClient';

/**
 * Minimum loader release that speaks the modern version json. Older loaders
 * require `-DFabricMcEmu=` to find the client classes, which newer ones ignore.
 */
const MIN_LOADER_SEMVER = '0.16.0';

interface FabricLibrary {
  name: string;
  url?: string;
  sha1?: string;
}

export interface FabricProfile {
  loader: { version: string; maven: string; stable: boolean };
  intermediary: { version: string; maven: string };
  launcherMeta?: {
    libraries?: {
      common?: FabricLibrary[];
      client?: FabricLibrary[];
    };
  };
}

export class UnsupportedLoaderVersionError extends Error {
  constructor(
    readonly gameVersion: string,
    message: string,
  ) {
    super(message);
    this.name = 'UnsupportedLoaderVersionError';
  }
}

function semverParts(version: string): [number, number, number] {
  const core = version.split('-')[0].split('+')[0];
  const [major, minor, patch] = core.split('.').map((n) => Number.parseInt(n, 10));
  return [Number.isFinite(major) ? major : 0, Number.isFinite(minor) ? minor : 0, Number.isFinite(patch) ? patch : 0];
}

/** Numeric compare so `0.9.0` sorts below `0.16.0` — a naive string compare would not. */
export function compareSemver(a: string, b: string): number {
  const left = semverParts(a);
  const right = semverParts(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/** True when `version` is at least `minimum`. */
export function semverAtLeast(version: string, minimum: string): boolean {
  return compareSemver(version, minimum) >= 0;
}

let profileCache: { gameVersion: string; profile: FabricProfile } | null = null;

/**
 * Fabric's own metadata for a game version. Throws rather than returning null:
 * a Fabric instance cannot launch vanilla, so "no Fabric exists here" has to be
 * an error the UI can show, not a silent downgrade.
 */
export async function resolveFabricProfile(gameVersion: string): Promise<FabricProfile> {
  if (profileCache && profileCache.gameVersion === gameVersion) return profileCache.profile;

  let profiles: FabricProfile[];
  try {
    profiles = await getJson<FabricProfile[]>(
      `${FABRIC_META}/versions/loader/${encodeURIComponent(gameVersion)}`,
    );
  } catch (err) {
    throw new UnsupportedLoaderVersionError(
      gameVersion,
      `Could not reach the Fabric metadata for Minecraft ${gameVersion}. ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new UnsupportedLoaderVersionError(
      gameVersion,
      `Fabric has not published a loader for Minecraft ${gameVersion}.`,
    );
  }

  const usable = profiles.filter((p) => p.loader?.maven && p.intermediary?.maven);
  if (usable.length === 0) {
    throw new UnsupportedLoaderVersionError(
      gameVersion,
      `Fabric published no usable loader build for Minecraft ${gameVersion}.`,
    );
  }

  // Stable builds first: a release candidate can refuse to load a released game.
  const chosen =
    usable.find((p) => p.loader.stable) ??
    // Otherwise the newest thing published, which numeric comparison gets right
    // where `sort()` on strings would put 0.9.10 above 0.16.0.
    [...usable].sort((a, b) => compareSemver(b.loader.version, a.loader.version))[0];

  if (!semverAtLeast(chosen.loader.version, MIN_LOADER_SEMVER)) {
    throw new UnsupportedLoaderVersionError(
      gameVersion,
      `Fabric ${chosen.loader.version} for Minecraft ${gameVersion} is older than Flame supports (${MIN_LOADER_SEMVER}+).`,
    );
  }

  profileCache = { gameVersion, profile: chosen };
  return chosen;
}

function mavenUrl(base: string, maven: string): string {
  const [group, artifact, version] = maven.split(':');
  if (!group || !artifact || !version) {
    throw new Error(`Unexpected maven coordinate: ${maven}`);
  }
  // Metadata gives urls with a trailing slash; normalise so we never emit `//`.
  const root = base.replace(/\/+$/, '');
  return `${root}/${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}.jar`;
}

/** Same coordinate, resolved inside the instance's `libraries` folder. */
function mavenPath(librariesDir: string, maven: string): string {
  const [group, artifact, version] = maven.split(':');
  if (!group || !artifact || !version) {
    throw new Error(`Unexpected maven coordinate: ${maven}`);
  }
  return path.join(
    librariesDir,
    group.replace(/\./g, path.sep),
    artifact,
    version,
    `${artifact}-${version}.jar`,
  );
}

export interface FabricInstallResult {
  /** Jars to append after the vanilla classpath. */
  loaderJars: string[];
  loaderVersion: string;
  fabricModJson: string;
}

/**
 * Ensures the instance has a working Fabric setup for `gameVersion` and returns
 * the classpath additions. Safe to call on every launch: existing jars are only
 * re-downloaded when their sha1 no longer matches.
 */
export async function ensureFabricLoader(
  instanceDir: string,
  gameVersion: string,
  onLog?: (line: string) => void,
): Promise<FabricInstallResult> {
  const log = onLog ?? (() => undefined);
  const profile = await resolveFabricProfile(gameVersion);

  // `launcherMeta.libraries` is Fabric's own contract for a working classpath.
  // Knot verifies the classpath during <clinit> and throws
  // `ASM not detected on the classpath` without ASM and Mixin, which surfaces as
  // an immediate exit 1 — before Minecraft writes a log. The loader jar alone is
  // therefore never enough.
  const declared: FabricLibrary[] = [
    { name: profile.loader.maven, url: FABRIC_MAVEN },
    { name: profile.intermediary.maven, url: FABRIC_MAVEN },
    ...(profile.launcherMeta?.libraries?.common ?? []),
    ...(profile.launcherMeta?.libraries?.client ?? []),
  ];

  const librariesDir = ensureDir(path.join(instanceDir, 'libraries'));
  const loaderJars: string[] = [];
  const seen = new Set<string>();

  for (const lib of declared) {
    const jar = mavenPath(librariesDir, lib.name);
    if (seen.has(jar)) continue;
    seen.add(jar);
    await download(mavenUrl(lib.url ?? FABRIC_MAVEN, lib.name), jar, {
      sha1: lib.sha1 ?? undefined,
      timeoutMs: 300000,
    });
    loaderJars.push(jar);
  }

  // Fabric only treats a directory as a mod source when it finds this file.
  // `depends.minecraft` pins the game version so a user editing instance.json to
  // another release gets a readable error instead of a crash mid-boot.
  const fabricModJson = path.join(instanceDir, 'fabric.mod.json');
  writeIfChanged(fabricModJson, `${JSON.stringify(buildFabricModJson(gameVersion, profile), null, 2)}\n`);

  ensureDir(path.join(instanceDir, '.fabric', 'remappedJars'));

  log(`Fabric ${profile.loader.version} ready for ${gameVersion} (${loaderJars.length} jars)`);
  return { loaderJars, loaderVersion: profile.loader.version, fabricModJson };
}

interface FabricModJson {
  id: string;
  version: string;
  name: string;
  environment: string;
  entrypoints: Record<string, unknown>;
  depends: Record<string, string>;
  mixins: unknown[];
  custom: Record<string, unknown>;
}

export function buildFabricModJson(
  gameVersion: string,
  profile: Pick<FabricProfile, 'loader'>,
): FabricModJson {
  return {
    id: 'flame-instance',
    // Fabric caches dev launches by id+version; bump it when the loader moves
    // so a stale cache cannot pin the previous loader.
    version: `1.0.0+${profile.loader.version}`,
    name: 'Flame Instance',
    environment: '*',
    entrypoints: { main: [] },
    depends: {
      fabricloader: `>=${MIN_LOADER_SEMVER}`,
      minecraft: gameVersion,
      java: '>=17',
    },
    mixins: [],
    custom: { flame: true },
  };
}

/** Only touches the file when the content differs, to keep mtimes stable. */
function writeIfChanged(file: string, content: string): void {
  try {
    if (fs.readFileSync(file, 'utf8') === content) return;
  } catch {
    /* absent or unreadable: fall through and write it */
  }
  fs.writeFileSync(file, content);
}