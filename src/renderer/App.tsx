import { useEffect } from 'react';
import { Footer } from './components/Footer';
import { Toast } from './components/Toast';
import { TopBar } from './components/TopBar';
import { UpdateBanner } from './components/UpdateBanner';
import { PlayView } from './views/PlayView';
import { PacksView } from './views/PacksView';
import { InstancesView } from './views/InstancesView';
import { AccountsView } from './views/AccountsView';
import { SettingsView } from './views/SettingsView';
import { useLauncher } from './state/store';

export default function App() {
  const ready = useLauncher((s) => s.ready);
  const view = useLauncher((s) => s.view);
  const init = useLauncher((s) => s.init);
  const phase = useLauncher((s) => s.launch.phase);

  useEffect(() => {
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready) {
    return (
      <div className="boot">
        <div className="boot__mark">
          <svg viewBox="0 0 24 24" width="34" height="34">
            <path
              d="M13.4 2.2c.5 3.1-.7 4.6-2.2 6.1C9.4 10 7.3 11.7 7.3 15a6.7 6.7 0 0 0 13.4 0c0-3.4-1.8-5.4-3.4-7.2-.4 1.2-1.2 2-2.2 2.3.6-2.7-.3-5.7-1.7-7.9Z"
              fill="currentColor"
            />
          </svg>
        </div>
        <div className="boot__bar"><span /></div>
        <span className="boot__text">Starting Flame…</span>
      </div>
    );
  }

  return (
    <div className={`app${phase === 'running' ? ' app--ingame' : ''}`}>
      <TopBar />
      <main className="content">
        {view === 'play' ? <PlayView /> : null}
        {view === 'packs' ? <PacksView /> : null}
        {view === 'instances' ? <InstancesView /> : null}
        {view === 'accounts' ? <AccountsView /> : null}
        {view === 'settings' ? <SettingsView /> : null}
      </main>
      <Footer />
      <Toast />
      <UpdateBanner />
    </div>
  );
}
