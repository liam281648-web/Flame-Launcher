import type {
  Account,
  AppInfo,
  AuthDone,
  FlameApi,
  InstalledPack,
  InstanceDraft,
  InstanceInfo,
  InstanceLoaderType,
  InstancePatch,
  InstanceSizeInfo,
  JavaInfo,
  LaunchState,
  LoaderAvailability,
  PackDownloadState,
  PackProject,
  PackSearchPage,
  PackSearchQuery,
  Settings,
  ShaderEngineState,
  UpdaterState,
  VersionEntry,
} from '@shared/types';
import { IDLE_LAUNCH_STATE, IDLE_SHADER_ENGINE_STATE, IDLE_UPDATER_STATE, PACK_FOLDER } from '@shared/types';

export const POPULAR_VERSIONS: VersionEntry[] = [
  '1.21.4', '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.1', '1.19.4', '1.18.2',
  '1.17.1', '1.16.5', '1.12.2', '1.8.9', '1.7.10',
].map((id) => ({ id, channel: 'release', releaseTime: null, installed: false }));

const MOCK_PACKS: PackProject[] = [
  ['complementary-reimagined', 'shader', 'Complementary Reimagined', 'A complementary shader pack with lighting and colour fixes.', 'Shane L.', 4_812_004],
  ['bismuth-free', 'shader', 'Bismuth', 'Blissful shaders, configurable colours and a GUI editor.', 'bakaboor', 3_204_118],
  ['bsl-8', 'shader', 'BSL 8', 'A shaderpack with beautiful shaders and configurable colours.', 'xisumavoid', 2_940_551],
  ['sodium-extra', 'resourcepack', 'Faithful PBR 32x', 'High resolution PBR textures for every vanilla block.', 'Ficsit', 5_120_887],
  ['vanilla-tweaks', 'resourcepack', 'Vanilla Tweaks', 'A large collection of vanilla-friendly tweaks and fixes.', 'xanthian', 1_884_302],
  ['sodium', 'mod', 'Sodium', 'A modern rendering engine that greatly improves performance.', 'CaffeineMC', 1_204_551],
  ['iris', 'mod', 'Iris Shaders', 'A shader loader for Fabric and Quilt.', 'IMS', 986_220],
  ['lithium', 'mod', 'Lithium', 'Optimises many aspects of the Minecraft codebase.', 'CaffeineMC', 812_004],
].map(([slug, kind, title, description, author, downloads]) => ({
  id: String(slug),
  slug: String(slug),
  kind: kind as PackProject['kind'],
  title: String(title),
  description: String(description),
  author: String(author),
  iconUrl: null,
  downloads: Number(downloads),
  follows: 0,
  updatedAt: new Date().toISOString(),
  url: `https://modrinth.com/project/${slug}`,
}));

/**
 * Installed packs carry the instance they belong to, mirroring the real
 * per-instance side-car file rather than one global list.
 */
type MockInstalledPack = InstalledPack & { instanceId: string };

let installedMocks: MockInstalledPack[] = [];

const DEFAULT_SETTINGS: Settings = {
  javaPath: '',
  minMemMb: 1024,
  maxMemMb: 4096,
  gameDir: '',
  closeOnLaunch: false,
  menuPack: true,
  extraJvmArgs: '',
};

/** Fabric exists from 1.14; anything older has to go through OptiFine. */
function needsLegacyShaderEngine(versionId: string): boolean {
  const [major, minor] = versionId.split('.').map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(major)) return true;
  if (major > 1) return false;
  return (minor ?? 0) < 14;
}

/** In-memory stand-in so the UI can run in a plain browser (npm run dev:renderer). */
function createMockApi(): FlameApi {
  let settings = { ...DEFAULT_SETTINGS };
  let accounts: Account[] = [];
  let activeId: string | null = null;
  let launchState: LaunchState = { ...IDLE_LAUNCH_STATE, logTail: [] };
  const launchListeners = new Set<(s: LaunchState) => void>();
  const updateListeners = new Set<(a: Account[], id: string | null) => void>();
  const statusListeners = new Set<(message: string) => void>();
  const doneListeners = new Set<(result: AuthDone) => void>();
  const errorListeners = new Set<(msg: string) => void>();
  const downloadListeners = new Set<(state: PackDownloadState) => void>();
  const shaderListeners = new Set<(s: ShaderEngineState) => void>();
  const instanceListeners = new Set<(i: InstanceInfo[], id: string | null) => void>();
  let shaderState: ShaderEngineState = { ...IDLE_SHADER_ENGINE_STATE };

  const MOCK_DATA_ROOT = 'C:/Users/dev/AppData/Roaming/Flame';

  let instances: InstanceInfo[] = [
    {
      id: 'default',
      name: 'Default',
      icon: null,
      gameVersion: '1.21.1',
      loader: { type: 'vanilla', version: '' },
      created: Date.now() - 86_400_000,
      lastPlayed: Date.now() - 3_600_000,
      path: `${MOCK_DATA_ROOT}/instances/default`,
    },
    {
      id: 'legacy-1-8',
      name: '1.8.9 shaders',
      icon: null,
      gameVersion: '1.8.9',
      loader: { type: 'vanilla', version: '' },
      created: Date.now() - 172_800_000,
      lastPlayed: null,
      path: `${MOCK_DATA_ROOT}/instances/legacy-1-8`,
    },
    {
      id: 'fabric-1-20-1',
      name: 'Fabric 1.20.1',
      icon: null,
      gameVersion: '1.20.1',
      loader: { type: 'fabric', version: '0.16.9' },
      created: Date.now() - 43_200_000,
      lastPlayed: Date.now() - 86_400_000,
      path: `${MOCK_DATA_ROOT}/instances/fabric-1-20-1`,
    },
  ];
  let activeInstanceId: string | null = 'default';
  let runningInstanceId: string | null = null;

  const emitLaunch = () => launchListeners.forEach((cb) => cb(launchState));
  const emitAccounts = () => updateListeners.forEach((cb) => cb(accounts, activeId));
  const emitShaders = () => shaderListeners.forEach((cb) => cb(shaderState));
  const emitInstances = () => instanceListeners.forEach((cb) => cb(instances, activeInstanceId));
  /** Installed packs are keyed by instance, exactly like the real side-car file. */
  const installedFor = (id: string | undefined, kind: InstalledPack['kind']) =>
    installedMocks.filter((p) => p.kind === kind && p.instanceId === (id ?? activeInstanceId));
  const requireInstance = (id: string | undefined): string => {
    const target = id ?? activeInstanceId ?? 'default';
    if (!instances.some((i) => i.id === target)) throw new Error(`Instance "${target}" does not exist.`);
    return target;
  };

  return {
    window: {
      minimize: () => undefined,
      toggleMaximize: () => undefined,
      close: () => undefined,
      isMaximized: async () => false,
      onMaximized: () => () => undefined,
    },
    app: {
      info: async (): Promise<AppInfo> => ({
        appVersion: '0.1.0-browser',
        platform: 'web',
        dataRoot: MOCK_DATA_ROOT,
        instancesRoot: `${MOCK_DATA_ROOT}/instances`,
      }),
      openExternal: (url) => window.open(url, '_blank', 'noopener'),
      openGameDir: () => undefined,
      pickFolder: async () => null,
    },
    instances: {
      list: async () => instances,
      activeId: async () => activeInstanceId,
      setActive: async (id) => {
        const meta = instances.find((i) => i.id === id);
        if (!meta) throw new Error(`Instance "${id}" does not exist.`);
        activeInstanceId = id;
        emitInstances();
        return meta;
      },
      create: async (draft: InstanceDraft): Promise<InstanceInfo> => {
        const base = (draft.name || 'instance')
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, '-')
          .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
        let id = base || 'instance';
        for (let n = 2; instances.some((i) => i.id === id); n++) id = `${base}-${n}`;
        const created: InstanceInfo = {
          id,
          name: draft.name.trim(),
          icon: draft.icon ?? null,
          gameVersion: draft.gameVersion.trim(),
          loader: {
            type: draft.loader?.type ?? 'vanilla',
            version: draft.loader?.type === 'vanilla' ? '' : (draft.loader?.version ?? '').trim(),
          },
          created: Date.now(),
          lastPlayed: null,
          path: `${MOCK_DATA_ROOT}/instances/${id}`,
        };
        instances = [...instances, created];
        activeInstanceId = id;
        emitInstances();
        return created;
      },
      rename: async (id, name) => {
        instances = instances.map((i) => (i.id === id ? { ...i, name: name.trim() || i.name } : i));
        emitInstances();
        return instances;
      },
      update: async (id, patch: InstancePatch) => {
        instances = instances.map((i) => {
          if (i.id !== id) return i;
          return {
            ...i,
            name: patch.name !== undefined ? patch.name.trim() || i.name : i.name,
            icon: patch.icon !== undefined ? patch.icon || null : i.icon,
            gameVersion: patch.gameVersion !== undefined ? patch.gameVersion.trim() : i.gameVersion,
            loader: patch.loader
              ? {
                  type: patch.loader.type,
                  version: patch.loader.type === 'vanilla' ? '' : patch.loader.version.trim(),
                }
              : i.loader,
          };
        });
        emitInstances();
        return instances;
      },
      remove: async (id) => {
        if (runningInstanceId === id) {
          throw new Error('This instance is running. Stop the game before deleting it.');
        }
        instances = instances.filter((i) => i.id !== id);
        installedMocks = installedMocks.filter((p) => p.instanceId !== id);
        if (activeInstanceId === id) activeInstanceId = instances[0]?.id ?? null;
        emitInstances();
        return instances;
      },
      open: () => undefined,
      openRoot: () => undefined,
      runningId: async () => runningInstanceId,
      loaders: async (type: InstanceLoaderType, mcVersion: string): Promise<LoaderAvailability> => {
        if (type === 'vanilla') {
          return { type, supported: true, versions: [], note: 'No loader.' };
        }
        if (type !== 'fabric') {
          return {
            type,
            supported: false,
            versions: [],
            note: `${type} is saved on the instance and used to filter Mods, but this build does not install it at launch yet.`,
          };
        }
        return {
          type,
          supported: true,
          versions: ['0.16.9', '0.16.5', '0.15.11'],
          note: mcVersion
            ? `3 Fabric builds published for ${mcVersion}. Flame installs the loader at launch.`
            : 'Pick a Minecraft version to see the published Fabric builds.',
        };
      },
      size: async (id): Promise<InstanceSizeInfo> => {
        const known = instances.find((i) => i.id === id);
        if (!known) throw new Error(`Instance "${id}" does not exist.`);
        return {
          // Deterministic per instance so the mock does not flicker on re-render.
          bytes: 180_000_000 + known.id.length * 12_345_678,
          files: 420 + known.id.length * 7,
        };
      },
      onUpdate: (cb) => {
        instanceListeners.add(cb);
        return () => instanceListeners.delete(cb);
      },
    },
    accounts: {
      list: async () => accounts,
      activeId: async () => activeId,
      setActive: async (id) => {
        activeId = id;
        emitAccounts();
        return accounts;
      },
      remove: async (id) => {
        accounts = accounts.filter((a) => a.id !== id);
        if (activeId === id) activeId = accounts[0]?.id ?? null;
        emitAccounts();
        return accounts;
      },
      addOffline: async (name) => {
        const account: Account = {
          id: `offline-${name.toLowerCase()}`,
          type: 'offline',
          username: name,
          uuid: '00000000-0000-3000-8000-000000000000',
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
        };
        accounts = [account, ...accounts.filter((a) => a.id !== account.id)];
        activeId = account.id;
        emitAccounts();
        return accounts;
      },
      refresh: async (id) => accounts.find((a) => a.id === id) ?? null,
      beginMicrosoft: () => {
        statusListeners.forEach((cb) => cb('Opening the Microsoft sign-in window…'));
        setTimeout(() => statusListeners.forEach((cb) => cb('Waiting for you to finish signing in…')), 700);
        setTimeout(() => doneListeners.forEach((cb) => cb('cancelled')), 2600);
      },
      cancelMicrosoft: () => {
        doneListeners.forEach((cb) => cb('cancelled'));
      },
      onAuthStatus: (cb) => {
        statusListeners.add(cb);
        return () => statusListeners.delete(cb);
      },
      onAuthDone: (cb) => {
        doneListeners.add(cb);
        return () => doneListeners.delete(cb);
      },
      onAuthError: (cb) => {
        errorListeners.add(cb);
        return () => errorListeners.delete(cb);
      },
      onUpdate: (cb) => {
        updateListeners.add(cb);
        return () => updateListeners.delete(cb);
      },
    },
    versions: {
      list: async () => POPULAR_VERSIONS,
      refresh: async () => POPULAR_VERSIONS,
    },
    settings: {
      get: async () => settings,
      set: async (patch) => {
        settings = { ...settings, ...patch };
        return settings;
      },
    },
    java: {
      detect: async () => ({ path: 'C:/Program Files/Eclipse Adoptium/jdk-21/bin/java.exe', version: '21.0.5', major: 21 }),
      install: async (major: number) => ({
        path: `C:/Users/dev/.flame/runtimes/jdk-${major}/bin/java.exe`,
        version: `${major}.0.2`,
        major,
      }),
      installed: async () => [{ path: 'C:/Program Files/Eclipse Adoptium/jdk-21/bin/java.exe', version: '21.0.5', major: 21 }],
      onProgress: () => () => undefined,
    },
    packs: {
      search: async (query): Promise<PackSearchPage> => {
        const all = MOCK_PACKS.filter((p) => p.kind === query.kind).filter((p) =>
          query.query.trim()
            ? `${p.title} ${p.description}`.toLowerCase().includes(query.query.trim().toLowerCase())
            : true,
        );
        const start = query.offset;
        return {
          projects: all.slice(start, start + query.limit),
          totalHits: all.length,
          offset: start,
          limit: query.limit,
          versionExcluded: Boolean(query.mcVersion) && /^\d{2,3}w\d{2}[a-z]$/.test(query.mcVersion),
        };
      },
      install: async (projectId, kind, mcVersion = '', instanceId?): Promise<InstalledPack> => {
        const target = requireInstance(instanceId);
        const project = MOCK_PACKS.find((p) => p.id === projectId);
        const fileName = `${project?.slug ?? projectId}-mock${kind === 'mod' ? '.jar' : '.zip'}`;
        const pack: MockInstalledPack = {
          kind,
          instanceId: target,
          fileName,
          path: `${MOCK_DATA_ROOT}/instances/${target}/${PACK_FOLDER[kind]}/${fileName}`,
          size: 2_411_724,
          modifiedAt: Date.now(),
          // A mod is enabled by lacking the `.disabled` suffix; a shader is
          // enabled by being the active one, so neither starts active here.
          enabled: kind === 'resourcepack',
          title: project?.title ?? projectId,
          projectId: project?.id ?? projectId,
          version: 'mock',
          iconUrl: project?.iconUrl ?? null,
          mcVersion,
          managed: false,
        };
        installedMocks = [
          pack,
          ...installedMocks.filter(
            (p) => !(p.kind === kind && p.fileName === fileName && p.instanceId === target),
          ),
        ];
        downloadListeners.forEach((cb) =>
          cb({
            projectId,
            title: project?.title ?? projectId,
            kind,
            instanceId: target,
            phase: 'done',
            current: pack.size,
            total: pack.size,
            error: null,
            filePath: pack.path,
          }),
        );
        return pack;
      },
      list: async (kind, instanceId) => installedFor(requireInstance(instanceId), kind),
      remove: async (kind, fileName, instanceId) => {
        const target = requireInstance(instanceId);
        installedMocks = installedMocks.filter(
          (p) => !(p.kind === kind && p.fileName === fileName && p.instanceId === target),
        );
        return installedFor(target, kind);
      },
      setEnabled: async (kind, fileName, enabled, instanceId) => {
        const target = requireInstance(instanceId);
        installedMocks = installedMocks.map((p) =>
          p.kind === kind && p.fileName === fileName && p.instanceId === target
            ? { ...p, enabled }
            : p,
        );
        return installedFor(target, kind);
      },
      onDownload: (cb) => {
        downloadListeners.add(cb);
        return () => downloadListeners.delete(cb);
      },
    },

    imports: {
      // A browser has no filesystem path for a dropped file, and Electron's
      // `webUtils` bridge does not exist here. Returning '' makes the store
      // report "desktop app only" instead of inventing a location.
      pathForFile: () => '',
      importFiles: async () => ({
        instanceId: activeInstanceId ?? 'default',
        files: [],
        touchedKinds: [],
        added: [],
      }),
      onProgress: () => () => undefined,
    },

    updater: {
      // Updates require a packaged build; there is nothing to offer in a browser.
      state: async () => ({ ...IDLE_UPDATER_STATE, supported: false }),
      check: async () => undefined,
      install: async () => {
        throw new Error('Updates require the desktop app.');
      },
      defer: async () => undefined,
      onState: () => () => undefined,
    },

    launch: {
      start: async (instanceId) => {
        const target = requireInstance(instanceId);
        const meta = instances.find((i) => i.id === target);
        const versionId = meta?.gameVersion ?? '1.21.1';
        runningInstanceId = target;

        // Only a vanilla instance provisions a shader engine; a loader instance
        // already runs a modded client, matching the real launcher.
        if (meta?.loader.type === 'vanilla' && installedFor(target, 'shader').length > 0) {
          shaderState = {
            ...IDLE_SHADER_ENGINE_STATE,
            phase: 'provisioning',
            message: `Preparing shader support for ${versionId}…`,
            mcVersion: versionId,
          };
          emitShaders();
          await new Promise((r) => setTimeout(r, 600));

          const legacy = needsLegacyShaderEngine(versionId);
          const detail = legacy
            ? 'OptiFine G5_HD_U_M5'
            : 'Iris 1.7.2 + Sodium 0.6.5 + Fabric 0.16.9';
          shaderState = {
            kind: legacy ? 'optifine' : 'fabric',
            phase: 'ready',
            label: legacy ? 'OptiFine' : 'Iris',
            detail,
            message: detail,
            mcVersion: versionId,
            error: null,
          };
          emitShaders();
        }

        const steps: Array<Partial<LaunchState>> = [
          { phase: 'preparing', message: `Checking ${versionId}…` },
          { phase: 'downloading', message: 'Game assets — 42%', progress: { label: 'Game assets', current: 42, total: 100 } },
          { phase: 'launching', message: 'Starting the game…', progress: null },
          { phase: 'running', message: 'Game running', progress: null, startedAt: Date.now() },
        ];
        for (const step of steps) {
          await new Promise((r) => setTimeout(r, 700));
          launchState = { ...launchState, ...step } as LaunchState;
          emitLaunch();
        }
        instances = instances.map((i) =>
          i.id === target ? { ...i, lastPlayed: Date.now() } : i,
        );
        emitInstances();
      },
      stop: async () => {
        runningInstanceId = null;
        launchState = { ...IDLE_LAUNCH_STATE, logTail: [] };
        emitLaunch();
      },
      state: async () => launchState,
      onState: (cb) => {
        launchListeners.add(cb);
        return () => launchListeners.delete(cb);
      },
      readLog: async () =>
        `# mock latest-launch.log\n${launchState.logTail.join('\n')}\n`,
      openLog: async () => undefined,
    },

    // Mirrors the real launcher: any installed shader pack makes a launch
    // provision a shader engine first (Iris on modern versions, OptiFine on
    // legacy ones such as 1.8.9).
    shaders: {
      status: async () => shaderState,
      onStatus: (cb) => {
        shaderListeners.add(cb);
        return () => shaderListeners.delete(cb);
      },
    },
  };
}

export const api: FlameApi = window.flame ?? createMockApi();
export const isElectron = Boolean(window.flame);
