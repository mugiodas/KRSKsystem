import { useEffect, useMemo, useState } from 'react';
import { Loader2, ShieldAlert } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { CourtRow, MatchRow, ParticipantRow, RankingRow } from '../../api/types';
import { Chip, Empty, Modal, useToast } from '../ui';

interface Props {
  eventId: string;
  participants: ParticipantRow[];
  courts: CourtRow[];
  matches: MatchRow[];
  presetPlayerIds: string[];
  isOwner: boolean;
  onClose: () => void;
  onCreated: (match: MatchRow) => void;
}

/** Operator override: build an arbitrary card even when the engine would not pick it. */
export function ManualMatchModal({ eventId, participants, courts, matches, presetPlayerIds, isOwner, onClose, onCreated }: Props) {
  const toast = useToast();
  const [aId, setAId] = useState(presetPlayerIds[0] ?? '');
  const [bId, setBId] = useState(presetPlayerIds[1] ?? '');
  const [courtId, setCourtId] = useState('');
  const [searchA, setSearchA] = useState('');
  const [searchB, setSearchB] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [force, setForce] = useState(false);
  const [rankings, setRankings] = useState<RankingRow[]>([]);

  useEffect(() => {
    api.rankings(eventId).then(setRankings).catch(() => setRankings([]));
  }, [eventId]);

  const busyIds = useMemo(() => {
    const live = ['WAITING', 'CALLED', 'COURT_ASSIGNED', 'PLAYING', 'RESULT_PENDING'];
    const set = new Set<string>();
    for (const match of matches) {
      if (!live.includes(match.status)) continue;
      set.add(match.playerAId);
      set.add(match.playerBId);
    }
    return set;
  }, [matches]);

  const options = useMemo(() => participants
    .filter((player) => player.active === 1 && player.checkedIn === 1)
    .map((player) => ({
      player,
      rank: rankings.find((row) => row.participantId === player.participantId),
      disabled: busyIds.has(player.participantId),
    })), [participants, rankings, busyIds]);

  const freeCourts = courts.filter((court) => court.enabled === 1 && !busyIds.has(`court:${court.courtId}`)
    && (court.status === 'AVAILABLE' || court.status === 'RESERVED'));

  function list(query: string, exclude: string) {
    return options
      .filter((option) => option.player.participantId !== exclude)
      .filter((option) => !query.trim() || option.player.name.includes(query.trim()) || option.player.club.includes(query.trim()))
      .sort((left, right) => Number(left.disabled) - Number(right.disabled) || right.player.played - left.player.played)
      .slice(0, 60);
  }

  const headToHead = useMemo(() => {
    if (!aId || !bId) return null;
    const played = matches.filter((match) => match.status === 'COMPLETED'
      && ((match.playerAId === aId && match.playerBId === bId) || (match.playerAId === bId && match.playerBId === aId)));
    return played.length;
  }, [aId, bId, matches]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.createMatch(eventId, {
        playerAId: aId, playerBId: bId, courtId: courtId || null, phase: 'REQUEST', force: force && isOwner,
      });
      toast.push('手動で対戦カードを作成しました。ソースは MANUAL として記録されています。');
      onCreated(created);
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '試合作成に失敗しました。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="手動で対戦カードを作成"
      subtitle="エンジン判断を上書きします（記録に source = MANUAL が残ります）"
      onClose={onClose}
      footer={(
        <>
          {force ? <Chip tone="urgent"><ShieldAlert size={11} />制約を上書きします</Chip> : null}
          <span style={{ marginRight: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ fontSize: 11, display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} disabled={!isOwner} style={{ margin: 0 }} />
              休憩時間・重複を無視 {isOwner ? '' : '（OWNER のみ）'}
            </label>
          </span>
          <button className="btn" onClick={onClose}>キャンセル</button>
          <button className="btn primary" disabled={!aId || !bId || aId === bId || busy} onClick={submit}>
            {busy ? <Loader2 size={13} /> : null}作成する
          </button>
        </>
      )}
    >
      {error ? <div className="notice error">{error}</div> : null}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {([['A', aId, setAId, bId, searchA, setSearchA], ['B', bId, setBId, aId, searchB, setSearchB]] as const).map(([side, value, setValue, other, query, setQuery]) => (
          <div className="field" key={side}>
            <label>選手 {side}</label>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名前で絞り込み" />
            <div style={{ maxHeight: 250, overflow: 'auto', border: '1px solid var(--line-strong)', borderRadius: 6 }}>
              {list(query, other).length === 0 ? <Empty>該当なし</Empty> : list(query, other).map(({ player, rank, disabled }) => (
                <button
                  key={player.participantId} type="button"
                  onClick={() => { if (!disabled) setValue(player.participantId); }}
                  disabled={disabled}
                  style={{
                    display: 'grid', gridTemplateColumns: '1fr auto', gap: 6, width: '100%', textAlign: 'left',
                    padding: '5px 8px', border: 0, borderBottom: '1px solid #eef1f6', cursor: disabled ? 'not-allowed' : 'pointer',
                    background: value === player.participantId ? 'var(--blue-100)' : '#fff', opacity: disabled ? 0.5 : 1,
                  }}
                >
                  <span style={{ fontSize: 12 }}>
                    <b>{player.name}</b>
                    <span style={{ color: 'var(--ink-500)', marginLeft: 5, fontSize: 11 }}>{player.className ?? '混合'} / {player.club}</span>
                  </span>
                  <span className="num" style={{ fontSize: 11, color: 'var(--ink-500)' }}>
                    {player.played}戦{player.wins}勝{rank ? ` ${rank.rank}位` : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'end' }}>
        <div className="field">
          <label>コート（未設定にするとキューに入り、エンジンまたは手動で割当）</label>
          <select value={courtId} onChange={(event) => setCourtId(event.target.value)} style={{ height: 30, border: '1px solid var(--line-strong)', borderRadius: 6, padding: '0 8px' }}>
            <option value="">割当なし（待機）</option>
            {freeCourts.map((court) => <option key={court.courtId} value={court.courtId}>{court.courtName}（{court.status}）</option>)}
          </select>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--ink-500)', paddingBottom: 6 }}>
          {headToHead === null ? '選手を選ぶと対戦実績を表示' : headToHead === 0 ? '同一大会での対戦実績はありません' : `これまでに ${headToHead}回 対戦`}
        </div>
      </div>
    </Modal>
  );
}
