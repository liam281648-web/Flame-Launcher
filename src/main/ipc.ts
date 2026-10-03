import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type {
  InstanceDraft,
  InstanceLoaderType,
  InstancePatch,
  PackDownloadState,
  PackKind,
  PackSearchQuery,
  Settings,
} from '../shared/types';
import {
  beginMicrosoftLogin,
  cancelMicrosoftLogin,
  listAccounts,
  refreshAccount,
  removeAccount,
  setActiveAccount,
  addOfflineAccount,
} from './accounts';
import { setRendererEmitter } from './events';
import { store } from './store';
import { fetchManifest, listVersions } from './launcher/manifest';
import {
  activeTarget,
  installProject,
  listInstalled,
  removeInstalled,
  searchProjects,
  setPackEnabled,
  targetFor,
} from './modrinth';
import { detectJava } from './launcher/java';
import { installJava, listInstalledRuntimes } from './launcher/java-runtime';
import {
  activeLaunchInstanceId,
  getLaunchState,
  launch,
  onLaunchState,
  stop,
  readLaunchLog,
  launchLogPath,
} from './launcher/launch';
import { getShaderEngineState } from './launcher/shader-engine';
import { importFiles } from './importer';
import { getUpdaterService } from './updater';
import { emit } from './events';
import { dataRoot, ensureDir } from './fsutil';
import {
  activeInstance,
  createInstance,
  ensureInstancesRoot,
  instancesRoot,
  instanceDir,
  instanceSize,
  listInstances,
  loaderAvailability,
  removeInstance,
  renameInstance,
  setActiveInstance,
  updateInstance,
} from './instances';

/**
 * Resolves the instance a pack operation targets. Defaults to the active
 * instance when the renderer does not name one, so a single-instance flow needs
 * no extra plumbing — but every handler accepts an explicit id, because the UI
 * always has the instance in hand and a stale "active" would silently write into
 * the wrong folder.
 */
function packTarget(instanceId?: string) {
  return instanceId ? targetFor(instanceId) : activeTarget();
}

function window(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null;
}

export function registerIpc(): void {
  // Creates `instances/`, migrates a pre-multi-instance game directory into the
  // default instance and resolves a valid active id, so every later handler can
  // assume an instance exists.
  ensureInstancesRoot();

  setRendererEmitter((channel, ...args) => {
    const win = window();
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  });

  onLaunchState((state) => {
    const win = window();
    if (win && !win.isDestroyed()) win.webContents.send('launch:state', state);

    if (state.phase === 'running' && store.getSettings().closeOnLaunch) {
      setTimeout(() => {
        const w = window();
        if (w && !w.isDestroyed()) w.close();
      }, 700);
    }
  });

  // ---- window controls
  ipcMain.on('window:minimize', () => window()?.minimize());
  ipcMain.on('window:toggleMaximize', () => {
    const win = window();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('window:close', () => window()?.close());
  ipcMain.handle('window:isMaximized', () => window()?.isMaximized() ?? false);

  // ---- app
  ipcMain.handle('app:info', () => ({
    appVersion: app.getVersion(),
    platform: process.platform,
    /** Shared cache root: versions, libraries, assets. */
    dataRoot: dataRoot(),
    /** Where instance folders live. */
    instancesRoot: instancesRoot(),
  }));
  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (typeof url === 'string' && /^https:\/\//i.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('app:openGameDir', () => {
    const dir = ensureDir(dataRoot());
    shell.openPath(dir);
  });

  // ---- instances
  // Every mutation re-emits the whole list: instance count is small, and one
  // authoritative event path is cheaper to reason about than partial patching.
  const publishInstances = (): void => {
    emit('instances:update', listInstances(), store.getActiveInstanceId());
  };

  ipcMain.handle('instances:list', () => listInstances());
  ipcMain.handle('instances:activeId', () => store.getActiveInstanceId());
  ipcMain.handle('instances:setActive', (_e, id: string) => {
    const meta = setActiveInstance(id);
    publishInstances();
    return meta;
  });
  ipcMain.handle('instances:create', (_e, draft: InstanceDraft) => {
    const created = createInstance(draft);
    publishInstances();
    return created;
  });
  ipcMain.handle('instances:rename', (_e, id: string, name: string) => {
    const list = renameInstance(id, name);
    publishInstances();
    return list;
  });
  ipcMain.handle('instances:update', (_e, id: string, patch: InstancePatch) => {
    const list = updateInstance(id, patch);
    publishInstances();
    return list;
  });
  ipcMain.handle('instances:remove', (_e, id: string) => {
    // Deleting the folder a live process is writing to fails on Windows and
    // silently corrupts the next launch elsewhere; refuse it with a real reason.
    if (activeLaunchInstanceId() === id) {
      throw new Error('This instance is running. Stop the game before deleting it.');
    }
    const list = removeInstance(id);
    publishInstances();
    return list;
  });
  ipcMain.handle('instances:size', (_e, id: string) => instanceSize(id));
  ipcMain.handle('instances:loaders', (_e, type: InstanceLoaderType, mcVersion = '') =>
    loaderAvailability(type, mcVersion),
  );
  ipcMain.handle('instances:open', (_e, id: string) => {
    shell.openPath(ensureDir(instanceDir(id)));
  });
  ipcMain.handle('instances:openRoot', () => {
    shell.openPath(ensureDir(instancesRoot()));
  });
  /** Non-null while a game process is alive, so the UI can block deleting it. */
  ipcMain.handle('instances:runningId', () => activeLaunchInstanceId());

  // ---- accounts
  ipcMain.handle('accounts:list', () => listAccounts());
  ipcMain.handle('accounts:activeId', () => store.getActiveId());
  ipcMain.handle('accounts:setActive', (_e, id: string) => setActiveAccount(id));
  ipcMain.handle('accounts:remove', (_e, id: string) => removeAccount(id));
  ipcMain.handle('accounts:addOffline', (_e, username: string) => addOfflineAccount(username));
  ipcMain.handle('accounts:refresh', async (_e, id: string) => {
    try {
      return await refreshAccount(id);
    } catch (err) {
      const win = window();
      win?.webContents.send('accounts:error', err instanceof Error ? err.message : String(err));
      return null;
    }
  });
  ipcMain.on('accounts:beginMicrosoft', () => beginMicrosoftLogin());
  ipcMain.on('accounts:cancelMicrosoft', () => cancelMicrosoftLogin());

  // ---- versions
  ipcMain.handle('versions:list', () => listVersions());
  ipcMain.handle('versions:refresh', async () => {
    await fetchManifest(true);
    return listVersions();
  });

  // ---- settings
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => store.setSettings(patch));

  // ---- java
  ipcMain.handle('java:detect', (_e, explicit?: string) => detectJava(explicit));
  ipcMain.handle('java:installed', () => listInstalledRuntimes());
  ipcMain.handle('java:install', async (_e, major: number) => {
    const target = Number(major) || 21;
    try {
      const info = await installJava(target, (p) =>
        emit('java:progress', { ...p, major: target, error: p.error ?? null }),
      );
      // refresh the stored path so Settings reflects the new runtime immediately
      const current = store.getSettings().javaPath;
      if (!current) {
        const detected = detectJava();
        if (detected) emit('java:detected', detected);
      }
      return info;
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  });

  // ---- launch
  ipcMain.handle('launch:start', async (_e, instanceId?: string) => {
    try {
      // Resolved in main, with the instance's own Minecraft version and loader;
      // the renderer never names a version for the game any more.
      await launch(instanceId);
    } catch {
      /* state already reported */
    }
  });
  ipcMain.handle('launch:stop', () => stop());
  ipcMain.handle('launch:state', () => getLaunchState());
  ipcMain.handle('launch:readLog', (_e, instanceId?: string, lines?: number) =>
    readLaunchLog(
      instanceId ?? activeInstance().id,
      typeof lines === 'number' && lines > 0 ? Math.min(2000, lines) : 200,
    ),
  );
  ipcMain.handle('launch:openLog', (_e, instanceId?: string) => {
    const file = launchLogPath(instanceId ?? activeInstance().id);
    if (fs.existsSync(file)) shell.openPath(file);
  });

  // ---- shader engine
  ipcMain.handle('shaders:status', () => getShaderEngineState());

  // ---- modrinth packs
  ipcMain.handle('packs:search', (_e, query: PackSearchQuery) => searchProjects(query));
  ipcMain.handle('packs:list', (_e, kind: PackKind, instanceId?: string) =>
    listInstalled(kind, packTarget(instanceId)),
  );
  ipcMain.handle('packs:remove', (_e, kind: PackKind, fileName: string, instanceId?: string) =>
    removeInstalled(kind, fileName, packTarget(instanceId)),
  );
  ipcMain.handle('packs:setEnabled', (
    _e,
    kind: PackKind,
    fileName: string,
    enabled: boolean,
    instanceId?: string,
  ) => setPackEnabled(kind, fileName, enabled, packTarget(instanceId)));
  ipcMain.handle('packs:install', async (
    _e,
    projectId: string,
    kind: PackKind,
    mcVersion = '',
    instanceId?: string,
  ) => {
    const settings = store.getSettings();
    const target = packTarget(instanceId);
    const state: PackDownloadState = {
      projectId,
      title: projectId,
      kind,
      instanceId: target.instanceId,
      phase: 'downloading',
      current: 0,
      total: 0,
      error: null,
      filePath: null,
    };
    try {
      const result = await installProject(kind, projectId, {
        mcVersion,
        // The menu theme is the launcher's own; never let a pack install silently
        // override the user's choice about it.
        enable: kind === 'resourcepack' ? settings.menuPack !== false : true,
        onProgress: (received, total) => emit('packs:download', { ...state, current: received, total }),
      }, target);
      emit('packs:download', {
        ...state,
        phase: 'done',
        current: result.size,
        total: result.size,
        filePath: result.path,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit('packs:download', { ...state, phase: 'error', error: message });
      throw new Error(message);
    }
  });

  // ---- dialogs
  ipcMain.handle('app:pickFolder', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose game directory',
    });
    return res.canceled ? null : res.filePaths[0] ?? null;
  });

  // ---- drag-and-drop import
  ipcMain.handle('imports:files', async (
    _e,
    paths: string[],
    instanceId?: string,
  ) => {
    const target = packTarget(instanceId);
    return importFiles(paths, target, {
      onProgress: (progress) => emit('imports:progress', { instanceId: target.instanceId, ...progress }),
    });
  });

  // ---- auto updater
  ipcMain.handle('updater:state', () => getUpdaterService().getState());
  ipcMain.handle('updater:check', () => getUpdaterService().check());
  ipcMain.handle('updater:install', () => getUpdaterService().install());
  ipcMain.handle('updater:defer', () => getUpdaterService().defer());
}
