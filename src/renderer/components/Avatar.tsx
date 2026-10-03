import { useEffect, useMemo, useState } from 'react';
import type { Account } from '@shared/types';

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const SKIN = ['#f0c8a0', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#a56b46'];
const HAIR = ['#14141a', '#2e2118', '#4a3320', '#7a5a35', '#c9b28a', '#3a4356', '#6b6f7a'];
const SHIRT = ['#1c2029', '#263046', '#2f4a3f', '#4a2f45', '#39303a', '#123047'];

export function PixelAvatar({ name, size = 48 }: { name: string; size?: number }) {
  const { shirt, cells } = useMemo(() => {
    const h = hashString(name.toLowerCase());
    const pick = (arr: string[], salt: number) => arr[(h >>> salt) % arr.length];
    const skin = pick(SKIN, 0);
    const hair = pick(HAIR, 6);
    const shirt = pick(SHIRT, 12);
    const cells: Array<{ x: number; y: number; fill: string }> = [];

    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 4; x++) {
        let fill = skin;
        const fringe = 2 + ((h >> 3) & 1);
        if (y < fringe) fill = hair;
        else if (y === fringe && x < 1 + ((h >> 5) & 1)) fill = hair;
        else if (y === fringe + 1 && x === 0 && ((h >> 7) & 1)) fill = hair;
        else if (y === 4 && x <= 1) fill = '#f6f8ff';
        else if (y === 4 && x === 2) fill = '#2f6db3';
        else if (y === 5 && x === 1) fill = shade(skin, -22);

        cells.push({ x, y, fill });
        if (x !== 3) cells.push({ x: 7 - x, y, fill });
      }
    }
    return { shirt, cells };
  }, [name]);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 8 8"
      shapeRendering="crispEdges"
      className="pixel-avatar"
      role="img"
      aria-label={name}
    >
      <rect x="0" y="0" width="8" height="8" fill="#0b0e16" />
      {cells.map((c, i) => (
        <rect key={i} x={c.x} y={c.y} width="1" height="1" fill={c.fill} />
      ))}
      <rect x="0" y="7.4" width="8" height="0.6" fill={shirt} />
    </svg>
  );
}

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, ((n >> 16) & 0xff) + amount));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + amount));
  const b = Math.max(0, Math.min(255, (n & 0xff) + amount));
  return `rgb(${r}, ${g}, ${b})`;
}

export function accountHeadId(account: Account): string {
  return account.type === 'offline' ? account.username : account.uuid.replace(/-/g, '');
}

export function headUrl(account: Account, size = 64): string {
  return `https://mc-heads.net/avatar/${accountHeadId(account)}/${size * 2}`;
}

export function bodyUrl(account: Account, size = 400): string {
  return `https://mc-heads.net/body/${accountHeadId(account)}/${size}`;
}

/** Preloads a texture so a broken URL never flashes before falling back. */
function usePreloaded(src: string | undefined): 'pending' | 'ok' | 'failed' {
  const [state, setState] = useState<'pending' | 'ok' | 'failed'>(src ? 'pending' : 'failed');

  useEffect(() => {
    if (!src) {
      setState('failed');
      return;
    }
    let alive = true;
    setState('pending');
    const img = new Image();
    img.onload = () => {
      if (alive) setState('ok');
    };
    img.onerror = () => {
      if (alive) setState('failed');
    };
    img.src = src;
    return () => {
      alive = false;
    };
  }, [src]);

  return state;
}

/**
 * Crops the 8×8 face (plus its hat overlay) out of a 64×64 Minecraft skin
 * texture using two stacked background layers.
 */
export function SkinHead({
  url,
  size,
  name,
}: {
  url: string;
  size: number;
  name: string;
}) {
  const unit = size / 8;
  const tex = `${64 * unit}px ${64 * unit}px`;

  return (
    <span
      className="avatar__skin"
      role="img"
      aria-label={name}
      style={{
        width: size,
        height: size,
        backgroundImage: `url("${url}"), url("${url}")`,
        backgroundSize: `${tex}, ${tex}`,
        backgroundPosition: `${-40 * unit}px ${-8 * unit}px, ${-8 * unit}px ${-8 * unit}px`,
      }}
    />
  );
}

export function Avatar({
  account,
  size = 40,
  glow = false,
}: {
  account: Account;
  size?: number;
  glow?: boolean;
}) {
  const skinState = usePreloaded(account.skinUrl);
  const [headFailed, setHeadFailed] = useState(false);

  useEffect(() => setHeadFailed(false), [account.id, account.skinUrl]);

  const showSkin = Boolean(account.skinUrl) && skinState === 'ok';
  const showHead = !showSkin && !headFailed;

  return (
    <span className={`avatar${glow ? ' avatar--glow' : ''}`} style={{ width: size, height: size }}>
      {showSkin && account.skinUrl ? (
        <SkinHead key={account.skinUrl} url={account.skinUrl} size={size} name={account.username} />
      ) : showHead ? (
        <img
          key={`${account.uuid}-${size}`}
          src={headUrl(account, size)}
          width={size}
          height={size}
          alt={account.username}
          draggable={false}
          onError={() => setHeadFailed(true)}
        />
      ) : (
        <PixelAvatar name={account.username} size={size} />
      )}
    </span>
  );
}
