import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  Account,
  AuthDone,
  FlameApi,
  ImportResult,
  ImportState,
  InstanceDraft,
  InstanceInfo,
  InstancePatch,
  InstalledPack,
  JavaInstallState,
  LaunchState,
  LoaderAvailability,
  PackDownloadState,
  PackKind,
  PackSearchPage,
  PackSearchQuery,
  Settings,
  ShaderEngineState,
  UpdaterState,
} from '../shared/types';

/**
 * Forwards every argument the main process emitted, not just the first.
 *
 * `emit(channel, list, activeId)` sends two positional values, and a listener
 * that only saw the first would treat a single list element as the whole list —
 * a failure that shows up as `.find is not a function` in the renderer rather
 * than as anything pointing at the bridge.
 */
function subscribe<T extends unknown[]>(
  channel: string,
  cb: (...args: T) => void,
): () => void {
  const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
    cb(...(args as T));
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

/** Single-payload channels, where the shape is the argument itself. */
function subscribeOne<T>(channel: string, cb: (payload: T) => void): () => void {
  return subscribe<[T]>(channel, cb);
}

const api: FlameApi = {
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximized: (cb) => subscribe('window:maximized', cb),
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openExternal: (url) => void ipcRenderer.invoke('app:openExternal', url),
    openGameDir: () => void ipcRenderer.invoke('app:openGameDir'),
    pickFolder: () => ipcRenderer.invoke('app:pickFolder'),
  },
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    activeId: () => ipcRenderer.invoke('accounts:activeId'),
    setActive: (id) => ipcRenderer.invoke('accounts:setActive', id),
    remove: (id) => ipcRenderer.invoke('accounts:remove', id),
    addOffline: (username) => ipcRenderer.invoke('accounts:addOffline', username),
    refresh: (id) => ipcRenderer.invoke('accounts:refresh', id),
    beginMicrosoft: () => ipcRenderer.send('accounts:beginMicrosoft'),
    cancelMicrosoft: () => ipcRenderer.send('accounts:cancelMicrosoft'),
    onAuthStatus: (cb) => subscribeOne<string>('accounts:authStatus', cb),
    onAuthError: (cb) => subscribeOne<string>('accounts:error', cb),
    onUpdate: (cb) => subscribe<[Account[], string | null]>('accounts:update', cb),
    onAuthDone: (cb) => subscribeOne<AuthDone>('accounts:authDone', cb),
  },
  versions: {
    list: () => ipcRenderer.invoke('versions:list'),
    refresh: () => ipcRenderer.invoke('versions:refresh'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:set', patch),
  },
  java: {
    detect: (explicitPath?: string) => ipcRenderer.invoke('java:detect', explicitPath),
    install: (major: number) => ipcRenderer.invoke('java:install', major),
    installed: () => ipcRenderer.invoke('java:installed'),
    onProgress: (cb) => subscribeOne<JavaInstallState>('java:progress', cb),
  },
  instances: {
    list: () => ipcRenderer.invoke('instances:list') as Promise<InstanceInfo[]>,
    activeId: () => ipcRenderer.invoke('instances:activeId') as Promise<string | null>,
    setActive: (id: string) => ipcRenderer.invoke('instances:setActive', id),
    create: (draft: InstanceDraft) => ipcRenderer.invoke('instances:create', draft),
    rename: (id: string, name: string) => ipcRenderer.invoke('instances:rename', id, name),
    update: (id: string, patch: InstancePatch) =>
      ipcRenderer.invoke('instances:update', id, patch),
    remove: (id: string) => ipcRenderer.invoke('instances:remove', id) as Promise<InstanceInfo[]>,
    size: (id: string) => ipcRenderer.invoke('instances:size', id),
    loaders: (type, mcVersion = '') => ipcRenderer.invoke('instances:loaders', type, mcVersion) as Promise<LoaderAvailability>,
    open: (id: string) => void ipcRenderer.invoke('instances:open', id),
    openRoot: () => void ipcRenderer.invoke('instances:openRoot'),
    /** Instance whose game is running right now, if any. */
    runningId: () => ipcRenderer.invoke('instances:runningId') as Promise<string | null>,
    onUpdate: (cb) => subscribe<[InstanceInfo[], string | null]>('instances:update', cb),
  },
  launch: {
    /** Omit the id to launch the active instance. */
    start: (instanceId?: string) => ipcRenderer.invoke('launch:start', instanceId),
    stop: () => ipcRenderer.invoke('launch:stop'),
    state: () => ipcRenderer.invoke('launch:state'),
    onState: (cb) => subscribeOne<LaunchState>('launch:state', cb),
    readLog: (instanceId?: string, lines?: number) =>
      ipcRenderer.invoke('launch:readLog', instanceId, lines),
    openLog: (instanceId?: string) => ipcRenderer.invoke('launch:openLog', instanceId),
  },
  shaders: {
    status: () => ipcRenderer.invoke('shaders:status'),
    onStatus: (cb) => subscribeOne<ShaderEngineState>('shaders:status', cb),
  },
  packs: {
    search: (query: PackSearchQuery) => ipcRenderer.invoke('packs:search', query),
    /** Every pack call takes the instance, defaulting to the active one in main. */
    install: (projectId: string, kind: PackKind, mcVersion = '', instanceId?: string) =>
      ipcRenderer.invoke('packs:install', projectId, kind, mcVersion, instanceId),
    list: (kind: PackKind, instanceId?: string) =>
      ipcRenderer.invoke('packs:list', kind, instanceId) as Promise<InstalledPack[]>,
    remove: (kind: PackKind, fileName: string, instanceId?: string) =>
      ipcRenderer.invoke('packs:remove', kind, fileName, instanceId),
    setEnabled: (kind: PackKind, fileName: string, enabled: boolean, instanceId?: string) =>
      ipcRenderer.invoke('packs:setEnabled', kind, fileName, enabled, instanceId),
    onDownload: (cb) => subscribeOne<PackDownloadState>('packs:download', cb),
  },
  imports: {
    /**
     * Electron removed `File.path` in v32, so the renderer genuinely cannot read
     * a dropped file's location. `webUtils` is only reachable from this side of
     * the context bridge, which is why the `File` object is passed over whole.
     *
     * Returns an empty string for a file that did not come from the OS — a
     * synthetic drag in a test, for instance — and the renderer treats that as
     * "nothing to import" rather than passing a bogus path to main.
     */
    pathForFile: (file: File) => {
      try {
        return webUtils.getPathForFile(file) ?? '';
      } catch {
        return '';
      }
    },
    importFiles: (paths: string[], instanceId?: string) =>
      ipcRenderer.invoke('imports:files', paths, instanceId) as Promise<ImportResult>,
    onProgress: (cb) => subscribeOne<ImportState>('imports:progress', cb),
  },
  updater: {
    state: () => ipcRenderer.invoke('updater:state') as Promise<UpdaterState>,
    check: () => ipcRenderer.invoke('updater:check') as Promise<void>,
    install: () => ipcRenderer.invoke('updater:install') as Promise<void>,
    defer: () => ipcRenderer.invoke('updater:defer') as Promise<void>,
    onState: (cb) => subscribeOne<UpdaterState>('updater:state', cb),
  },
};

contextBridge.exposeInMainWorld('flame', api);
