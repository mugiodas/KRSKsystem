import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { ScreenBoard, ScreenCourt } from '../api/types';
import { clockTime, minutesLabel, parseIso, stopwatch, urgencyOf } from '../lib/time';

const POLL_MS = 3_000;
const ROTATE_MS = 10_000;
/** A projector that lost the Wi-Fi should say so, but keep the last board visible. */
const STALE_MS = 20_000;

/**
 * The hall board (`/screen/:eventId?t=...`). It is a separate surface rather than a
 * stripped dashboard: read only, no controls, sized for a projector ten metres away,
 * and driven by the public token endpoint so a TV needs no account.
 */
export function ScreenPage() {
  const params = useParams<{ eventId: string }>();
  const [search] = useSearchParams();
  const eventId = params.eventId ?? '';
  const token = search.get('t') ?? '';
  const [board, setBoard] = useState<ScreenBoard | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [fetchedMs, setFetchedMs] = useState<number | null>(null);
  // Local ticking so the countdown moves between polls without re-fetching.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [classIndex, setClassIndex] = useState(0);
  const offsetRef = useRef(0);

  const load = useCallback(async () => {
    if (!eventId || !token) {
      setError({ code: 'SCREEN_LINK_MISSING', message: '表示用リンク（?t=…）がありません。運営に確認してください。' });
      return;
    }
    try {
      const next = await api.screenBoard(eventId, token);
      offsetRef.current = next.nowMs - Date.now();
      setBoard(next);
      setFetchedMs(Date.now());
      setError(null);
    } catch (caught) {
      // A revoked or mistyped link is not going to fix itself, so back off.
      setError({
        code: caught instanceof ApiError ? caught.code : 'NETWORK',
        message: caught instanceof ApiError ? caught.message : '通信に失敗しました。再接続しています…',
      });
    }
  }, [eventId, token]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => { void load(); }, error && error.code !== 'NETWORK' ? 30_000 : POLL_MS);
    return () => window.clearInterval(interval);
  }, [load, error?.code]);

  useEffect(() => {
    const tick = window.setInterval(() => setNowMs(Date.now() + offsetRef.current), 500);
    const onShow = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onShow);
    return () => { window.clearInterval(tick); document.removeEventListener('visibilitychange', onShow); };
  }, [load]);

  // F starts a kiosk style fullscreen, which is the one thing a TV operator presses.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key.toLowerCase() === 'f' && !event.metaKey && !event.ctrlKey) {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen?.();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const previous = document.title;
    if (board?.eventName) document.title = `${board.eventName} ・ 会場スクリーン`;
    return () => { document.title = previous; };
  }, [board?.eventName]);

  const standings = board?.standings ?? [];
  useEffect(() => {
    if (standings.length < 2) return;
    const rotate = window.setInterval(() => setClassIndex((index) => (index + 1) % standings.length), ROTATE_MS);
    return () => window.clearInterval(rotate);
  }, [standings.length]);

  const stale = fetchedMs !== null && Date.now() - fetchedMs > STALE_MS;
  const liveNow = nowMs;

  if (!board) {
    return (
      <div className="sc">
        <div className="sc-boot">
          {error ? (
            <div className="sc-boot-card">
              <b>会場スクリーンを表示できません</b>
              <span>{error.message}</span>
              <em>{error.code === 'SCREEN_LINK_INVALID' || error.code === 'SCREEN_LINK_MISSING'
                ? 'リンクは運営ダッシュボードの 設定 → 会場スクリーン で発行・更新できます。'
                : 'しばらくすると自動で再試行します。'}</em>
            </div>
          ) : <div className="sc-boot-card"><b>接続しています…</b><span>{clockTime(liveNow, true)}</span></div>}
        </div>
      </div>
    );
  }

  const remaining = Math.max(0, board.remainingMinutes - Math.max(0, Math.round((liveNow - board.nowMs) / 60_000)));
  const tone = urgencyOf(remaining);

  return (
    <div className="sc">
      <header className="sc-head">
        <div className="sc-title">
          <b>{board.eventName}</b>
          <span>{board.venue}{board.eventDate ? ` ・ ${board.eventDate}` : ''}</span>
        </div>
        <div className="sc-phase">
          <b>{phaseLabel(board.phase, board.status)}</b>
          <span>{board.progress.courtsBusy}/{board.progress.courtsTotal} コート稼働 ・ {board.progress.completedMatches}試合完了</span>
        </div>
        <div className={`sc-left is-${tone}`}>
          <span>終了まで</span>
          <b className="num">{minutesLabel(remaining)}</b>
        </div>
        <div className="sc-clock num">{clockTime(liveNow, true)}</div>
      </header>

      <main className="sc-courts" role="status" aria-live="polite">
        {board.courts.map((court) => (
          <CourtTile key={`${court.courtNumber}-${court.match?.playerAName ?? 'free'}`} court={court} nowMs={liveNow} boardMs={board.nowMs} />
        ))}
      </main>

      <aside className="sc-rail">
        <RailBlock title="まもなく">
          {board.upNext.length === 0
            ? <p className="sc-none">ただいま次のカードを調整しています</p>
            : board.upNext.map((row, index) => (
              <div key={`${row.players}-${index}`} className="sc-next">
                <b>{row.players}</b>
                <span>
                  {row.courtName ?? 'コート調整中'}
                  {row.etaMinutes !== null ? ` ・ ${row.etaMinutes <= 0 ? 'ほどなく' : `${row.etaMinutes}分後`}` : ''}
                </span>
              </div>
            ))}
        </RailBlock>

        <RailBlock title="直近の結果">
          {board.results.length === 0
            ? <p className="sc-none">確定した結果はまだありません</p>
            : board.results.map((row, index) => (
              <div key={`${row.winner}-${index}`} className="sc-result">
                <b>{row.winner}</b>
                <span className="num">{row.score}</span>
                <em>{row.loser} ／ {clockTime(row.at)}</em>
              </div>
            ))}
        </RailBlock>

        {board.league ? (
          <RailBlock title="リーグ消化">
            <div className="sc-league">
              <div className="sc-league-bar"><i style={{ width: `${Math.min(100, Math.round(board.league.completionRate * 100))}%` }} /></div>
              <span>
                {board.league.completedMatches}/{board.league.plannedMatches}試合 ・
                {board.league.status === 'ON_TRACK' ? ' 計画どおり'
                  : board.league.status === 'BEHIND' ? ' 計画より遅れ'
                    : board.league.status === 'WONT_FIT' ? ' 時間内に消化困難' : ''}
              </span>
            </div>
          </RailBlock>
        ) : null}

        {standings.length > 0 ? (
          <RailBlock
            title={`順位 ・ ${standings[classIndex]?.className ?? ''}`}
            dots={standings.length > 1 ? { index: classIndex, count: standings.length } : undefined}
          >
            <table className="sc-table">
              <tbody>
                {(standings[classIndex]?.rows ?? []).map((row) => (
                  <tr key={row.rank}>
                    <td className="num rank">{row.rank}</td>
                    <td><b>{row.name}</b></td>
                    <td className="num">{row.wins}勝{Math.max(0, row.played - row.wins)}敗</td>
                    <td className={`num diff${row.pointDifference > 0 ? ' up' : row.pointDifference < 0 ? ' down' : ''}`}>
                      {row.pointDifference > 0 ? '+' : ''}{row.pointDifference}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </RailBlock>
        ) : null}

        {board.brackets.length > 0 ? (
          <RailBlock title="トーナメント">
            {board.brackets.map((row) => (
              <div key={row.className} className="sc-bracket">
                <b>{row.className}</b>
                <span>
                  {row.status === 'COMPLETED' ? `優勝 ${row.champion ?? '—'}`
                    : `${row.roundName ?? `${Math.max(1, Math.ceil(Math.log2(row.size)))}回戦`} ・ ${row.decided}/${row.total}試合終了`}
                </span>
              </div>
            ))}
          </RailBlock>
        ) : null}

        {board.announcements.length > 0 ? (
          <RailBlock title="連絡">
            {board.announcements.map((row, index) => (
              <div key={`${row.title}-${index}`} className={`sc-notice is-${row.severity.toLowerCase()}`}>
                <b>{row.title}</b>
                <span>{row.body}</span>
              </div>
            ))}
          </RailBlock>
        ) : null}
      </aside>

      <footer className="sc-foot">
        <span>表示更新 {clockTime(fetchedMs ?? board.nowMs, true)}{stale ? ' ・ 最新化を再試行中' : ''}</span>
        <span className="sc-brand">KRSK SYSTEM</span>
        <span>F キーで全画面</span>
      </footer>
    </div>
  );
}

function phaseLabel(phase: string, status: string): string {
  if (status === 'PAUSED') return '一時停止中';
  if (status === 'COMPLETED') return '大会終了';
  if (status === 'CANCELLED') return '大会中止';
  if (phase === 'TOURNAMENT') return 'トーナメント';
  if (phase === 'REQUEST') return 'フリーマッチ';
  return 'リーグ戦';
}

const TILE_LABEL: Record<string, string> = {
  PLAYING: '試合中',
  CALLING: 'まもなく開始',
  COURT_ASSIGNED: '準備中',
  RESULT_PENDING: '結果確認中',
  RESERVED: '予約済',
  BLOCKED: '使用不可',
  MAINTENANCE: '整備中',
};

/** The hall reads the state of the court, so the band says what happens next there. */
function stateLabel(state: string, match: NonNullable<ScreenCourt['match']>): string {
  if (state === 'live') return '試合中';
  if (state === 'pending') return match.resultStatus ? '結果確認中' : '結果入力待ち';
  return 'まもなく開始';
}

function CourtTile({ court, nowMs, boardMs }: { court: ScreenCourt; nowMs: number; boardMs: number }) {
  const match = court.match;
  const state = !match ? (court.status === 'BLOCKED' || court.status === 'MAINTENANCE' ? 'blocked' : 'free')
    : match.status === 'PLAYING' ? 'live'
      : match.status === 'RESULT_PENDING' ? 'pending' : 'call';
  const startMs = parseIso(match?.startTime);
  const headline = !match ? (state === 'blocked' ? '使用できません' : '空きコート')
    : state === 'call' ? (match.roundName ?? 'まもなく') : null;
  return (
    <article className={`sc-court is-${state}`}>
      <header>
        <span className="sc-court-name">{court.courtName}</span>
        <span className="sc-court-state">{match ? stateLabel(state, match) : TILE_LABEL[court.status] ?? '空き'}</span>
      </header>
      {match ? (
        <>
          <div className="sc-players">
            <b>{match.playerAName}</b>
            <span className="sc-vs">VS</span>
            <b>{match.playerBName}</b>
          </div>
          {match.scoreA !== null && match.scoreB !== null ? (
            <div className="sc-score num">{match.scoreA} <em>-</em> {match.scoreB}</div>
          ) : (
            <div className="sc-score is-pending num">{state === 'pending' ? '— — —' : headline ?? ' '}</div>
          )}
          <div className="sc-meta">
            {match.phase === 'TOURNAMENT' && match.roundName ? <span className="sc-chip">{match.roundName}</span> : null}
            {state === 'live' && startMs !== null ? <span className="num">経過 {stopwatch(startMs, nowMs)}</span> : null}
            {state === 'live' && court.endsInMinutes !== null
              ? <span>残り {Math.max(0, court.endsInMinutes - Math.max(0, Math.round((nowMs - boardMs) / 60_000)))}分</span> : null}
            {state === 'live' && court.endsInMinutes === null && court.overMinutes > 0
              ? <span className="warn">延長中</span> : null}
            {state === 'pending' ? (match.resultStatus === 'ENTERED'
              ? <span>選手の申告を相手に確認してもらっています</span>
              : match.resultStatus === 'DISPUTED' ? <span className="warn">申告が食い違っています。係りが確認します</span>
                : <span>結果を入力してください</span>) : null}
            {state === 'call' && match.scheduledTime ? <span className="num">開始予定 {clockTime(match.scheduledTime)}</span> : null}
          </div>
        </>
      ) : (
        <div className="sc-free">
          <b>{headline}</b>
          <span>{state === 'blocked' ? 'このコートは使えません' : '次の対戦を待っています'}</span>
        </div>
      )}
    </article>
  );
}

function RailBlock({ title, children, dots }: { title: string; children: React.ReactNode; dots?: { index: number; count: number } }) {
  return (
    <section className="sc-block">
      <header>
        <h3>{title}</h3>
        {dots ? (
          <span className="sc-dots">
            {Array.from({ length: dots.count }, (_, index) => <i key={index} className={index === dots.index ? 'on' : ''} />)}
          </span>
        ) : null}
      </header>
      {children}
    </section>
  );
}
