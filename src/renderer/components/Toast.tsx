import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { useLauncher } from '../state/store';

export function Toast() {
  const toast = useLauncher((s) => s.toast);
  const dismiss = useLauncher((s) => s.dismissToast);

  if (!toast) return null;

  const Icon = toast.kind === 'error' ? AlertTriangle : toast.kind === 'success' ? CheckCircle2 : Info;

  return (
    <div className={`toast toast--${toast.kind}`} role="status">
      <Icon size={16} />
      <span className="toast__text">{toast.text}</span>
      <button className="toast__close" onClick={dismiss} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}
