import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

/* ---------------- modal ---------------- */
export function Modal({ title, subtitle, onClose, children, footer, size }: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'narrow' | 'wide';
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`modal${size === 'narrow' ? ' narrow' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          {subtitle ? <span className="hint" style={{ fontSize: 11, color: 'var(--ink-500)' }}>{subtitle}</span> : null}
          <span className="spacer" />
          <button className="btn sm" onClick={onClose} aria-label="閉じる"><X size={13} /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

/* ---------------- toasts ---------------- */
interface Toast { id: number; message: string; tone: 'info' | 'error' }
interface ToastApi { push: (message: string, tone?: 'info' | 'error') => void }
const ToastContext = createContext<ToastApi>({ push: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: 'info' | 'error' = 'info') => {
    const id = Date.now() + Math.random();
    setItems((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), tone === 'error' ? 6500 : 3800);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {items.length > 0 ? (
        <div className="toast-stack">
          {items.map((item) => <div key={item.id} className={`toast${item.tone === 'error' ? ' error' : ''}`}>{item.message}</div>)}
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

/* ---------------- small pieces ---------------- */
export const STATUS_LABEL: Record<string, string> = {
  WAITING: '待機',
  CALLED: '呼出',
  COURT_ASSIGNED: 'コート割当',
  PLAYING: '試合中',
  RESULT_PENDING: '結果待ち',
  COMPLETED: '終了',
  CANCELLED: '取消',
  DISPUTED: '係争',
  NO_SHOW: 'ノーショー',
};

export const SEVERITY_LABEL: Record<string, string> = {
  DRAFT: '下書き', READY: '準備完了', RUNNING: '開催中', PAUSED: '一時停止', COMPLETED: '終了', CANCELLED: '中止',
};

export const COURT_LABEL: Record<string, string> = {
  AVAILABLE: '空き', RESERVED: '予約', CALLING: '呼出中', PLAYING: '稼働中',
  RESULT_PENDING: '結果入力', BLOCKED: '使用不可', MAINTENANCE: '整備中',
};

export function statusTone(status: string): string {
  if (status === 'PLAYING') return 'blue';
  if (status === 'RESULT_PENDING') return 'warn';
  if (status === 'COURT_ASSIGNED') return 'ok';
  if (status === 'CALLED') return 'ok';
  if (status === 'WAITING') return '';
  if (status === 'NO_SHOW' || status === 'DISPUTED') return 'urgent';
  return '';
}

export function Chip({ tone, children, dot }: { tone?: string; children: ReactNode; dot?: boolean }) {
  return <span className={`chip${tone ? ` ${tone}` : ''}${dot ? ' dot' : ''}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ScoreStepper({ value, onChange, disabled }: { value: number; onChange: (next: number) => void; disabled?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <button type="button" className="btn sm" disabled={disabled || value <= 0} onClick={() => onChange(Math.max(0, value - 1))}>−</button>
      <input
        className="num" type="number" min={0} max={99} value={value} disabled={disabled}
        style={{ width: 48, height: 26, textAlign: 'center', border: '1px solid var(--line-strong)', borderRadius: 4, font: 'inherit', fontFamily: 'var(--mono)' }}
        onChange={(event) => onChange(Math.min(99, Math.max(0, Number(event.target.value) || 0)))}
      />
      <button type="button" className="btn sm" disabled={disabled || value >= 99} onClick={() => onChange(value + 1)}>＋</button>
    </div>
  );
}
