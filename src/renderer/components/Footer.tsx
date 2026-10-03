import { AtSign, Globe, MessageCircle, Send } from 'lucide-react';
import { useLauncher } from '../state/store';

const SOCIALS = [
  { id: 'site', label: 'Website', icon: Globe },
  { id: 'community', label: 'Community server', icon: MessageCircle },
  { id: 'news', label: 'News & updates', icon: Send },
  { id: 'support', label: 'Support', icon: AtSign },
];

export function Footer() {
  const notify = useLauncher((s) => s.notify);

  return (
    <footer className="footer">
      <div className="footer__group footer__group--left">
        <span className="footer__mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="13" height="13">
            <path
              d="M13.4 2.2c.5 3.1-.7 4.6-2.2 6.1C9.4 10 7.3 11.7 7.3 15a6.7 6.7 0 0 0 13.4 0c0-3.4-1.8-5.4-3.4-7.2-.4 1.2-1.2 2-2.2 2.3.6-2.7-.3-5.7-1.7-7.9Z"
              fill="currentColor"
            />
          </svg>
        </span>
        <span>© Flame Client 2026</span>
        <span className="footer__dot" />
        <span className="footer__version">v0.1.0</span>
      </div>

      <div className="footer__group footer__group--social">
        {SOCIALS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className="footer__social"
              title={item.label}
              aria-label={item.label}
              onClick={() => notify('info', `${item.label} links are coming soon.`)}
            >
              <Icon size={15} strokeWidth={1.8} />
            </button>
          );
        })}
      </div>

      <div className="footer__group footer__group--right">
        <span className="footer__legal">Not affiliated with Mojang, AB.</span>
      </div>
    </footer>
  );
}
