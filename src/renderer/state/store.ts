import type {
  Account,
  AppInfo,
  ImportState,
  InstalledPack,
  InstanceDraft,
  InstanceInfo,
  InstanceLoaderType,
  InstancePatch,
  InstanceSizeInfo,
  JavaInfo,
  JavaInstallState,
  LaunchState,
  LoaderAvailability,
  PackDownloadState,
  PackKind,
  PackProject,
  Settings,
  ShaderEngineState,
  UpdaterState,
  VersionChannel,
  VersionEntry,
  ViewId,
} from '@shared/types';
import { IDLE_LAUNCH_STATE, IDLE_SHADER_ENGINE_STATE, IDLE_UPDATER_STATE } from '@shared/types';
import { create } from 'zustand';
import { api } from '../lib/api';

export type ToastKind = 'info' | 'success' | 'error';
export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

interface LauncherState {
  ready: boolean;
  view: ViewId;
  maximized: boolean;

  accounts: Account[];
  activeAccountId: string | null;
  authStatus: string | null;
  authBusy: boolean;
  authError: string | null;

  instances: InstanceInfo[];
  activeInstanceId: string | null;
  /** Instance whose game process is alive, if any. Blocks destructive actions. */
  runningInstanceId: string | null;
  /** Sizes are fetched lazily per card; absent means "not measured yet". */
  instanceSizes: Record<string, InstanceSizeInfo>;
  /** Sizes can take a moment on a large instance, so they load after the cards. */
  sizesLoading: boolean;
  instancesBusy: boolean;
  loaderInfo: LoaderAvailability | null;
  loaderInfoKey: string;

  appInfo: AppInfo | null;

  versions: VersionEntry[];
  versionsLoading: boolean;
  versionsError: string | null;
  channelFilter: 'all' | 'release' | 'snapshot' | 'installed';
  /** Mirror of the active instance's Minecraft version; edit it via the instance. */
  selectedVersionId: string;

  packKind: PackKind;
  packQuery: string;
  packPage: PackProject[];
  packTotalHits: number;
  packOffset: number;
  packLimit: number;
  packLoading: boolean;
  packError: string | null;
  packsVersionExcluded: boolean;
  packsInstalled: InstalledPack[];
  /** One entry per in-flight/most-recent download, keyed by Modrinth project id. */
  packDownloads: Record<string, PackDownloadState>;

  settings: Settings | null;
  javaInfo: JavaInfo | null;
  javaRuntimes: JavaInfo[];
  javaInstall: JavaInstallState | null;
  javaInstalling: boolean;

  setPackKind: (kind: PackKind) => void;
  setPackQuery: (query: string) => void;
  goToPackPage: (offset: number) => void;
  searchPacks: (opts?: { reset?: boolean }) => Promise<void>;
  installPack: (project: PackProject) => Promise<void>;
  removePack: (fileName: string) => Promise<void>;
  togglePack: (fileName: string, enabled: boolean) => Promise<void>;
  refreshInstalledPacks: () => Promise<void>;

  launch: LaunchState;
  shaders: ShaderEngineState;
  toast: Toast | null;

  /** File currently being imported, for the drop overlay's busy state. */
  importProgress: ImportState | null;
  importing: boolean;
  updater: UpdaterState;

  init: () => Promise<void>;
  setView: (view: ViewId) => void;
  setMaximized: (value: boolean) => void;

  refreshAccounts: () => Promise<void>;
  selectAccount: (id: string) => Promise<void>;
  removeAccount: (id: string) => Promise<void>;
  addOffline: (name: string) => Promise<void>;
  beginMicrosoft: () => void;
  cancelMicrosoft: () => void;
  clearAuthError: () => void;

  refreshInstances: () => Promise<void>;
  selectInstance: (id: string) => Promise<void>;
  createInstance: (draft: InstanceDraft) => Promise<void>;
  renameInstance: (id: string, name: string) => Promise<void>;
  updateInstance: (id: string, patch: InstancePatch) => Promise<void>;
  deleteInstance: (id: string) => Promise<void>;
  measureInstance: (id: string) => Promise<void>;
  measureAllInstances: () => Promise<void>;
  loadLoaderInfo: (type: InstanceLoaderType, mcVersion: string) => Promise<void>;

  /**
   * Imports dropped files into one instance.
   *
   * Takes `File` objects rather than paths because the renderer cannot read a
   * dropped file's location itself — the path is resolved through the preload
   * bridge, which is the only side with access to `webUtils`.
   */
  importDroppedFiles: (files: File[], instanceId?: string) => Promise<void>;
  /** Same import, from already-resolved paths (the modal picker and tests). */
  importPaths: (paths: string[], instanceId?: string) => Promise<void>;

  refreshVersions: (force?: boolean) => Promise<void>;
  setChannelFilter: (filter: LauncherState['channelFilter']) => void;
  /** Points the active instance at another Minecraft version. */
  selectVersion: (id: string) => void;

  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  detectJava: () => Promise<void>;
  installJava: (major: number) => Promise<void>;

  installUpdate: () => Promise<void>;
  deferUpdate: () => Promise<void>;
  checkForUpdates: () => Promise<void>;

  /**
   * Launches an instance, defaulting to the active one.
   *
   * The id is a parameter rather than read-only-from-state so a card's Play
   * button can launch *its* instance: awaiting the select first and then reading
   * the active id races the IPC round trip and can start the wrong instance.
   */
  startLaunch: (instanceId?: string) => Promise<void>;
  stopLaunch: () => Promise<void>;

  notify: (kind: ToastKind, text: string) => void;
  dismissToast: () => void;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
let toastSeq = 0;

/**
 * Single funnel for every change to the instance list.
 *
 * The selected Minecraft version is a mirror of the active instance's version,
 * not independent state: keeping one source of truth is what stops the Play tab
 * from offering a version the instance it is about to launch does not use.
 */
function applyInstances(
  set: (partial: Partial<LauncherState>) => void,
  instances: InstanceInfo[],
  activeId: string | null,
): void {
  const active = instances.find((i) => i.id === activeId) ?? instances[0] ?? null;
  set({
    instances,
    activeInstanceId: active?.id ?? null,
    selectedVersionId: active?.gameVersion ?? '',
  });
}

export const useLauncher = create<LauncherState>((set, get) => ({
  ready: false,
  view: 'play',
  maximized: false,

  accounts: [],
  activeAccountId: null,
  authStatus: null,
  authBusy: false,
  authError: null,

  instances: [],
  activeInstanceId: null,
  runningInstanceId: null,
  instanceSizes: {},
  sizesLoading: false,
  instancesBusy: false,
  loaderInfo: null,
  loaderInfoKey: '',

  appInfo: null,

  versions: [],
  versionsLoading: false,
  versionsError: null,
  channelFilter: 'all',
  selectedVersionId: '',

  settings: null,
  javaInfo: null,
  javaRuntimes: [],
  javaInstall: null,
  javaInstalling: false,

  packKind: 'shader',
  packQuery: '',
  packPage: [],
  packTotalHits: 0,
  packOffset: 0,
  packLimit: 24,
  packLoading: false,
  packError: null,
  packsVersionExcluded: false,
  packsInstalled: [],
  packDownloads: {},
  launch: { ...IDLE_LAUNCH_STATE, logTail: [] },
  shaders: { ...IDLE_SHADER_ENGINE_STATE },
  toast: null,
  importProgress: null,
  importing: false,
  updater: { ...IDLE_UPDATER_STATE },

  init: async () => {
    api.launch.onState((state) => {
      set({ launch: state });
      // The main process owns which instance is running, and it is not the same
      // thing as the active selection: the user may switch tabs mid-game. Query
      // on every transition so the delete guard and the Running badge reflect
      // the process rather than whatever card was last clicked.
      if (state.phase === 'launching' || state.phase === 'running' || state.phase === 'stopping') {
        void api.instances.runningId().then((id) => {
          if (get().runningInstanceId !== id) set({ runningInstanceId: id });
        });
      } else if (state.phase === 'idle' || state.phase === 'error') {
        if (get().runningInstanceId !== null) set({ runningInstanceId: null });
      }
    });
    api.window.onMaximized((maximized) => set({ maximized }));

    api.instances.onUpdate((instances, activeId) => {
      applyInstances(set, instances, activeId);
    });

    api.accounts.onUpdate((accounts, activeId) => set({ accounts, activeAccountId: activeId }));
    api.accounts.onAuthStatus((message) => set({ authStatus: message, authBusy: true, authError: null }));
    api.accounts.onAuthError((message) => set({ authError: message, authStatus: null }));
    api.accounts.onAuthDone((result) => {
      set({ authBusy: false, authStatus: null });
      if (result !== 'ok') return;
      const { accounts, activeAccountId } = get();
      const active = accounts.find((a) => a.id === activeAccountId);
      get().notify('success', active ? `Signed in as ${active.username}` : 'Signed in with Microsoft');
    });
    api.java.onProgress((state) => {
      const installing = state.phase === 'downloading' || state.phase === 'extracting';
      set({ javaInstall: state, javaInstalling: installing });
      if (state.phase === 'done' || state.phase === 'error') {
        // a runtime was installed (or failed) during a launch — refresh the panel
        void get().detectJava();
      }
    });

    api.packs.onDownload((state) => {
      set((s) => ({ packDownloads: { ...s.packDownloads, [state.projectId]: state } }));
      if (state.phase === 'done') {
        void get().refreshInstalledPacks();
        get().notify('success', `Installed ${state.title}`);
      } else if (state.phase === 'error') {
        get().notify('error', `Install failed: ${state.error ?? 'unknown error'}`);
      }
    });

    // The engine is provisioned during launch, so surface the outcome once it
    // settles rather than on every intermediate "downloading" step.
    let announcedEngine: string | null = null;
    api.shaders.onStatus((state) => {
      set({ shaders: state });
      if (state.phase === 'provisioning') return;
      const key = `${state.phase}:${state.kind}:${state.mcVersion}`;
      if (announcedEngine === key) return;
      announcedEngine = key;
      if (state.phase === 'ready') {
        get().notify('success', `Shader engine (${state.label}) ready for ${state.mcVersion}`);
      } else if (state.phase === 'error') {
        get().notify('error', state.error ?? 'No shader engine is available for this version.');
      }
    });

    // Imports report per file so the overlay can name what it is waiting on,
    // and so a multi-file drop does not freeze on one long modpack download.
    api.imports.onProgress((state) => {
      set({ importProgress: state, importing: state.phase !== 'done' && state.phase !== 'error' });
    });

    api.updater.onState((state) => set({ updater: state }));

    const [settings, accounts, launch, shaders, javaInfo, activeId, javaRuntimes, appInfo, instances, instanceActiveId, runningId, updater] = await Promise.all([
      api.settings.get(),
      api.accounts.list(),
      api.launch.state(),
      api.shaders.status(),
      api.java.detect(),
      api.accounts.activeId(),
      api.java.installed(),
      api.app.info(),
      api.instances.list(),
      api.instances.activeId(),
      api.instances.runningId(),
      api.updater.state(),
    ]);

    set({ settings, accounts, activeAccountId: activeId, launch, shaders, javaInfo, javaRuntimes, appInfo, runningInstanceId: runningId, updater, ready: true });
    applyInstances(set, instances, instanceActiveId);
    void get().refreshVersions();
    // Measuring walks the whole folder tree, so it happens after the cards are
    // on screen rather than blocking them.
    void get().measureAllInstances();
  },

  setView: (view) => set({ view }),
  setMaximized: (maximized) => set({ maximized }),

  refreshAccounts: async () => {
    const accounts = await api.accounts.list();
    set({ accounts });
  },

  selectAccount: async (id) => {
    const accounts = await api.accounts.setActive(id);
    set({ accounts, activeAccountId: id });
  },

  removeAccount: async (id) => {
    const accounts = await api.accounts.remove(id);
    const activeId = await api.accounts.activeId();
    set({ accounts, activeAccountId: activeId });
    get().notify('info', 'Account removed');
  },

  addOffline: async (name) => {
    try {
      const accounts = await api.accounts.addOffline(name);
      const activeId = await api.accounts.activeId();
      set({ accounts, activeAccountId: activeId });
      get().notify('success', `Added offline profile ${name.trim()}`);
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  },

  beginMicrosoft: () => {
    set({ authError: null, authStatus: 'Starting Microsoft sign-in…', authBusy: true });
    api.accounts.beginMicrosoft();
  },

  cancelMicrosoft: () => {
    api.accounts.cancelMicrosoft();
    set({ authStatus: null, authBusy: false });
  },

  clearAuthError: () => set({ authError: null }),

  refreshVersions: async (force = false) => {
    set({ versionsLoading: true, versionsError: null });
    try {
      const versions = force ? await api.versions.refresh() : await api.versions.list();
      // The active instance owns the version, so fall back to its value rather
      // than a remembered one — the version list must not override an instance.
      const active = get().instances.find((i) => i.id === get().activeInstanceId);
      const current = active?.gameVersion ?? get().selectedVersionId;
      const known = versions.some((v) => v.id === current);
      const fallback =
        versions.find((v) => v.channel === 'release')?.id ?? versions[0]?.id ?? current;
      set({
        versions,
        versionsLoading: false,
        selectedVersionId: known ? current : (current || fallback),
      });
    } catch (err) {
      set({
        versionsLoading: false,
        versionsError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  setChannelFilter: (channelFilter) => set({ channelFilter }),

  selectVersion: (id) => {
    const activeId = get().activeInstanceId;
    if (!activeId) {
      get().notify('error', 'No instance selected.');
      return;
    }
    set({ selectedVersionId: id });
    void get().updateInstance(activeId, { gameVersion: id });
  },

  refreshInstances: async () => {
    const [instances, activeId] = await Promise.all([
      api.instances.list(),
      api.instances.activeId(),
    ]);
    applyInstances(set, instances, activeId);
  },

  selectInstance: async (id) => {
    try {
      await api.instances.setActive(id);
      const instances = await api.instances.list();
      applyInstances(set, instances, id);
      // Packs and mods are per instance, so a switch invalidates both.
      void get().refreshInstalledPacks();
      if (get().packPage.length > 0) void get().searchPacks({ reset: true });
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : String(err));
    }
  },

  createInstance: async (draft) => {
    set({ instancesBusy: true });
    try {
      const created = await api.instances.create(draft);
      const instances = await api.instances.list();
      applyInstances(set, instances, created.id);
      get().notify('success', `Created instance "${created.name}"`);
      void get().measureInstance(created.id);
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      set({ instancesBusy: false });
    }
  },

  renameInstance: async (id, name) => {
    try {
      const instances = await api.instances.rename(id, name);
      applyInstances(set, instances, get().activeInstanceId);
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : String(err));
    }
  },

  updateInstance: async (id, patch) => {
    try {
      const instances = await api.instances.update(id, patch);
      applyInstances(set, instances, get().activeInstanceId);
      // A version or loader change re-filters search results for mods.
      if (patch.gameVersion !== undefined || patch.loader !== undefined) {
        void get().loadLoaderInfo(
          instances.find((i) => i.id === id)?.loader.type ?? 'vanilla',
          instances.find((i) => i.id === id)?.gameVersion ?? '',
        );
        if (get().packPage.length > 0) void get().searchPacks({ reset: true });
      }
      if (patch.gameVersion !== undefined && id === get().activeInstanceId) {
        void get().refreshInstalledPacks();
      }
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : String(err));
    }
  },

  deleteInstance: async (id) => {
    const meta = get().instances.find((i) => i.id === id);
    if (!meta) return;
    if (get().runningInstanceId === id) {
      get().notify('error', 'This instance is running. Stop the game before deleting it.');
      return;
    }
    try {
      const instances = await api.instances.remove(id);
      const activeId = await api.instances.activeId();
      applyInstances(set, instances, activeId);
      get().notify('info', `Deleted instance "${meta.name}"`);
      void get().measureAllInstances();
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : String(err));
    }
  },

  measureInstance: async (id) => {
    try {
      const size = await api.instances.size(id);
      set((s) => ({ instanceSizes: { ...s.instanceSizes, [id]: size } }));
    } catch {
      /* a folder that vanished simply has no size to show */
    }
  },

  measureAllInstances: async () => {
    const ids = get().instances.map((i) => i.id);
    if (ids.length === 0) return;
    set({ sizesLoading: true });
    try {
      const sizes: Record<string, InstanceSizeInfo> = {};
      // Sequential on purpose: each walk is disk-bound, and running them all at
      // once on an HDD just thrashes the head.
      for (const id of ids) {
        try {
          sizes[id] = await api.instances.size(id);
        } catch {
          /* skip an unreadable instance */
        }
      }
      set((s) => ({ instanceSizes: { ...s.instanceSizes, ...sizes } }));
    } finally {
      set({ sizesLoading: false });
    }
  },

  loadLoaderInfo: async (type, mcVersion) => {
    const key = `${type}@${mcVersion}`;
    // Only refetch when the pair actually changed; the create dialog asks on
    // every keystroke of the version field.
    if (get().loaderInfoKey === key) return;
    set({ loaderInfoKey: key, loaderInfo: null });
    try {
      const loaderInfo = await api.instances.loaders(type, mcVersion);
      if (get().loaderInfoKey !== key) return;
      set({ loaderInfo });
    } catch {
      set({ loaderInfo: null });
    }
  },

  importDroppedFiles: async (files, instanceId) => {
    if (files.length === 0) return;
    // The renderer cannot see a dropped file's path: Electron removed
    // `File.path`, so every file has to cross the bridge and come back resolved.
    const paths = files
      .map((file) => api.imports.pathForFile(file))
      .filter((p): p is string => Boolean(p));
    if (paths.length === 0) {
      get().notify('error', 'Could not read the dropped file. Drag from a file manager.');
      return;
    }
    if (paths.length < files.length) {
      get().notify('info', `Skipped ${files.length - paths.length} file(s) with no path.`);
    }
    await get().importPaths(paths, instanceId);
  },

  importPaths: async (paths, instanceId) => {
    if (paths.length === 0) return;
    const target = instanceId ?? get().activeInstanceId ?? undefined;
    if (!target) {
      get().notify('error', 'Create an instance before importing into it.');
      return;
    }
    const name =
      get().instances.find((i) => i.id === target)?.name ??
      get().instances.find((i) => i.id === target)?.id ??
      target;
    set({ importing: true, importProgress: null });
    try {
      const result = await api.imports.importFiles(paths, target);
      const ok = result.files.filter((f) => f.ok);
      const failed = result.files.filter((f) => !f.ok);

      if (ok.length > 0) {
        // `added` is already classified by main, so count from it rather than
        // pattern-matching instance paths in the renderer.
        const mods = result.added.filter((p) => p.kind === 'mod').length;
        get().notify(
          'success',
          mods > 0
            ? `Imported ${mods} mod${mods === 1 ? '' : 's'} into ${name}`
            : `Imported ${ok.length} file${ok.length === 1 ? '' : 's'} into ${name}`,
        );
      }
      if (failed.length > 0) {
        // Report the first reason rather than all of them: they are usually the
        // same cause, and a ten-line toast would cover the UI.
        get().notify(
          'error',
          `${failed.length} file${failed.length === 1 ? '' : 's'} skipped — ${failed[0].fileName}: ${
            failed[0].error ?? 'unknown error'
          }`,
        );
      }

      // Only the list actually on screen needs reloading, but the imported packs
      // may belong to a different tab, so refresh when that tab comes forward.
      if (result.touchedKinds.includes(get().packKind)) {
        await get().refreshInstalledPacks();
      }
      void get().measureInstance(target);
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : String(err));
    } finally {
      set({ importing: false, importProgress: null });
    }
  },

  installUpdate: async () => {
    try {
      await api.updater.install();
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : String(err));
    }
  },

  deferUpdate: async () => {
    await api.updater.defer();
  },

  checkForUpdates: async () => {
    const { updater } = get();
    if (!updater.supported) {
      get().notify('info', 'Updates are only available in an installed build.');
      return;
    }
    await api.updater.check();
  },

  saveSettings: async (patch) => {
    const settings = await api.settings.set(patch);
    set({ settings });
    if ('javaPath' in patch) void get().detectJava();
  },

  detectJava: async () => {
    const settings = get().settings;
    const [javaInfo, javaRuntimes] = await Promise.all([
      api.java.detect(settings?.javaPath || undefined),
      api.java.installed(),
    ]);
    set({ javaInfo, javaRuntimes });
  },

  installJava: async (major) => {
    if (get().javaInstalling) return;
    set({
      javaInstalling: true,
      javaInstall: { major, phase: 'downloading', label: 'Starting download…', current: 0, total: 1, error: null },
    });
    try {
      const javaInfo = await api.java.install(major);
      const javaRuntimes = await api.java.installed();
      set({
        javaInfo,
        javaRuntimes,
        javaInstall: { major, phase: 'done', label: `Java ${major} installed`, current: 1, total: 1, error: null },
        javaInstalling: false,
      });
      get().notify('success', `Java ${major} installed and ready`);
      setTimeout(() => {
        if (get().javaInstall?.phase === 'done') set({ javaInstall: null });
      }, 2500);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({
        javaInstalling: false,
        javaInstall: { major, phase: 'error', label: 'Install failed', current: 0, total: 1, error: message },
      });
      get().notify('error', `Java install failed: ${message}`);
      throw err;
    }
  },

  startLaunch: async (targetId) => {
    // Prefer the explicit target, then the mirror of the active instance.
    const instanceId = targetId ?? get().activeInstanceId;
    const { activeAccountId, launch } = get();
    if (!activeAccountId) {
      set({ view: 'accounts' });
      get().notify('error', 'Add or select an account before launching.');
      return;
    }
    if (!instanceId) {
      set({ view: 'instances' });
      get().notify('error', 'Create an instance before launching.');
      return;
    }
    if (launch.phase === 'running' || launch.phase === 'preparing' || launch.phase === 'downloading') return;
    try {
      // A card that launched a non-active instance keeps it selected, so the
      // Play tab, the version mirror and the log view all follow the launch.
      if (targetId && targetId !== get().activeInstanceId) await get().selectInstance(targetId);
      // No version argument: main resolves the instance, its version and its
      // loader, so the renderer cannot request a combination that does not exist.
      await api.launch.start(instanceId);
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : String(err));
    }
  },

  stopLaunch: async () => {
    await api.launch.stop();
    get().notify('info', 'Stopping the game…');
  },

  setPackKind: (packKind) => {
    if (packKind === get().packKind) return;
    // Project types are mutually exclusive, so switching tabs invalidates results.
    set({ packKind, packOffset: 0, packPage: [], packError: null });
    void get().searchPacks();
    void get().refreshInstalledPacks();
  },

  setPackQuery: (packQuery) => set({ packQuery, packOffset: 0 }),

  goToPackPage: (packOffset) => {
    set({ packOffset: Math.max(0, packOffset), packPage: [] });
    void get().searchPacks();
  },

  searchPacks: async (opts) => {
    const { packKind, packQuery, packOffset, packLimit } = get();
    const active = get().instances.find((i) => i.id === get().activeInstanceId);
    const reset = opts?.reset ?? packOffset === 0;
    set({ packLoading: true, packError: null });
    try {
      const page = await api.packs.search({
        kind: packKind,
        query: packQuery,
        // The instance decides the version *and* the loader: a mod that does not
        // match either would fail in-game, so filtering here saves the user from
        // finding that out after downloading.
        mcVersion: active?.gameVersion ?? '',
        loader: active?.loader.type ?? 'vanilla',
        offset: packOffset,
        limit: packLimit,
      });
      set((s) => ({
        packPage: reset ? page.projects : [...s.packPage, ...page.projects],
        packTotalHits: page.totalHits,
        packsVersionExcluded: page.versionExcluded,
        packLoading: false,
      }));
    } catch (err) {
      set({
        packLoading: false,
        packError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  installPack: async (project) => {
    const { packKind, packDownloads, activeInstanceId } = get();
    const active = get().instances.find((i) => i.id === activeInstanceId);
    if (!active) {
      get().notify('error', 'Select an instance first.');
      return;
    }
    if (packDownloads[project.id]?.phase === 'downloading') return;
    set({
      packDownloads: {
        ...packDownloads,
        [project.id]: {
          projectId: project.id,
          title: project.title,
          kind: packKind,
          instanceId: active.id,
          phase: 'downloading',
          current: 0,
          total: 0,
          error: null,
          filePath: null,
        },
      },
    });
    try {
      await api.packs.install(project.id, packKind, active.gameVersion, active.id);
    } catch {
      // the failure is already reported through onDownload + a toast
    }
  },

  removePack: async (fileName) => {
    const kind = get().packKind;
    try {
      const packsInstalled = await api.packs.remove(kind, fileName, get().activeInstanceId ?? undefined);
      set({ packsInstalled });
      get().notify('info', `Removed ${fileName}`);
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : String(err));
    }
  },

  togglePack: async (fileName, enabled) => {
    const kind = get().packKind;
    try {
      const packsInstalled = await api.packs.setEnabled(
        kind,
        fileName,
        enabled,
        get().activeInstanceId ?? undefined,
      );
      set({ packsInstalled });
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : String(err));
    }
  },

  refreshInstalledPacks: async () => {
    const packsInstalled = await api.packs.list(get().packKind, get().activeInstanceId ?? undefined);
    set({ packsInstalled });
  },

  notify: (kind, text) => {
    if (toastTimer) clearTimeout(toastTimer);
    const id = ++toastSeq;
    set({ toast: { id, kind, text } });
    toastTimer = setTimeout(() => {
      if (get().toast?.id === id) set({ toast: null });
    }, 4200);
  },

  dismissToast: () => set({ toast: null }),
}));

export function filterVersions(
  versions: VersionEntry[],
  filter: LauncherState['channelFilter'],
): VersionEntry[] {
  switch (filter) {
    case 'release':
      return versions.filter((v) => v.channel === 'release');
    case 'snapshot':
      return versions.filter((v) => v.channel === 'snapshot');
    case 'installed':
      return versions.filter((v) => v.installed);
    default:
      return versions;
  }
}

export const CHANNEL_LABEL: Record<VersionChannel, string> = {
  release: 'Release',
  snapshot: 'Snapshot',
  old_beta: 'Beta',
  old_alpha: 'Alpha',
};

/** The active instance, or null before the first list load. */
export function activeInstanceOf(state: LauncherState): InstanceInfo | null {
  return state.instances.find((i) => i.id === state.activeInstanceId) ?? null;
}
