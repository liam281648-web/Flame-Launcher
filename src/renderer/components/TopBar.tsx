import { useEffect, useRef, useState, type ComponentType } from 'react';
import {
  Check,
  ChevronDown,
  Gamepad2,
  Layers,
  LogOut,
  Minus,
  Settings2,
  Square,
  UserRound,
  X,
} from 'lucide-react';
import type { ViewId } from '@shared/types';
import { Avatar } from './Avatar';
import { InstanceMenu } from './InstanceMenu';
import { useLauncher } from '../state/store';

const TABS: Array<{ id: ViewId; label: string; icon: ComponentType<{ size?: number; strokeWidth?: number }> }> = [
  { id: 'play', label: 'Home', icon: Gamepad2 },
  { id: 'instances', label: 'Instances', icon: BoxesIcon },
  { id: 'packs', label: 'Packs & Mods', icon: Layers },
  { id: 'settings', label: 'Settings', icon: Settings2 },
  { id: 'accounts', label: 'Accounts', icon: UserRound },
];

/** Inline so the tab row keeps one icon dependency less than an extra import. */
function BoxesIcon({ size = 16, strokeWidth = 1.9 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8.5 12 4l9 4.5-9 4.5-9-4.5Z" />
      <path d="M3 12.5 12 17l9-4.5" />
      <path d="M3 16.5 12 21l9-4.5" />
    </svg>
  );
}

export function TopBar() {
  const accounts = useLauncher((s) => s.accounts);
  const activeAccountId = useLauncher((s) => s.activeAccountId);
  const selectAccount = useLauncher((s) => s.selectAccount);
  const removeAccount = useLauncher((s) => s.removeAccount);
  const setView = useLauncher((s) => s.setView);
  const view = useLauncher((s) => s.view);
  const maximized = useLauncher((s) => s.maximized);
  const versionsError = useLauncher((s) => s.versionsError);
  const notify = useLauncher((s) => s.notify);
  const phase = useLauncher((s) => s.launch.phase);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const active = accounts.find((a) => a.id === activeAccountId) ?? null;
  const online = !versionsError;

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  return (
    <header className="topbar">
      <div className="brand" data-drag="true">
        <div className="brand__mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="17" height="17">
            <path
              d="M13.4 2.2c.5 3.1-.7 4.6-2.2 6.1C9.4 10 7.3 11.7 7.3 15a6.7 6.7 0 0 0 13.4 0c0-3.4-1.8-5.4-3.4-7.2-.4 1.2-1.2 2-2.2 2.3.6-2.7-.3-5.7-1.7-7.9Z"
              fill="currentColor"
            />
          </svg>
        </div>
        <span className="brand__name">Flame Client</span>
        <span className="brand__status" title={online ? 'Services online' : 'Mojang unreachable'}>
          <span className={`dot dot--${online ? 'green' : 'red'}`} />
        </span>
      </div>

      <nav className="nav" aria-label="Primary">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const activeTab = view === tab.id;
          return (
            <button
              key={tab.id}
              className={`nav__tab${activeTab ? ' nav__tab--active' : ''}`}
              onClick={() => setView(tab.id)}
              title={tab.label}
              aria-current={activeTab ? 'page' : undefined}
            >
              <Icon size={16} strokeWidth={1.9} />
              <span className="nav__label">{tab.label}</span>
              {tab.id === 'play' && phase === 'running' ? (
                <span className="nav__pip" />
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="topbar__right">
        <InstanceMenu />

        <div className="account-pill" ref={menuRef}>
          <button
            className="account-pill__btn"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
          >
            {active ? (
              <Avatar account={active} size={24} />
            ) : (
              <span className="account-pill__ghost">
                <UserRound size={14} />
              </span>
            )}
            <span className="account-pill__name">{active ? active.username : 'No account'}</span>
            <ChevronDown size={14} className={menuOpen ? 'chevron chevron--up' : 'chevron'} />
          </button>

          {menuOpen ? (
            <div className="account-menu">
              <div className="account-menu__label">Switch account</div>
              {accounts.length === 0 ? (
                <div className="account-menu__empty">No accounts yet</div>
              ) : (
                accounts.slice(0, 6).map((acc) => (
                  <button
                    key={acc.id}
                    className={`account-menu__item${acc.id === activeAccountId ? ' account-menu__item--active' : ''}`}
                    onClick={() => {
                      void selectAccount(acc.id);
                      setMenuOpen(false);
                    }}
                  >
                    <Avatar account={acc} size={26} />
                    <span className="account-menu__meta">
                      <span className="account-menu__username">{acc.username}</span>
                      <span className="account-menu__type">
                        {acc.type === 'microsoft' ? 'Microsoft' : 'Offline'} ·{' '}
                        <span className="dot dot--green dot--inline" /> online
                      </span>
                    </span>
                    {acc.id === activeAccountId ? <Check size={14} /> : null}
                  </button>
                ))
              )}

              <div className="account-menu__divider" />
              <button
                className="account-menu__action"
                onClick={() => {
                  setView('accounts');
                  setMenuOpen(false);
                }}
              >
                <UserRound size={14} /> Manage accounts
              </button>
<button
            className="account-menu__action"
            onClick={() => {
              setView('instances');
              setMenuOpen(false);
            }}
          >
            <BoxesIcon size={14} /> Manage instances
          </button>
          <button
            className="account-menu__action"
            onClick={() => {
              setView('settings');
              setMenuOpen(false);
            }}
          >
            <Settings2 size={14} /> Settings
          </button>
              {active ? (
                <button
                  className="account-menu__action account-menu__action--danger"
                  onClick={() => {
                    void removeAccount(active.id);
                    notify('info', `Signed out of ${active.username}`);
                    setMenuOpen(false);
                  }}
                >
                  <LogOut size={14} /> Sign out
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="win-controls">
          <button className="win-btn" onClick={() => window.flame?.window.minimize()} aria-label="Minimize">
            <Minus size={15} />
          </button>
          <button
            className="win-btn"
            onClick={() => window.flame?.window.toggleMaximize()}
            aria-label={maximized ? 'Restore' : 'Maximize'}
          >
            {maximized ? <CopyIcon /> : <Square size={12} />}
          </button>
          <button
            className="win-btn win-btn--close"
            onClick={() => window.flame?.window.close()}
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>
      </div>
    </header>
  );
}

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="1.5" y="3.5" width="7" height="7" stroke="currentColor" strokeWidth="1.1" />
      <path d="M4 3.5V2.5h6.5V9H9.5" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}
