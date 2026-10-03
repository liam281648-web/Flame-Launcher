import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronUp, Search } from 'lucide-react';
import { CHANNEL_LABEL, filterVersions, useLauncher } from '../state/store';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'release', label: 'Releases' },
  { id: 'snapshot', label: 'Snapshots' },
  { id: 'installed', label: 'Installed' },
] as const;

export function VersionMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const versions = useLauncher((s) => s.versions);
  const loading = useLauncher((s) => s.versionsLoading);
  const error = useLauncher((s) => s.versionsError);
  const filter = useLauncher((s) => s.channelFilter);
  const setFilter = useLauncher((s) => s.setChannelFilter);
  const selected = useLauncher((s) => s.selectedVersionId);
  const selectVersion = useLauncher((s) => s.selectVersion);
  const refreshVersions = useLauncher((s) => s.refreshVersions);

  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onClose]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return filterVersions(versions, filter)
      .filter((v) => (q ? v.id.toLowerCase().includes(q) : true))
      .slice(0, 400);
  }, [versions, filter, query]);

  if (!open) return null;

  return (
    <div className="version-menu" ref={ref}>
      <div className="version-menu__search">
        <Search size={14} />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search versions…"
        />
        <button
          className="version-menu__refresh"
          onClick={() => void refreshVersions(true)}
          title="Refresh from Mojang"
        >
          <ChevronUp size={13} className={loading ? 'spin' : ''} />
        </button>
      </div>

      <div className="version-menu__tabs">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={`chip${filter === f.id ? ' chip--active' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="version-menu__list">
        {error ? (
          <div className="version-menu__note">
            {error}
            <button className="text-btn" onClick={() => void refreshVersions(true)}>
              Retry
            </button>
          </div>
        ) : loading && versions.length === 0 ? (
          <div className="version-menu__note">Loading versions…</div>
        ) : visible.length === 0 ? (
          <div className="version-menu__note">No versions match “{query}”.</div>
        ) : (
          visible.map((v) => (
            <button
              key={v.id}
              className={`version-row${v.id === selected ? ' version-row--active' : ''}`}
              onClick={() => {
                selectVersion(v.id);
                onClose();
              }}
            >
              <span className={`version-row__dot version-row__dot--${v.channel}`} />
              <span className="version-row__id">{v.id}</span>
              <span className="version-row__meta">
                {v.installed ? <span className="badge badge--installed">Installed</span> : null}
                <span className="version-row__channel">{CHANNEL_LABEL[v.channel]}</span>
              </span>
              {v.id === selected ? <Check size={14} className="version-row__check" /> : null}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
