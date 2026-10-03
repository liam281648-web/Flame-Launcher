import fs from 'node:fs';
import path from 'node:path';
import { sha1Of, sha512Of } from './fsutil';

export const USER_AGENT = 'FlameClient/0.1.0 (+https://github.com/flame)';

export async function getJson<T>(url: string, timeoutMs = 30000): Promise<T> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GET ${url} failed (${res.status} ${res.statusText})`);
  return (await res.json()) as T;
}

export async function postForm<T>(
  url: string,
  params: Record<string, string>,
  headers: Record<string, string> = {},
  timeoutMs = 30000,
): Promise<{ ok: boolean; status: number; body: T }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      ...headers,
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = text as unknown as T;
  }
  return { ok: res.ok, status: res.status, body };
}

export async function postJson<T>(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
  timeoutMs = 30000,
): Promise<{ ok: boolean; status: number; body: T }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = text as unknown as T;
  }
  return { ok: res.ok, status: res.status, body };
}

export async function getJsonAuth<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`GET ${url} failed (${res.status})`);
  return (await res.json()) as T;
}

export interface DownloadOptions {
  sha1?: string;
  /** Preferred over `sha1` where both are published: `.mrpack` indexes carry both. */
  sha512?: string;
  onProgress?: (received: number, total: number) => void;
  retries?: number;
  timeoutMs?: number;
}

/**
 * Downloads url to dest (atomic: temp file + rename). Skips work when file already valid.
 *
 * Two hashes are supported because Modrinth's `.mrpack` index publishes sha512
 * while the search API only publishes sha1, and an importer must be able to
 * verify either without the caller branching.
 */
export async function download(url: string, dest: string, opts: DownloadOptions = {}): Promise<void> {
  const retries = opts.retries ?? 3;
  const wantSha1 = opts.sha1?.toLowerCase();
  const wantSha512 = opts.sha512?.toLowerCase();

  /** True when the bytes on disk match every hash the caller supplied. */
  const matches = (buf: Buffer): boolean => {
    if (wantSha1 && sha1Of(buf) !== wantSha1) return false;
    if (wantSha512 && sha512Of(buf) !== wantSha512) return false;
    return true;
  };

  // A caller that supplied a hash is asserting the bytes are trustworthy, so a
  // cached file has to be verified against it. Gating this on sha1 alone would
  // hand back an unverified sha512-only download and defeat the whole check.
  const verifiable = Boolean(wantSha1 || wantSha512);

  if (fs.existsSync(dest)) {
    try {
      const stat = fs.statSync(dest);
      if (stat.size > 0 && (!verifiable || matches(fs.readFileSync(dest)))) return;
    } catch {
      /* re-download */
    }
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const tmp = `${dest}.${process.pid}.${attempt}.part`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120000),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);

      const total = Number(res.headers.get('content-length') ?? 0);
      const chunks: Buffer[] = [];
      let received = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(Buffer.from(value));
          received += value.length;
          opts.onProgress?.(received, total);
        }
      }
      const buf = Buffer.concat(chunks);
      if (!matches(buf)) throw new Error(`hash mismatch for ${url}`);
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest);
      return;
    } catch (err) {
      lastErr = err;
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`download failed: ${url}`);
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}
