import { Megaphone } from 'lucide-react';
import type { MyMatchView } from '../../api/types';
import { clockTime, formatDateTime, minutesBetween, parseIso } from '../../lib/time';

/** Announcements plus the few event facts a player needs, no operator density. */
export function InfoTab({ view }: { view: MyMatchView }) {
  const endMs = parseIso(view.event.endTime);
  const left = endMs === null ? null : Math.round(minutesBetween(Date.now(), endMs));
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <article className="m-card">
        <header><Megaphone size={13} /> お知らせ</header>
        <section>
          {view.announcements.length === 0 ? <p style={{ fontSize: 13, color: 'var(--ink-500)' }}>運営からの連絡はまだありません。</p> : (
            <div className="m-list">
              {view.announcements.map((item, index) => (
                <div key={index} className={`m-notice ${item.severity}`}>
                  <b style={{ display: 'block', fontSize: 14 }}>{item.title}</b>
                  <div style={{ marginTop: 3 }}>{item.body}</div>
                  <div style={{ marginTop: 5, fontSize: 10.5, opacity: 0.75 }}>{formatDateTime(item.createdAt)}{item.actorName ? ` ・ ${item.actorName}` : ''}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      </article>
      <article className="m-card">
        <header>大会情報</header>
        <section>
          <div className="m-list" style={{ gap: 6 }}>
            <div className="m-item"><div><div className="t" style={{ fontSize: 14 }}>{view.event.eventName}</div><div className="s">{view.event.status === 'RUNNING' ? '開催中' : view.event.status === 'PAUSED' ? '一時停止' : view.event.status}</div></div></div>
            <div className="m-item">
              <div><div className="t">終了予定</div><div className="s">{clockTime(view.event.endTime)}{left !== null ? ` ・ 残り約 ${Math.max(0, left)}分` : ''}</div></div>
              <span className="score" style={{ fontSize: 13 }}>{view.waiting.slotMinutes}分/枠</span>
            </div>
            <div className="m-item">
              <div><div className="t">あなたの状態</div><div className="s">{view.participant.checkedIn ? 'チェックイン済' : '未チェックイン — 運営へお知らせください'}</div></div>
              <span className={`m-badge ${view.participant.checkedIn ? 'ok' : 'warn'}`}>{view.participant.className ?? 'クラス未定'}</span>
            </div>
          </div>
          <p style={{ marginTop: 10, fontSize: 11.5, color: 'var(--ink-500)', lineHeight: 1.65 }}>
            待機時間と試合数はマッチングエンジンが毎回計算し直しています。順番は固定ではなく、休憩時間・対戦実績・希望を踏まえて更新されます。
          </p>
        </section>
      </article>
    </div>
  );
}
