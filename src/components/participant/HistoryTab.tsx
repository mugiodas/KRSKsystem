import type { MyMatchView } from '../../api/types';
import { clockTime } from '../../lib/time';
import { Volume2 } from 'lucide-react';

/** Today's record for one player: enough to answer "how am I doing". */
export function HistoryTab({ view }: { view: MyMatchView }) {
  const { today, rank, history } = view;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div className="m-stats">
        <div className="m-stat"><b>{today.played}</b><span>今日の試合</span></div>
        <div className="m-stat"><b>{today.wins}</b><span>勝ち</span></div>
        <div className="m-stat"><b>{rank ? `${rank.rank}位` : '—'}</b><span>{rank ? `${rank.of}人中 / 勝率 ${Math.round(rank.winRate * 100)}%` : '順位は結果確定後'}</span></div>
      </div>
      <article className="m-card">
        <header>本日対戦した相手（{history.length}試合）</header>
        <section>
          {history.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--ink-500)' }}>まだ結果が確定した試合はありません。結果が入力されるとここに残ります。</p>
          ) : (
            <div className="m-list">
              {history.map((row) => (
                <div key={row.matchId} className={`m-item ${row.won ? 'won' : 'lost'}`}>
                  <div>
                    <div className="t">{row.won ? '勝ち' : '負け'} vs {row.opponentName}</div>
                    <div className="s">{row.courtName ?? '—'} ・ {clockTime(row.endTime)} ・ {row.phase === 'LEAGUE' ? 'リーグ' : '希望'}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="score" style={{ color: row.won ? 'var(--ok)' : 'var(--ink-700)' }}>{row.scoreMine}-{row.scoreOpponent}</div>
                    <div className="s">得点 {today.pointsFor}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </article>
      {view.otherMatches.length > 0 ? (
        <article className="m-card">
          <header>他の予定</header>
          <section>
            <div className="m-list">
              {view.otherMatches.map((row) => (
                <div key={row.matchId} className="m-item">
                  <div>
                    <div className="t">vs {row.opponentName}</div>
                    <div className="s">{row.courtName ?? 'コート未定'} ・ {clockTime(row.scheduledTime)} ・ {row.status === 'WAITING' ? '待機' : row.status === 'CALLED' ? '呼出' : '割当済'}</div>
                  </div>
                  <Volume2 size={15} style={{ color: 'var(--ink-500)' }} />
                </div>
              ))}
            </div>
          </section>
        </article>
      ) : null}
    </div>
  );
}
