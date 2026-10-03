import fs from 'node:fs';
import path from 'node:path';

/**
 * Sets a single `key:value` line in `options.txt`, leaving every other line
 * byte-for-byte intact. Minecraft rewrites the whole file on exit, so anything
 * Flame does here is transient unless Flame keeps managing that key itself.
 *
 * No-ops when the value is already correct, which keeps the file's mtime (and
 * therefore the Installed Packs ordering) stable during refreshes.
 */
function setOptionsValue(gameDir: string, key: string, value: string): void {
  const file = path.join(gameDir, 'options.txt');
  const existed = fs.existsSync(file);
  const content = existed ? fs.readFileSync(file, 'utf8') : '';
  const sep = content.includes('\r\n') ? '\r\n' : '\n';

  const lines = content ? content.split(/\r?\n/) : [];
  const prefix = `${key}:`;
  const idx = lines.findIndex((l) => l.startsWith(prefix));
  const line = `${prefix}${value}`;

  if (idx >= 0 && lines[idx] === line) return;

  if (idx >= 0) lines[idx] = line;
  else lines.push(line);

  let out = lines.join(sep);
  if (!out.endsWith(sep)) out += sep;

  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(file, out, 'utf8');
}

/**
 * Reads the enabled resource pack list out of `options.txt`.
 *
 * Minecraft stores `resourcePacks` as a JSON array. `vanilla` is always
 * implicitly active and must never appear in our managed list.
 */
export function readEnabledPacks(gameDir: string): string[] {
  const file = path.join(gameDir, 'options.txt');
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith('resourcePacks:')) continue;
    try {
      const parsed = JSON.parse(line.slice('resourcePacks:'.length));
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === 'string' && v !== 'vanilla');
      }
    } catch {
      /* malformed line — treat as nothing enabled */
    }
    return [];
  }
  return [];
}

/**
 * Adds or removes one pack in the `resourcePacks` entry of `options.txt`, keeping
 * every unrelated line byte-for-byte intact. Vanilla and the Flame menu theme are
 * handled elsewhere, so they are never added or removed from here.
 */
export function writeEnabledPacks(gameDir: string, fileName: string, enabled: boolean): void {
  const name = path.basename(fileName);
  if (name !== fileName) throw new Error('Invalid pack file name.');
  if (name === 'flame-menu.zip') return; // owned by the launcher's own theme

  const current = readEnabledPacks(gameDir);
  const next = enabled
    ? current.includes(name)
      ? current
      : [...current, name]
    : current.filter((v) => v !== name);

  if (JSON.stringify(current) === JSON.stringify(next)) return;
  setOptionsValue(gameDir, 'resourcePacks', JSON.stringify(['vanilla', ...next]));
}

/** Minecraft's sentinel for "no shader pack selected". */
const NO_SHADER = 'none';

/**
 * Reads the active shader pack out of `options.txt`, or null when none is
 * selected. Minecraft writes the bare file name (no `shaderpacks/` prefix) or
 * the quoted string `none`.
 */
export function readActiveShader(gameDir: string): string | null {
  const file = path.join(gameDir, 'options.txt');
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith('shaderPack:')) continue;
    const raw = line.slice('shaderPack:'.length).trim();
    let value: string;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'string') return null;
      value = parsed;
    } catch {
      // Tolerate an unquoted value rather than silently reporting "no shader".
      value = raw.replace(/^"+|"+$/g, '');
    }
    if (value === '' || value.toLowerCase() === NO_SHADER) return null;
    return value;
  }
  return null;
}

/**
 * Selects a shader pack, or clears the selection with null. Minecraft only
 * honours one shader at a time, so this replaces the value outright.
 */
export function writeActiveShader(gameDir: string, fileName: string | null): void {
  const name = fileName === null ? null : path.basename(fileName);
  if (name !== null && name !== fileName) throw new Error('Invalid shader file name.');
  setOptionsValue(gameDir, 'shaderPack', JSON.stringify(name ?? NO_SHADER));
}