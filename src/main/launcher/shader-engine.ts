import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { ShaderEngineKind, ShaderEngineState } from '../../shared/types';
import { IDLE_SHADER_ENGINE_STATE, PACK_FOLDER } from '../../shared/types';
import { download, getJson } from '../http';
import { ensureDir, dataRoot } from '../fsutil';
import { emit } from '../events';

/**
 * Zero-config shader support.
 *
 * A vanilla client cannot render shader packs, so Flame provisions the mod
 * stack itself right before launch instead of asking the player to install one:
 *
 *  - modern versions -> Fabric loader + Iris + Sodium
 *  - legacy versions -> OptiFine (pre-Fabric era, e.g. 1.8.9)
 *
 * Both paths are additive: they only append jars, JVM flags and game arguments
 * to the command line that already launches the vanilla game, so a failure
 * degrades to plain rendering instead of breaking the launch.
 */

const FABRIC_META = 'https://meta.fabricmc.net/v2';
const MODRINTH = 'https://api.modrinth.com/v2';

/**
 * Machine-readable index of every published OptiFine build. optifine.net has no
 * API of its own; the listed mirrors 302 straight back to optifine.net, so the
 * jars still come from the official server.
 */
const OPTIFINE_INDEX = 'https://zkitefly.github.io/optifine-download-list/index.json';

/** Launchwrapper fork OptiFine ships inside its installer and expects on the classpath. */
const LAUNCHWRAPPER_CLASS = 'net.minecraft.launchwrapper.Launch';
const OPTIFINE_TWEAKER = 'optifine.OptiFineTweaker';
const FABRIC_KNOT = 'net.fabricmc.loader.impl.launch.knot.KnotClient';

// ------------------------------------------------------------------- status

let state: ShaderEngineState = { ...IDLE_SHADER_ENGINE_STATE };

function setState(patch: Partial<ShaderEngineState>): void {
  state = { ...state, ...patch };
  emit('shaders:status', state);
}

export function getShaderEngineState(): ShaderEngineState {
  return state;
}

export function resetShaderEngineState(): void {
  setState({ ...IDLE_SHADER_ENGINE_STATE });
}

// --------------------------------------------------------------------- plan

export interface ShaderEnginePlan {
  kind: ShaderEngineKind;
  /** Short engine name, e.g. `Iris` or `OptiFine`. */
  label: string;
  /** Exact versions in use. */
  detail: string;
  /** Jars appended after the vanilla classpath. */
  appendClasspath: string[];
  jvmArgs: string[];
  gameArgs: string[];
  /** Replaces `json.mainClass` when set. */
  mainClass: string | null;
}

export const NO_SHADER_ENGINE: ShaderEnginePlan = {
  kind: 'none',
  label: '',
  detail: '',
  appendClasspath: [],
  jvmArgs: [],
  gameArgs: [],
  mainClass: null,
};

// ------------------------------------------------------------------- upstream

/**
 * The maven root Fabric's own metadata points at. Not every dependency lives
 * under maven.fabricmc.net, so each library may declare its own `url`.
 */
const FABRIC_MAVEN = 'https://maven.fabricmc.net';

interface FabricLibrary {
  name: string;
  url?: string;
  sha1?: string;
}

interface FabricProfile {
  loader: { version: string; maven: string; stable: boolean };
  intermediary: { version: string; maven: string };
  /**
   * Everything besides the loader jar itself: ASM and Mixin in particular.
   * Knot refuses to boot without them (`ASM not detected on the classpath`),
   * so the loader jar alone is never a sufficient classpath.
   */
  launcherMeta?: {
    libraries?: {
      common?: FabricLibrary[];
      client?: FabricLibrary[];
    };
  };
}

interface ModrinthFile {
  filename: string;
  size: number;
  url: string;
  primary?: boolean;
  hashes?: { sha1?: string; sha512?: string };
}

interface ModrinthVersion {
  id: string;
  version_number: string;
  version_type: string;
  game_versions: string[];
  loaders: string[];
  files: ModrinthFile[];
}

interface OptiFineEntry {
  name: string;
  ispreview: boolean;
  mcversion: string;
  filename: string;
  forge: string;
}

interface OptiFineIndex {
  /** Mirror prefixes; each ends in `file/`. */
  download: string[];
  /** Newest build first. */
  file: OptiFineEntry[];
}

/** `net.fabricmc:fabric-loader:0.16.9` -> a maven path under `base`. */
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

/** Fabric only exists from 1.14 onwards; older versions answer with 404/empty. */
async function resolveFabric(mcVersion: string): Promise<FabricProfile | null> {
  let profiles: FabricProfile[];
  try {
    profiles = await getJson<FabricProfile[]>(
      `${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}`,
    );
  } catch {
    return null;
  }
  if (!Array.isArray(profiles) || profiles.length === 0) return null;

  // Stable builds first so a launch never picks a loader mid-release.
  const chosen =
    profiles.find((p) => p.loader?.stable && p.intermediary?.maven) ??
    profiles.find((p) => p.loader?.maven && p.intermediary?.maven);
  return chosen ?? null;
}

/**
 * Picks the newest Iris (and Sodium) build for one Minecraft version.
 *
 * The `game_versions`/`loaders` query params are only a hint — the default
 * Sodium version resolves to a NeoForge build for a much newer Minecraft — so
 * every candidate is re-checked against its own declared fields.
 */
async function resolveModrinthMod(
  slug: string,
  mcVersion: string,
): Promise<{ versionNumber: string; file: ModrinthFile } | null> {
  let versions: ModrinthVersion[];
  const params = new URLSearchParams({
    game_versions: JSON.stringify([mcVersion]),
    loaders: JSON.stringify(['fabric']),
  });
  try {
    versions = await getJson<ModrinthVersion[]>(
      `${MODRINTH}/project/${encodeURIComponent(slug)}/version?${params.toString()}`,
    );
  } catch {
    return null;
  }

  const usable = (versions ?? []).filter(
    (v) =>
      Array.isArray(v.game_versions) &&
      v.game_versions.includes(mcVersion) &&
      Array.isArray(v.loaders) &&
      v.loaders.includes('fabric') &&
      (v.files ?? []).some((f) => /\.jar$/i.test(f.filename)),
  );
  if (usable.length === 0) return null;

  const chosen =
    usable.find((v) => v.version_type === 'release') ?? usable[0];
  const file = (chosen.files ?? []).find((f) => /\.jar$/i.test(f.filename));
  if (!file) return null;

  return { versionNumber: chosen.version_number, file };
}

let optifineIndexCache: { index: OptiFineIndex; fetchedAt: number } | null = null;
const OPTIFINE_TTL = 6 * 60 * 60 * 1000;

async function fetchOptiFineIndex(): Promise<OptiFineIndex | null> {
  if (optifineIndexCache && Date.now() - optifineIndexCache.fetchedAt < OPTIFINE_TTL) {
    return optifineIndexCache.index;
  }
  try {
    const index = await getJson<OptiFineIndex>(OPTIFINE_INDEX);
    if (!Array.isArray(index?.file) || index.file.length === 0) return null;
    optifineIndexCache = { index, fetchedAt: Date.now() };
    return index;
  } catch (err) {
    console.warn('[shaders] OptiFine index unavailable', err);
    return null;
  }
}

/** Newest non-preview build for a Minecraft version; the index is newest-first. */
async function resolveOptiFine(mcVersion: string): Promise<OptiFineEntry | null> {
  const index = await fetchOptiFineIndex();
  if (!index) return null;
  const entry = index.file.find((f) => f.mcversion === mcVersion && !f.ispreview);
  if (!entry) return null;
  return entry;
}

// -------------------------------------------------------------- provisioning

export interface ProvisionOptions {
  versionId: string;
  /** Instance the launch belongs to; scopes the per-instance folders. */
  instanceId: string;
  /** Vanilla client jar, used as the patch base for OptiFine. */
  clientJar: string;
  /** JVM that will run the game; the OptiFine patcher needs the same one. */
  javaPath: string;
  /**
   * Shared cache root holding `libraries/` and `versions/`. Libraries and the
   * OptiFine build are version-scoped, not instance-scoped, so they are
   * downloaded once and reused by every instance on this Minecraft version.
   */
  installDir?: string;
  /** The instance directory — the game's `--gameDir`, and where packs live. */
  instanceDir: string;
  onLog?: (line: string) => void;
  onProgress?: (message: string) => void;
}

function countShaderPacks(instanceDir: string): number {
  try {
    return fs
      .readdirSync(path.join(instanceDir, PACK_FOLDER.shader))
      .filter((n) => /\.(zip|jar|mcmeta)$/i.test(n)).length;
  } catch {
    return 0;
  }
}

async function provisionFabric(
  mcVersion: string,
  installDir: string,
  instanceDir: string,
  log: (line: string) => void,
  progress: (message: string) => void,
): Promise<ShaderEnginePlan | null> {
  progress(`Resolving Fabric for ${mcVersion}…`);
  const profile = await resolveFabric(mcVersion);
  if (!profile) {
    log(`no Fabric loader published for ${mcVersion}`);
    return null;
  }

  const librariesDir = path.join(installDir, 'libraries');

  progress(`Downloading Fabric ${profile.loader.version}…`);

  // `launcherMeta.libraries` is Fabric's own contract for a working classpath.
  // Knot runs `LoaderUtil.verifyClasspath` during <clinit> and throws
  // `ASM not detected on the classpath` without ASM/Mixin, which surfaces as an
  // immediate exit 1 — before Minecraft has a chance to write latest.log. The
  // loader jar on its own is therefore never sufficient.
  const declared: FabricLibrary[] = [
    { name: profile.loader.maven, url: FABRIC_MAVEN },
    { name: profile.intermediary.maven, url: FABRIC_MAVEN },
    ...(profile.launcherMeta?.libraries?.common ?? []),
    ...(profile.launcherMeta?.libraries?.client ?? []),
  ];

  const fabricJars: string[] = [];
  const seen = new Set<string>();
  for (const lib of declared) {
    const jar = mavenPath(librariesDir, lib.name);
    if (seen.has(jar)) continue;
    seen.add(jar);
    try {
      await download(mavenUrl(lib.url ?? FABRIC_MAVEN, lib.name), jar, {
        sha1: lib.sha1 ?? undefined,
        timeoutMs: 300000,
      });
    } catch (err) {
      // A missing runtime library is fatal for this path — better to fall back
      // to vanilla than to hand Knot a classpath it will reject at boot.
      throw new Error(`Could not download ${lib.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    fabricJars.push(jar);
  }

  // Engine mods live under the instance, not the shared cache: they must never
  // leak into another instance's `mods/` folder.
  const modsDir = ensureDir(path.join(instanceDir, 'flame', 'mods', mcVersion));

  const iris = await resolveModrinthMod('iris', mcVersion);
  if (!iris) {
    log('Iris has no Fabric build for this version');
    return null;
  }
  progress(`Downloading Iris ${iris.versionNumber}…`);
  const irisJar = path.join(modsDir, iris.file.filename);
  await download(iris.file.url, irisJar, {
    sha1: iris.file.hashes?.sha1 ?? undefined,
    timeoutMs: 300000,
  });

  const sodium = await resolveModrinthMod('sodium', mcVersion);
  progress(sodium ? `Downloading Sodium ${sodium.versionNumber}…` : 'Sodium unavailable, using Iris alone…');
  let sodiumVersion = '';
  if (sodium) {
    const sodiumJar = path.join(modsDir, sodium.file.filename);
    await download(sodium.file.url, sodiumJar, {
      sha1: sodium.file.hashes?.sha1 ?? undefined,
      timeoutMs: 300000,
    });
    sodiumVersion = ` + Sodium ${sodium.versionNumber}`;
  }

  // Fabric loader discovers mods under <gameDir>/mods by default. Every version
  // Flame supports shares one game directory, so Iris built for 1.21 sitting
  // next to a 1.16 launch would abort the game — point each version at its own
  // folder inside the instance instead.
  const modsFolder = path
    .relative(instanceDir, modsDir)
    .split(path.sep)
    .join('/');

  log(
    `Fabric ${profile.loader.version} + Iris ${iris.versionNumber}${sodiumVersion} ` +
      `(${fabricJars.length} loader libraries) -> ${modsDir}`,
  );

  return {
    kind: 'fabric',
    label: 'Iris',
    detail: `Iris ${iris.versionNumber}${sodiumVersion} + Fabric ${profile.loader.version}`,
    // Appended after the vanilla classpath: Knot finds the game, ASM and Mixin
    // by scanning the whole `java.class.path`.
    appendClasspath: fabricJars,
    // Loader 0.19.x reads the vanilla main class straight out of the version
    // json, so no `-DFabricMcEmu=` override is needed (and none is recognised).
    jvmArgs: [`-Dfabric.modsFolder=${modsFolder}`],
    gameArgs: [],
    mainClass: FABRIC_KNOT,
  };
}

/**
 * Runs OptiFine's own patcher over the vanilla client.
 *
 * Verified against the shipped bytecode: the entry point takes
 * `<base.jar> <diff.jar> <mod.jar>` and emits the OptiFine *mod* jar — vanilla
 * classes are not merged in, they are transformed at runtime by the tweaker, so
 * the vanilla client jar stays on the classpath next to the result.
 */
function runOptiFinePatcher(
  javaPath: string,
  installer: string,
  clientJar: string,
  output: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      javaPath,
      ['-cp', installer, 'optifine.Patcher', clientJar, installer, output],
      { cwd: path.dirname(output), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let tail = '';
    const collect = (buf: Buffer) => {
      tail = `${tail}${buf.toString('utf8')}`.slice(-4000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(output)) resolve();
      else reject(new Error(`OptiFine patcher exited with code ${code}. ${tail.trim()}`));
    });
  });
}

/** Pulls `launchwrapper-of-<v>.jar` out of the installer; returns its path. */
function extractLaunchWrapper(installer: string, outDir: string): string {
  const zip = new AdmZip(installer);

  const txt = zip.getEntry('launchwrapper-of.txt');
  const version = txt?.getData().toString('utf8').trim();
  if (!version) throw new Error('OptiFine installer is missing launchwrapper-of.txt');

  const entryName = `launchwrapper-of-${version}.jar`;
  const entry = zip.getEntry(entryName);
  if (!entry) throw new Error(`OptiFine installer is missing ${entryName}`);

  const dest = path.join(ensureDir(outDir), entryName);
  fs.writeFileSync(dest, entry.getData());
  return dest;
}

async function provisionOptiFine(
  mcVersion: string,
  opts: ProvisionOptions,
  log: (line: string) => void,
  progress: (message: string) => void,
): Promise<ShaderEnginePlan | null> {
  progress(`Looking up OptiFine for ${mcVersion}…`);
  const entry = await resolveOptiFine(mcVersion);
  if (!entry) {
    log(`no OptiFine build published for ${mcVersion}`);
    return null;
  }

  const index = await fetchOptiFineIndex();
  const mirrors = index?.download ?? [];
  if (mirrors.length === 0) {
    log('OptiFine index returned no download mirrors');
    return null;
  }

  const installDir = opts.installDir ?? dataRoot();
  const ofDir = ensureDir(path.join(installDir, 'flame', 'optifine'));
  const installer = path.join(ofDir, entry.filename);

  progress(`Downloading OptiFine ${entry.name}…`);
  let lastError: unknown;
  for (const mirror of mirrors) {
    try {
      await download(`${mirror}${encodeURIComponent(entry.filename)}`, installer, {
        timeoutMs: 300000,
      });
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw new Error(`Could not download OptiFine: ${lastError instanceof Error ? lastError.message : lastError}`);

  const launchWrapper = extractLaunchWrapper(installer, path.join(installDir, 'libraries', 'optifine'));

  // Rebuild the mod jar whenever the client jar or the installer is newer than
  // what we produced, so an updated Minecraft build is not left unpatched.
  const modJar = path.join(ofDir, `${mcVersion}-optifine.jar`);
  const inputs = [opts.clientJar, installer].map((f) => {
    try {
      return fs.statSync(f).mtimeMs;
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  });
  const newestInput = Math.max(...inputs);
  const outputStale = (() => {
    try {
      return fs.statSync(modJar).mtimeMs < newestInput;
    } catch {
      return true;
    }
  })();

  if (outputStale) {
    progress('Patching Minecraft with OptiFine…');
    await runOptiFinePatcher(opts.javaPath, installer, opts.clientJar, modJar);
  }

  log(`OptiFine ${entry.name} -> ${modJar}`);
  return {
    kind: 'optifine',
    label: 'OptiFine',
    detail: `OptiFine ${entry.name}`,
    appendClasspath: [launchWrapper, modJar],
    jvmArgs: [],
    gameArgs: ['--tweakClass', OPTIFINE_TWEAKER],
    mainClass: LAUNCHWRAPPER_CLASS,
  };
}

/**
 * Prepares the shader stack for a launch.
 *
 * Never throws for a missing engine — the caller logs the reason and launches
 * vanilla. Throws only when the player asked for shaders and provisioning was
 * attempted but produced nothing usable.
 */
export async function provisionShaderEngine(
  opts: ProvisionOptions,
): Promise<ShaderEnginePlan> {
  const installDir = opts.installDir ?? dataRoot();
  const log = opts.onLog ?? (() => undefined);
  const progress = opts.onProgress ?? (() => undefined);

  const shaderCount = countShaderPacks(opts.instanceDir);
  if (shaderCount === 0) {
    resetShaderEngineState();
    return NO_SHADER_ENGINE;
  }

  setState({
    kind: 'none',
    phase: 'provisioning',
    label: '',
    detail: '',
    message: `Preparing shader support for ${opts.versionId}…`,
    mcVersion: opts.versionId,
    error: null,
  });

  let plan: ShaderEnginePlan | null = null;
  try {
    plan = await provisionFabric(opts.versionId, installDir, opts.instanceDir, log, progress);
    if (!plan) plan = await provisionOptiFine(opts.versionId, opts, log, progress);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`provisioning failed: ${message}`);
    setState({
      kind: 'none',
      phase: 'error',
      label: '',
      detail: '',
      message: 'Shader engine unavailable — launching vanilla.',
      mcVersion: opts.versionId,
      error: message,
    });
    return NO_SHADER_ENGINE;
  }

  if (!plan) {
    const message =
      `No shader engine is available for Minecraft ${opts.versionId}. ` +
      `Flame will launch vanilla; the ${shaderCount} installed shader pack(s) will not load.`;
    log(message);
    setState({
      kind: 'none',
      phase: 'error',
      label: '',
      detail: '',
      message: 'No shader engine available for this version.',
      mcVersion: opts.versionId,
      error: message,
    });
    return NO_SHADER_ENGINE;
  }

  setState({
    kind: plan.kind,
    phase: 'ready',
    label: plan.label,
    detail: plan.detail,
    message: plan.detail,
    mcVersion: opts.versionId,
    error: null,
  });

  return plan;
}