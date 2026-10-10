import { useMemo } from 'react';
import { Ban, ChevronRight, Users } from 'lucide-react';
import type { MatchRow, RequestRow } from '../../api/types';
import { clockTime, minutesBetween, parseIso } from '../../lib/time';
import { Chip, Empty } from '../ui';

interface Props {
  matches: MatchRow[];
  requests: RequestRow[];
  nowMs: number;
  canOperate: boolean;
  timeProtected: boolean;
  onCall: (match: MatchRow) => void;
  onAssign: (match: MatchRow, courtId: string) => void;
  onCancel: (match: MatchRow) => void;
  onNoShow: (match: MatchRow) => void;
  freeCourts: Array<{ courtId: string; courtName: string }>;
}

/**
 * WAITING / CALLED matches in engine priority order. Rows stay short because
 * the operator scans this list while talking to players.
 */
export function MatchQueue({ matches, requests, nowMs, canOperate, timeProtected, onCall, onAssign, onCancel, onNoShow, freeCourts }: Props) {
  const rows = useMemo(() => matches
    .filter((match) => match.status === 'WAITING' || match.status === 'CALLED')
    .sort((left, right) => Number(right.priorityScore) - Number(left.priorityScore)
      || (parseIso(left.scheduledTime) ?? 0) - (parseIso(right.scheduledTime) ?? 0)), [matches]);
  const activeRequests = requests.filter((request) => request.status === 'ACTIVE');

  return (
    <section className="panel" id="queue">
      <header className="panel-head">
        <h2>MATCH QUEUE</h2>
        <Chip>{rows.length} 待機</Chip>
        {activeRequests.length > 0 ? <Chip tone="blue">{activeRequests.length} 希望</Chip> : null}
        {timeProtected ? <Chip tone="warn">終了時刻保護中</Chip> : null}
        <span className="spacer" />
        {freeCourts.length > 0 ? <span className="hint">空き {freeCourts.length}面</span> : <span className="hint">全コート稼働中</span>}
      </header>
      <div className="panel-body" style={{ padding: 0, maxHeight: '42vh' }}>
        {rows.length === 0 ? (
          <Empty>待機中の試合はありません。エンジン実行またはリーグ生成で試合を作成します。</Empty>
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th style={{ width: 46 }}>優先</th>
                <th>対戦カード</th>
                <th style={{ width: 56 }}>クラス</th>
                <th className="right" style={{ width: 62 }}>予定</th>
                <th className="right" style={{ width: 62 }}>経過</th>
                <th style={{ width: canOperate ? 190 : 40 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((match) => {
                const scheduled = parseIso(match.scheduledTime);
                const waited = scheduled === null ? null : minutesBetween(scheduled, nowMs);
                return (
                  <tr key={match.matchId}>
                    <td>
                      <span className="num" style={{ fontWeight: 700, color: match.priorityScore >= 40 ? 'var(--navy-800)' : 'var(--ink-500)' }}>
                        {Math.round(match.priorityScore)}
                      </span>
                    </td>
                    <td>
                      <span className="name">{match.playerAName}</span>
                      <span className="muted"> × </span>
                      <span className="name">{match.playerBName}</span>
                      <div style={{ marginTop: 2, display: 'flex', gap: 4 }}>
                        {match.source === 'MANUAL' ? <Chip tone="warn">手動</Chip> : null}
                        {match.source === 'REQUEST' ? <Chip tone="blue">希望</Chip> : null}
                        {match.phase === 'LEAGUE' ? <Chip>リーグ</Chip> : match.phase === 'TOURNAMENT' ? <Chip>トーナメント</Chip> : <Chip>希望制</Chip>}
                        {match.courtId ? <Chip tone="ok">コート割当済</Chip> : null}
                      </div>
                    </td>
                    <td className="muted">{match.className ?? '混合'}</td>
                    <td className="right num muted">{clockTime(match.scheduledTime)}</td>
                    <td className={`right num${waited !== null && waited > 15 ? ' ' : ''}`} style={{ color: waited !== null && waited > 15 ? 'var(--urgent)' : undefined }}>
                      {waited === null ? '-' : `${Math.round(waited)}分`}
                    </td>
                    <td>
                      {canOperate ? (
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          {match.status === 'WAITING' ? (
                            <>
                              <button className="btn sm primary" onClick={() => onCall(match)}><ChevronRight size={12} />呼出</button>
                              {freeCourts.length > 0 ? (
                                <select
                                  value=""
                                  onChange={(event) => { if (event.target.value) onAssign(match, event.target.value); }}
                                  title="コートを割り当てる"
                                  style={{ height: 23, fontSize: 11, border: '1px solid var(--line-strong)', borderRadius: 4 }}
                                >
                                  <option value="">コート</option>
                                  {freeCourts.map((court) => <option key={court.courtId} value={court.courtId}>{court.courtName}</option>)}
                                </select>
                              ) : null}
                            </>
                          ) : (
                            <span className="chip ok dot">呼出済み</span>
                          )}
                          <button className="btn sm" onClick={() => onNoShow(match)} title="ノーショー扱いにする"><Users size={12} /></button>
                          <button className="btn sm danger" onClick={() => onCancel(match)} title="試合をキャンセル"><Ban size={12} /></button>
                        </div>
                      ) : <span className="muted">閲覧のみ</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
