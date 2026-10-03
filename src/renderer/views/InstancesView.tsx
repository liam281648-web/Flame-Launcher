import { useMemo, useState } from 'react';
import { FolderOpen, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import type { InstanceInfo } from '@shared/types';
import { LOADER_LABEL } from '@shared/types';
import { InstanceGlyph, instanceSubtitle } from '../components/InstanceMenu';
import { InstanceDialog } from '../components/InstanceDialog';
import { DropTarget } from '../components/DropTarget';
import { Modal } from '../components/Modal';
import { useLauncher } from '../state/store';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function formatWhen(epoch: number | null): string {
  if (!epoch) return 'Never played';
  const delta = Date.now() - epoch;
  if (delta < 60_000) return 'Just now';
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)} h ago`;
  if (delta < 7 * 86_400_000) return `${Math.round(delta / 86_400_000)} d ago`;
  return new Date(epoch).toLocaleDateString();
}

/** Which instances may be deleted, and why not when they may not. */
function deleteBlockReason(
  instance: InstanceInfo,
  runningInstanceId: string | null,
  instanceCount: number,
): string | null {
  if (runningInstanceId === instance.id) return 'Running — stop the game first';
  if (instanceCount <= 1) return 'The last instance cannot be deleted';
  return null;
}

export function InstancesView() {
  const instances = useLauncher((s) => s.instances);
  const activeInstanceId = useLauncher((s) => s.activeInstanceId);
  const runningInstanceId = useLauncher((s) => s.runningInstanceId);
  const sizes = useLauncher((s) => s.instanceSizes);
  const sizesLoading = useLauncher((s) => s.sizesLoading);
  const selectInstance = useLauncher((s) => s.selectInstance);
  const deleteInstance = useLauncher((s) => s.deleteInstance);
  const startLaunch = useLauncher((s) => s.startLaunch);
  const setView = useLauncher((s) => s.setView);
  const launchPhase = useLauncher((s) => s.launch.phase);
  const importDroppedFiles = useLauncher((s) => s.importDroppedFiles);

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<InstanceInfo | null>(null);
  const [confirm, setConfirm] = useState<InstanceInfo | null>(null);

  const busy = launchPhase !== 'idle' && launchPhase !== 'error';
  const sorted = useMemo(
    // Most recently played first; an instance that never ran sorts last.
    () => [...instances].sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0)),
    [instances],
  );

  // Dropping on empty space means the active instance, which is the same target
  // the Pack tab would use. Each card overrides this with its own id.
  const activeName =
    sorted.find((i) => i.id === activeInstanceId)?.name ??
    sorted.find((i) => i.id === activeInstanceId)?.id ??
    'the active instance';

  return (
    <DropTarget
      variant="full"
      instanceName={activeName}
      onFiles={(files) => void importDroppedFiles(files)}
    >
    <div className="view">
      <header className="view__head">
        <div>
          <h1 className="view__title">Instances</h1>
          <p className="view__sub">
            Each instance keeps its own mods, worlds, resource packs and shaders. Minecraft
            downloads are shared, so a new instance costs no extra bandwidth.
          </p>
        </div>
        <div className="view__actions">
          <button className="btn btn--ghost" onClick={() => window.flame?.instances.openRoot()}>
            <FolderOpen size={15} /> Open instances folder
          </button>
          <button className="btn btn--primary" onClick={() => setCreating(true)}>
            <Plus size={15} /> Create instance
          </button>
        </div>
      </header>

      {sorted.length === 0 ? (
        <div className="empty">
          <p>No instances yet.</p>
          <button className="btn btn--primary" onClick={() => setCreating(true)}>
            Create your first instance
          </button>
        </div>
      ) : (
        <div className="instance-grid">
          {sorted.map((instance) => {
            const size = sizes[instance.id];
            const isActive = instance.id === activeInstanceId;
            const isRunning = instance.id === runningInstanceId;
            const blockReason = deleteBlockReason(instance, runningInstanceId, sorted.length);
            return (
              <DropTarget
                key={instance.id}
                instanceName={instance.name}
                onFiles={(files) => void importDroppedFiles(files, instance.id)}
              >
              <article
                className={`instance-card${isActive ? ' instance-card--active' : ''}${
                  isRunning ? ' instance-card--running' : ''
                }`}
              >
                <header className="instance-card__head">
                  <InstanceGlyph instance={instance} size={44} />
                  <div className="instance-card__titles">
                    <h2 className="instance-card__name">{instance.name}</h2>
                    <span className="instance-card__sub">{instanceSubtitle(instance)}</span>
                  </div>
                  {isActive ? <span className="tag tag--accent">Active</span> : null}
                  {isRunning ? <span className="tag tag--live">Running</span> : null}
                </header>

                <dl className="instance-card__meta">
                  <div>
                    <dt>Loader</dt>
                    <dd>{LOADER_LABEL[instance.loader.type]}</dd>
                  </div>
                  <div>
                    <dt>Size</dt>
                    <dd>
                      {size ? formatBytes(size.bytes) : sizesLoading ? 'Measuring…' : '—'}
                      {size ? <span className="muted"> · {size.files} files</span> : null}
                    </dd>
                  </div>
                  <div>
                    <dt>Last played</dt>
                    <dd>{formatWhen(instance.lastPlayed)}</dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>{new Date(instance.created).toLocaleDateString()}</dd>
                  </div>
                </dl>

                <footer className="instance-card__actions">
                  <button
                    className="btn btn--primary btn--sm"
                    disabled={busy || isRunning}
                    onClick={() => void startLaunch(instance.id)}
                  >
                    <Play size={14} /> Play
                  </button>
                  <button
                    className="btn btn--ghost btn--sm"
                    disabled={isActive && busy}
                    onClick={() => {
                      if (!isActive) void selectInstance(instance.id);
                      setView('packs');
                    }}
                  >
                    Mods &amp; packs
                  </button>
                  <span className="spacer" />
                  <button
                    className="icon-btn"
                    title="Open folder"
                    aria-label={`Open ${instance.name} folder`}
                    onClick={() => window.flame?.instances.open(instance.id)}
                  >
                    <FolderOpen size={15} />
                  </button>
                  <button
                    className="icon-btn"
                    title="Edit"
                    aria-label={`Edit ${instance.name}`}
                    onClick={() => setEditing(instance)}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    className="icon-btn icon-btn--danger"
                    title={blockReason ?? 'Delete instance'}
                    aria-label={`Delete ${instance.name}`}
                    disabled={blockReason !== null}
                    onClick={() => setConfirm(instance)}
                  >
                    <Trash2 size={15} />
                  </button>
                </footer>
              </article>
              </DropTarget>
            );
          })}
        </div>
      )}

      {creating ? <InstanceDialog editing={null} onClose={() => setCreating(false)} /> : null}
      {editing ? <InstanceDialog editing={editing} onClose={() => setEditing(null)} /> : null}
      {confirm ? (
        <Modal
          title={`Delete "${confirm.name}"?`}
          subtitle="This permanently removes the instance folder and everything in it."
          onClose={() => setConfirm(null)}
          width={440}
        >
          <div className="form">
            <p className="muted">
              Worlds, mods, configuration and installed packs in this instance are deleted.
              Nothing else is touched: shared Minecraft downloads stay in place.
            </p>
            <div className="modal__actions">
              <button className="btn btn--ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn btn--danger"
                onClick={() => {
                  // The store action owns the confirm toast, so no second call
                  // here: deleting twice would race on the same id.
                  const target = confirm;
                  setConfirm(null);
                  void deleteInstance(target.id);
                }}
              >
                Delete permanently
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
    </DropTarget>
  );
}