import { useState } from 'react';
import { Download, Sparkles, TriangleAlert } from 'lucide-react';
import { useLauncher } from '../state/store';

/**
 * Non-intrusive update notice.
 *
 * Only ever appears for a real published update on an installed build: main
 * gates every phase on `app.isPackaged` and reports `supported: false`
 * otherwise, and this component returns null for that. That is why there is no
 * "check for updates" spinner in dev — nothing could succeed there.
 */
export function UpdateBanner() {
  const updater = useLauncher((s) => s.updater);
  const installUpdate = useLauncher((s) => s.installUpdate);
  const deferUpdate = useLauncher((s) => s.deferUpdate);
  const [notesOpen, setNotesOpen] = useState(false);

  if (!updater.supported || updater.deferred) return null;

  const downloading = updater.phase === 'downloading';
  const ready = updater.phase === 'ready';
  const failed = updater.phase === 'error';
  // Nothing to say between checks, or while an update is merely available but
  // still downloading.
  if (updater.phase !== 'downloading' && !ready && !failed) return null;

  const title = failed
    ? 'Update check failed'
    : downloading
      ? `Downloading Flame ${updater.version ?? ''}`.trim()
      : 'A new version of Flame Client is ready to install.';

  const detail = failed
    ? (updater.error ?? 'Check again later.')
    : downloading
      ? `${Math.round(updater.percent)}% — this happens in the background`
      : `Flame ${updater.version ?? ''} — installs when the launcher closes`.trim();

  return (
    <div className="update-banner" role="status">
      <span className="update-banner__icon">
        {failed ? <TriangleAlert size={17} /> : downloading ? <Download size={17} /> : <Sparkles size={17} />}
      </span>

      <div className="update-banner__body">
        <span className="update-banner__title">{title}</span>
        <span className="update-banner__detail">{detail}</span>

        {downloading ? (
          <span className="update-banner__track">
            <span
              className="update-banner__fill"
              style={{ width: `${Math.max(3, updater.percent)}%` }}
            />
          </span>
        ) : null}

        {ready && updater.releaseNotes ? (
          <>
            <button
              className="text-btn"
              onClick={() => setNotesOpen((v) => !v)}
              aria-expanded={notesOpen}
            >
              {notesOpen ? 'Hide notes' : 'What’s new?'}
            </button>
            {notesOpen ? <pre className="update-banner__notes">{updater.releaseNotes}</pre> : null}
          </>
        ) : null}
      </div>

      {ready || failed ? (
        <div className="update-banner__actions">
          <button className="btn btn--ghost btn--small" onClick={() => void deferUpdate()}>
            Later
          </button>
          {ready ? (
            <button className="btn btn--primary btn--small" onClick={() => void installUpdate()}>
              Restart now
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}