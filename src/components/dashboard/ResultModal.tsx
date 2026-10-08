import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Send } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { MatchRow } from '../../api/types';
import { Chip, Modal, ScoreStepper, useToast } from '../ui';

interface Props {
  eventId: string;
  match: MatchRow;
  /** OWNER/ADMIN may correct a stored result; a player may submit their own score. */
  mode: 'enter' | 'correct';
  targetMinutes: number;
  onDone: () => void;
  onClose: () => void;
}

/**
 * Result entry is deliberately the loudest action in the app: it frees a court,
 * updates rankings and triggers the next engine pass, so it is reachable from
 * the court card, the alert card and the queue in one click.
 */
export function ResultModal({ eventId, match: listed, mode, targetMinutes, onDone, onClose }: Props) {
  const toast = useToast();
  // The list endpoint has no result row, so the authoritative version numbers
  // come from the detail endpoint before any correction is attempted.
  const [match, setMatch] = useState<MatchRow>(listed);
  const [scoreA, setScoreA] = useState(listed.scoreA ?? 0);
  const [scoreB, setScoreB] = useState(listed.scoreB ?? 0);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setScoreA(listed.scoreA ?? 0);
    setScoreB(listed.scoreB ?? 0);
    void api.match(eventId, listed.matchId)
      .then((detail) => { if (!cancelled) setMatch(detail); })
      .catch(() => { if (!cancelled) setMatch(listed); });
    return () => { cancelled = true; };
  }, [eventId, listed.matchId]);

  const winner = useMemo(() => (scoreA === scoreB ? null : scoreA > scoreB ? match.playerAName : match.playerBName), [scoreA, scoreB, match]);
  const elapsed = match.startTime ? Math.round((Date.now() - new Date(match.startTime).getTime()) / 60_000) : null;
  const canSubmit = scoreA !== scoreB && (scoreA > 0 || scoreB > 0) && Math.max(scoreA, scoreB) >= 2;

  async function confirmStoredResult() {
    if (!match.result) return;
    setBusy(true);
    try {
      await api.confirmResult(eventId, match.matchId, match.result.rowVersion);
      toast.push('結果を確認済みにしました。');
      onDone();
      const detail = await api.match(eventId, match.matchId).catch(() => null);
      if (detail) setMatch(detail);
    } catch (caught) {
      toast.push(caught instanceof ApiError ? caught.message : '確認に失敗しました。', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    setSaving(true);
    setError(null);
    try {
      if (mode === 'correct') {
        await api.correctResult(eventId, match.matchId, scoreA, scoreB, match.result?.rowVersion ?? match.rowVersion);
        toast.push('結果を修正しました。ランキングを再計算しました。');
      } else {
        await api.enterResult(eventId, match.matchId, scoreA, scoreB, match.rowVersion);
        toast.push(`${match.courtName ?? 'コート'} の結果を登録しました。次カードを自動割当中です。`);
      }
      onDone();
      onClose();
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : '結果の登録に失敗しました。';
      setError(caught instanceof ApiError && caught.code === 'VERSION_CONFLICT'
        ? '他の端末で更新されました。最新表示で入力し直してください。'
        : message);
    } finally {
      setBusy(false);
      setSaving(false);
    }
  }

  return (
    <Modal
      title={mode === 'correct' ? '結果の修正' : '結果入力'}
      subtitle={`${match.playerAName} × ${match.playerBName}`}
      onClose={onClose}
      footer={(
        <>
          <span style={{ marginRight: 'auto', fontSize: 11, color: 'var(--ink-500)' }}>
            {match.courtName ?? 'コート未定'} ・ {match.className ?? 'クラスなし'}
            {elapsed !== null ? ` ・ 所要 ${elapsed}分（目標 ${targetMinutes}分）` : ''}
          </span>
          {match.result && match.result.status !== 'CONFIRMED' ? (
            <button className="btn" disabled={busy} onClick={confirmStoredResult}><Check size={13} />確認済みにする</button>
          ) : null}
          <button className="btn" onClick={onClose}>キャンセル</button>
          <button className="btn primary" disabled={!canSubmit || saving} onClick={submit}>
            {saving ? <Loader2 size={13} className="spin" /> : mode === 'correct' ? <Check size={13} /> : <Send size={13} />}
            {mode === 'correct' ? '修正を保存' : 'このスコアで確定'}
          </button>
        </>
      )}
    >
      {error ? <div className="notice error">{error}</div> : null}
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 12, alignItems: 'center' }}>
          <PlayerScore name={match.playerAName} club={match.playerAClub} value={scoreA} onChange={setScoreA} won={winner === match.playerAName} />
          <div style={{ textAlign: 'center', color: 'var(--ink-500)', fontWeight: 700 }}>VS</div>
          <PlayerScore name={match.playerBName} club={match.playerBClub} value={scoreB} onChange={setScoreB} won={winner === match.playerBName} alignRight />
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--ink-500)' }}>常用スコア</span>
          {[[21, 15], [21, 19], [21, 18], [15, 11], [15, 13], [21, 12]].map(([a, b]) => (
            <button key={`${a}-${b}`} className="btn sm subtle" onClick={() => { setScoreA(a); setScoreB(b); }}>{a}-{b}</button>
          ))}
          <button className="btn sm subtle" onClick={() => { setScoreA(scoreB); setScoreB(scoreA); }}>入替</button>
        </div>

        <div className="notice info">
          <span>
            登録すると試合が <b>COMPLETED</b> になり、コートが空き、順位表とマッチング待ち時間が再計算されます。
            {mode === 'enter' ? ' 間違えた場合は OWNERS/ADMIN が結果を修正できます。' : ''}
          </span>
        </div>
        {winner === null ? <div style={{ fontSize: 11, color: 'var(--warn)' }}>同点では登録できません。どちらかが勝っているスコアを入力してください。</div> : null}
        <div style={{ display: 'flex', gap: 6 }}>
          <Chip tone={match.status === 'RESULT_PENDING' ? 'warn' : 'blue'}>{match.status === 'RESULT_PENDING' ? '試合終了・結果待ち' : '試合中'}</Chip>
          {match.result ? <Chip tone="ok">結果 {match.result.status === 'CONFIRMED' ? '確認済' : '入力済'}</Chip> : null}
        </div>
      </div>
    </Modal>
  );
}

function PlayerScore({ name, club, value, onChange, won, alignRight }: {
  name: string; club: string; value: number; onChange: (next: number) => void; won: boolean; alignRight?: boolean;
}) {
  return (
    <div style={{ border: `1px solid ${won ? 'var(--blue-500)' : 'var(--line)'}`, borderRadius: 8, padding: '10px 12px', background: won ? 'var(--blue-050)' : '#fff', textAlign: alignRight ? 'right' : 'left' }}>
      <div style={{ fontSize: 13, fontWeight: 700 }}>{name}</div>
      <div style={{ fontSize: 11, color: 'var(--ink-500)', marginBottom: 6 }}>{club}</div>
      <div style={{ display: 'flex', justifyContent: alignRight ? 'flex-end' : 'flex-start', alignItems: 'center', gap: 8 }}>
        <ScoreStepper value={value} onChange={onChange} />
        {won ? <Chip tone="ok">WIN</Chip> : null}
      </div>
    </div>
  );
}
