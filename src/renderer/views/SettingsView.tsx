import { useEffect, useState } from 'react';
import {
  Check,
  CloudDownload,
  Cpu,
  ExternalLink,
  FolderOpen,
  Gamepad2,
  Info,
  RefreshCw,
  Save,
  ShieldCheck,
} from 'lucide-react';
import type { Settings } from '@shared/types';
import { useLauncher } from '../state/store';

const JAVA_CHOICES = [8, 17, 21];

export function SettingsView() {
  const settings = useLauncher((s) => s.settings);
  const saveSettings = useLauncher((s) => s.saveSettings);
  const javaInfo = useLauncher((s) => s.javaInfo);
  const detectJava = useLauncher((s) => s.detectJava);
  const installJava = useLauncher((s) => s.installJava);
  const javaInstall = useLauncher((s) => s.javaInstall);
  const javaInstalling = useLauncher((s) => s.javaInstalling);
  const javaRuntimes = useLauncher((s) => s.javaRuntimes);
  const notify = useLauncher((s) => s.notify);

  const [draft, setDraft] = useState<Settings | null>(settings);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings) {
      setDraft(settings);
      setDirty(false);
    }
  }, [settings]);

  if (!draft) return null;

  const update = (patch: Partial<Settings>) => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
  };

  const persist = async () => {
    if (draft.maxMemMb < draft.minMemMb) {
      notify('error', 'Maximum memory must be greater than or equal to minimum memory.');
      return;
    }
    setSaving(true);
    try {
      await saveSettings(draft);
      setDirty(false);
      notify('success', 'Settings saved');
    } finally {
      setSaving(false);
    }
  };

  const pickFolder = async (apply: (dir: string) => void) => {
    const dir = await window.flame?.app.pickFolder();
    if (dir) apply(dir);
  };

  const javaLabel = javaInfo
    ? `Java ${javaInfo.version} detected`
    : 'No Java runtime detected';

  const installPct =
    javaInstall && javaInstall.total > 0
      ? Math.round((javaInstall.current / javaInstall.total) * 100)
      : 0;

  return (
    <div className="view view--scroll">
      <header className="view__head view__head--row">
        <div>
          <h1 className="view__title">Settings</h1>
          <p className="view__sub">Tune the launcher and the runtime used to start the game.</p>
        </div>
        <button className="btn btn--primary" onClick={() => void persist()} disabled={!dirty || saving}>
          {saving ? <RefreshCw size={15} className="spin" /> : <Save size={15} />}
          {dirty ? 'Save changes' : 'Saved'}
        </button>
      </header>

      <div className="settings-grid">
        <section className="card">
          <div className="card__head">
            <h2><Cpu size={16} /> Java runtime</h2>
            <span className={`badge ${javaInfo ? 'badge--ok' : 'badge--warn'}`}>{javaLabel}</span>
          </div>

          <label className="field__label" htmlFor="java-path">Java executable or JDK folder</label>
          <div className="input-row">
            <input
              id="java-path"
              className="input"
              value={draft.javaPath}
              placeholder="Auto-detect"
              onChange={(e) => update({ javaPath: e.target.value })}
            />
            <button
              className="btn btn--ghost"
              onClick={() => void pickFolder((dir) => update({ javaPath: dir }))}
            >
              <FolderOpen size={15} /> Browse
            </button>
            <button className="btn btn--ghost" onClick={() => void detectJava()}>
              <RefreshCw size={15} /> Detect
            </button>
          </div>
          {javaInfo ? (
            <p className="hint hint--path">{javaInfo.path}</p>
          ) : (
            <p className="hint">
              No Java found — Flame can download one for you. Install a runtime below, or launch
              and it will be installed automatically.
            </p>
          )}

          <div className="java-install">
            <div className="java-install__head">
              <span className="field__label java-install__label">Auto-installed runtimes</span>
              <button className="text-btn" onClick={() => void detectJava()}>
                <RefreshCw size={13} /> Rescan
              </button>
            </div>

            <div className="java-install__row">
              {JAVA_CHOICES.map((major) => {
                const installedHere = javaRuntimes.some((r) => r.major === major);
                return (
                  <button
                    key={major}
                    className={`java-chip${installedHere ? ' java-chip--active' : ''}`}
                    disabled={javaInstalling}
                    onClick={() => void installJava(major)}
                    title={
                      installedHere
                        ? `Java ${major} installed`
                        : `Download and install Temurin ${major} automatically`
                    }
                  >
                    {installedHere ? <Check size={13} /> : <CloudDownload size={13} />}
                    Java {major}
                  </button>
                );
              })}
            </div>

            {javaRuntimes.length > 0 ? (
              <p className="hint hint--path">
                Installed by Flame:{' '}
                {javaRuntimes.map((r) => `Java ${r.major} (${r.path})`).join(' · ')}
              </p>
            ) : null}

            {javaInstall && javaInstall.phase !== 'done' ? (
              <div className="java-install__status">
                <div className="java-install__status-head">
                  <span className={javaInstall.phase === 'error' ? 'java-install__error' : ''}>
                    {javaInstall.phase === 'error'
                      ? (javaInstall.error ?? 'Install failed')
                      : javaInstall.label}
                  </span>
                  {javaInstall.phase === 'downloading' ? <span>{installPct}%</span> : null}
                </div>
                {javaInstall.phase !== 'error' ? (
                  <div className="java-install__track">
                    <div
                      className="java-install__fill"
                      style={{
                        width: `${javaInstall.phase === 'extracting' ? 100 : Math.max(2, installPct)}%`,
                      }}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="field-split">
            <div>
              <label className="field__label" htmlFor="min-mem">Min memory (MB)</label>
              <input
                id="min-mem"
                className="input"
                type="number"
                min={512}
                step={256}
                value={draft.minMemMb}
                onChange={(e) => update({ minMemMb: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="field__label" htmlFor="max-mem">Max memory (MB)</label>
              <input
                id="max-mem"
                className="input"
                type="number"
                min={1024}
                step={256}
                value={draft.maxMemMb}
                onChange={(e) => update({ maxMemMb: Number(e.target.value) })}
              />
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card__head">
            <h2><Gamepad2 size={16} /> Storage</h2>
          </div>

          <label className="field__label" htmlFor="game-dir">Shared data folder</label>
          <div className="input-row">
            <input
              id="game-dir"
              className="input"
              value={draft.gameDir}
              placeholder="Default: %APPDATA%\Flame"
              onChange={(e) => update({ gameDir: e.target.value })}
            />
            <button
              className="btn btn--ghost"
              onClick={() => void pickFolder((dir) => update({ gameDir: dir }))}
            >
              <FolderOpen size={15} /> Browse
            </button>
            <button className="btn btn--ghost" onClick={() => window.flame?.app.openGameDir()}>
              <ExternalLink size={15} /> Open
            </button>
          </div>
          <small className="muted">
            Holds the shared Minecraft downloads (<code>versions/</code>, <code>libraries/</code>,{' '}
            <code>assets/</code>) plus <code>instances/</code>. Each instance has its own{' '}
            <code>mods/</code>, <code>worlds/</code>, <code>options.txt</code> and installed packs.
          </small>
          <div className="input-row">
            <button
              className="btn btn--ghost"
              onClick={() => window.flame?.instances.openRoot()}
            >
              <ExternalLink size={15} /> Open instances folder
            </button>
          </div>

          <label className="toggle">
            <input
              type="checkbox"
              checked={draft.closeOnLaunch}
              onChange={(e) => update({ closeOnLaunch: e.target.checked })}
            />
            <span className="toggle__track" aria-hidden="true"><span className="toggle__thumb" /></span>
            <span className="toggle__text">
              Close the launcher when the game starts
              <small>Hides the window once Minecraft is running.</small>
            </span>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={draft.menuPack}
              onChange={(e) => update({ menuPack: e.target.checked })}
            />
            <span className="toggle__track" aria-hidden="true"><span className="toggle__thumb" /></span>
            <span className="toggle__text">
              Flame menu theme
              <small>Installs a resource pack on launch: FLAME logo, dark buttons, blurred panorama.</small>
            </span>
          </label>
        </section>

        <section className="card">
          <div className="card__head">
            <h2><ShieldCheck size={16} /> Microsoft sign-in</h2>
            <span className="card__hint">Browser popup</span>
          </div>

          <p className="hint">
            Signing in opens a Microsoft window where you approve access yourself. Flame never sees
            your password, and your session is stored encrypted on this device. Manage linked
            apps at&nbsp;
            <button
              className="text-btn"
              onClick={() => window.flame?.app.openExternal('https://account.microsoft.com/security')}
            >
              account.microsoft.com <ExternalLink size={12} />
            </button>
          </p>
        </section>

        <section className="card">
          <div className="card__head">
            <h2><Info size={16} /> Advanced</h2>
          </div>

          <label className="field__label" htmlFor="jvm-args">Extra JVM arguments</label>
          <input
            id="jvm-args"
            className="input"
            value={draft.extraJvmArgs}
            placeholder="-XX:+UseG1GC -XX:MaxGCPauseMillis=40"
            onChange={(e) => update({ extraJvmArgs: e.target.value })}
            spellCheck={false}
          />
          <p className="hint">Appended after the launcher's own JVM flags. Separate with spaces.</p>
        </section>
      </div>

      <div className="about">
        <span>Flame Client v0.1.0</span>
        <span className="about__dot" />
        <span>Electron · React</span>
        <span className="about__dot" />
        <button
          className="text-btn"
          onClick={() => window.flame?.app.openExternal('https://www.minecraft.net/download')}
        >
          Minecraft download <ExternalLink size={12} />
        </button>
        <span className="about__spacer" />
        <span className="about__saved">
          {dirty ? 'Unsaved changes' : <><Check size={13} /> All changes saved</>}
        </span>
      </div>
    </div>
  );
}
