import { useMemo } from 'react';

interface Star {
  left: number;
  top: number;
  size: number;
  delay: number;
  duration: number;
  opacity: number;
}

function makeStars(count: number, seed = 7): Star[] {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  return Array.from({ length: count }, () => ({
    left: rand() * 100,
    top: rand() * 100,
    size: rand() > 0.88 ? 2.5 : rand() > 0.6 ? 2 : 1.5,
    delay: rand() * 6,
    duration: 3 + rand() * 5,
    opacity: 0.2 + rand() * 0.6,
  }));
}

type Hue = 'grass' | 'ice' | 'violet' | 'stone';

const CUBES: Array<{ x: number; y: number; scale: number; delay: number; hue: Hue }> = [
  { x: 4, y: 14, scale: 1.45, delay: 0, hue: 'grass' },
  { x: 16, y: 58, scale: 0.85, delay: 1.6, hue: 'ice' },
  { x: 85, y: 12, scale: 1.15, delay: 0.8, hue: 'violet' },
  { x: 78, y: 58, scale: 0.7, delay: 2.4, hue: 'stone' },
  { x: 46, y: 82, scale: 0.45, delay: 3.2, hue: 'ice' },
];

const PALETTES: Record<Hue, { top: string; left: string; right: string; edge: string }> = {
  grass: { top: '#3ea45c', left: '#5d4028', right: '#6f4c31', edge: '#8ce8a4' },
  ice: { top: '#7fd6ff', left: '#275f8c', right: '#367fb8', edge: '#c2eeff' },
  violet: { top: '#6a5cd8', left: '#2a2458', right: '#3f3789', edge: '#a99cff' },
  stone: { top: '#48536a', left: '#1f2634', right: '#2c3547', edge: '#93a4c4' },
};

function Cube({ hue }: { hue: Hue }) {
  const p = PALETTES[hue];
  return (
    <svg viewBox="0 0 60 60" width="60" height="60" className="hero__cube">
      <polygon points="30,0 60,15 30,30 0,15" fill={p.top} />
      <polygon points="0,15 30,30 30,60 0,45" fill={p.left} />
      <polygon points="60,15 30,30 30,60 60,45" fill={p.right} />
      <polyline
        points="0,15 30,0 60,15 60,45 30,60 0,45 0,15"
        fill="none"
        stroke={p.edge}
        strokeOpacity="0.55"
        strokeWidth="1.2"
      />
      <line
        x1="30"
        y1="30"
        x2="30"
        y2="60"
        stroke={p.edge}
        strokeOpacity="0.3"
        strokeWidth="1.2"
      />
    </svg>
  );
}

export function VoxelScene() {
  const stars = useMemo(() => makeStars(110), []);

  return (
    <div className="hero__scene" aria-hidden="true">
      <div className="hero__sky" />

      {stars.map((star, i) => (
        <span
          key={i}
          className="hero__star"
          style={
            {
              left: `${star.left}%`,
              top: `${star.top}%`,
              width: star.size,
              height: star.size,
              opacity: star.opacity,
              animationDelay: `${star.delay}s`,
              animationDuration: `${star.duration}s`,
            } as React.CSSProperties
          }
        />
      ))}

      {CUBES.map((cube, i) => (
        <span
          key={i}
          className="hero__cube-wrap"
          style={
            {
              left: `${cube.x}%`,
              top: `${cube.y}%`,
              transform: `scale(${cube.scale})`,
              animationDelay: `${cube.delay}s`,
            } as React.CSSProperties
          }
        >
          <Cube hue={cube.hue} />
        </span>
      ))}

      <div className="hero__glow" />
      <div className="hero__vignette" />
    </div>
  );
}
