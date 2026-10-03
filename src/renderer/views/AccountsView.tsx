import { useState } from 'react';
import { Check, Loader2, LogOut, MonitorSmartphone, Plus, Trash2, Users } from 'lucide-react';
import { Avatar } from '../components/Avatar';
import { useLauncher } from '../state/store';

export function AccountsView() {
  const accounts = useLauncher((s) => s.accounts);
  const activeAccountId = useLauncher((s) => s.activeAccountId);
  const selectAccount = useLauncher((s) => s.selectAccount);
  const removeAccount = useLauncher((s) => s.removeAccount);
  const addOffline = useLauncher((s) => s.addOffline);
  const beginMicrosoft = useLauncher((s) => s.beginMicrosoft);
  const cancelMicrosoft = useLauncher((s) => s.cancelMicrosoft);
  const authError = useLauncher((s) => s.authError);
  const authStatus = useLauncher((s) => s.authStatus);
  const authBusy = useLauncher((s) => s.authBusy);
  const clearAuthError = useLauncher((s) => s.clearAuthError);
  const notify = useLauncher((s) => s.notify);

  const [offlineName, setOfflineName] = useState('');
  const [offlineError, setOfflineError] = useState<string | null>(null);

  const submitOffline = async (e: React.FormEvent) => {
    e.preventDefault();
    setOfflineError(null);
    try {
      await addOffline(offlineName);
      setOfflineName('');
    } catch (err) {
      setOfflineError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="view view--scroll">
      <header className="view__head">
        <h1 className="view__title">Accounts</h1>
        <p className="view__sub">
          Sign in with Microsoft for online play, or add an offline profile for singleplayer and
          offline servers.
        </p>
      </header>

      {authBusy ? (
        <div className="alert alert--info" role="status">
          <span className="alert__body">
            <Loader2 size={15} className="spin" />
            <span>{authStatus ?? 'Signing in…'}</span>
          </span>
          <button className="text-btn" onClick={cancelMicrosoft}>
            Cancel
          </button>
        </div>
      ) : null}

      {authError && !authBusy ? (
        <div className="alert alert--error" role="alert">
          <span className="alert__body">{authError}</span>
          <button className="text-btn" onClick={clearAuthError}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="accounts-grid">
        <section className="card">
          <div className="card__head">
            <h2>Add account</h2>
            <span className="card__hint">Recommended: Microsoft</span>
          </div>

          <button
            className="btn btn--primary btn--block"
            onClick={beginMicrosoft}
            disabled={authBusy}
          >
            {authBusy ? <Loader2 size={16} className="spin" /> : <MonitorSmartphone size={16} />}
            Sign in with Microsoft
          </button>

          <div className="or-divider"><span>or</span></div>

          <form className="offline-form" onSubmit={submitOffline}>
            <label className="field__label" htmlFor="offline-name">
              Offline username
            </label>
            <div className="offline-form__row">
              <input
                id="offline-name"
                className="input"
                value={offlineName}
                onChange={(e) => setOfflineName(e.target.value)}
                placeholder="e.g. Steve_99"
                maxLength={16}
                autoComplete="off"
              />
              <button className="btn btn--ghost" type="submit">
                <Plus size={16} /> Add
              </button>
            </div>
            {offlineError ? <p className="field__error">{offlineError}</p> : null}
          </form>

          <p className="hint">
            A Microsoft window pops up to finish signing in. Offline profiles cannot join
            online-mode servers and do not carry your real skin into multiplayer.
          </p>
        </section>

        <section className="card">
          <div className="card__head">
            <h2>Your profiles</h2>
            <span className="card__hint">
              {accounts.length} {accounts.length === 1 ? 'account' : 'accounts'}
            </span>
          </div>

          {accounts.length === 0 ? (
            <div className="empty">
              <Users size={22} />
              <p>No accounts yet. Add one to start playing.</p>
            </div>
          ) : (
            <ul className="account-list">
              {accounts.map((acc) => {
                const isActive = acc.id === activeAccountId;
                return (
                  <li key={acc.id} className={`account-card${isActive ? ' account-card--active' : ''}`}>
                    <Avatar account={acc} size={46} glow={isActive} />
                    <div className="account-card__meta">
                      <span className="account-card__name">
                        {acc.username}
                        {isActive ? <span className="badge badge--active">Active</span> : null}
                      </span>
                      <span className="account-card__sub">
                        <span className={`badge badge--${acc.type}`}>
                          {acc.type === 'microsoft' ? 'Microsoft' : 'Offline'}
                        </span>
                        <span className="account-card__id">{acc.uuid.slice(0, 13)}…</span>
                      </span>
                    </div>

                    <div className="account-card__actions">
                      {!isActive ? (
                        <button className="btn btn--small" onClick={() => void selectAccount(acc.id)}>
                          <Check size={14} /> Use
                        </button>
                      ) : null}
                      <button
                        className="icon-btn"
                        title={acc.type === 'microsoft' ? 'Sign out' : 'Remove profile'}
                        onClick={() => {
                          void removeAccount(acc.id);
                          notify(
                            'info',
                            acc.type === 'microsoft'
                              ? `Signed out ${acc.username}`
                              : `Removed ${acc.username}`,
                          );
                        }}
                      >
                        {acc.type === 'microsoft' ? <LogOut size={15} /> : <Trash2 size={15} />}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
