import { BellRing, ClipboardCheck, Coffee, Timer } from 'lucide-react';
import type { MyMatchView } from '../../api/types';
import { clockTime, minutesBetween, parseIso } from '../../lib/time';

interface Props {
  view: MyMatchView;
  nowMs: number;
  onEnterResult: (matchId: string) => void;
}

/**
 * The only question on a player's phone is "when do I play, and where?".
 * Everything else on this screen is subordinate to that answer.
 */
export function NextMatchCard({ view, nowMs, onEnterResult }: Props) {
  const next = view.nextMatch;
  const playable = next && (next.status === 'PLAYING' || next.status === 'RESULT_PENDING' || next.status === 'COURT_ASSIGNED');
  const startMs = next ? parseIso(next.startTime ?? next.scheduledTime) : null;
  const remaining = startMs === null ? null : Math.round((startMs - nowMs) / 60_000);
  const bracket = next?.bracket ?? null;

  if (!next) {
    const estimate = view.waiting.estimateMinutes;
    return (
      <article className="m-card hero">
        <header>待機中</header>
        <section>
          {view.waiting.restBlocked ? (
            <div className="m-rest">
              <Coffee size={16} />
              <span>
                休憩中です。あと <b className="num">{Math.ceil(view.waiting.restReadyInMinutes)}</b> 分で再出場できます。
                休憩が終われば待機列 {view.waiting.waitingCount}名 の中に自動で入ります。
              </span>
            </div>
          ) : (
            <>
              <div className="m-hero-court">
                <b>{estimate === null ? '調整中' : `約 ${Math.max(0, Math.round(estimate / view.waiting.slotMinutes) || 1)} 枠`}</b>
                <span>あとお時間で出番が来ます</span>
              </div>
              <div className="m-hero-time">
                現在の待機 {Math.round(view.waiting.minutes)}分 ・ 待機列 {view.waiting.position ?? '—'} / {view.waiting.waitingCount}人 ・ 空きコート {view.waiting.freeCourts}面
              </div>
              <div className="m-countdown">
                <b className="num">{estimate === null ? '—' : `${Math.max(0, Math.round(estimate))}`}</b>
                <span>分後に出場予定（1枠 {view.waiting.slotMinutes}分 × {view.waiting.freeCourts > 0 ? '空きコートあり' : 'コート稼働中'}）</span>
              </div>
            </>
          )}
          <p style={{ marginTop: 10, fontSize: 12, color: 'var(--ink-500)', lineHeight: 1.6 }}>
            対戦相手が決まるとこの画面が大きく変わります。離れていてもわかるように、音声ではなく表示でお知らせします。
          </p>
        </section>
      </article>
    );
  }

  const called = next.status === 'CALLED';
  const tone = called ? 'called' : playable ? 'playing' : '';
  return (
    <article className={`m-card hero ${tone}`}>
      <header>
        {bracket && !called ? <>{bracket.roundLabel}<span className="muted" style={{ fontSize: 11 }}>（全{bracket.rounds}回戦・トーナメント）</span></> : null}
        {called ? <><BellRing size={13} /> コートへ向かってください</>
          : next.status === 'PLAYING' ? '試合中'
            : next.status === 'RESULT_PENDING' ? '結果入力が必要です'
              : next.status === 'COURT_ASSIGNED' ? '次の試合' : '対戦カードが決まりました'}
      </header>
      <section>
        {next.courtName ? (
          <div className="m-hero-court">
            <b>{next.courtName.replace(/[^0-9]/g, '') || next.courtNumber}</b>
            <span>{next.courtName} ・ {bracket ? `トーナメント ${bracket.roundLabel}` : next.phase === 'LEAGUE' ? 'リーグ' : next.phase === 'TOURNAMENT' ? '大会' : '希望対戦'}</span>
          </div>
        ) : (
          <div className="m-hero-court"><b>コート未定</b><span>決まり次第表示されます</span></div>
        )}
        <div className="m-hero-time">
          {next.startTime ? `開始 ${clockTime(next.startTime, true)}` : next.scheduledTime ? `予定 ${clockTime(next.scheduledTime)}` : '時間未定'}
        </div>

        <div className="m-vs">
          <div><div className="who me">あなた<small>{view.participant.club}</small></div></div>
          <div className="vs">VS</div>
          <div><div className="who">{next.opponentName}<small>{next.opponentClub}</small></div></div>
        </div>

        {remaining !== null && !playable ? (
          <div className="m-countdown">
            <b className="num">{remaining >= 0 ? `${remaining}` : `+${Math.abs(remaining)}`}</b>
            <span>{remaining >= 0 ? '分後スタート' : '分 超過'}</span>
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}><Timer size={12} /> 1試合 {view.event.defaultMatchMinutes}分</span>
          </div>
        ) : null}

        {next.status === 'PLAYING' || next.status === 'RESULT_PENDING' ? (
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
            <span className="num" style={{ fontWeight: 800, fontSize: 22 }}>
              {next.isMineSideA ? next.scoreA ?? 0 : next.scoreB ?? 0} - {next.isMineSideA ? next.scoreB ?? 0 : next.scoreA ?? 0}
            </span>
            <span style={{ color: 'var(--ink-500)', fontSize: 11.5 }}>現在スコア（ yours - opponent ）</span>
          </div>
        ) : null}

        <div className="m-actions">
          {playable ? (
            <button className="m-btn primary" onClick={() => onEnterResult(next.matchId)}>
              <ClipboardCheck size={17} />結果を入力
            </button>
          ) : (
            <button className="m-btn" onClick={() => navigator.vibrate?.([120, 60, 120])}>
              <BellRing size={16} />集合音を出す
            </button>
          )}
        </div>
        {next.status === 'WAITING' && !bracket ? (
          <p style={{ marginTop: 8, fontSize: 11.5, color: 'var(--ink-500)' }}>
            コートが空き次第、番号が確定します。待機列 {view.waiting.position ?? '—'} 位です。
          </p>
        ) : null}
        {bracket && bracket.bracketStatus === 'OPEN' ? (
          <p style={{ marginTop: 8, fontSize: 11.5, color: 'var(--ink-500)' }}>
            {bracket.roundLabel === '決勝' ? '勝てば優勝です。' : `勝てば ${bracket.rounds > 2 ? '次のラウンド' : '決勝'}へ進みます。負けたらこの大会の対戦は終了です。`}
          </p>
        ) : null}
      </section>
    </article>
  );
}
