import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, ChevronRight, LayoutDashboard, LogOut, MapPin, Smartphone, Users } from 'lucide-react';
import { api } from '../api/client';
import type { EventSummary } from '../api/types';
import { useSession } from '../auth/session';
import { Chip, Empty, SEVERITY_LABEL } from '../components/ui';
import { clockTime } from '../lib/time';

/** Event picker. Staff land here, participants are redirected to the mobile board. */
export function EventSelectPage() {
  const { session, signOut, isStaff } = useSession();
  const navigate = useNavigate();
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (session && !isStaff) { navigate('/m', { replace: true }); return; }
    api.events().then(setEvents).catch((caught) => setError(caught instanceof Error ? caught.message : '取得失敗'));
  }, [session, isStaff, navigate]);

  if (!isStaff && session) return <div className="empty">参加者画面へ移動しています…</div>;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><b>KRSK SYSTEM</b><span>EVENT SELECT</span></div>
        <span className="spacer" />
        <span style={{ fontSize: 11, opacity: 0.8 }}>{session?.displayName}（{session?.role}）</span>
        <button className="btn ghost" onClick={() => void signOut().then(() => navigate('/login'))}><LogOut size={13} />ログアウト</button>
      </header>
      <div className="shell-body">
        <div style={{ maxWidth: 860, margin: '0 auto', padding: '22px 16px', display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <h1 style={{ fontSize: 17 }}>開催する大会を選んでください</h1>
            <span className="hint" style={{ color: 'var(--ink-500)', fontSize: 12 }}>運営中は大会画面のまま監視されます</span>
          </div>
          {error ? <div className="notice error">{error}</div> : null}
          {events === null ? <Empty>読み込み中…</Empty> : events.length === 0 ? <Empty>大会が作成されていません。</Empty> : events.map((event) => {
            const utilization = event.matchCount > 0 ? Math.round((event.completedMatchCount / event.matchCount) * 100) : 0;
            return (
              <button
                key={event.eventId} type="button"
                onClick={() => navigate(`/events/${event.eventId}`)}
                style={{
                  display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, textAlign: 'left', cursor: 'pointer',
                  padding: '12px 14px', border: '1px solid var(--line)', borderRadius: 10, background: '#fff', boxShadow: 'var(--shadow)',
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <b style={{ fontSize: 15 }}>{event.eventName}</b>
                    <Chip tone={event.status === 'RUNNING' ? 'ok' : event.status === 'PAUSED' ? 'warn' : ''} dot>{SEVERITY_LABEL[event.status] ?? event.status}</Chip>
                    <Chip>{event.eventMode === 'LEAGUE_REQUEST' ? 'リーグ→希望制' : event.eventMode === 'REQUEST_ONLY' ? '希望制のみ' : 'リーグ→大会→希望制'}</Chip>
                  </div>
                  <div style={{ display: 'flex', gap: 14, marginTop: 6, fontSize: 11.5, color: 'var(--ink-500)', flexWrap: 'wrap' }}>
                    <span><CalendarDays size={12} style={{ verticalAlign: -2 }} /> {event.eventDate} {clockTime(event.startTime)}–{clockTime(event.endTime)}</span>
                    <span><MapPin size={12} style={{ verticalAlign: -2 }} /> {event.venue}</span>
                    <span><Users size={12} style={{ verticalAlign: -2 }} /> {event.participantCount}/{event.maxParticipants}名・{event.courtCount}面</span>
                    <span>完了 {event.completedMatchCount}/{event.matchCount}試合（{utilization}%）</span>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--navy-800)', fontWeight: 700, fontSize: 12 }}>
                  <LayoutDashboard size={14} />運用ボード <ChevronRight size={14} />
                </div>
              </button>
            );
          })}
          <div className="notice info" style={{ marginTop: 6 }}>
            <Smartphone size={13} />
            <span>参加者アカウント（{session?.role === 'PARTICIPANT' ? '現在のアカウント' : 'p01@demo.local / demo'}）では、この代わりに次試合だけのスマートフォン画面が表示されます。</span>
            <button className="btn sm" onClick={() => navigate('/m')}>参加者画面を見る</button>
          </div>
        </div>
      </div>
    </div>
  );
}
