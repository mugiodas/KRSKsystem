import { useMemo } from 'react';
import { Flag, Pause, Play, Timer, Volume2 } from 'lucide-react';
import type { CourtRow, MatchRow } from '../../api/types';
import { clockTime, parseIso, stopwatch } from '../../lib/time';
import { Chip, COURT_LABEL, Empty, statusTone } from '../ui';

interface Props {
  courts: CourtRow[];
  matches: MatchRow[];
  nowMs: number;
  canOperate: boolean;
  matchMinutes: number;
  onStart: (match: MatchRow) => void;
  onFinish: (match: MatchRow) => void;
  onResult: (match: MatchRow) => void;
  onCall: (match: MatchRow) => void;
  onManualAssign: (match: MatchRow, courtId: string) => void;
}

export function CourtLive({ courts, matches, nowMs, canOperate, matchMinutes, onStart, onFinish, onResult, onCall, onManualAssign }: Props) {
  const byCourt = useMemo(() => {
    const map = new Map<string, MatchRow>();
    for (const match of matches) {
      if (!match.courtId) continue;
      if (!['COURT_ASSIGNED', 'PLAYING', 'RESULT_PENDING'].includes(match.status)) continue;
      map.set(match.courtId, match);
    }
    return map;
  }, [matches]);

  const liveCount = courts.filter((court) => byCourt.has(court.courtId)).length;

  return (
    <section className="panel" id="courts">
      <header className="panel-head">
        <h2>COURT LIVE</h2>
        <Chip tone="blue">{liveCount} / {courts.length} 面稼働</Chip>
        <span className="spacer" />
        <span className="hint">1本 {matchMinutes}分・結果入力込み</span>
      </header>
      <div className="panel-body">
        {courts.length === 0 ? <Empty>コートが登録されていません。</Empty> : (
          <div className="court-grid">
            {courts.map((court) => {
              const match = byCourt.get(court.courtId);
              return (
                <CourtCard
                  key={court.courtId} court={court} match={match} nowMs={nowMs} canOperate={canOperate}
                  matchMinutes={matchMinutes} courts={courts}
                  onStart={onStart} onFinish={onFinish} onResult={onResult} onCall={onCall} onManualAssign={onManualAssign}
                />
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function CourtCard({ court, match, nowMs, canOperate, matchMinutes, courts, onStart, onFinish, onResult, onCall, onManualAssign }: {
  court: CourtRow;
  match?: MatchRow;
  nowMs: number;
  canOperate: boolean;
  matchMinutes: number;
  courts: CourtRow[];
  onStart: (match: MatchRow) => void;
  onFinish: (match: MatchRow) => void;
  onResult: (match: MatchRow) => void;
  onCall: (match: MatchRow) => void;
  onManualAssign: (match: MatchRow, courtId: string) => void;
}) {
  const startMs = parseIso(match?.startTime);
  const elapsedSeconds = startMs === null ? 0 : Math.max(0, Math.round((nowMs - startMs) / 1000));
  const targetSeconds = matchMinutes * 60;
  const ratio = startMs === null ? 0 : Math.min(1.4, elapsedSeconds / Math.max(60, targetSeconds));
  const overtime = elapsedSeconds > targetSeconds + 120;
  const blocked = court.enabled === 0 || court.status === 'BLOCKED' || court.status === 'MAINTENANCE';

  return (
    <article className="court-card" data-live={match ? '1' : '0'} data-blocked={blocked ? '1' : '0'}>
      <header className="court-top">
        <b>{court.courtName}</b>
        {match
          ? <Chip tone={statusTone(match.status)} dot>{match.status === 'PLAYING' ? '試合中' : match.status === 'RESULT_PENDING' ? '結果待ち' : 'コート割当'}</Chip>
          : <Chip tone={blocked ? 'urgent' : 'ok'} dot>{blocked ? '使用不可' : '空き'}</Chip>}
        <span className="spacer" />
        {match && startMs !== null ? (
          <span className={`court-clock${overtime ? ' urgent' : ratio > 0.75 ? ' warn' : ''}`}>
            <Timer size={11} style={{ verticalAlign: -1, marginRight: 3 }} />
            {stopwatch(startMs, nowMs)}
          </span>
        ) : (
          <Chip>{COURT_LABEL[court.status] ?? court.status}</Chip>
        )}
      </header>

      {match ? (
        <>
          <div className="court-players">
            {([['A', match.playerAName, match.playerAClub, match.scoreA, match.winnerId === match.playerAId],
              ['B', match.playerBName, match.playerBClub, match.scoreB, match.winnerId === match.playerBId]] as const).map(([side, name, club, score, won]) => (
              <div key={side} className={`court-player${won ? ' won' : ''}`}>
                <div>
                  <div className="name">{name}{won ? <span className="chip ok" style={{ marginLeft: 5 }}>WIN</span> : null}</div>
                  <div className="club">{club}</div>
                </div>
                <div className="score-box num">{score === null || score === undefined ? <span style={{ color: 'var(--line-strong)' }}>–</span> : score}</div>
              </div>
            ))}
          </div>
          <div className="progress"><i className={overtime ? 'over' : ''} style={{ width: `${Math.min(100, ratio * 100)}%` }} /></div>
          <div className="court-foot">
            {match.status === 'COURT_ASSIGNED' && canOperate ? <button className="btn primary sm" onClick={() => onStart(match)}><Play size={12} />開始</button> : null}
            {match.status === 'PLAYING' && canOperate ? <button className="btn sm" onClick={() => onFinish(match)}><Flag size={12} />終了</button> : null}
            {match.status === 'PLAYING' || match.status === 'RESULT_PENDING' ? (
              <button className="btn primary sm" onClick={() => onResult(match)}><Volume2 size={12} />結果入力</button>
            ) : null}
            {match.status === 'COURT_ASSIGNED' && canOperate ? (
              <select
                value={court.courtId}
                onChange={(event) => { if (event.target.value !== court.courtId) onManualAssign(match, event.target.value); }}
                title="コートを移す"
              >
                {courts.filter((item) => item.enabled === 1).map((item) => <option key={item.courtId} value={item.courtId}>{item.courtName}へ</option>)}
              </select>
            ) : null}
            <span style={{ flex: '1 1 auto' }} />
            <span className="hint" style={{ fontSize: 10.5 }}>{match.source === 'MANUAL' ? '手動' : match.source === 'REQUEST' ? '希望' : '自動'} {match.scheduledTime ? clockTime(match.scheduledTime) : ''}</span>
          </div>
        </>
      ) : blocked ? (
        <div className="court-empty">このコートは使用できません</div>
      ) : (
        <IdleCourtBody canOperate={canOperate} onCall={onCall} />
      )}
    </article>
  );
}

/** An idle court is an action slot, not a blank box: the operator calls the next pair straight from here. */
function IdleCourtBody({ canOperate, onCall }: { canOperate: boolean; onCall?: (match: MatchRow) => void }) {
  return (
    <div className="court-empty">
      {canOperate && onCall
        ? <span className="chip blue"><Pause size={10} /> 空きコート — キューから呼出可能</span>
        : '空きコート'}
    </div>
  );
}
