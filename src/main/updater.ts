import { app } from 'electron';
import type { UpdaterPhase, UpdaterState } from '../shared/types';
import { IDLE_UPDATER_STATE } from '../shared/types';
import { emit } from './events';

/**
 * GitHub Releases auto-update.
 *
 * Two properties matter more than the update check itself:
 *
 *  1. It is inert unless the app is actually packaged. electron-updater refuses
 *     to run unpacked ("application is not packed") and would throw during
 *     `npm run dev` and in the e2e suite, so `supported` gates everything.
 *  2. "Later" is not "never". `autoInstallOnAppQuit` is left on, so a
 *     downloaded update applies the next time the launcher exits — no persisted
 *     "pending" flag that could disagree with what is actually on disk.
 */

/** Milliseconds before the first check: long enough not to compete with boot. */
const FIRST_CHECK_DELAY = 20_000;
const INTERVAL = 6 * 60 * 60 * 1000;

/** The slice of electron-updater's surface this module uses. */
export interface UpdaterLike {
  autoDownload: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, handler: (...args: unknown[]) => void): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateInfoLike {
  version?: string;
  releaseNotes?: string | { body?: string }[] | null;
}

function releaseNotesToText(notes: UpdateInfoLike['releaseNotes']): string | null {
  if (typeof notes === 'string') return notes.trim() || null;
  if (!Array.isArray(notes)) return null;
  const text = notes
    .map((note) => (typeof note === 'string' ? note : (note?.body ?? '')))
    .filter(Boolean)
    .join('\n\n')
    .trim();
  return text || null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Builds the updater state machine around an injected `autoUpdater`.
 *
 * Everything else here is pure enough to drive from a test with a fake updater,
 * which is the only way to assert the deferred/quit flow without a published
 * release or a network connection.
 */
export function createUpdaterService(updater: UpdaterLike, supported: boolean) {
  let state: UpdaterState = { ...IDLE_UPDATER_STATE, supported };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let started = false;

  const publish = (patch: Partial<UpdaterState>) => {
    state = { ...state, ...patch };
    emit('updater:state', state);
  };

  const stopTimers = () => {
    if (timer) clearTimeout(timer);
    if (interval) clearInterval(interval);
    timer = null;
    interval = null;
  };

  const setPhase = (phase: UpdaterPhase, patch: Partial<UpdaterState> = {}) =>
    publish({ phase, ...patch });

  /**
   * Reads the current phase.
   *
   * `state` is reassigned from inside `publish`, which narrowing across a plain
   * `state.phase` read cannot see. Going through a call keeps the compiler
   * honest about the guard below instead of treating it as dead code.
   */
  const currentPhase = (): UpdaterPhase => state.phase;

  /** Re-checks without touching `deferred`, so a "Later" banner stays hidden. */
  const check = async (): Promise<void> => {
    if (!supported) return;
    const phase = currentPhase();
    if (phase === 'checking' || phase === 'downloading') return;
    setPhase('checking', { error: null });
    try {
      await updater.checkForUpdates();
      // electron-updater reports the outcome through its events, so normally one
      // of the handlers above moves the phase on. Settling back to idle here is
      // the safety net: if it ever resolves silently, the launcher must not stay
      // stuck at 'checking' forever, because that guard drops every later check.
      if (currentPhase() === 'checking') setPhase('idle');
    } catch (err) {
      // A failed check is not worth interrupting the user over — the banner only
      // appears for a real update, so this stays in the log.
      console.error('[updater] check failed', err);
      setPhase('idle', { error: messageOf(err) });
    }
  };

  const install = (): void => {
    if (state.phase !== 'ready') throw new Error('No update has been downloaded yet.');
    // isSilent keeps the installer from showing its own UI on top of a quit the
    // user already agreed to; isForceRunAfter relaunches straight into the
    // updated build.
    updater.quitAndInstall(true, true);
  };

  const defer = (): void => {
    publish({ deferred: true });
  };

  const wire = () => {
    updater.on('checking-for-update', () => setPhase('checking', { error: null }));

    updater.on('update-available', (info: unknown) => {
      const update = (info ?? {}) as UpdateInfoLike;
      setPhase('available', {
        version: update.version ?? null,
        releaseNotes: releaseNotesToText(update.releaseNotes),
        percent: 0,
      });
    });

    updater.on('update-not-available', () => {
      setPhase('idle', { version: null, releaseNotes: null, percent: 0 });
    });

    updater.on('download-progress', (progress: unknown) => {
      const p = (progress ?? {}) as { percent?: number; transferred?: number; total?: number };
      const percent = Number(p.percent ?? 0);
      setPhase('downloading', {
        version: state.version,
        percent: Number.isFinite(percent) ? percent : 0,
        transferred: p.transferred ?? 0,
        total: p.total ?? 0,
      });
    });

    updater.on('update-downloaded', (info: unknown) => {
      const update = (info as UpdateInfoLike | undefined) ?? {};
      setPhase('ready', {
        version: update.version ?? state.version,
        releaseNotes: releaseNotesToText(update.releaseNotes) ?? state.releaseNotes,
        percent: 100,
      });
    });

    // Without a listener electron-updater rethrows and takes the process with it.
    updater.on('error', (err: unknown) => {
      console.error('[updater]', messageOf(err));
      setPhase(state.deferred ? 'idle' : 'error', { error: messageOf(err) });
    });
  };

  return {
    getState: (): UpdaterState => ({ ...state }),

    /** Wires the events and schedules the first check plus the interval. */
    start: () => {
      if (started || !supported) return;
      started = true;
      wire();
      timer = setTimeout(() => {
        timer = null;
        void check();
      }, FIRST_CHECK_DELAY);
      interval = setInterval(() => void check(), INTERVAL);
      // A launcher left open overnight must never be what holds the process up.
      timer.unref?.();
      interval.unref?.();
    },

    check,
    install,
    defer,

    /** Test seam, and how the renderer-facing IPC avoids leaking timers. */
    stop: stopTimers,
  };
}

export type UpdaterService = ReturnType<typeof createUpdaterService>;

let service: UpdaterService | null = null;

/** Stand-in used whenever no real updater exists, so the state machine still runs. */
function noopUpdater(): UpdaterLike {
  return {
    autoDownload: true,
    allowPrerelease: false,
    allowDowngrade: false,
    autoInstallOnAppQuit: true,
    on() {},
    checkForUpdates: async () => undefined,
    quitAndInstall() {},
  };
}

/**
 * Real service, wired to electron-updater.
 *
 * The import is deferred to the call site so a dev or unpackaged run never even
 * loads the module: electron-updater reads `app-update.yml` from the packaged
 * resources at construction time and logs hard errors when it is absent.
 */
function realUpdater(): UpdaterLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { autoUpdater } = require('electron-updater') as { autoUpdater: UpdaterLike };
    autoUpdater.autoDownload = true;
    // Downloads in the background and swaps in on quit; the banner is only ever
    // about telling the user it already happened.
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    return autoUpdater;
  } catch (err) {
    console.error('[updater] electron-updater unavailable', err);
    return null;
  }
}

/** True only for a real installed build — the gate for every update affordance. */
export function updaterSupported(): boolean {
  try {
    return app.isPackaged === true;
  } catch {
    return false;
  }
}

/**
 * Starts background update checks. Safe to call more than once, and a no-op in
 * development, in the test suite, and in any build without electron-updater.
 */
export function initUpdater(): void {
  if (service) return;
  const supported = updaterSupported();
  const updater = supported ? realUpdater() : null;
  service = createUpdaterService(updater ?? noopUpdater(), supported && updater !== null);
  service.start();
}

export function getUpdaterService(): UpdaterService {
  // IPC can land before `initUpdater` (the renderer is created in the same tick),
  // so hand back an inert service rather than throwing.
  if (!service) service = createUpdaterService(noopUpdater(), false);
  return service;
}