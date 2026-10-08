import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { DashboardAlert } from '../../lib/alerts';

const ICON = { URGENT: AlertTriangle, IMPORTANT: AlertTriangle, INFO: Info } as const;

/**
 * ALERT is the first thing the operator reads, so it sits above everything
 * and each card jumps straight to the match or court it is about.
 */
export function AlertRail({ alerts, onJump, loading }: { alerts: DashboardAlert[]; onJump: (alert: DashboardAlert) => void; loading: boolean }) {
  return (
    <section className="panel" id="alerts" style={{ padding: 0, background: 'transparent', border: 0, boxShadow: 'none' }}>
      <div className="alerts">
        {alerts.length === 0 ? (
          <div className="alerts-empty">
            {loading
              ? '大会状況を読み込んでいます…'
              : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--ok)' }}><CheckCircle2 size={13} /> 対応が必要な問題はありません。コートを監視しています。</span>}
          </div>
        ) : alerts.map((alert) => {
          const Icon = ICON[alert.severity];
          const clickable = Boolean(alert.matchId || alert.courtId || (alert.participantIds && alert.participantIds.length > 0));
          return (
            <button
              key={alert.id} type="button" className={`alert-card ${alert.severity}`}
              disabled={!clickable} onClick={() => onJump(alert)}
              title={clickable ? 'クリックして該当箇所へ移動します' : undefined}
            >
              <h3 style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <Icon size={13} style={{ flex: '0 0 auto' }} />
                {alert.title}
                <span className="spacer" style={{ flex: '1 1 auto' }} />
                <span className={`chip ${alert.severity === 'URGENT' ? 'urgent' : alert.severity === 'IMPORTANT' ? 'warn' : 'blue'}`}>
                  {alert.severity === 'URGENT' ? '要即時対応' : alert.severity === 'IMPORTANT' ? '要確認' : '情報'}
                </span>
              </h3>
              <p>{alert.detail}</p>
            </button>
          );
        })}
      </div>
    </section>
  );
}
