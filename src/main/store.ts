import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Account, AuthSecrets, Settings } from '../shared/types';

export const DEFAULT_SETTINGS: Settings = {
  javaPath: '',
  minMemMb: 1024,
  maxMemMb: 4096,
  gameDir: '',
  closeOnLaunch: false,
  menuPack: true,
  extraJvmArgs: '',
};

interface ConfigFile {
  settings: Settings;
  accounts: Account[];
  activeAccountId: string | null;
  /** Instance selected in the launcher. Resolved against `instances/` on read. */
  activeInstanceId: string | null;
  /** In-memory plaintext secrets — sealed with safeStorage on every write. */
  secrets: Record<string, AuthSecrets>;
  windowBounds?: { x: number; y: number; width: number; height: number; maximized: boolean };
}

const EMPTY: ConfigFile = {
  settings: { ...DEFAULT_SETTINGS },
  accounts: [],
  activeAccountId: null,
  activeInstanceId: null,
  secrets: {},
};

let cache: ConfigFile | null = null;
let saveTimer: NodeJS.Timeout | null = null;

function configPath(): string {
  // Test hooks: let the e2e suite point at disposable storage so a real install
  // is never touched. Unset in normal use.
  const override = process.env.FLAME_USER_DATA;
  const base = override ? override : app.getPath('userData');
  return path.join(base, 'flame.config.json');
}

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function sealSecrets(secrets: Record<string, AuthSecrets>): Record<string, string> {
  const out: Record<string, string> = {};
  const encrypted = encryptionAvailable();
  for (const [id, value] of Object.entries(secrets)) {
    if (!value) continue;
    const json = JSON.stringify(value);
    try {
      out[id] = encrypted ? `enc:${safeStorage.encryptString(json).toString('base64')}` : `plain:${json}`;
    } catch (err) {
      console.error('[store] failed to encrypt secrets, storing them in plain text', err);
      out[id] = `plain:${json}`;
    }
  }
  return out;
}

function unsealSecrets(raw: unknown): { secrets: Record<string, AuthSecrets>; changed: boolean } {
  const out: Record<string, AuthSecrets> = {};
  if (!raw || typeof raw !== 'object') return { secrets: out, changed: false };

  let changed = false;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    try {
      if (typeof value === 'string') {
        if (value.startsWith('enc:')) {
          out[id] = JSON.parse(safeStorage.decryptString(Buffer.from(value.slice(4), 'base64')));
        } else if (value.startsWith('plain:')) {
          out[id] = JSON.parse(value.slice(6));
          changed = true;
        } else {
          out[id] = JSON.parse(value);
          changed = true;
        }
      } else if (value && typeof value === 'object') {
        out[id] = value as AuthSecrets; // legacy plaintext config
        changed = true;
      }
    } catch (err) {
      console.error(`[store] could not decrypt saved session for ${id} — it will need to sign in again`, err);
    }
  }
  return { secrets: out, changed: changed && encryptionAvailable() };
}

/** Editors on Windows happily prepend a BOM, which JSON.parse rejects outright. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Scans forward from `source` reading one complete JSON value.
 *
 * Returns `null` when the value is itself truncated (the realistic crash case), so
 * callers can salvage the entries written *before* the damage and drop the rest.
 */
function readValue(source: string, start: number): { text: string; next: number } | null {
  let i = start;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let sawAny = false;

  for (; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      sawAny = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth++;
      sawAny = true;
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (depth === 0) return null; // outer container closed — no value here
      depth--;
      if (depth === 0) return { text: source.slice(start, i + 1), next: i + 1 };
      continue;
    }
    if (depth === 0) {
      if (ch === ',') return sawAny ? { text: source.slice(start, i), next: i + 1 } : null;
      // A bare scalar: ends at any structural character.
      if (/[\s:}]/.test(ch)) return sawAny ? { text: source.slice(start, i), next: i } : null;
      sawAny = true;
    }
  }

  // Ran out of input. Complete only if nothing was left open.
  if (!sawAny || depth > 0 || inString) return null;
  return { text: source.slice(start, i), next: i };
}

function skipTo(source: string, from: number, re: RegExp): number {
  let i = from;
  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source[i] === ',' || source[i] === ':') {
      i++;
      continue;
    }
    if (re.test(source[i])) return i;
    return i;
  }
  return i;
}

/** Complete entries of a truncated array, e.g. the accounts written before a crash. */
function salvageArray(source: string): unknown[] {
  const out: unknown[] = [];
  let i = 1; // skip '['
  while (i < source.length) {
    const next = skipTo(source, i, /[[{"]/);
    if (next >= source.length) break;
    const value = readValue(source, next);
    if (!value) break;
    try {
      out.push(JSON.parse(value.text));
    } catch {
      /* drop this one entry and keep scanning */
    }
    i = value.next;
  }
  return out;
}

/** Complete `"key": value` pairs of a truncated object, e.g. sealed secrets. */
function salvageObject(source: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let i = 1; // skip '{'
  while (i < source.length) {
    const keyStart = skipTo(source, i, /"/);
    if (keyStart >= source.length || source[keyStart] !== '"') break;
    const key = readValue(source, keyStart);
    if (!key) break;
    const colon = skipTo(source, key.next, /:/);
    if (source[colon] !== ':') break;
    const value = readValue(source, colon + 1);
    if (!value) break;
    try {
      out[String(JSON.parse(key.text))] = JSON.parse(value.text);
    } catch {
      /* drop this one pair and keep scanning */
    }
    i = value.next;
  }
  return out;
}

/** A config document must be a plain object; `null` and arrays are not usable. */
function asConfigObject(value: unknown): Partial<ConfigFile> & { secrets?: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Partial<ConfigFile> & { secrets?: unknown })
    : {};
}

function parseConfig(raw: string): Partial<ConfigFile> & { secrets?: unknown } {
  const cleaned = stripBom(raw).trim();
  if (!cleaned) return {};

  try {
    return asConfigObject(JSON.parse(cleaned));
  } catch (err) {
    console.error(`[store] config is not valid JSON (${err instanceof Error ? err.message : err}) — salvaging readable fields`);
  }

  // Last-ditch recovery: pull individual `"key": value` pairs out of the broken
  // document so a single trailing comma or stray character doesn't nuke everything.
  const salvaged: Record<string, unknown> = {};
  for (const match of cleaned.matchAll(/"(settings|accounts|activeAccountId|activeInstanceId|secrets|windowBounds)"\s*:\s*/g)) {
    const key = match[1];
    const rest = cleaned.slice(match.index + match[0].length);

    if (rest.startsWith('{') || rest.startsWith('[')) {
      const whole = readValue(rest, 0);
      if (whole) {
        try {
          salvaged[key] = JSON.parse(whole.text);
          continue;
        } catch {
          /* fall through to partial salvage */
        }
      }
      // Truncated container: keep the entries written before the damage.
      const partial = rest.startsWith('[') ? salvageArray(rest) : salvageObject(rest);
      const size = partial instanceof Array ? partial.length : Object.keys(partial).length;
      if (size > 0) salvaged[key] = partial;
      continue;
    }

    const primitive = readValue(rest, 0);
    if (!primitive) continue;
    try {
      salvaged[key] = JSON.parse(primitive.text);
    } catch {
      continue;
    }
  }

  const recovered = Object.keys(salvaged).length > 0;
  if (recovered) console.warn('[store] recovered config fields:', Object.keys(salvaged).join(', '));
  return salvaged as Partial<ConfigFile> & { secrets?: unknown };
}

/**
 * Keeps the damaged file around as `flame.config.corrupt-<n>.json` so a user who
 * lost their accounts can still recover them by hand. Returns the backup path.
 */
function backupCorrupt(raw: string): string | null {
  try {
    const dir = path.dirname(configPath());
    const stem = path.basename(configPath(), '.json');
    for (let n = 1; n <= 20; n++) {
      const dest = path.join(dir, `${stem}.corrupt-${n}.json`);
      if (fs.existsSync(dest)) continue;
      fs.writeFileSync(dest, raw, 'utf8');
      console.error(`[store] damaged config copied to ${dest}`);
      return dest;
    }
  } catch (err) {
    console.error('[store] could not back up damaged config', err);
  }
  return null;
}

function load(): ConfigFile {
  if (cache) return cache;
  const file = configPath();

  // First launch: nothing saved yet is the normal case, not an error.
  if (!fs.existsSync(file)) {
    cache = structuredClone(EMPTY);
    return cache;
  }

  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = parseConfig(raw);

    // An unreadable document means we are about to overwrite it with defaults.
    // Preserve the original first so nothing is lost.
    if (!stripBom(raw).trim()) {
      backupCorrupt(raw);
      cache = structuredClone(EMPTY);
      return cache;
    }

    let recovered = false;
    try {
      JSON.parse(stripBom(raw));
    } catch {
      backupCorrupt(raw);
      recovered = true;
    }

    const { secrets, changed } = unsealSecrets(parsed.secrets);
    cache = {
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      activeAccountId: parsed.activeAccountId ?? null,
      activeInstanceId: parsed.activeInstanceId ?? null,
      secrets,
      windowBounds: parsed.windowBounds,
    };
    if (changed || recovered) scheduleSave();
  } catch (err) {
    // Unreadable file (permissions, a directory in its place, …) — don't retry
    // on every access and don't destroy whatever is on disk.
    console.error('[store] could not read config, continuing with defaults', err);
    cache = structuredClone(EMPTY);
  }
  return cache;
}

function flush(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
try {
    const cfg = load();
    const payload = JSON.stringify({ ...cfg, secrets: sealSecrets(cfg.secrets) }, null, 2);
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    // Write-then-rename so a crash mid-write can never leave a half-written
    // config that the next launch would have to salvage.
    const tmp = `${configPath()}.tmp`;
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, configPath());
  } catch (err) {
    console.error('[store] failed to persist config', err);
  }
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 250);
}

export const store = {
  getSettings(): Settings {
    return { ...load().settings };
  },

  setSettings(patch: Partial<Settings>): Settings {
    const cfg = load();
    cfg.settings = { ...cfg.settings, ...patch };
    scheduleSave();
    return { ...cfg.settings };
  },

  getAccounts(): Account[] {
    return [...load().accounts].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  },

  getActiveId(): string | null {
    return load().activeAccountId;
  },

  getActiveAccount(): Account | null {
    const cfg = load();
    return cfg.accounts.find((a) => a.id === cfg.activeAccountId) ?? null;
  },

  upsertAccount(account: Account, secrets?: AuthSecrets): void {
    const cfg = load();
    const idx = cfg.accounts.findIndex((a) => a.id === account.id);
    if (idx >= 0) cfg.accounts[idx] = { ...cfg.accounts[idx], ...account };
    else cfg.accounts.push(account);
    if (secrets) cfg.secrets[account.id] = secrets;
    cfg.activeAccountId = account.id;
    scheduleSave();
  },

  setActive(id: string): void {
    const cfg = load();
    if (cfg.accounts.some((a) => a.id === id)) {
      cfg.activeAccountId = id;
      scheduleSave();
    }
  },

  removeAccount(id: string): void {
    const cfg = load();
    cfg.accounts = cfg.accounts.filter((a) => a.id !== id);
    delete cfg.secrets[id];
    if (cfg.activeAccountId === id) {
      const next = [...cfg.accounts].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
      cfg.activeAccountId = next?.id ?? null;
    }
    scheduleSave();
  },

  getSecrets(id: string): AuthSecrets | null {
    return load().secrets[id] ?? null;
  },

  setSecrets(id: string, secrets: AuthSecrets): void {
    load().secrets[id] = secrets;
    scheduleSave();
  },

  touch(id: string): void {
    const cfg = load();
    const acc = cfg.accounts.find((a) => a.id === id);
    if (acc) {
      acc.lastUsedAt = Date.now();
      scheduleSave();
    }
  },

  getActiveInstanceId(): string | null {
    return load().activeInstanceId;
  },

  setActiveInstanceId(id: string | null): void {
    load().activeInstanceId = id;
    scheduleSave();
  },

  getWindowBounds(): ConfigFile['windowBounds'] {
    return load().windowBounds;
  },

  setWindowBounds(bounds: NonNullable<ConfigFile['windowBounds']>): void {
    load().windowBounds = bounds;
    scheduleSave();
  },

  flush,
};
