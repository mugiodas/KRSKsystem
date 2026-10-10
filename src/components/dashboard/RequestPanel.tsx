import { useMemo } from 'react';
import { Hand, Star } from 'lucide-react';
import { api } from '../../api/client';
import type { MatchRow, RequestRow } from '../../api/types';
import { formatDateTime } from '../../lib/time';
import { Chip, Empty } from '../ui';

interface Props {
  eventId: string;
  requests: RequestRow[];
  matches: MatchRow[];
  canOperate: boolean;
  onChanged: () => void;
}

const PRIORITY_LABEL: Record<number, string> = { 1: '強く希望', 2: '希望', 3: 'お試し' };

/**
 * Requests are advice, not orders: the engine weighs them against waiting time
 * and match balance. This panel shows which ones the engine already matched.
 */
export function RequestPanel({ eventId, requests, matches, canOperate, onChanged }: Props) {
  const rows = useMemo(() => requests.filter((request) => request.status === 'ACTIVE' || request.status === 'MATCHED'), [requests]);
  const active = rows.filter((request) => request.status === 'ACTIVE');

  return (
    <section className="panel" id="requests">
      <header className="panel-head">
        <h2>MATCH REQUESTS</h2>
        <Chip tone={active.length > 6 ? 'warn' : ''}>{active.length} 件が未成立</Chip>
        <Chip tone="ok">{rows.filter((request) => request.status === 'MATCHED').length} 成立</Chip>
        <span className="spacer" />
        <span className="hint">エンジンの RequestPriority に入り、成立時に MATCHED へ変わります</span>
      </header>
      <div className="panel-body" style={{ padding: 0, maxHeight: '56vh' }}>
        {rows.length === 0 ? <Empty>対戦希望はまだありません。参加者画面から送信できます。</Empty> : (
          <table className="grid-table">
            <thead>
              <tr>
                <th style={{ width: 60 }}>強さ</th>
                <th>希望内容</th>
                <th className="right" style={{ width: 74 }}>対戦済</th>
                <th style={{ width: 130 }}>結果</th>
                <th style={{ width: 96 }}>送信</th>
                <th style={{ width: 92 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((request) => {
                const headToHead = matches.filter((match) => match.status === 'COMPLETED'
                  && ((match.playerAId === request.requesterId && match.playerBId === request.targetPlayerId)
                    || (match.playerAId === request.targetPlayerId && match.playerBId === request.requesterId))).length;
                const matched = matches.find((match) => match.matchId === request.matchedMatchId);
                return (
                  <tr key={request.requestId}>
                    <td>
                      <span className="chip" style={{ background: request.priority === 1 ? 'var(--blue-100)' : 'var(--info-bg)' }}>
                        <Star size={10} /> {PRIORITY_LABEL[request.priority]}
                      </span>
                    </td>
                    <td>
                      <span className="name">{request.requesterName}</span>
                      <span className="muted"> → </span>
                      <span className="name">{request.targetName}</span>
                      <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{request.targetClassName ?? ''}</span>
                    </td>
                    <td className="right num muted">{headToHead}回</td>
                    <td>
                      {request.status === 'MATCHED'
                        ? <Chip tone="ok" dot>{matched?.courtName ?? '試合成立'}</Chip>
                        : <Chip tone="warn">待機中</Chip>}
                    </td>
                    <td className="muted" style={{ fontSize: 11 }}>{formatDateTime(request.createdAt)}</td>
                    <td>
                      {canOperate && request.status === 'ACTIVE' ? (
                        <button
                          className="btn sm" onClick={() => {
                            void api.cancelRequest(eventId, request.requestId, request.rowVersion).then(onChanged);
                          }}
                        >
                          <Hand size={11} />取下げ
                        </button>
                      ) : <span className="muted">—</span>}
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
