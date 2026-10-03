export type ViewId = 'play' | 'packs' | 'instances' | 'accounts' | 'settings';

export type LaunchPhase =
  | 'idle'
  | 'preparing'
  | 'downloading'
  | 'launching'
  | 'running'
  | 'stopping'
  | 'error';

export interface LaunchProgress {
  label: string;
  current: number;
  total: number;
}

export interface LaunchState {
  phase: LaunchPhase;
  message: string;
  progress: LaunchProgress | null;
  error: string | null;
  startedAt: number | null;
  logTail: string[];
  /**
   * Absolute path to `latest-launch.log`, which holds the complete stdout and
   * stderr of the last launch attempt. Present whenever a process was spawned.
   */
  logPath: string | null;
  /**
   * Exit code of the last process, when it exited rather than being stopped.
   * Kept separate from `error` so the UI can report it without parsing prose.
   */
  exitCode: number | null;
}

export const IDLE_LAUNCH_STATE: LaunchState = {
  phase: 'idle',
  message: 'Ready to launch',
  progress: null,
  error: null,
  startedAt: null,
  logTail: [],
  logPath: null,
  exitCode: null,
};

export type AccountType = 'microsoft' | 'offline';

export interface Account {
  id: string;
  type: AccountType;
  username: string;
  uuid: string;
  createdAt: number;
  lastUsedAt: number;
  xuid?: string;
  /** Active skin texture URL from the Minecraft profile, used to render the avatar. */
  skinUrl?: string;
}

export interface AuthSecrets {
  /** Microsoft (MSA) refresh token — rotated on every refresh. */
  refreshToken?: string;
  /** Minecraft Services access token sent to the game as --accessToken. */
  accessToken?: string;
  /** Epoch ms at which `accessToken` stops being valid. */
  expiresAt?: number;
}

export type AuthStatus = string;
export type AuthDone = 'ok' | 'cancelled' | 'error';

export type VersionChannel = 'release' | 'snapshot' | 'old_beta' | 'old_alpha';

export interface VersionEntry {
  id: string;
  channel: VersionChannel;
  releaseTime: string | null;
  installed: boolean;
}

export interface JavaInfo {
  path: string;
  version: string;
  major: number;
}

export interface JavaInstallState {
  major: number;
  phase: 'idle' | 'downloading' | 'extracting' | 'done' | 'error';
  label: string;
  current: number;
  total: number;
  error: string | null;
}

export interface Settings {
  javaPath: string;
  minMemMb: number;
  maxMemMb: number;
  gameDir: string;
  closeOnLaunch: boolean;
  menuPack: boolean;
  extraJvmArgs: string;
}

export interface AppInfo {
  appVersion: string;
  platform: string;
  /** Launcher data folder. Holds the shared asset/library cache plus `instances/`. */
  dataRoot: string;
  /** Absolute path of the `instances/` directory. */
  instancesRoot: string;
}

// ------------------------------------------------------------------ instances

/**
 * Mod loaders Flame can record on an instance.
 *
 * `supported` in {@link LoaderAvailability} distinguishes "Flame will actually
 * install this loader at launch" from "the choice is stored and used for pack
 * compatibility, but the loader itself is not provisioned yet". Keeping them in
 * one enum means a not-yet-provisioned loader can be selected without pretending
 * it works.
 */
export type InstanceLoaderType = 'vanilla' | 'fabric' | 'forge' | 'neoforge' | 'quilt';

export const INSTANCE_LOADERS: InstanceLoaderType[] = [
  'vanilla',
  'fabric',
  'forge',
  'neoforge',
  'quilt',
];

export const LOADER_LABEL: Record<InstanceLoaderType, string> = {
  vanilla: 'Vanilla',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  quilt: 'Quilt',
};

/**
 * Loaders whose runtime Flame can assemble before launch. `forge`/`neoforge`
 * need their full installer pipelines and `quilt` publishes a separate Knot
 * build, so those are stored and honoured for pack filtering only.
 */
export const PROVISIONED_LOADERS: InstanceLoaderType[] = ['vanilla', 'fabric'];

export interface InstanceLoader {
  type: InstanceLoaderType;
  /** Loader build, e.g. `0.16.9`. Always the empty string for vanilla. */
  version: string;
}

/** Contents of an instance's `instance.json`. */
export interface InstanceMeta {
  /** Directory slug, also the `instance.json` key. Unique and path-safe. */
  id: string;
  /** User-defined display name. Defaults to the id. */
  name: string;
  /** Custom icon: a Modrinth project id, an absolute path, or a data URL. */
  icon: string | null;
  /** Minecraft release or snapshot id, e.g. `1.20.1`. */
  gameVersion: string;
  loader: InstanceLoader;
  /** Epoch ms when the instance was created. */
  created: number;
  /** Epoch ms of the last successful launch, or null if never launched. */
  lastPlayed: number | null;
}

/** An instance as sent to the renderer: metadata plus its resolved location. */
export interface InstanceInfo extends InstanceMeta {
  /** Absolute path of the instance directory (the game's `--gameDir`). */
  path: string;
}

export interface InstanceDraft {
  /** Desired display name. A slug is derived from it when `id` is omitted. */
  name: string;
  /** Explicit slug; generated from the name when empty. */
  id?: string;
  gameVersion: string;
  loader: InstanceLoader;
  icon?: string | null;
}

export type InstancePatch = Partial<Pick<InstanceMeta, 'name' | 'gameVersion' | 'loader' | 'icon'>>;

export interface LoaderAvailability {
  type: InstanceLoaderType;
  /** True when Flame provisions this loader at launch time. */
  supported: boolean;
  /** Loader builds published for the requested Minecraft version, newest first. */
  versions: string[];
  /** Human-readable explanation shown in the create dialog. */
  note: string;
}

export interface InstanceSizeInfo {
  bytes: number;
  /** Files counted under the instance directory, ignoring shared caches. */
  files: number;
}

// ------------------------------------------------------------------- modrinth

/**
 * Modrinth `project_type` values Flame can install.
 *
 * `mod` entries are ordinary mods that a loader picks up from the instance's
 * `mods/` folder; `resourcepack` and `shader` are the two the launcher manages
 * through `options.txt` itself.
 */
export type PackKind = 'resourcepack' | 'shader' | 'mod';

/** Folder inside the instance each pack type is installed into. */
export const PACK_FOLDER: Record<PackKind, string> = {
  resourcepack: 'resourcepacks',
  shader: 'shaderpacks',
  mod: 'mods',
};

/** All kinds, in tab order. Used whenever both pack folders must be walked. */
export const PACK_KINDS: PackKind[] = ['mod', 'resourcepack', 'shader'];

export const PACK_LABEL: Record<PackKind, string> = {
  mod: 'Mods',
  resourcepack: 'Resource Packs',
  shader: 'Shader Packs',
};

export interface PackProject {
  id: string;
  slug: string;
  kind: PackKind;
  title: string;
  description: string;
  author: string;
  iconUrl: string | null;
  downloads: number;
  follows: number;
  updatedAt: string | null;
  /** Modrinth page, used for the "open on Modrinth" link. */
  url: string;
}

export interface PackSearchPage {
  projects: PackProject[];
  /** Total matching results across all pages. */
  totalHits: number;
  offset: number;
  limit: number;
  /** True when the requested Minecraft version has no indexed builds. */
  versionExcluded: boolean;
}

export interface PackVersionFile {
  url: string;
  filename: string;
  size: number;
  sha1: string | null;
}

export interface PackVersion {
  id: string;
  versionNumber: string;
  name: string;
  datePublished: string | null;
  /** Primary download for this version, already filtered to the requested MC version. */
  file: PackVersionFile | null;
}

export type PackDownloadPhase = 'queued' | 'downloading' | 'done' | 'error';

export interface PackDownloadState {
  /** Project slug, so the card that started the download can match it back. */
  projectId: string;
  /** Instance the file is being written into, so per-instance lists refresh. */
  instanceId: string;
  title: string;
  kind: PackKind;
  phase: PackDownloadPhase;
  current: number;
  total: number;
  error: string | null;
  /** Absolute path of the installed file, set once phase is 'done'. */
  filePath: string | null;
}

export interface InstalledPack {
  kind: PackKind;
  /**
   * Canonical file name inside the instance's pack folder, e.g.
   * `complementary-reimagined-r4.5.zip`. For a disabled mod this is the name
   * *without* the `.disabled` suffix, so callers can toggle and delete by it.
   */
  fileName: string;
  /** Real path on disk, which for a disabled mod carries the `.disabled` suffix. */
  path: string;
  size: number;
  modifiedAt: number;
  enabled: boolean;
  /** Human-readable name to show in the UI. Never empty — falls back to the file stem. */
  title: string;
  /** Modrinth project id when the pack came from Modrinth, otherwise null. */
  projectId: string | null;
  /** Version string as published by the author, e.g. `r4.5`. Null when unknown. */
  version: string | null;
  /** Project icon URL. Null when unknown or the image fails to load. */
  iconUrl: string | null;
  /** Minecraft version the installed build was resolved for. */
  mcVersion: string | null;
  /**
   * True for files Flame installs and repairs itself (the menu theme, the
   * shader-engine stack). The UI surfaces these as read-only with a restore
   * action instead of offering a plain delete.
   */
  managed: boolean;
}

// -------------------------------------------------------- drag-and-drop import

/**
 * What a dropped file turned out to be.
 *
 * `archive` and `modpack` are containers: they route their contents into
 * several instance folders at once. `unsupported` means nothing recognisable
 * was inside, which is reported rather than silently ignored.
 */
export type ImportKind = 'mod' | 'resourcepack' | 'shader' | 'archive' | 'modpack' | 'unsupported';

export interface ImportFileResult {
  /** Base name of the dropped file, for the toast and the UI log. */
  fileName: string;
  kind: ImportKind;
  /** False when the file was recognised but could not be written. */
  ok: boolean;
  error: string | null;
  /** Human-readable summary, e.g. `3 mods, 1 config file`. */
  detail: string | null;
  /** Absolute paths written, used for the summary count and the metadata pass. */
  written: string[];
}

export interface ImportResult {
  instanceId: string;
  files: ImportFileResult[];
  /** Pack kinds whose installed lists changed, so the UI refreshes only those. */
  touchedKinds: PackKind[];
  /** Packs that are now installed and visible in the UI. */
  added: InstalledPack[];
}

export type ImportPhase = 'queued' | 'working' | 'done' | 'error';

export interface ImportState {
  instanceId: string;
  fileName: string;
  phase: ImportPhase;
  /** Bytes, for `.mrpack` downloads; the file count otherwise. */
  current: number;
  total: number;
  detail: string | null;
  error: string | null;
}

// ------------------------------------------------------------- auto updater

export type UpdaterPhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';

export interface UpdaterState {
  phase: UpdaterPhase;
  /** Version string of the pending update, e.g. `0.2.0`. Null until known. */
  version: string | null;
  releaseNotes: string | null;
  /** Download progress, 0-100. */
  percent: number;
  transferred: number;
  total: number;
  /** True once the user pressed "Later"; the banner is hidden until next launch. */
  deferred: boolean;
  error: string | null;
  /**
   * False in development and in unpackaged builds, where no update can ever be
   * found. The UI hides the update affordances entirely rather than showing a
   * control that could only fail.
   */
  supported: boolean;
}

export const IDLE_UPDATER_STATE: UpdaterState = {
  phase: 'idle',
  version: null,
  releaseNotes: null,
  percent: 0,
  transferred: 0,
  total: 0,
  deferred: false,
  error: null,
  supported: false,
};

// ------------------------------------------------------------- shader engine

/** Which mod stack renders the shaders. */
export type ShaderEngineKind = 'none' | 'fabric' | 'optifine';

export type ShaderEnginePhase = 'idle' | 'provisioning' | 'ready' | 'error';

export interface ShaderEngineState {
  kind: ShaderEngineKind;
  phase: ShaderEnginePhase;
  /** Short engine name for toasts, e.g. `Iris` or `OptiFine`. Empty when kind is 'none'. */
  label: string;
  /** Exact versions in use, e.g. `Iris 1.7.2 + Sodium 0.6.4`. */
  detail: string;
  /** Current activity line shown while provisioning. */
  message: string;
  /** Minecraft version the engine is being prepared for. */
  mcVersion: string | null;
  error: string | null;
}

export const IDLE_SHADER_ENGINE_STATE: ShaderEngineState = {
  kind: 'none',
  phase: 'idle',
  label: '',
  detail: '',
  message: 'Vanilla rendering — no shader pack enabled.',
  mcVersion: null,
  error: null,
};

export interface FlameApi {
  window: {
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
    isMaximized: () => Promise<boolean>;
    onMaximized: (cb: (maximized: boolean) => void) => () => void;
  };
  app: {
    info: () => Promise<AppInfo>;
    openExternal: (url: string) => void;
    /** Opens the shared data folder (versions, libraries, assets, instances). */
    openGameDir: () => void;
    pickFolder: () => Promise<string | null>;
  };
  accounts: {
    list: () => Promise<Account[]>;
    activeId: () => Promise<string | null>;
    setActive: (id: string) => Promise<Account[]>;
    remove: (id: string) => Promise<Account[]>;
    addOffline: (username: string) => Promise<Account[]>;
    refresh: (id: string) => Promise<Account | null>;
    beginMicrosoft: () => void;
    cancelMicrosoft: () => void;
    onAuthStatus: (cb: (message: string) => void) => () => void;
    onAuthDone: (cb: (result: AuthDone) => void) => () => void;
    onAuthError: (cb: (message: string) => void) => () => void;
    onUpdate: (cb: (accounts: Account[], activeId: string | null) => void) => () => void;
  };
  versions: {
    list: () => Promise<VersionEntry[]>;
    refresh: () => Promise<VersionEntry[]>;
  };
  settings: {
    get: () => Promise<Settings>;
    set: (patch: Partial<Settings>) => Promise<Settings>;
  };
  java: {
    detect: (explicitPath?: string) => Promise<JavaInfo | null>;
    install: (major: number) => Promise<JavaInfo>;
    installed: () => Promise<JavaInfo[]>;
    onProgress: (cb: (state: JavaInstallState) => void) => () => void;
  };
  instances: {
    list: () => Promise<InstanceInfo[]>;
    activeId: () => Promise<string | null>;
    /** Makes `id` active and returns it. Throws on unknown ids. */
    setActive: (id: string) => Promise<InstanceInfo>;
    create: (draft: InstanceDraft) => Promise<InstanceInfo>;
    rename: (id: string, name: string) => Promise<InstanceInfo[]>;
    update: (id: string, patch: InstancePatch) => Promise<InstanceInfo[]>;
    /** Permanently deletes the instance folder and metadata. */
    remove: (id: string) => Promise<InstanceInfo[]>;
    /** Opens the instance directory in the OS file manager. */
    open: (id: string) => void;
    /** Opens the folder that contains every instance. */
    openRoot: () => void;
    /**
     * Loader builds published for `mcVersion`, newest first. Vanilla returns an
     * empty list. Loaders Flame cannot provision return an empty list and
     * `supported: false`.
     */
    loaders: (type: InstanceLoaderType, mcVersion: string) => Promise<LoaderAvailability>;
    /** Recursive size of the instance directory, excluding the shared caches. */
    size: (id: string) => Promise<InstanceSizeInfo>;
    /** Instance whose game process is alive right now, if any. */
    runningId: () => Promise<string | null>;
    onUpdate: (
      cb: (instances: InstanceInfo[], activeId: string | null) => void,
    ) => () => void;
  };
  launch: {
    /** Launches an instance (defaults to the active one) using its own version. */
    start: (instanceId?: string) => Promise<void>;
    stop: () => Promise<void>;
    state: () => Promise<LaunchState>;
    onState: (cb: (state: LaunchState) => void) => () => void;
    /**
     * Reads back `latest-launch.log`. `lines` caps how much is returned, with
     * the most recent lines last, so the crash viewer stays bounded.
     */
    readLog: (instanceId?: string, lines?: number) => Promise<string>;
    /** Opens `latest-launch.log` in the OS default viewer. */
    openLog: (instanceId?: string) => Promise<void>;
  };
  shaders: {
    status: () => Promise<ShaderEngineState>;
    onStatus: (cb: (state: ShaderEngineState) => void) => () => void;
  };
  packs: {
    search: (query: PackSearchQuery) => Promise<PackSearchPage>;
    /**
     * Every call takes an `instanceId`; main falls back to the active instance
     * when it is omitted, so a single-instance flow needs no extra plumbing.
     */
    install: (
      projectId: string,
      kind: PackKind,
      mcVersion?: string,
      instanceId?: string,
    ) => Promise<InstalledPack>;
    list: (kind: PackKind, instanceId?: string) => Promise<InstalledPack[]>;
    remove: (kind: PackKind, fileName: string, instanceId?: string) => Promise<InstalledPack[]>;
    setEnabled: (
      kind: PackKind,
      fileName: string,
      enabled: boolean,
      instanceId?: string,
    ) => Promise<InstalledPack[]>;
    onDownload: (cb: (state: PackDownloadState) => void) => () => void;
  };
  imports: {
    /**
     * Resolves a dropped `File` to its absolute path.
     *
     * Electron removed `File.path` in v32; this is the supported replacement and
     * it has to run on the Electron side of the context bridge, so the renderer
     * hands the `File` object over rather than a path it cannot read.
     */
    pathForFile: (file: File) => string;
    /**
     * Classifies and installs the given files into `instanceId` (defaults to the
     * active instance). Never rejects for a per-file problem: each entry of
     * `ImportResult.files` carries its own `ok`/`error` so one bad archive does
     * not discard the rest of the drop.
     */
    importFiles: (paths: string[], instanceId?: string) => Promise<ImportResult>;
    onProgress: (cb: (state: ImportState) => void) => () => void;
  };
  updater: {
    state: () => Promise<UpdaterState>;
    /** Manual check, surfaced for a future Settings row. Resolves quietly. */
    check: () => Promise<void>;
    /** Quits and runs the installer. Throws when nothing is downloaded yet. */
    install: () => Promise<void>;
    /** Hides the banner; the update still installs on the next restart. */
    defer: () => Promise<void>;
    onState: (cb: (state: UpdaterState) => void) => () => void;
  };
}

export interface PackSearchQuery {
  kind: PackKind;
  /** Free-text query; empty matches everything. */
  query: string;
  /** Running Minecraft version to filter by, e.g. `1.20.1`. Empty disables the filter. */
  mcVersion: string;
  offset: number;
  limit: number;
  /**
   * Instance loader, used as a Modrinth `categories:` facet for the `mod` kind.
   * Ignored for packs, which Modrinth tags with loaders inconsistently.
   */
  loader?: string;
}

/**
 * Shaders cannot run on a vanilla client — they need a shader-capable mod loaded
 * first. Flame provisions that stack automatically at launch (Fabric + Iris +
 * Sodium on modern versions, OptiFine on legacy ones), so the note below is only
 * telling the player what is about to happen for them.
 */
export const SHADER_ENGINE_NOTE =
  'Shaders load automatically at launch — Flame installs Iris + Sodium on Fabric for modern versions, and OptiFine for legacy ones.';
