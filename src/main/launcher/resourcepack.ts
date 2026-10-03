import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { PNG } from 'pngjs';

export const MENU_PACK_NAME = 'flame-menu.zip';

const REV = 4;
const PACK_DESCRIPTION = 'Flame Client \u2014 modern menu theme';
const PACK_IDS = [`file/${MENU_PACK_NAME}`, MENU_PACK_NAME];

const PANORAMA_FACES = 6;
const LOGO_TARGETS = {
  legacy: { width: 274, height: 44, split: 155, bandRow: 45 },
  modern: { width: 1024, height: 176 },
};

export interface MenuPackArgs {
  versionId: string;
  clientJar: string;
  assetIndexId?: string;
  assetsDir?: string;
  gameDir: string;
  enabled: boolean;
}

type PackFormat = number | [number, number];

// ---------------------------------------------------------------- glyph font

const GLYPH_W = 10;
const GLYPH_H = 12;
const GLYPH_GAP = 3;

const GLYPHS: Record<string, string[]> = {
  F: [
    '##########',
    '##########',
    '##########',
    '###.......',
    '###.......',
    '###.......',
    '##########',
    '##########',
    '###.......',
    '###.......',
    '###.......',
    '###.......',
  ],
  L: [
    '###.......',
    '###.......',
    '###.......',
    '###.......',
    '###.......',
    '###.......',
    '###.......',
    '###.......',
    '###.......',
    '###.......',
    '##########',
    '##########',
  ],
  A: [
    '..######..',
    '.########.',
    '###....###',
    '###....###',
    '###....###',
    '###....###',
    '##########',
    '##########',
    '###....###',
    '###....###',
    '###....###',
    '###....###',
  ],
  M: [
    '###....###',
    '###....###',
    '####..####',
    '###.##.###',
    '###.##.###',
    '###....###',
    '###....###',
    '###....###',
    '###....###',
    '###....###',
    '###....###',
    '###....###',
  ],
  E: [
    '##########',
    '##########',
    '##########',
    '###.......',
    '###.......',
    '###.......',
    '######....',
    '######....',
    '###.......',
    '###.......',
    '##########',
    '##########',
  ],
};

const WORD = 'FLAME';

interface Wordmark {
  w: number;
  h: number;
  cells: Uint8Array;
}

function buildWordmark(text: string): Wordmark {
  const glyphs = [...text].map((ch) => GLYPHS[ch]);
  const w = glyphs.length * GLYPH_W + (glyphs.length - 1) * GLYPH_GAP;
  const h = GLYPH_H;
  const cells = new Uint8Array(w * h);
  let x0 = 0;
  for (const glyph of glyphs) {
    for (let y = 0; y < GLYPH_H; y++) {
      for (let x = 0; x < GLYPH_W; x++) {
        if (glyph[y][x] === '#') cells[y * w + x0 + x] = 1;
      }
    }
    x0 += GLYPH_W + GLYPH_GAP;
  }
  return { w, h, cells };
}

function dilate(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (src[y * w + x]) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < w && ny >= 0 && ny < h) out[ny * w + nx] = 1;
          }
        }
      }
    }
  }
  return out;
}

const OUTLINE_RGB = [3, 4, 7];
const FACE_TOP_RGB = [216, 226, 236];
const FACE_BOTTOM_RGB = [136, 150, 166];

function renderWordmark(text: string, scale: number): { png: PNG; inkW: number; inkH: number } {
  const mark = buildWordmark(text);
  const pad = 1;
  const pw = mark.w + pad * 2;
  const ph = mark.h + pad * 2;
  const cw = pw * scale;
  const ch = ph * scale;
  const png = new PNG({ width: cw, height: ch });
  png.data.fill(0);

  const padded = new Uint8Array(pw * ph);
  for (let y = 0; y < mark.h; y++) {
    for (let x = 0; x < mark.w; x++) {
      if (mark.cells[y * mark.w + x]) padded[(y + pad) * pw + (x + pad)] = 1;
    }
  }
  const outline = dilate(padded, pw, ph);
  const originX = pad * scale;
  const originY = pad * scale;

  const fillCell = (dx: number, dy: number, rgb: number[]) => {
    const px = originX + dx * scale;
    const py = originY + dy * scale;
    for (let y = py; y < py + scale; y++) {
      for (let x = px; x < px + scale; x++) {
        const i = (y * cw + x) * 4;
        png.data[i] = rgb[0];
        png.data[i + 1] = rgb[1];
        png.data[i + 2] = rgb[2];
        png.data[i + 3] = 255;
      }
    }
  };

  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      if (outline[y * pw + x] && !padded[y * pw + x]) fillCell(x - pad, y - pad, OUTLINE_RGB);
    }
  }

  for (let y = 0; y < ph; y++) {
    const dy = y - pad;
    const t = mark.h > 1 ? Math.min(1, Math.max(0, dy / (mark.h - 1))) : 0;
    for (let x = 0; x < pw; x++) {
      if (!padded[y * pw + x]) continue;
      const below = y + 1 >= ph || !padded[(y + 1) * pw + x];
      let r = FACE_TOP_RGB[0] + (FACE_BOTTOM_RGB[0] - FACE_TOP_RGB[0]) * t;
      let g = FACE_TOP_RGB[1] + (FACE_BOTTOM_RGB[1] - FACE_TOP_RGB[1]) * t;
      let b = FACE_TOP_RGB[2] + (FACE_BOTTOM_RGB[2] - FACE_TOP_RGB[2]) * t;
      if (below) {
        r *= 0.6;
        g *= 0.62;
        b *= 0.66;
      }
      fillCell(x - pad, dy, [Math.round(r), Math.round(g), Math.round(b)]);
    }
  }

  return { png, inkW: cw, inkH: ch };
}

// ------------------------------------------------------------ byte helpers

function boxBlurPass(input: Buffer, width: number, height: number, radius: number, horizontal: boolean): Buffer {
  const out = Buffer.alloc(input.length);
  const lines = horizontal ? height : width;
  const len = horizontal ? width : height;
  const win = radius * 2 + 1;
  const clamp = (v: number) => (v < 0 ? 0 : v >= len ? len - 1 : v);

  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * width * 4 : line * 4;
    const stride = horizontal ? 4 : width * 4;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let i = -radius; i <= radius; i++) sum += input[base + clamp(i) * stride + c];
      for (let x = 0; x < len; x++) {
        out[base + x * stride + c] = Math.round(sum / win);
        sum += input[base + clamp(x + radius + 1) * stride + c];
        sum -= input[base + clamp(x - radius) * stride + c];
      }
    }
  }
  return out;
}

function blurPanorama(png: PNG, darken: number): void {
  const radius = Math.max(2, Math.round(Math.min(png.width, png.height) / 64));
  let data: Buffer = png.data;
  for (let pass = 0; pass < 3; pass++) {
    data = boxBlurPass(data, png.width, png.height, radius, true);
    data = boxBlurPass(data, png.width, png.height, radius, false);
  }
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.min(255, Math.round((data[i] * darken) / 100));
    data[i + 1] = Math.min(255, Math.round((data[i + 1] * darken) / 100));
    data[i + 2] = Math.min(255, Math.round((data[i + 2] * darken) / 100));
    data[i + 3] = 255;
  }
  png.data = data;
}

// ------------------------------------------------------------------- buttons

type ButtonStyle = 'normal' | 'hover' | 'disabled';

const BUTTON_PALETTES: Record<
  ButtonStyle,
  { top: number[]; bottom: number[]; outer: number[]; inner: number[]; alpha: number; radius: number; tint: number }
> = {
  normal: {
    top: [21, 26, 34],
    bottom: [29, 36, 47],
    outer: [6, 8, 11],
    inner: [47, 58, 73],
    alpha: 244,
    radius: 3,
    tint: 0,
  },
  hover: {
    top: [27, 35, 46],
    bottom: [37, 48, 63],
    outer: [8, 12, 17],
    inner: [78, 200, 255],
    alpha: 250,
    radius: 3,
    tint: 10,
  },
  disabled: {
    top: [15, 18, 24],
    bottom: [19, 23, 30],
    outer: [8, 10, 13],
    inner: [30, 36, 46],
    alpha: 224,
    radius: 1,
    tint: 0,
  },
};

function roundedBoxSd(x: number, y: number, w: number, h: number, r: number): number {
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const qx = Math.abs(x - cx) - cx + r;
  const qy = Math.abs(y - cy) - cy + r;
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function renderButton(style: ButtonStyle, width: number, height: number): PNG {
  const p = BUTTON_PALETTES[style];
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const sd = roundedBoxSd(x, y, width, height, p.radius);
      if (sd > 0) {
        png.data[i + 3] = 0;
        continue;
      }
      let rgb: number[];
      if (sd > -1) rgb = p.outer;
      else if (sd > -2) rgb = p.inner;
      else {
        const t = Math.min(1, Math.max(0, (y - 2) / Math.max(1, height - 5)));
        rgb = [
          p.top[0] + (p.bottom[0] - p.top[0]) * t,
          p.top[1] + (p.bottom[1] - p.top[1]) * t,
          p.top[2] + (p.bottom[2] - p.top[2]) * t,
        ];
        if (p.tint) {
          rgb = [
            rgb[0] + (78 - rgb[0]) * (p.tint / 100),
            rgb[1] + (200 - rgb[1]) * (p.tint / 100),
            rgb[2] + (255 - rgb[2]) * (p.tint / 100),
          ];
        }
        if (y <= 3 && style !== 'disabled') {
          rgb = rgb.map((v) => Math.min(255, v + 10));
        }
      }
      png.data[i] = Math.round(rgb[0]);
      png.data[i + 1] = Math.round(rgb[1]);
      png.data[i + 2] = Math.round(rgb[2]);
      png.data[i + 3] = p.alpha;
    }
  }
  return png;
}

// --------------------------------------------------------------------- logo

function readPngDims(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function clearRegion(png: PNG, x0: number, y0: number, w: number, h: number): void {
  for (let y = y0; y < y0 + h && y < png.height; y++) {
    for (let x = x0; x < x0 + w && x < png.width; x++) {
      png.data[(y * png.width + x) * 4 + 3] = 0;
    }
  }
}

function blitWordmark(
  logo: PNG,
  mark: { png: PNG; inkW: number; inkH: number },
  place: (canvasX: number, canvasY: number) => { x: number; y: number } | null,
): void {
  const src = mark.png;
  for (let cy = 0; cy < src.height; cy++) {
    for (let cx = 0; cx < src.width; cx++) {
      const si = (cy * src.width + cx) * 4;
      if (src.data[si + 3] === 0) continue;
      const dest = place(cx, cy);
      if (!dest || dest.x < 0 || dest.y < 0 || dest.x >= logo.width || dest.y >= logo.height) continue;
      const di = (dest.y * logo.width + dest.x) * 4;
      logo.data[di] = src.data[si];
      logo.data[di + 1] = src.data[si + 1];
      logo.data[di + 2] = src.data[si + 2];
      logo.data[di + 3] = 255;
    }
  }
}

function buildLogo(vanilla: PNG): 'legacy' | 'modern' | null {
  if (vanilla.width === 256 && vanilla.height === 256) {
    const t = LOGO_TARGETS.legacy;
    const scale = Math.min(Math.floor(t.width / (buildWordmark(WORD).w + 2)), Math.floor(t.height / (buildWordmark(WORD).h + 2)));
    if (scale < 1) return null;
    const mark = renderWordmark(WORD, scale);
    const x0 = Math.round((t.width - mark.inkW) / 2);
    const y0 = Math.round((t.height - mark.inkH) / 2);
    clearRegion(vanilla, 0, 0, t.split, t.height);
    clearRegion(vanilla, 0, t.bandRow, t.split, t.height);
    blitWordmark(vanilla, mark, (cx, cy) => {
      const sx = x0 + cx;
      const sy = y0 + cy;
      if (sx < 0 || sy < 0 || sy >= t.height) return null;
      if (sx < t.split) return { x: sx, y: sy };
      return { x: sx - t.split, y: t.bandRow + sy };
    });
    return 'legacy';
  }

  if (vanilla.width === 1024 && vanilla.height === 256) {
    const t = LOGO_TARGETS.modern;
    const scale = Math.min(Math.floor(t.width / (buildWordmark(WORD).w + 2)), Math.floor(t.height / (buildWordmark(WORD).h + 2)));
    if (scale < 1) return null;
    const mark = renderWordmark(WORD, scale);
    const x0 = Math.round((t.width - mark.inkW) / 2);
    const y0 = Math.round((t.height - mark.inkH) / 2);
    clearRegion(vanilla, 0, 0, t.width, t.height);
    blitWordmark(vanilla, mark, (cx, cy) => ({ x: x0 + cx, y: y0 + cy }));
    return 'modern';
  }

  return null;
}

// ------------------------------------------------------------------ pack meta

function legacyPackFormat(versionId: string): number {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(versionId);
  if (!m) return 1;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3] ?? 0);
  if (major !== 1) return 1;
  if (minor <= 8) return 1;
  if (minor <= 10) return 2;
  if (minor <= 12) return 3;
  if (minor <= 14) return 4;
  if (minor === 15) return 5;
  if (minor === 16) return patch <= 1 ? 5 : 6;
  if (minor === 17) return 7;
  if (minor === 18) return 8;
  if (minor === 19) {
    if (patch <= 2) return 9;
    if (patch === 3) return 12;
    return 13;
  }
  if (minor === 20) return 15;
  return 1;
}

function readPackFormat(zip: AdmZip, versionId: string): PackFormat {
  const entry = zip.getEntry('version.json');
  if (entry) {
    try {
      const json = JSON.parse(entry.getData().toString('utf8'));
      const pv = json?.pack_version;
      if (typeof pv === 'number') return pv;
      if (pv && typeof pv === 'object') {
        if (typeof pv.resource_major === 'number') {
          const minor = pv.resource_minor ?? 0;
          return minor > 0 ? [pv.resource_major, minor] : pv.resource_major;
        }
        if (typeof pv.resource === 'number') return pv.resource;
      }
    } catch {
      /* fall through */
    }
  }
  return legacyPackFormat(versionId);
}

function buildMcmeta(fmt: PackFormat): Buffer {
  const pack: Record<string, unknown> = { description: PACK_DESCRIPTION };
  if (typeof fmt === 'number') {
    pack.pack_format = fmt;
    pack.supported_formats = fmt;
    pack.min_format = fmt;
    pack.max_format = fmt;
  } else {
    pack.pack_format = fmt[0];
    pack.min_format = fmt;
    pack.max_format = fmt;
  }
  return Buffer.from(JSON.stringify({ pack }, null, 2), 'utf8');
}

// ----------------------------------------------------------------- pack icon

function buildPackIcon(): Buffer {
  const size = 64;
  const png = new PNG({ width: size, height: size });
  png.data.fill(0);
  const r = 12;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sd = roundedBoxSd(x, y, size, size, r);
      if (sd > 0) continue;
      const i = (y * size + x) * 4;
      if (sd > -2.5) {
        const t = (x + y) / (2 * (size - 1));
        png.data[i] = Math.round(78 + (125 - 78) * t);
        png.data[i + 1] = Math.round(200 + (107 - 200) * t);
        png.data[i + 2] = Math.round(255 + (255 - 255) * t);
        png.data[i + 3] = 255;
      } else {
        const gy = y / (size - 1);
        png.data[i] = Math.round(11 + 9 * gy);
        png.data[i + 1] = Math.round(13 + 12 * gy);
        png.data[i + 2] = Math.round(18 + 16 * gy);
        png.data[i + 3] = 255;
      }
    }
  }

  const scale = 3;
  const mark = renderWordmark('F', scale);
  const ox = Math.round((size - mark.inkW) / 2);
  const oy = Math.round((size - mark.inkH) / 2);
  for (let cy = 0; cy < mark.png.height; cy++) {
    for (let cx = 0; cx < mark.png.width; cx++) {
      const si = (cy * mark.png.width + cx) * 4;
      if (mark.png.data[si + 3] === 0) continue;
      const x = ox + cx;
      const y = oy + cy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const di = (y * size + x) * 4;
      png.data[di] = mark.png.data[si];
      png.data[di + 1] = mark.png.data[si + 1];
      png.data[di + 2] = mark.png.data[si + 2];
      png.data[di + 3] = 255;
    }
  }

  return PNG.sync.write(png);
}

// ---------------------------------------------------------------- language

const LANG_OVERRIDES: Record<string, string> = {
  'menu.singleplayer': 'SINGLEPLAYER',
  'menu.multiplayer': 'MULTIPLAYER',
  'menu.online': 'REALMS',
};

interface LangFile {
  name: string;
  data: Buffer;
}

function buildLang(zip: AdmZip): LangFile | null {
  const jsonEntry = zip.getEntry('assets/minecraft/lang/en_us.json');
  if (jsonEntry) {
    try {
      const obj = JSON.parse(jsonEntry.getData().toString('utf8')) as Record<string, string>;
      let touched = false;
      for (const [key, value] of Object.entries(LANG_OVERRIDES)) {
        if (typeof obj[key] === 'string') {
          obj[key] = value;
          touched = true;
        }
      }
      if (!touched) return null;
      return { name: 'en_us.json', data: Buffer.from(JSON.stringify(obj), 'utf8') };
    } catch {
      return null;
    }
  }

  const langEntry = zip.getEntry('assets/minecraft/lang/en_US.lang');
  if (langEntry) {
    const raw = langEntry.getData().toString('utf8');
    const crlf = raw.includes('\r\n');
    const lines = raw.split(/\r?\n/);
    let touched = false;
    for (let i = 0; i < lines.length; i++) {
      const eq = lines[i].indexOf('=');
      if (eq < 0) continue;
      const key = lines[i].slice(0, eq);
      if (LANG_OVERRIDES[key]) {
        const trailing = lines[i].endsWith('\r') ? '\r' : '';
        lines[i] = `${key}=${LANG_OVERRIDES[key]}${trailing}`;
        touched = true;
      }
    }
    if (!touched) return null;
    return { name: 'en_US.lang', data: Buffer.from(lines.join(crlf ? '\r\n' : '\n'), 'utf8') };
  }

  return null;
}

// ---------------------------------------------------------------- panorama

interface PanoramaSource {
  kind: 'jar' | 'objects';
  faces: string[];
}

function findPanoramaSource(zip: AdmZip, args: MenuPackArgs): PanoramaSource | null {
  const jarFaces: string[] = [];
  for (let i = 0; i < PANORAMA_FACES; i++) {
    const entry = zip.getEntry(`assets/minecraft/textures/gui/title/background/panorama_${i}.png`);
    if (!entry || entry.header.size < 1000) return findObjectsPanorama(args);
    jarFaces.push(`panorama_${i}`);
  }
  return { kind: 'jar', faces: jarFaces };
}

function findObjectsPanorama(args: MenuPackArgs): PanoramaSource | null {
  if (!args.assetsDir || !args.assetIndexId) return null;
  const indexFile = path.join(args.assetsDir, 'indexes', `${args.assetIndexId}.json`);
  if (!fs.existsSync(indexFile)) return null;
  try {
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as {
      objects?: Record<string, { hash: string; size: number }>;
    };
    const faces: string[] = [];
    for (let i = 0; i < PANORAMA_FACES; i++) {
      const obj = index.objects?.[`minecraft/textures/gui/title/background/panorama_${i}.png`];
      if (!obj || obj.size < 1000) return null;
      const file = path.join(args.assetsDir, 'objects', obj.hash.slice(0, 2), obj.hash);
      if (!fs.existsSync(file)) return null;
      faces.push(file);
    }
    return { kind: 'objects', faces };
  } catch {
    return null;
  }
}

function loadPanoramaPngs(zip: AdmZip, source: PanoramaSource): PNG[] | null {
  const out: PNG[] = [];
  try {
    for (let i = 0; i < PANORAMA_FACES; i++) {
      const buf =
        source.kind === 'jar'
          ? zip.getEntry(`assets/minecraft/textures/gui/title/background/panorama_${i}.png`)!.getData()
          : fs.readFileSync(source.faces[i]);
      const png = PNG.sync.read(buf);
      blurPanorama(png, 84);
      out.push(png);
    }
    return out;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- options.txt

function gameSeparator(content: string): string {
  if (content.includes('\r\n')) return '\r\n';
  return '\n';
}

function patchOptions(gameDir: string, enabled: boolean): boolean {
  const file = path.join(gameDir, 'options.txt');
  const existed = fs.existsSync(file);
  if (!existed && !enabled) return false;
  const content = existed ? fs.readFileSync(file, 'utf8') : '';
  const sep = existed ? gameSeparator(content) : process.platform === 'win32' ? '\r\n' : '\n';
  const lines = content ? content.split(/\r?\n/) : [];
  const idx = lines.findIndex((l) => l.startsWith('resourcePacks:'));
  const scaleIdx = lines.findIndex((l) => l.startsWith('guiScale:'));

  let current: string[] = [];
  if (idx >= 0) {
    try {
      const parsed = JSON.parse(lines[idx].slice('resourcePacks:'.length));
      if (Array.isArray(parsed)) current = parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      current = [];
    }
  }

  const others = current.filter((v) => !PACK_IDS.includes(v) && v !== 'vanilla');
  const next = enabled ? ['vanilla', ...others, ...PACK_IDS] : ['vanilla', ...others];
  if (!enabled && idx < 0) return false;
  let changed = false;

  const before = JSON.stringify(current);
  const after = JSON.stringify(next);
  if (before !== after) {
    const line = `resourcePacks:${after}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
    changed = true;
  }

  if (enabled && scaleIdx >= 0 && /^guiScale:0$/.test(lines[scaleIdx])) {
    lines[scaleIdx] = 'guiScale:2';
    changed = true;
  }

  if (!changed) return false;

  let out = lines.join(sep);
  if (!existed) out += sep;
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(file, out, 'utf8');
  return true;
}

// ------------------------------------------------------------------- build

interface PackInspection {
  fmt: PackFormat;
  logoMode: 'legacy' | 'modern' | null;
  buttonMode: 'sprites' | 'widgets' | null;
  langName: string | null;
  panorama: PanoramaSource | null;
}

function inspectPack(zip: AdmZip, args: MenuPackArgs): PackInspection {
  const fmt = readPackFormat(zip, args.versionId);

  let logoMode: 'legacy' | 'modern' | null = null;
  const logoEntry = zip.getEntry('assets/minecraft/textures/gui/title/minecraft.png');
  if (logoEntry) {
    const dims = readPngDims(logoEntry.getData());
    if (dims) {
      if (dims.width === 256 && dims.height === 256) logoMode = 'legacy';
      else if (dims.width === 1024 && dims.height === 256) logoMode = 'modern';
    }
  }

  const buttonMode: 'sprites' | 'widgets' | null = zip.getEntry('assets/minecraft/textures/gui/sprites/widget/button.png')
    ? 'sprites'
    : zip.getEntry('assets/minecraft/textures/gui/widgets.png')
      ? 'widgets'
      : null;

  const langName = zip.getEntry('assets/minecraft/lang/en_us.json')
    ? 'en_us.json'
    : zip.getEntry('assets/minecraft/lang/en_US.lang')
      ? 'en_US.lang'
      : null;

  const panorama = findPanoramaSource(zip, args);

  return { fmt, logoMode, buttonMode, langName, panorama };
}

function cacheKey(inspection: PackInspection, jarStat: fs.Stats): string {
  const payload = {
    rev: REV,
    fmt: inspection.fmt,
    logoMode: inspection.logoMode,
    buttonMode: inspection.buttonMode,
    langName: inspection.langName,
    panorama: inspection.panorama
      ? { kind: inspection.panorama.kind, size: safeSize(inspection.panorama.faces[0]) }
      : null,
    jarSize: jarStat.size,
    jarMtime: jarStat.mtimeMs,
  };
  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}

function safeSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

function readCachedKey(zipPath: string): string | null {
  try {
    const zip = new AdmZip(zipPath);
    const entry = zip.getEntry('flame-meta.json');
    if (!entry) return null;
    const meta = JSON.parse(entry.getData().toString('utf8'));
    return typeof meta?.key === 'string' ? meta.key : null;
  } catch {
    return null;
  }
}

function writeZipAtomic(zipPath: string, zip: AdmZip): void {
  const tmp = `${zipPath}.tmp`;
  zip.writeZip(tmp);
  try {
    fs.unlinkSync(zipPath);
  } catch {
    /* first run */
  }
  fs.renameSync(tmp, zipPath);
}

// ------------------------------------------------------------------- public

export async function applyMenuPack(args: MenuPackArgs): Promise<string> {
  const packsDir = path.join(args.gameDir, 'resourcepacks');
  const zipPath = path.join(packsDir, MENU_PACK_NAME);

  if (!args.enabled) {
    const changed = patchOptions(args.gameDir, false);
    let removedFile = false;
    try {
      if (fs.existsSync(zipPath)) {
        fs.unlinkSync(zipPath);
        removedFile = true;
      }
      const tmp = `${zipPath}.tmp`;
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return changed || removedFile
      ? 'Flame menu theme disabled \u2014 vanilla menu restored on next launch'
      : 'Flame menu theme disabled';
  }

  fs.mkdirSync(packsDir, { recursive: true });
  const jarStat = fs.statSync(args.clientJar);
  const source = new AdmZip(args.clientJar);
  const inspection = inspectPack(source, args);
  const key = cacheKey(inspection, jarStat);

  if (fs.existsSync(zipPath) && readCachedKey(zipPath) === key) {
    patchOptions(args.gameDir, true);
    return `Flame menu theme up to date (${args.versionId})`;
  }

  const out = new AdmZip();
  out.addFile('pack.mcmeta', buildMcmeta(inspection.fmt));
  out.addFile('pack.png', buildPackIcon());
  out.addFile('assets/minecraft/texts/splashes.txt', Buffer.from(' ', 'utf8'));
  out.addFile(
    'flame-meta.json',
    Buffer.from(JSON.stringify({ key, rev: REV, versionId: args.versionId }), 'utf8'),
  );

  if (inspection.langName) {
    const lang = buildLang(source);
    if (lang) out.addFile(`assets/minecraft/lang/${lang.name}`, lang.data);
  }

  if (inspection.logoMode) {
    const logoEntry = source.getEntry('assets/minecraft/textures/gui/title/minecraft.png');
    if (logoEntry) {
      const logo = PNG.sync.read(logoEntry.getData());
      if (buildLogo(logo)) {
        out.addFile('assets/minecraft/textures/gui/title/minecraft.png', PNG.sync.write(logo));
      }
    }
  }

  if (inspection.buttonMode === 'sprites') {
    for (const style of ['normal', 'hover', 'disabled'] as const) {
      const name =
        style === 'normal' ? 'button.png' : style === 'hover' ? 'button_highlighted.png' : 'button_disabled.png';
      const png = renderButton(style, 200, 20);
      out.addFile(`assets/minecraft/textures/gui/sprites/widget/${name}`, PNG.sync.write(png));
    }
  } else if (inspection.buttonMode === 'widgets') {
    const widgetsEntry = source.getEntry('assets/minecraft/textures/gui/widgets.png');
    if (widgetsEntry) {
      const widgets = PNG.sync.read(widgetsEntry.getData());
      if (widgets.width >= 200 && widgets.height >= 106) {
        const rows: Array<[number, ButtonStyle]> = [
          [46, 'disabled'],
          [66, 'normal'],
          [86, 'hover'],
        ];
        for (const [y, style] of rows) {
          const art = renderButton(style, 200, 20);
          for (let ry = 0; ry < 20; ry++) {
            for (let rx = 0; rx < 200; rx++) {
              const si = (ry * 200 + rx) * 4;
              const di = ((y + ry) * widgets.width + rx) * 4;
              widgets.data[di] = art.data[si];
              widgets.data[di + 1] = art.data[si + 1];
              widgets.data[di + 2] = art.data[si + 2];
              widgets.data[di + 3] = art.data[si + 3];
            }
          }
        }
        out.addFile('assets/minecraft/textures/gui/widgets.png', PNG.sync.write(widgets));
      }
    }
  }

  if (inspection.panorama) {
    const faces = loadPanoramaPngs(source, inspection.panorama);
    if (faces) {
      for (let i = 0; i < faces.length; i++) {
        out.addFile(
          `assets/minecraft/textures/gui/title/background/panorama_${i}.png`,
          PNG.sync.write(faces[i]),
        );
      }
    }
  }

  writeZipAtomic(zipPath, out);
  patchOptions(args.gameDir, true);

  const parts = [
    inspection.logoMode ? 'logo' : null,
    inspection.buttonMode ? 'buttons' : null,
    inspection.panorama ? 'panorama' : null,
    inspection.langName ? 'labels' : null,
  ].filter(Boolean);
  return `Flame menu theme applied to ${args.versionId} (${parts.join(', ')})`;
}
