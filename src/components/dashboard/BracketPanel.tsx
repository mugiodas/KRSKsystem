import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Network, RefreshCw, Trash2, Trophy } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { TournamentBracket, TournamentPairing } from '../../api/types';
import { clockTime } from '../../lib/time';
import { Chip, Empty, STATUS_LABEL, statusTone } from '../ui';

interface Props {
  eventId: string;
  canOperate: boolean;
  /** Snapshot timestamp — the panel refetches whenever the board refreshed. */
  refreshKey: string;
  onGenerate: () => void;
  onResult: (matchId: string, mode: 'enter' | 'correct') => void;
}

/** Cards that still have to be played - the draw is only finished when this is 0. */
const openCards = (bracket: TournamentBracket): number => bracket.pairings
  .filter((pairing) => pairing.matchId && pairing.status !== 'COMPLETED' && pairing.status !== 'CANCELLED').length;

function isLive(pairing: TournamentPairing): boolean {
  return pairing.status === 'COURT_ASSIGNED' || pairing.status === 'PLAYING' || pairing.status === 'RESULT_PENDING';
}

/**
 * The tournament board (event mode C). Cards are already on the court queue — this
 * panel shows who plays whom next, who walked over, and lets the operator correct
 * a score before the next round is called.
 */
export function BracketPanel({ eventId, canOperate, refreshKey, onGenerate, onResult }: Props) {
  const [brackets, setBrackets] = useState<TournamentBracket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setBrackets(await api.tournamentBrackets(eventId));
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'トーナメント表を取得できませんでした。');
    }
  }, [eventId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const run = useCallback(async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      setError(null);
      await load();
      return true;
    } catch (caught) {
      setError(caught instanceof ApiError ? `${label}：${caught.message}` : `${label}に失敗しました。`);
      return false;
    } finally {
      setBusy(false);
    }
  }, [load]);

  const columnsByRound = useMemo(() => (bracket: TournamentBracket) => {
    const map = new Map<number, TournamentPairing[]>();
    for (const pairing of bracket.pairings) {
      map.set(pairing.round, [...(map.get(pairing.round) ?? []), pairing]);
    }
    return [...map.entries()].sort((left, right) => left[0] - right[0])
      .map(([round, pairings]) => ({ round, label: pairings[0]?.roundLabel ?? `${round}回戦`, pairings }));
  }, []);

  if (error && !brackets) {
    return <div className="notice error"><AlertTriangle size={13} />{error}</div>;
  }
  if (!brackets || brackets.length === 0) {
    return (
      <div className="panel">
        <header className="panel-head">
          <h2>トーナメント表</h2>
          {canOperate ? <button className="btn sm primary" onClick={onGenerate}><Network size={12} />自動生成</button> : null}
        </header>
        <Empty>
          まだトーナメント表はありません。リーグ戦の合計が付いたクラスで「自動生成」を押すと、
          シード順を確認してからドローを作成します（チェックイン済みの参加者が対象）。
        </Empty>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {error ? <div className="notice error"><AlertTriangle size={13} />{error}</div> : null}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button className="btn sm" onClick={() => void load()}><RefreshCw size={12} />更新</button>
        {canOperate ? <button className="btn sm" disabled={busy} onClick={onGenerate}><Network size={12} />自動生成</button> : null}
      </div>
      {brackets.map((bracket) => {
        const rounds = columnsByRound(bracket);
        const progress = bracket.requiredMatches > 0 ? bracket.decidedMatches / bracket.requiredMatches : 1;
        return (
          <section key={bracket.bracketId} className="panel bkt">
            <header className="panel-head">
              <h2>{bracket.className ?? 'クラスなし'}</h2>
              <Chip tone={bracket.status === 'COMPLETED' ? 'ok' : 'blue'}>{bracket.size}ドロー・{bracket.rounds}回戦</Chip>
              <span className="muted" style={{ fontSize: 11.5 }}>
                {bracket.decidedMatches}/{bracket.requiredMatches}枚 完了・未消化 {openCards(bracket)}枚
                {bracket.byes > 0 ? `・不戦勝 ${bracket.byes}名` : ''}
              </span>
              {bracket.status === 'COMPLETED' && bracket.winnerName ? (
                <Chip tone="ok"><Trophy size={11} />優勝 {bracket.winnerName}</Chip>
              ) : null}
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                {canOperate && bracket.status === 'OPEN' ? (
                  <>
                    <button className="btn sm" disabled={busy}
                      onClick={() => void run('再整備', () => api.tournamentRebalance(eventId, bracket.bracketId))}>
                      進行を直す
                    </button>
                    <button className="btn sm danger" disabled={busy}
                      onClick={() => void run('削除', () => window.confirm('このトーナメント表を削除しますか？待機中のカードも取り消されます。')
                        ? api.tournamentDelete(eventId, bracket.bracketId) : Promise.resolve())}>
                      <Trash2 size={12} />削除
                    </button>
                  </>
                ) : null}
              </span>
            </header>
            <div className="bkt-bar"><span style={{ width: `${Math.min(100, progress * 100)}%` }} /></div>
            <div className="bkt-scroll">
              {rounds.map((column) => (
                <div key={column.round} className="bkt-round">
                  <h4>{column.label}</h4>
                  {column.pairings.map((pairing) => {
                    const live = isLive(pairing);
                    const done = pairing.status === 'COMPLETED';
                    return (
                      <div key={`${pairing.round}-${pairing.slot}`}
                        className={`bkt-card${live ? ' live' : ''}${done ? ' done' : ''}${!pairing.matchId ? ' bye' : ''}`}>
                        {(['playerAId', 'playerBId'] as const).map((key) => {
                          const id = pairing[key];
                          const name = key === 'playerAId' ? pairing.playerAName : pairing.playerBName;
                          const won = Boolean(id) && pairing.winnerId === id;
                          const auto = !pairing.matchId && Boolean(id);
                          return (
                            <div key={key} className={`bkt-line${won ? ' win' : ''}${id ? '' : ' void'}`}>
                              <span className="name">{name ?? (auto ? '勝者待ち' : '—')}</span>
                              {won ? <Chip tone="ok">勝</Chip> : null}
                              {auto ? <Chip>不戦勝</Chip> : null}
                            </div>
                          );
                        })}
                        <footer>
                          {pairing.matchId ? (
                            <>
                              <Chip tone={statusTone(pairing.status ?? '')}>{STATUS_LABEL[pairing.status ?? ''] ?? pairing.status}</Chip>
                              {done && pairing.scoreA !== null && pairing.scoreB !== null
                                ? <span className="num muted">{pairing.scoreA}-{pairing.scoreB}</span> : null}
                              <span className="muted">{pairing.courtName ?? 'コート未定'}{pairing.scheduledTime ? ` ${clockTime(pairing.scheduledTime)}` : ''}</span>
                              {canOperate ? (
                                <button className="btn sm"
                                  onClick={() => onResult(pairing.matchId!, done ? 'correct' : 'enter')}>
                                  {done ? '修正' : '結果'}
                                </button>
                              ) : null}
                            </>
                          ) : (
                            <span className="muted">不戦勝で {pairing.round + 1 > 1 ? '次ラウンド' : '決勝'}へ</span>
                          )}
                        </footer>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
