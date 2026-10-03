import { BrowserWindow, app, nativeTheme, shell } from 'electron';
import path from 'node:path';
import { registerIpc } from './ipc';
import { store } from './store';
import { initUpdater } from './updater';

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

// Single instance lock — a second launch just focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

function createWindow(): void {
  const bounds = store.getWindowBounds();

  const win = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 800,
    minWidth: 1040,
    minHeight: 680,
    x: bounds?.x,
    y: bounds?.y,
    show: false,
    frame: false,
    backgroundColor: '#06080c',
    title: 'Flame Client',
    autoHideMenuBar: true,
    resizable: true,
    fullscreenable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      devTools: DEV_SERVER_URL ? true : false,
    },
  });

  nativeTheme.themeSource = 'dark';

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  win.once('ready-to-show', () => {
    if (bounds?.maximized) win.maximize();
    win.show();
  });

  const broadcastMaximized = () => {
    if (!win.isDestroyed()) win.webContents.send('window:maximized', win.isMaximized());
  };
  win.on('maximize', broadcastMaximized);
  win.on('unmaximize', broadcastMaximized);

  let boundsTimer: NodeJS.Timeout | null = null;
  const persistBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isMaximized()) return;
      const b = win.getBounds();
      store.setWindowBounds({ ...b, maximized: win.isMaximized() });
    }, 400);
  };
  win.on('resize', persistBounds);
  win.on('move', persistBounds);
  win.on('close', () => {
    if (!win.isDestroyed()) {
      const b = win.getBounds();
      store.setWindowBounds({ ...b, maximized: win.isMaximized() });
      store.flush();
    }
  });

  // Block any unexpected navigation / window.open inside the shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('data:') && !(DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL))) {
      event.preventDefault();
    }
  });
}

app.whenReady().then(() => {
  registerIpc();
  // After registerIpc so the renderer emitter already exists: the first check is
  // scheduled 20s out, but a cached update could still be reported immediately.
  initUpdater();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  store.flush();
  if (process.platform !== 'darwin') app.quit();
});


