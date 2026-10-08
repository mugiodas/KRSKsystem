import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { ParticipantRow, RankingRow } from '../../api/types';
import { Chip, Empty } from '../ui';

interface Props {
  eventId: string;
  participants: ParticipantRow[];
}

/** League standings per class, straight from completed results. */
export function RankingPanel({ eventId, participants }: Props) {
  const [rows, setRows] = useState<RankingRow[]>([]);
  const [classId, setClassId] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.rankings(eventId, classId || undefined).then(setRows).catch(() => setRows([])).finally(() => setLoading(false));
  }, [eventId, classId]);

  const classes = useMemo(() => {
    const map = new Map<string, string>();
    participants.forEach((player) => { if (player.classId && player.className) map.set(player.classId, player.className); });
    return [...map.entries()];
  }, [participants]);

  const byClass = useMemo(() => {
    const map = new Map<string, RankingRow[]>();
    rows.forEach((row) => {
      const key = row.className ?? 'クラス指定なし';
      map.set(key, [...(map.get(key) ?? []), row]);
    });
    return [...map.entries()].sort((left, right) => left[0].localeCompare(right[0], 'ja'));
  }, [rows]);

  const maxPlayed = Math.max(1, ...rows.map((row) => row.played));

  return (
    <section className="panel" id="ranking">
      <header className="panel-head">
        <h2>RANKING</h2>
        <Chip>{rows.length}名</Chip>
        <span className="spacer" />
        <div className="tabs">
          <button aria-selected={classId === ''} onClick={() => setClassId('')}>全クラス</button>
          {classes.map(([id, name]) => <button key={id} aria-selected={classId === id} onClick={() => setClassId(id)}>{name}</button>)}
        </div>
      </header>
      <div className="panel-body" style={{ padding: 0, maxHeight: '58vh' }}>
        {loading ? <Empty>計算中…</Empty> : rows.length === 0 ? <Empty>まだ確定した結果がありません。</Empty> : (
          byClass.map(([className, list]) => (
            <div key={className}>
              <div style={{ padding: '5px 10px', background: 'var(--surface-alt)', borderBottom: '1px solid var(--line)', fontSize: 11.5, fontWeight: 700, color: 'var(--navy-800)' }}>
                {className} <span style={{ fontWeight: 400, color: 'var(--ink-500)' }}>（{list.length}名）</span>
              </div>
              <table className="grid-table">
                <thead>
                  <tr>
                    <th style={{ width: 42 }}>順位</th>
                    <th>選手</th>
                    <th className="right" style={{ width: 54 }}>試合</th>
                    <th className="right" style={{ width: 46 }}>勝</th>
                    <th className="right" style={{ width: 46 }}>負</th>
                    <th className="right" style={{ width: 62 }}>勝率</th>
                    <th className="right" style={{ width: 62 }}>得点差</th>
                    <th style={{ width: 110 }}>消化率</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((row) => (
                    <tr key={row.participantId}>
                      <td><span className="num" style={{ fontWeight: 700, color: row.rank <= 3 ? 'var(--navy-800)' : 'var(--ink-500)' }}>{row.rank}</span></td>
                      <td>
                        <span className="name">{row.participantName}</span>
                        <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{row.club}</span>
                      </td>
                      <td className="right num">{row.played}</td>
                      <td className="right num">{row.wins}</td>
                      <td className="right num muted">{row.losses}</td>
                      <td className="right num">{row.played === 0 ? '—' : `${Math.round(row.winRate * 100)}%`}</td>
                      <td className="right num" style={{ color: row.pointDifference > 0 ? 'var(--ok)' : row.pointDifference < 0 ? 'var(--urgent)' : undefined }}>
                        {row.pointDifference > 0 ? `+${row.pointDifference}` : row.pointDifference}
                      </td>
                      <td><div className="bar"><i style={{ width: `${(row.played / maxPlayed) * 100}%` }} /></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
