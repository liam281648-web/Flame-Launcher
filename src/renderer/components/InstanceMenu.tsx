import { useEffect, useRef, useState } from 'react';
import { Boxes, Check, ChevronDown, Cog, FolderOpen, Play, Plus } from 'lucide-react';
import type { InstanceInfo } from '@shared/types';
import { LOADER_LABEL } from '@shared/types';
import { useLauncher } from '../state/store';

/** Compact instance glyph; falls back to a coloured initial. */
export function InstanceGlyph({
  instance,
  size = 28,
}: {
  instance: InstanceInfo;
  size?: number;
}) {
  if (instance.icon) {
    return (
      <img
        className="instance-glyph"
        src={instance.icon}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        // A custom icon can point anywhere; a failed load must not break the card.
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = 'none';
        }}
      />
    );
  }
  const tint = instance.loader.type === 'vanilla' ? 'var(--accent)' : 'var(--accent-2, #7aa2ff)';
  return (
    <span
      className="instance-glyph instance-glyph--auto"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: tint }}
      aria-hidden="true"
    >
      {instance.name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

/** One-line summary: `1.20.1 · Fabric 0.16.9`. */
export function instanceSubtitle(instance: InstanceInfo): string {
  const { type, version } = instance.loader;
  if (type === 'vanilla') return instance.gameVersion;
  return `${instance.gameVersion} · ${LOADER_LABEL[type]}${version ? ` ${version}` : ''}`;
}

/**
 * Always-visible instance switcher.
 *
 * Instance choice is global state — it decides what Play launches and what the
 * Packs tabs edit — so it lives in the title bar rather than inside one view.
 */
export function InstanceMenu() {
  const instances = useLauncher((s) => s.instances);
  const activeInstanceId = useLauncher((s) => s.activeInstanceId);
  const selectInstance = useLauncher((s) => s.selectInstance);
  const setView = useLauncher((s) => s.setView);
  const launchPhase = useLauncher((s) => s.launch.phase);
  const runningInstanceId = useLauncher((s) => s.runningInstanceId);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const active = instances.find((i) => i.id === activeInstanceId) ?? null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="instance-pill" ref={ref}>
      <button
        className="instance-pill__btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Switch instance"
        title={active ? `${active.name} — ${instanceSubtitle(active)}` : 'No instance'}
      >
        {active ? (
          <InstanceGlyph instance={active} size={22} />
        ) : (
          <span className="account-pill__ghost">
            <Boxes size={14} />
          </span>
        )}
        <span className="instance-pill__name">{active ? active.name : 'No instance'}</span>
        <ChevronDown size={14} className={open ? 'chevron chevron--up' : 'chevron'} />
      </button>

      {open ? (
        <div className="account-menu instance-menu">
          <div className="account-menu__label">Active instance</div>
          {instances.length === 0 ? (
            <div className="account-menu__empty">No instances yet</div>
          ) : (
            instances.map((inst) => {
              const busy = launchPhase !== 'idle' && inst.id === activeInstanceId;
              return (
                <button
                  key={inst.id}
                  className={`instance-menu__item${
                    inst.id === activeInstanceId ? ' account-menu__item--active' : ''
                  }`}
                  onClick={() => {
                    void selectInstance(inst.id);
                    setOpen(false);
                  }}
                  disabled={busy}
                  title={busy ? 'A launch is in progress for this instance' : undefined}
                >
                  <InstanceGlyph instance={inst} size={26} />
                  <span className="account-menu__meta">
                    <span className="account-menu__username">{inst.name}</span>
                    <span className="account-menu__type">{instanceSubtitle(inst)}</span>
                  </span>
                  {runningInstanceId === inst.id ? <Play size={13} /> : null}
                  {inst.id === activeInstanceId ? <Check size={14} /> : null}
                </button>
              );
            })
          )}

          <div className="account-menu__divider" />
          <button
            className="account-menu__action"
            onClick={() => {
              setView('instances');
              setOpen(false);
            }}
          >
            <Plus size={14} /> Create or manage instances
          </button>
          <button
            className="account-menu__action"
            onClick={() => {
              if (active) window.flame?.instances.open(active.id);
              setOpen(false);
            }}
          >
            <FolderOpen size={14} /> Open folder
          </button>
          <button
            className="account-menu__action"
            onClick={() => {
              setView('settings');
              setOpen(false);
            }}
          >
            <Cog size={14} /> Java &amp; memory
          </button>
        </div>
      ) : null}
    </div>
  );
}