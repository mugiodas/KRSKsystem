import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';
import type { EngineState, MatchRow, ParticipantRow, RequestRow } from '../../api/types';
import { Chip, Empty } from '../ui';

type SortKey = 'waiting' | 'played' | 'name' | 'rating';

interface Props {
  participants: ParticipantRow[];
  engine: EngineState | null;
  matches: MatchRow[];
  requests: RequestRow[];
  selectedIds: string[];
  onToggleSelect: (participantId: string) => void;
}

const LIVE = ['CALLED', 'COURT_ASSIGNED', 'PLAYING', 'RESULT_PENDING'];

/**
 * PARTICIPANT STATUS: everyone in one scannable table. Waiting minutes and
 * match count are the two numbers the operator acts on, so they lead the row.
 */
export function ParticipantStatus({ participants, engine, matches, requests, selectedIds, onToggleSelect }: Props) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('waiting');
  const [onlyActive, setOnlyActive] = useState(false);

  const rows = useMemo(() => {
    const waiting = new Map(engine?.waitingPlayers.map((player) => [player.participantId, player]) ?? []);
    const busyIds = new Set<string>();
    const courtOf = new Map<string, string>();
    for (const match of matches) {
      if (!LIVE.includes(match.status)) continue;
      busyIds.add(match.playerAId);
      busyIds.add(match.playerBId);
      if (match.courtName) {
        courtOf.set(match.playerAId, match.courtName);
        courtOf.set(match.playerBId, match.courtName);
      }
    }
    const requested = new Set(requests.filter((request) => request.status === 'ACTIVE').flatMap((request) => [request.requesterId, request.targetPlayerId]));
    const maxWait = Math.max(30, ...[...waiting.values()].map((player) => player.waitingMinutes));

    const mapped = participants
      .filter((player) => (onlyActive ? player.active === 1 && player.checkedIn === 1 : true))
      .filter((player) => !query.trim() || player.name.includes(query.trim()) || player.club.includes(query.trim()) || (player.nameKana ?? '').includes(query.trim()))
      .map((player) => {
        const state = waiting.get(player.participantId);
        const waitingMinutes = busyIds.has(player.participantId) ? 0 : state?.waitingMinutes ?? 0;
        const rest = !busyIds.has(player.participantId) && state && !state.restReady;
        // The engine already knows who is holding a request, so the badge stays
        // correct even if the request list itself failed to load.
        const hasRequest = requested.has(player.participantId) || (state?.activeRequests ?? 0) > 0;
        return {
          player,
          waitingMinutes,
          restMinutes: rest ? state.restReadyInMinutes : 0,
          busy: busyIds.has(player.participantId),
          court: courtOf.get(player.participantId) ?? null,
          hasRequest,
          maxWait,
        };
      });

    const compare: Record<SortKey, (a: typeof mapped[0], b: typeof mapped[0]) => number> = {
      waiting: (a, b) => b.waitingMinutes - a.waitingMinutes || a.player.played - b.player.played,
      played: (a, b) => a.player.played - b.player.played || b.waitingMinutes - a.waitingMinutes,
      name: (a, b) => a.player.name.localeCompare(b.player.name, 'ja'),
      rating: (a, b) => b.player.rating - a.player.rating,
    };
    return mapped.sort(compare[sort]);
  }, [participants, engine, matches, requests, query, sort, onlyActive]);

  const waitingTotal = rows.filter((row) => !row.busy && row.waitingMinutes > 0).length;
  const playing = rows.filter((row) => row.busy).length;

  return (
    <section className="panel" id="participants">
      <header className="panel-head">
        <h2>PARTICIPANT STATUS</h2>
        <Chip>{rows.length}名</Chip>
        <Chip tone="blue">{playing}名 プレー中</Chip>
        <Chip tone={waitingTotal > 8 ? 'warn' : ''}>待機 {waitingTotal}名</Chip>
        <span className="spacer" />
        <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyActive} onChange={(event) => setOnlyActive(event.target.checked)} style={{ margin: 0 }} />
          出席のみ
        </label>
        <div className="search">
          <Search size={12} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名前・所属" />
        </div>
        <div className="tabs">
          {([['waiting', '待ち時間'], ['played', '試合数'], ['rating', 'レーティング'], ['name', '五十音']] as const).map(([key, label]) => (
            <button key={key} aria-selected={sort === key} onClick={() => setSort(key)}>{label}</button>
          ))}
        </div>
      </header>
      <div className="panel-body" style={{ padding: 0, maxHeight: '40vh' }}>
        {rows.length === 0 ? <Empty>該当する参加者がいません。</Empty> : (
          <table className="grid-table">
            <thead>
              <tr>
                <th style={{ width: 26 }} />
                <th>名前</th>
                <th style={{ width: 58 }}>クラス</th>
                <th className="right" style={{ width: 58 }}>試合</th>
                <th className="right" style={{ width: 46 }}>勝</th>
                <th className="right" style={{ width: 58 }}>レート</th>
                <th style={{ width: 128 }}>待ち時間</th>
                <th style={{ width: 88 }}>状態</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ player, waitingMinutes, busy, court, hasRequest, restMinutes, maxWait }) => {
                const tone = waitingMinutes >= 30 ? 'urgent' : waitingMinutes >= 16 ? 'warn' : '';
                const selected = selectedIds.includes(player.participantId);
                return (
                  <tr key={player.participantId} className={selected ? 'sel' : ''}>
                    <td>
                      <input
                        type="checkbox" checked={selected} style={{ margin: 0 }}
                        onChange={() => onToggleSelect(player.participantId)}
                        title="対戦カード作成の選手選択に使う"
                      />
                    </td>
                    <td>
                      <span className="name">{player.name}</span>
                      <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>{player.club}</span>
                      {hasRequest ? <span className="chip blue" style={{ marginLeft: 5 }}>希望</span> : null}
                    </td>
                    <td className="muted">{player.className ?? '—'}</td>
                    <td className="right num">{player.played}</td>
                    <td className="right num">{player.wins}</td>
                    <td className="right num muted">{player.rating}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div className="wait-bar" style={{ flex: '1 1 auto' }}>
                          <i className={tone} style={{ width: `${busy ? 0 : Math.min(100, (waitingMinutes / maxWait) * 100)}%` }} />
                        </div>
                        <span className="num" style={{ width: 34, textAlign: 'right', color: tone === 'urgent' ? 'var(--urgent)' : undefined }}>
                          {busy ? '—' : `${Math.round(waitingMinutes)}`}
                        </span>
                      </div>
                    </td>
                    <td>
                      {busy ? <Chip tone="blue" dot>{court ?? '試合中'}</Chip>
                        : restMinutes > 0 ? <Chip tone="warn">休憩 {Math.ceil(restMinutes)}分</Chip>
                          : player.checkedIn === 0 ? <Chip tone="urgent">未チェックイン</Chip>
                            : player.active === 0 ? <Chip>退場</Chip> : <Chip tone="ok" dot>待機</Chip>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderTop: '1px solid var(--line)', fontSize: 11, color: 'var(--ink-500)' }}>
        {selectedIds.length > 0 ? (
          <span>
            {selectedIds.length}名選択中 {selectedIds.length === 2 ? '— 右上の「選択した2名で試合作成」から手動カードを作成できます' : '— 2名選ぶと手動作成に使えます'}
          </span>
        ) : (
          <span>行頭チェックで2名選ぶと手動対戦カードの作成に使えます。順位表は RANKING タブへ。</span>
        )}
        <span style={{ flex: '1 1 auto' }} />
        {engine ? (
          <button className="btn sm subtle" onClick={() => setSort(sort === 'waiting' ? 'played' : 'waiting')}>
            {sort === 'waiting' ? <>試合数が少ない順 <ChevronUp size={11} /></> : <>待ち時間順 <ChevronDown size={11} /></>}
          </button>
        ) : null}
      </div>
    </section>
  );
}
