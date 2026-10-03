import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { InstanceInfo, InstanceLoaderType, LoaderAvailability } from '@shared/types';
import { LOADER_LABEL, PACK_KINDS } from '@shared/types';
import { Modal } from '../components/Modal';
import { useLauncher } from '../state/store';

const LOADER_ORDER: InstanceLoaderType[] = ['vanilla', 'fabric', 'forge', 'neoforge', 'quilt'];

interface Draft {
  name: string;
  gameVersion: string;
  loaderType: InstanceLoaderType;
  loaderVersion: string;
  icon: string;
}

/**
 * Create / edit dialog.
 *
 * The loader list is driven by what the main process reports as provisionable
 * rather than a hardcoded list, so a loader that Flame can only record (Forge,
 * NeoForge, Quilt today) is visibly labelled instead of silently doing nothing.
 */
export function InstanceDialog({
  editing,
  onClose,
}: {
  /** Present when editing; the create path starts from a blank draft. */
  editing: InstanceInfo | null;
  onClose: () => void;
}) {
  const versions = useLauncher((s) => s.versions);
  const versionsLoading = useLauncher((s) => s.versionsLoading);
  const selectedVersionId = useLauncher((s) => s.selectedVersionId);
  const createInstance = useLauncher((s) => s.createInstance);
  const updateInstance = useLauncher((s) => s.updateInstance);
  const instancesBusy = useLauncher((s) => s.instancesBusy);
  const loadLoaderInfo = useLauncher((s) => s.loadLoaderInfo);
  const loaderInfo = useLauncher((s) => s.loaderInfo);
  const loaderInfoKey = useLauncher((s) => s.loaderInfoKey);
  const refreshVersions = useLauncher((s) => s.refreshVersions);

  const [draft, setDraft] = useState<Draft>(() => ({
    name: editing?.name ?? '',
    gameVersion: editing?.gameVersion ?? selectedVersionId ?? versions[0]?.id ?? '',
    loaderType: editing?.loader.type ?? 'vanilla',
    loaderVersion: editing?.loader.version ?? '',
    icon: editing?.icon ?? '',
  }));
  const [error, setError] = useState<string | null>(null);

  const infoKey = `${draft.loaderType}@${draft.gameVersion}`;
  // `loaderInfo` is fetched per (loader, version) pair; ignore a stale answer.
  const info: LoaderAvailability | null = loaderInfoKey === infoKey ? loaderInfo : null;

  useEffect(() => {
    void loadLoaderInfo(draft.loaderType, draft.gameVersion);
  }, [draft.loaderType, draft.gameVersion, loadLoaderInfo]);

  // Only offers versions; a snapshot has no loader builds and confuses the dialog.
  const versionOptions = useMemo(
    () => versions.filter((v) => v.channel === 'release' || v.channel === 'snapshot'),
    [versions],
  );

  const submit = async () => {
    setError(null);
    const name = draft.name.trim();
    if (!name) {
      setError('Give the instance a name.');
      return;
    }
    if (!draft.gameVersion.trim()) {
      setError('Choose a Minecraft version.');
      return;
    }
    const loader =
      draft.loaderType === 'vanilla'
        ? { type: 'vanilla' as const, version: '' }
        : { type: draft.loaderType, version: draft.loaderVersion.trim() };

    try {
      if (editing) {
        await updateInstance(editing.id, {
          name,
          gameVersion: draft.gameVersion.trim(),
          loader,
          icon: draft.icon.trim() || null,
        });
      } else {
        await createInstance({
          name,
          gameVersion: draft.gameVersion.trim(),
          loader,
          icon: draft.icon.trim() || null,
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const loaderVersions = info?.versions ?? [];

  return (
    <Modal
      title={editing ? 'Edit instance' : 'Create instance'}
      subtitle={
        editing
          ? 'Changing the version keeps your mods, worlds and options in this instance.'
          : 'A separate folder for mods, worlds, resource packs and shaders.'
      }
      onClose={onClose}
      width={520}
    >
      <div className="form">
        <label className="field">
          <span className="field__label">Name</span>
          <input
            className="input"
            value={draft.name}
            placeholder="My 1.20.1 pack"
            maxLength={64}
            autoFocus
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>

        <label className="field">
          <span className="field__label">Minecraft version</span>
          <div className="field__row">
            <select
              className="input"
              value={draft.gameVersion}
              onChange={(e) => setDraft({ ...draft, gameVersion: e.target.value })}
            >
              {versionOptions.length === 0 ? (
                <option value={draft.gameVersion}>{draft.gameVersion || 'Loading…'}</option>
              ) : null}
              {versionOptions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.id} {v.channel === 'snapshot' ? '(snapshot)' : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={versionsLoading}
              onClick={() => void refreshVersions(true)}
            >
              {versionsLoading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </label>

        <div className="field">
          <span className="field__label">Mod loader</span>
          <div className="loader-grid">
            {LOADER_ORDER.map((type) => (
              <button
                key={type}
                type="button"
                className={`loader-chip${draft.loaderType === type ? ' loader-chip--active' : ''}`}
                onClick={() =>
                  setDraft({
                    ...draft,
                    loaderType: type,
                    loaderVersion: type === 'vanilla' ? '' : draft.loaderVersion,
                  })
                }
              >
                {LOADER_LABEL[type]}
              </button>
            ))}
          </div>
        </div>

        {draft.loaderType !== 'vanilla' ? (
          <label className="field">
            <span className="field__label">
              {LOADER_LABEL[draft.loaderType]} version{' '}
              <span className="field__hint">optional</span>
            </span>
            {loaderVersions.length > 0 ? (
              <select
                className="input"
                value={draft.loaderVersion}
                onChange={(e) => setDraft({ ...draft, loaderVersion: e.target.value })}
              >
                <option value="">Latest available</option>
                {loaderVersions.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input"
                value={draft.loaderVersion}
                placeholder="Latest available"
                onChange={(e) => setDraft({ ...draft, loaderVersion: e.target.value })}
              />
            )}
          </label>
        ) : null}

        {info && !info.supported ? (
          <div className="notice notice--warn">
            <AlertTriangle size={15} />
            <span>{info.note}</span>
          </div>
        ) : info?.note ? (
          <div className="notice">{info.note}</div>
        ) : null}

        <label className="field">
          <span className="field__label">
            Icon URL <span className="field__hint">optional</span>
          </span>
          <input
            className="input"
            value={draft.icon}
            placeholder="https://…/icon.png"
            onChange={(e) => setDraft({ ...draft, icon: e.target.value })}
          />
        </label>

        <div className="notice notice--muted">
          Flame creates <code>instances/&lt;id&gt;/</code> holding {PACK_KINDS.map(
            (k) => `${k === 'mod' ? 'mods' : k === 'shader' ? 'shaderpacks' : 'resourcepacks'}/`,
          ).join(' ')}{' '}
          plus <code>saves/</code> and <code>config/</code>. The Minecraft
          download itself is shared between instances, so a second one costs no
          extra bandwidth.
        </div>

        {error ? <div className="notice notice--error">{error}</div> : null}

        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={instancesBusy}
            onClick={() => void submit()}
          >
            {instancesBusy ? 'Working…' : editing ? 'Save changes' : 'Create instance'}
          </button>
        </div>
      </div>
    </Modal>
  );
}