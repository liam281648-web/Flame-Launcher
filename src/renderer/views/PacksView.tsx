import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Blocks,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Info,
  Layers,
  Loader2,
  Package,
  Search,
  Sparkles,
  Trash2,
  TriangleAlert,
  Wand2,
} from 'lucide-react';
import type { InstalledPack, PackKind, PackProject, ShaderEngineState } from '@shared/types';
import { LOADER_LABEL, PACK_FOLDER, PACK_LABEL, SHADER_ENGINE_NOTE } from '@shared/types';
import { humanBytes } from '../lib/format';
import { useLauncher } from '../state/store';

const KINDS: Array<{ id: PackKind; label: string; icon: typeof Layers; folder: string }> = [
  { id: 'shader', label: PACK_LABEL.shader, icon: Sparkles, folder: PACK_FOLDER.shader },
  { id: 'resourcepack', label: PACK_LABEL.resourcepack, icon: Package, folder: PACK_FOLDER.resourcepack },
  { id: 'mod', label: PACK_LABEL.mod, icon: Blocks, folder: PACK_FOLDER.mod },
];

/** Search placeholder per tab; `mods` needs its own noun to read naturally. */
const SEARCH_NOUN: Record<PackKind, string> = {
  shader: 'shaders',
  resourcepack: 'resource packs',
  mod: 'mods',
};

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export function PacksView() {
  const kind = useLauncher((s) => s.packKind);
  const query = useLauncher((s) => s.packQuery);
  const packPage = useLauncher((s) => s.packPage);
  const totalHits = useLauncher((s) => s.packTotalHits);
  const offset = useLauncher((s) => s.packOffset);
  const limit = useLauncher((s) => s.packLimit);
  const loading = useLauncher((s) => s.packLoading);
  const error = useLauncher((s) => s.packError);
  const versionExcluded = useLauncher((s) => s.packsVersionExcluded);
  const installed = useLauncher((s) => s.packsInstalled);
  const downloads = useLauncher((s) => s.packDownloads);
  const instances = useLauncher((s) => s.instances);
  const activeInstanceId = useLauncher((s) => s.activeInstanceId);
  const instance = instances.find((i) => i.id === activeInstanceId) ?? null;
  const shaderEngine = useLauncher((s) => s.shaders);

  const setPackKind = useLauncher((s) => s.setPackKind);
  const setPackQuery = useLauncher((s) => s.setPackQuery);
  const searchPacks = useLauncher((s) => s.searchPacks);
  const goToPackPage = useLauncher((s) => s.goToPackPage);
  const installPack = useLauncher((s) => s.installPack);
  const removePack = useLauncher((s) => s.removePack);
  const togglePack = useLauncher((s) => s.togglePack);
  const refreshInstalled = useLauncher((s) => s.refreshInstalledPacks);

  const [search, setSearch] = useState(query);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void searchPacks({ reset: true });
    void refreshInstalled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  // Refetch when the target instance changes: the installed list and the search
  // filters (version and loader) are both instance-scoped.
  useEffect(() => {
    if (!activeInstanceId) return;
    void refreshInstalled();
    if (packPage.length > 0) void searchPacks({ reset: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeInstanceId]);

  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current);
  }, []);

  const submit = (value: string) => {
    setSearch(value);
    setPackQuery(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void searchPacks({ reset: true }), 350);
  };

  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(totalHits / limit));

  const installedProjectIds = useMemo(
    () => new Set(installed.map((p) => p.projectId).filter((id): id is string => Boolean(id))),
    [installed],
  );

  return (
    <div className="view view--scroll packs">
      <header className="view__head view__head--row">
        <div>
          <h1 className="view__title">Packs &amp; Mods</h1>
          <p className="view__sub">
            Browse Modrinth and install straight into{' '}
            <strong>{instance ? instance.name : 'the active instance'}</strong>
            {instance ? ` — filtered to Minecraft ${instance.gameVersion}` : ''}.
          </p>
        </div>
        <button
          className="btn btn--ghost"
          onClick={() => {
            if (activeInstanceId) window.flame?.instances.open(activeInstanceId);
          }}
        >
          <ExternalLink size={15} /> Open instance folder
        </button>
      </header>

      <div className="packs__tabs" role="tablist" aria-label="Pack type">
        {KINDS.map((k) => {
          const Icon = k.icon;
          return (
            <button
              key={k.id}
              role="tab"
              aria-selected={kind === k.id}
              title={k.id === 'shader' ? SHADER_ENGINE_NOTE : undefined}
              className={`packs__tab${kind === k.id ? ' packs__tab--active' : ''}`}
              onClick={() => setPackKind(k.id)}
            >
              <Icon size={15} />
              {k.label}
              {k.id === 'shader' ? (
                <Info size={13} className="packs__tab-info" aria-hidden="true" />
              ) : null}
              <span className="packs__tab-folder">{k.folder}/</span>
            </button>
          );
        })}
      </div>

      {kind === 'shader' ? (
        <p className="packs__note" title={SHADER_ENGINE_NOTE}>
          <Info size={14} />
          <span>{SHADER_ENGINE_NOTE}</span>
        </p>
      ) : null}

      {kind === 'mod' && instance ? (
        <p className="packs__note">
          <Info size={14} />
          <span>
            Results are filtered to {LOADER_LABEL[instance.loader.type]} mods for{' '}
            {instance.gameVersion}. Disabling a mod renames it to{' '}
            <code>.jar.disabled</code>, which every loader skips.
          </span>
        </p>
      ) : null}

      {kind === 'shader' ? <EngineStatus engine={shaderEngine} /> : null}

      <div className="packs__bar">
        <div className="packs__search">
          <Search size={15} />
          <input
            className="input"
            value={search}
            placeholder={`Search ${SEARCH_NOUN[kind]}…`}
            onChange={(e) => submit(e.target.value)}
            spellCheck={false}
          />
        </div>
        <span className="packs__count">
          {loading && packPage.length === 0 ? 'Searching…' : `${compact(totalHits)} results`}
        </span>
      </div>

      {versionExcluded ? (
        <p className="hint">
          Snapshots aren&apos;t indexed on Modrinth, so every release is shown instead.
        </p>
      ) : null}

      {error ? (
        <div className="alert alert--error">
          <TriangleAlert size={15} />
          <div className="alert__body">
            Couldn&apos;t reach Modrinth: {error}
          </div>
        </div>
      ) : null}

      {installed.length > 0 ? (
        <section className="card">
          <div className="card__head">
            <h2>
              <Layers size={16} /> Installed {SEARCH_NOUN[kind]}
            </h2>
            <span className="card__hint">
              {installed.length} in {instance ? `instances/${instance.id}/` : ''}
              {PACK_FOLDER[kind]}/
            </span>
          </div>
          <ul className="packs__installed">
            {installed.map((pack) => (
              <li key={pack.fileName} className="packs__installed-row">
                <PackThumb pack={pack} />
                <span className="packs__installed-name" title={pack.path}>
                  <span className="packs__installed-title">{pack.title}</span>
                  <span className="packs__installed-meta">
                    {[pack.version, pack.mcVersion, humanBytes(pack.size)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span className="packs__installed-size">{humanBytes(pack.size)}</span>
                <label
                  className="toggle toggle--compact"
                  title={
                    kind === 'mod'
                      ? pack.enabled
                        ? 'Enabled — click to add .disabled'
                        : 'Disabled — click to enable'
                      : pack.enabled
                        ? 'Active'
                        : 'Inactive'
                  }
                >
                  <input
                    type="checkbox"
                    checked={pack.enabled}
                    aria-label={`${pack.enabled ? 'Disable' : 'Enable'} ${pack.title}`}
                    onChange={(e) => void togglePack(pack.fileName, e.target.checked)}
                  />
                  <span className="toggle__track" aria-hidden="true">
                    <span className="toggle__thumb" />
                  </span>
                </label>
                <button
                  className="icon-btn icon-btn--danger"
                  title={`Delete ${pack.title}`}
                  aria-label={`Delete ${pack.title}`}
                  onClick={() => void removePack(pack.fileName)}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {packPage.length === 0 && !loading && !error ? (
        <div className="empty">
          <Package size={22} />
          <p>No {SEARCH_NOUN[kind]} matched that search.</p>
        </div>
      ) : null}

      <div className="packs__grid">
        {packPage.map((project) => (
          <PackCard
            key={project.id}
            project={project}
            progress={downloads[project.id]}
            installed={installedProjectIds.has(project.id)}
            onInstall={() => void installPack(project)}
          />
        ))}
      </div>

      {loading && packPage.length > 0 ? (
        <div className="packs__more">
          <Loader2 size={15} className="spin" /> Loading…
        </div>
      ) : null}

      {totalHits > limit ? (
        <div className="packs__pager">
          <button
            className="btn btn--ghost"
            disabled={offset === 0 || loading}
            onClick={() => goToPackPage(Math.max(0, offset - limit))}
          >
            <ChevronLeft size={15} /> Previous
          </button>
          <span className="packs__page">
            Page {page} of {pages}
          </span>
          <button
            className="btn btn--ghost"
            disabled={offset + limit >= totalHits || loading}
            onClick={() => goToPackPage(offset + limit)}
          >
            Next <ChevronRight size={15} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function PackThumb({ pack }: { pack: InstalledPack }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="packs__installed-thumb">
      {pack.iconUrl && !failed ? (
        <img src={pack.iconUrl} alt="" draggable={false} onError={() => setFailed(true)} />
      ) : pack.kind === 'shader' ? (
        <Sparkles size={15} />
      ) : pack.kind === 'mod' ? (
        <Blocks size={15} />
      ) : (
        <Package size={15} />
      )}
    </span>
  );
}

/**
 * Mirrors the launcher-side provisioning state. The engine is assembled during
 * launch rather than at install time, so this starts empty and fills in as soon
 * as a launch has run.
 */
function EngineStatus({ engine }: { engine: ShaderEngineState }) {
  if (engine.phase === 'idle') return null;

  const tone =
    engine.phase === 'ready'
      ? 'packs__engine--ready'
      : engine.phase === 'error'
        ? 'packs__engine--error'
        : 'packs__engine--busy';

  return (
    <div className={`packs__engine ${tone}`}>
      {engine.phase === 'provisioning' ? (
        <Loader2 size={15} className="spin" />
      ) : engine.phase === 'error' ? (
        <TriangleAlert size={15} />
      ) : (
        <Wand2 size={15} />
      )}
      <div className="packs__engine-body">
        <strong>
          {engine.phase === 'ready'
            ? `Shader engine (${engine.label})`
            : engine.phase === 'error'
              ? 'Shader engine unavailable'
              : 'Shader engine'}
        </strong>
        <span>{engine.phase === 'error' ? (engine.error ?? engine.message) : engine.message}</span>
      </div>
    </div>
  );
}

function PackCard({
  project,
  progress,
  installed,
  onInstall,
}: {
  project: PackProject;
  progress?: { phase: string; current: number; total: number; error: string | null };
  installed: boolean;
  onInstall: () => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const busy = progress?.phase === 'downloading';
  const failed = progress?.phase === 'error';
  const pct = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  return (
    <article className="pack-card">
      <div className="pack-card__thumb">
        {project.iconUrl && !imgFailed ? (
          <img
            src={project.iconUrl}
            alt=""
            draggable={false}
            onError={() => setImgFailed(true)}
          />
        ) : (
          <Package size={22} />
        )}
      </div>

      <div className="pack-card__body">
        <h3 className="pack-card__title" title={project.title}>
          {project.title}
        </h3>
        <p className="pack-card__desc">{project.description}</p>
        <div className="pack-card__meta">
          <span>{project.author}</span>
          <span className="about__dot" />
          <span>{compact(project.downloads)} downloads</span>
        </div>

        {busy ? (
          <div className="pack-card__progress">
            <div className="pack-card__track">
              <div className="pack-card__fill" style={{ width: `${Math.max(3, pct)}%` }} />
            </div>
            <span className="pack-card__pct">{pct}%</span>
          </div>
        ) : failed ? (
          <p className="pack-card__error">{progress?.error ?? 'Install failed'}</p>
        ) : null}

        <div className="pack-card__actions">
          <button className="btn btn--primary btn--small" disabled={busy} onClick={onInstall}>
            {busy ? (
              <Loader2 size={14} className="spin" />
            ) : installed ? (
              <Check size={14} />
            ) : (
              <Download size={14} />
            )}
            {busy ? 'Installing…' : 'Install'}
          </button>
          <button
            className="icon-btn"
            title={`Open ${project.title} on Modrinth`}
            aria-label={`Open ${project.title} on Modrinth`}
            onClick={() => window.flame?.app.openExternal(project.url)}
          >
            <ExternalLink size={15} />
          </button>
        </div>
      </div>
    </article>
  );
}