import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Boxes,
  ChevronDown,
  CircleStop,
  Copy,
  FileText,
  Loader2,
  MonitorSmartphone,
  Palette,
  Plus,
  Settings2,
  Sparkles,
  TriangleAlert,
  UserPlus,
} from 'lucide-react';
import type { ViewId } from '@shared/types';
import { PROVISIONED_LOADERS } from '@shared/types';
import { Avatar, PixelAvatar } from '../components/Avatar';
import { VoxelScene } from '../components/VoxelScene';
import { DropTarget } from '../components/DropTarget';
import { VersionMenu } from '../components/VersionMenu';
import { InstanceGlyph, instanceSubtitle } from '../components/InstanceMenu';
import { api } from '../lib/api';
import { useLauncher } from '../state/store';

const BUSY_PHASES = ['preparing', 'downloading', 'launching'] as const;

/** Loaders Flame installs at launch; anything else runs vanilla with a warning. */
const PROVISIONED = new Set<string>(PROVISIONED_LOADERS);

const SERVERS = [
  { id: 'hypixel', name: 'Hypixel', glyph: 'H', hue: 'gold' },
  { id: 'cubecraft', name: 'CubeCraft', glyph: 'CC', hue: 'blue' },
  { id: 'hive', name: 'The Hive', glyph: 'HB', hue: 'amber' },
  { id: 'mcc', name: 'MCC Island', glyph: 'MCC', hue: 'violet' },
  { id: 'legacy', name: 'PvP Legacy', glyph: 'PL', hue: 'red' },
  { id: 'wynncraft', name: 'Wynncraft', glyph: 'W', hue: 'green' },
  { id: 'minemen', name: 'Minemen Club', glyph: 'MM', hue: 'cyan' },
  { id: 'portal', name: 'Portal Network', glyph: 'PN', hue: 'rose' },
] as const;

const NEWS: Array<{
  id: string;
  art: string;
  icon: typeof Sparkles;
  tag: string;
  title: string;
  text: string;
  cta: string;
  view: ViewId;
}> = [
  {
    id: 'packs',
    art: 'violet',
    icon: Sparkles,
    tag: 'Packs & Shaders',
    title: 'Shaders, one click away',
    text: 'Browse thousands of shaders and resource packs on Modrinth and install them straight into your instance — filtered to the version you are playing.',
    cta: 'Browse packs',
    view: 'packs',
  },
  {
    id: 'auth',
    art: 'green',
    icon: MonitorSmartphone,
    tag: 'Accounts',
    title: 'Sign in with Microsoft',
    text: 'Play online with your real skin and username. Flame never sees your password — you approve access in a Microsoft window and your session stays encrypted on this device.',
    cta: 'Add account',
    view: 'accounts',
  },
  {
    id: 'menu',
    art: 'amber',
    icon: Palette,
    tag: 'Settings',
    title: 'The Flame menu theme',
    text: 'Launch into a custom main menu with dark buttons and a blurred panorama. Toggle it any time, alongside memory, Java and JVM options in Settings.',
    cta: 'Open settings',
    view: 'settings',
  },
];

export function PlayView() {
  const accounts = useLauncher((s) => s.accounts);
  const activeAccountId = useLauncher((s) => s.activeAccountId);
  const selectedVersionId = useLauncher((s) => s.selectedVersionId);
  const instances = useLauncher((s) => s.instances);
  const activeInstanceId = useLauncher((s) => s.activeInstanceId);
  const runningInstanceId = useLauncher((s) => s.runningInstanceId);
  const launch = useLauncher((s) => s.launch);
  const startLaunch = useLauncher((s) => s.startLaunch);
  const stopLaunch = useLauncher((s) => s.stopLaunch);
  const setView = useLauncher((s) => s.setView);
  const versionsError = useLauncher((s) => s.versionsError);
  const notify = useLauncher((s) => s.notify);
  const importDroppedFiles = useLauncher((s) => s.importDroppedFiles);

  const [menuOpen, setMenuOpen] = useState(false);
  const [instanceOpen, setInstanceOpen] = useState(false);
  const instanceRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());
  const [logOpen, setLogOpen] = useState(false);
  const [logText, setLogText] = useState('');

  const active = accounts.find((a) => a.id === activeAccountId) ?? null;
  const instance = instances.find((i) => i.id === activeInstanceId) ?? null;
  const phase = launch.phase;
  const busy = BUSY_PHASES.includes(phase as (typeof BUSY_PHASES)[number]);
  const running = phase === 'running';
  const stopping = phase === 'stopping';
  const errored = phase === 'error';

  useEffect(() => {
    if (!instanceOpen) return;
    const onDown = (e: MouseEvent) => {
      if (instanceRef.current && !instanceRef.current.contains(e.target as Node)) {
        setInstanceOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [instanceOpen]);

  // Fetch the full log from disk on demand so the drawer shows everything the
  // process printed, not just the in-memory tail. Scoped to the instance, since
  // each one keeps its own log.
  useEffect(() => {
    if (!logOpen) return;
    let cancelled = false;
    void api.launch
      .readLog(instance?.id, 400)
      .then((text) => {
        if (!cancelled) setLogText(text);
      })
      .catch(() => {
        if (!cancelled) setLogText('Could not read latest-launch.log.');
      });
    return () => {
      cancelled = true;
    };
  }, [logOpen, launch.exitCode, instance?.id]);

  // The in-memory tail is enough for the common case and avoids a disk read.
  const previewText = logText || launch.logTail.join('\n');

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  const elapsed = useMemo(() => {
    if (!running || !launch.startedAt) return null;
    const total = Math.max(0, Math.floor((now - launch.startedAt) / 1000));
    const mm = String(Math.floor(total / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }, [running, launch.startedAt, now]);

  const progressPct = launch.progress
    ? Math.round((launch.progress.current / Math.max(1, launch.progress.total)) * 100)
    : null;

  const launchLabel = instance ? instance.name.toUpperCase() : 'NO INSTANCE';

  const subLabel = errored
    ? 'LAUNCH FAILED — TRY AGAIN'
    : !instance
      ? 'CREATE AN INSTANCE'
      : busy
      ? phase === 'downloading'
        ? `DOWNLOADING ${progressPct ?? 0}%`
        : phase === 'launching'
          ? 'LAUNCHING…'
          : 'PREPARING…'
      : running
        ? 'GAME RUNNING'
        : stopping
          ? 'STOPPING…'
          : !active
            ? 'SIGN IN TO PLAY'
            : versionsError
              ? 'OFFLINE MODE'
              : 'READY TO LAUNCH';

  const statusText = errored
    ? (launch.error ?? 'Launch failed')
    : !instance
      ? 'Create an instance to start playing'
      : running
        ? `Game running${elapsed ? ` · ${elapsed}` : ''}`
        : stopping
          ? 'Stopping the game…'
          : busy
            ? (launch.message ?? 'Working…')
            : versionsError
              ? `Offline mode — ${versionsError}`
              : active
                ? `Ready to launch · ${instanceSubtitle(instance)}`
                : `Sign in to play · ${instanceSubtitle(instance)}`;

  const statusKind = errored ? 'error' : running ? 'success' : busy ? 'busy' : 'ready';

  return (
    // Dropping anywhere on the home screen targets the active instance, which is
    // the one the launch button is about to start.
    <DropTarget
      variant="full"
      instanceName={instance?.name ?? instance?.id ?? 'the active instance'}
      onFiles={(files) => void importDroppedFiles(files)}
    >
    <div className="view view--home">
      <section className="hero">
        <VoxelScene />

        <div className="hero__content">
          <div className="hero__player">
            {active ? (
              <>
                <Avatar account={active} size={34} glow />
                <span className="hero__player-meta">
                  <span className="hero__player-name">{active.username}</span>
                  <span className="hero__player-type">
                    {active.type === 'microsoft' ? 'Microsoft account' : 'Offline profile'}
                  </span>
                </span>
              </>
            ) : (
              <>
                <span className="hero__player-ghost">
                  <PixelAvatar name="Steve" size={34} />
                </span>
                <span className="hero__player-meta">
                  <span className="hero__player-name">No player</span>
                  <span className="hero__player-type">Sign in to play</span>
                </span>
              </>
            )}
          </div>

          <div className="hero__center">
            <div className={`launch-cluster launch-cluster--${phase}`}>
              <button
                className="launch-btn"
                onClick={() => void startLaunch()}
                disabled={busy || stopping || !active || !instance}
                aria-label={`${launchLabel} — ${subLabel}`}
              >
                {busy ? (
                  <Loader2 size={22} className="spin launch-btn__icon" />
                ) : (
                  <span className="launch-btn__pip" aria-hidden="true" />
                )}
                <span className="launch-btn__text">
                  <span className="launch-btn__label">{launchLabel}</span>
                  <span className="launch-btn__sub">{subLabel}</span>
                </span>
                <span className="launch-btn__shine" aria-hidden="true" />
              </button>

              <button
                className={`launch-ver${menuOpen ? ' launch-ver--open' : ''}`}
                onClick={() => setMenuOpen((v) => !v)}
                aria-label="Choose a Minecraft version"
                aria-expanded={menuOpen}
                disabled={!instance}
                title={instance ? 'Change this instance’s Minecraft version' : 'No instance'}
              >
                <ChevronDown size={20} />
              </button>

              <VersionMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
            </div>

            <div className="hero-instance" ref={instanceRef}>
              <button
                className={`hero-instance__btn${instanceOpen ? ' hero-instance__btn--open' : ''}`}
                onClick={() => setInstanceOpen((v) => !v)}
                aria-expanded={instanceOpen}
                aria-label="Choose the instance to launch"
              >
                {instance ? (
                  <>
                    <InstanceGlyph instance={instance} size={20} />
                    <span className="hero-instance__meta">
                      <span className="hero-instance__name">{instance.name}</span>
                      <span className="hero-instance__sub">{instanceSubtitle(instance)}</span>
                    </span>
                  </>
                ) : (
                  <>
                    <span className="hero-instance__meta">
                      <span className="hero-instance__name">No instance</span>
                      <span className="hero-instance__sub">Create one to get started</span>
                    </span>
                  </>
                )}
                <ChevronDown size={15} className={instanceOpen ? 'chevron chevron--up' : 'chevron'} />
              </button>

              {instanceOpen ? (
                <div className="hero-instance__menu">
                  <div className="hero-instance__label">Launch which instance?</div>
                  {instances.map((inst) => (
                    <button
                      key={inst.id}
                      className={`hero-instance__item${
                        inst.id === activeInstanceId ? ' hero-instance__item--active' : ''
                      }`}
                      disabled={busy && inst.id === activeInstanceId}
                      onClick={() => {
                        void useLauncher.getState().selectInstance(inst.id);
                        setInstanceOpen(false);
                      }}
                    >
                      <InstanceGlyph instance={inst} size={24} />
                      <span className="hero-instance__meta">
                        <span className="hero-instance__name">{inst.name}</span>
                        <span className="hero-instance__sub">{instanceSubtitle(inst)}</span>
                      </span>
                      {runningInstanceId === inst.id ? (
                        <span className="tag tag--live">Running</span>
                      ) : null}
                    </button>
                  ))}
                  <div className="hero-instance__divider" />
                  <button
                    className="hero-instance__item hero-instance__item--action"
                    onClick={() => {
                      setInstanceOpen(false);
                      setView('instances');
                    }}
                  >
                    <Plus size={15} />
                    <span className="hero-instance__meta">
                      <span className="hero-instance__name">Create or manage instances</span>
                    </span>
                  </button>
                </div>
              ) : null}
            </div>

            {instance && !PROVISIONED.has(instance.loader.type) && instance.loader.type !== 'vanilla' ? (
              <div className="hero-instance__warn">
                <TriangleAlert size={13} />
                <span>
                  {instance.loader.type} is not installed at launch yet — this instance starts as
                  vanilla and its mods are ignored.
                </span>
                <button
                  className="text-btn"
                  onClick={() => {
                    setView('instances');
                  }}
                >
                  <Settings2 size={12} /> Edit
                </button>
              </div>
            ) : null}

            {busy && launch.progress ? (
              <div className="hero__progress">
                <div className="hero__progress-head">
                  <span>{launch.progress.label}</span>
                  <span>{progressPct}%</span>
                </div>
                <div className="hero__progress-track">
                  <div
                    className="hero__progress-fill"
                    style={{ width: `${Math.max(2, progressPct ?? 0)}%` }}
                  />
                </div>
              </div>
            ) : null}

            <div className={`hero__status hero__status--${statusKind}`}>
              <span
                className={`dot dot--${statusKind === 'error' ? 'red' : running ? 'green' : 'blue'}`}
              />
              <span className="hero__status-text">{statusText}</span>
              {running ? (
                <button className="text-btn text-btn--danger" onClick={() => void stopLaunch()}>
                  <CircleStop size={14} /> Stop
                </button>
              ) : null}
            </div>

            {errored ? (
              <div className={`crash${logOpen ? ' crash--open' : ''}`}>
                <button
                  className="crash__head"
                  onClick={() => setLogOpen((v) => !v)}
                  aria-expanded={logOpen}
                >
                  <TriangleAlert size={14} />
                  <span className="crash__title">
                    {launch.exitCode !== null
                      ? `Launch failed (exit code ${launch.exitCode})`
                      : 'Launch failed'}
                  </span>
                  <ChevronDown size={15} className="crash__chev" />
                </button>

                {logOpen ? (
                  <div className="crash__body">
                    {launch.error ? <p className="crash__reason">{launch.error}</p> : null}
                    <pre className="crash__log">{previewText.trim() || 'No output was captured.'}</pre>
                    <div className="crash__actions">
                      <button
                        className="btn btn--ghost btn--small"
                        onClick={() => void api.launch.openLog()}
                      >
                        <FileText size={13} /> Open latest-launch.log
                      </button>
                      <button
                        className="btn btn--ghost btn--small"
                        onClick={() => {
                          void navigator.clipboard
                            ?.writeText(previewText)
                            .then(() => notify('success', 'Log copied to clipboard'))
                            .catch(() => notify('error', 'Could not copy the log.'));
                        }}
                      >
                        <Copy size={13} /> Copy
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {!active ? (
              <button className="hero__cta" onClick={() => setView('accounts')}>
                <UserPlus size={15} /> Add an account to play
              </button>
            ) : instances.length === 0 ? (
              <button className="hero__cta" onClick={() => setView('instances')}>
                <Boxes size={15} /> Create your first instance
              </button>
            ) : null}
          </div>
        </div>
      </section>

      <section className="strip" aria-label="Featured servers">
        {SERVERS.map((server) => (
          <button
            key={server.id}
            className={`strip__tile strip__tile--${server.hue}`}
            title={server.name}
            aria-label={server.name}
            onClick={() => notify('info', `${server.name} quick-join is coming soon.`)}
          >
            <span className="strip__glyph">{server.glyph}</span>
          </button>
        ))}
      </section>

      <section className="news">
        <h2 className="news__title">Recent News</h2>
        <div className="news__grid">
          {NEWS.map((item) => {
            const Icon = item.icon;
            return (
              <article key={item.id} className="news-card">
                <div className={`news-card__art news-card__art--${item.art}`}>
                  <Icon size={34} strokeWidth={1.6} />
                  <span className="news-card__tag">{item.tag}</span>
                </div>
                <div className="news-card__body">
                  <h3 className="news-card__title">{item.title}</h3>
                  <p className="news-card__text">{item.text}</p>
                  <div className="news-card__foot">
                    <span className="news-card__by">
                      Posted by <strong>Flame Team</strong>
                    </span>
                    <button className="btn btn--primary btn--small" onClick={() => setView(item.view)}>
                      {item.cta}
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
    </DropTarget>
  );
}
