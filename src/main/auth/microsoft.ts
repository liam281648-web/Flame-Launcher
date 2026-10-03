import { BrowserWindow, shell } from 'electron';
import { Auth, lexicon } from 'msmc';
import type { Account, AuthSecrets } from '../../shared/types';

/** Official Minecraft launcher public client id used by msmc — no custom Azure tenant. */
export const MS_CLIENT_ID = '00000000402b5328';

export type AuthCode = 'cancelled' | 'denied' | 'network' | 'no_minecraft' | 'unknown';

export class AuthError extends Error {
  constructor(message: string, readonly code: AuthCode = 'unknown') {
    super(message);
    this.name = 'AuthError';
  }
}

/** Human readable messages for the raw lexicon codes msmc throws. */
const LEXICON_ERRORS: Record<string, [string, AuthCode]> = {
  'error.gui.closed': ['Sign-in was cancelled.', 'cancelled'],
  'error.gui.raw.noBrowser': ['Could not open the sign-in window.', 'unknown'],
  'error.auth.microsoft': ['Microsoft sign-in failed. Check your credentials and try again.', 'denied'],
  'error.auth.xboxLive': ['Xbox Live sign-in failed. Try again in a moment.', 'unknown'],
  'error.auth.xsts': ['Xbox Live authorization failed for this account.', 'unknown'],
  'error.auth.xsts.userNotFound': [
    'This Microsoft account has no Xbox profile. Create one at xbox.com, then try again.',
    'no_minecraft',
  ],
  'error.auth.xsts.bannedCountry': ["Xbox Live isn't available in this account's region.", 'denied'],
  'error.auth.xsts.child': ['This is a child account and cannot sign in on its own.', 'denied'],
  'error.auth.xsts.child.SK': [
    'This account needs parental consent on the Xbox site before it can sign in.',
    'denied',
  ],
  'error.auth.minecraft': ['Minecraft sign-in failed.', 'no_minecraft'],
  'error.auth.minecraft.login': [
    'Minecraft services rejected this account. Make sure you own Minecraft: Java Edition.',
    'no_minecraft',
  ],
  'error.auth.minecraft.profile': ['This account has no Minecraft: Java Edition profile.', 'no_minecraft'],
  'error.auth.minecraft.entitlements': ['Could not verify Minecraft ownership for this account.', 'no_minecraft'],
};

const getLexiconMessage = lexicon.getCode as unknown as (code: string) => string;

function fromLexicon(code: string): AuthError {
  const hit = LEXICON_ERRORS[code];
  if (hit) return new AuthError(hit[0], hit[1]);
  const message = getLexiconMessage(code);
  return new AuthError(message && message !== code ? message : 'Sign-in failed. Please try again.', 'unknown');
}

export function toAuthError(err: unknown, signal?: AbortSignal): AuthError {
  if (signal?.aborted) return new AuthError('Sign-in was cancelled.', 'cancelled');
  if (err instanceof AuthError) return err;
  if (typeof err === 'string') return fromLexicon(err);

  if (err && typeof err === 'object') {
    const e = err as { ts?: unknown; response?: { status?: number } };
    if (typeof e.ts === 'string') {
      const base = fromLexicon(e.ts);
      const status = e.response?.status;
      if (status && base.code === 'unknown') return new AuthError(`${base.message} (HTTP ${status})`, base.code);
      return base;
    }
  }

  if (err instanceof Error) {
    const msg = err.message || String(err);
    const network =
      err.name === 'FetchError' ||
      err.name === 'AbortError' ||
      /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network/i.test(msg);
    if (network) {
      return new AuthError('Could not reach the sign-in servers. Check your internet connection and try again.', 'network');
    }
    return new AuthError(msg, 'unknown');
  }

  return new AuthError('Sign-in failed for an unknown reason.', 'unknown');
}

// ------------------------------------------------------------- popup window

interface PopupParams {
  code?: string;
  error?: string;
  errorDescription?: string;
}

function parseRedirectParams(url: string): PopupParams {
  try {
    const parsed = new URL(url);
    const read = (search: string): PopupParams => {
      const params = new URLSearchParams(search);
      return {
        code: params.get('code') ?? undefined,
        error: params.get('error') ?? undefined,
        errorDescription: params.get('error_description') ?? undefined,
      };
    };
    const query = read(parsed.search);
    if (query.code || query.error) return query;
    if (parsed.hash.length > 1) return read(parsed.hash.slice(1));
    return query;
  } catch {
    return {};
  }
}

/**
 * Opens the Microsoft OAuth link in a dedicated popup and resolves with the
 * authorization code once the browser is redirected back to the OAuth redirect URI.
 */
function openMicrosoftPopup(link: string, redirect: string, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(new AuthError('Sign-in was cancelled.', 'cancelled'));
      return;
    }

    let settled = false;
    const base = redirect.toLowerCase();

    const parent = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());

    const win = new BrowserWindow({
      width: 520,
      height: 740,
      minWidth: 420,
      minHeight: 520,
      show: false,
      title: 'Sign in to your Microsoft account',
      backgroundColor: '#f4f4f4',
      autoHideMenuBar: true,
      parent,
      modal: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        spellcheck: false,
      },
    });

    const onAbort = () => fail(new AuthError('Sign-in was cancelled.', 'cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });

    let showTimer: NodeJS.Timeout | null = setTimeout(() => show(), 1500);
    win.once('ready-to-show', () => show());

    function show(): void {
      if (showTimer) {
        clearTimeout(showTimer);
        showTimer = null;
      }
      if (!settled && !win.isDestroyed()) win.show();
    }

    function finish(): void {
      if (showTimer) {
        clearTimeout(showTimer);
        showTimer = null;
      }
      signal.removeEventListener('abort', onAbort);
      if (!win.isDestroyed()) win.destroy();
    }

    function succeed(code: string): void {
      if (settled) return;
      settled = true;
      finish();
      resolve(code);
    }

    function fail(err: AuthError): void {
      if (settled) return;
      settled = true;
      finish();
      reject(err);
    }

    function handle(url: string): void {
      if (settled || !url.toLowerCase().startsWith(base)) return;
      const { code, error, errorDescription } = parseRedirectParams(url);
      if (code) {
        succeed(code);
        return;
      }
      if (error) {
        if (/access_denied|user_cancelled|cancel/i.test(error)) {
          fail(new AuthError('Sign-in was cancelled.', 'cancelled'));
        } else if (/login_required|interaction_required|consent_required|no_account/i.test(error)) {
          fail(new AuthError('Your Microsoft session expired. Please sign in again.', 'denied'));
        } else {
          fail(new AuthError(errorDescription || error, 'denied'));
        }
      }
      // No code and no error: let the page render so the user can close it themselves.
    }

    const maybeIntercept = (event: { preventDefault: () => void }, url: string): void => {
      if (settled || !url.toLowerCase().startsWith(base)) return;
      event.preventDefault();
      handle(url);
    };

    win.webContents.on('will-navigate', maybeIntercept);
    win.webContents.on('will-redirect', maybeIntercept);
    win.webContents.on('did-navigate', (_event, url) => handle(url));
    win.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) handle(url);
    });

    win.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (settled || !isMainFrame || errorCode === -3 || !validatedUrl) return;
        if (!/login\.live\.com|microsoftonline\.com|login\.microsoft\.com|live\.com/i.test(validatedUrl)) return;
        fail(
          new AuthError(
            `Could not load the Microsoft sign-in page (${errorDescription || errorCode}). Check your internet connection.`,
            'network',
          ),
        );
      },
    );

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });

    win.on('closed', () => fail(new AuthError('Sign-in was cancelled.', 'cancelled')));

    void win.loadURL(link).catch((err: unknown) => fail(toAuthError(err, signal)));
  });
}

// -------------------------------------------------------------- result build

interface ProfileLike {
  id?: string;
  name?: string;
  demo?: boolean;
  skins?: Array<{ id?: string; state?: string; url?: string }>;
}

interface SessionLike {
  mcToken: string;
  xuid: string;
  exp: number;
  msRefresh?: string;
}

function buildResult(profile: ProfileLike | undefined, session: SessionLike): { account: Account; secrets: AuthSecrets } {
  if (!profile?.id || !profile.name) {
    throw new AuthError('Could not load your Minecraft profile.', 'no_minecraft');
  }
  if (profile.demo === true) {
    throw new AuthError(
      'This account has only the Minecraft demo. Buy the full game at minecraft.net, then try again.',
      'no_minecraft',
    );
  }

  const id = String(profile.id).replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(id)) {
    throw new AuthError(
      'This Microsoft account has no Minecraft: Java Edition profile. Buy the game at minecraft.net, then try again.',
      'no_minecraft',
    );
  }
  if (!session.mcToken) {
    throw new AuthError('Minecraft authentication returned no session token.', 'unknown');
  }

  const skinUrl = profile.skins?.find((s) => s.state === 'ACTIVE')?.url;

  const account: Account = {
    id,
    type: 'microsoft',
    username: profile.name,
    uuid: id,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    xuid: session.xuid || undefined,
    skinUrl,
  };

  const exp = Number(session.exp);
  const expiresAt =
    Number.isFinite(exp) && exp > Date.now() ? Math.min(exp, Date.now() + 24 * 3600 * 1000) : Date.now() + 12 * 3600 * 1000;

  const secrets: AuthSecrets = {
    refreshToken: session.msRefresh || undefined,
    accessToken: session.mcToken,
    expiresAt,
  };

  return { account, secrets };
}

// ---------------------------------------------------------------- public api

export async function loginWithMicrosoft(
  signal: AbortSignal,
  onStatus?: (message: string) => void,
): Promise<{ account: Account; secrets: AuthSecrets }> {
  const status = (message: string) => {
    try {
      onStatus?.(message);
    } catch {
      /* status is cosmetic */
    }
  };

  try {
    const auth = new Auth('select_account');
    auth.on('load', (_code: string, message?: string) => status(message ?? ''));

    status('Opening the Microsoft sign-in window…');
    const code = await openMicrosoftPopup(auth.createLink(), auth.token.redirect, signal);

    status('Completing Microsoft sign-in…');
    const xbox = await auth.login(code);

    status('Signing in to Xbox Live and Minecraft…');
    const mc = await xbox.getMinecraft();

    return buildResult(mc.profile, {
      mcToken: mc.mcToken,
      xuid: mc.xuid,
      exp: mc.exp,
      msRefresh: xbox.save(),
    });
  } catch (err) {
    throw toAuthError(err, signal);
  }
}

/** Returns fresh Minecraft-scoped credentials, rotating the stored refresh token. */
export async function refreshMicrosoft(
  refreshToken: string,
  onStatus?: (message: string) => void,
): Promise<{ account: Account; secrets: AuthSecrets }> {
  if (!refreshToken) throw new AuthError('No saved Microsoft session. Sign in again.', 'denied');
  try {
    const auth = new Auth('select_account');
    if (onStatus) auth.on('load', (_code: string, message?: string) => onStatus(message ?? ''));

    const xbox = await auth.refresh(refreshToken);
    const mc = await xbox.getMinecraft();

    return buildResult(mc.profile, {
      mcToken: mc.mcToken,
      xuid: mc.xuid,
      exp: mc.exp,
      msRefresh: xbox.save(),
    });
  } catch (err) {
    throw toAuthError(err);
  }
}
