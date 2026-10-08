import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { MatchRow, MyMatchView } from '../../api/types';

interface Props {
  eventId: string;
  view: MyMatchView;
  matchId: string;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * A participant may submit the score of their own match. It posts to the same
 * endpoint the operator uses, so there is exactly one source of truth — and
 * the side (A/B) is read from the match itself rather than trusted from the UI.
 */
export function ResultSheet({ eventId, view, matchId, onClose, onSaved }: Props) {
  const [detail, setDetail] = useState<MatchRow | null>(null);
  const [mine, setMine] = useState(0);
  const [theirs, setTheirs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.match(eventId, matchId).then((value) => {
      if (cancelled) return;
      setDetail(value);
      const mineIsA = value.playerAId === view.participant.participantId;
      const history = view.history.find((row) => row.matchId === matchId);
      setMine(history ? history.scoreMine : (mineIsA ? value.scoreA ?? 0 : value.scoreB ?? 0));
      setTheirs(history ? history.scoreOpponent : (mineIsA ? value.scoreB ?? 0 : value.scoreA ?? 0));
    }).catch(() => setDetail(null));
    return () => { cancelled = true; };
  }, [eventId, matchId, view.participant.participantId, view.history]);

  const opponentName = detail
    ? (detail.playerAId === view.participant.participantId ? detail.playerBName : detail.playerAName)
    : view.nextMatch?.opponentName ?? '相手';

  async function submit() {
    if (!detail) return;
    setBusy(true);
    setError(null);
    const mineIsA = detail.playerAId === view.participant.participantId;
    try {
      await api.enterResult(eventId, matchId, mineIsA ? mine : theirs, mineIsA ? theirs : mine, detail.rowVersion);
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '送信に失敗しました。運営に直接伝えてください。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" style={{ alignItems: 'flex-end', padding: 0 }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div style={{ width: '100%', background: '#fff', borderRadius: '16px 16px 0 0', padding: '12px 16px calc(16px + env(safe-area-inset-bottom))', maxWidth: 520, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <b style={{ fontSize: 15 }}>結果の送信</b>
          <span style={{ flex: '1 1 auto' }} />
          <button className="btn sm" onClick={onClose} aria-label="閉じる"><X size={14} /></button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--ink-500)', marginTop: 4 }}>
          vs {opponentName} — {detail ? `${detail.courtName ?? 'コート未定'}・${detail.status === 'PLAYING' ? '試合中（終了後にもう一度送信できます）' : '結果入力待ち'}` : '読込中…'}
        </p>
        {error ? <div className="notice error" style={{ marginTop: 8 }}>{error}</div> : null}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 10, alignItems: 'center', marginTop: 14 }}>
          <NumberField label="あなた" value={mine} onChange={setMine} />
          <span style={{ color: 'var(--ink-500)', fontWeight: 800 }}>–</span>
          <NumberField label={opponentName} value={theirs} onChange={setTheirs} />
        </div>
        {mine === theirs ? <div style={{ fontSize: 11.5, color: 'var(--warn)', marginTop: 6 }}>同点では送信できません。どちらかが勝っているスコアを入力してください。</div> : null}
        <div className="m-sheet-actions">
          <button className="m-btn primary" disabled={busy || !detail || mine === theirs || (mine === 0 && theirs === 0)} onClick={submit}>
            {busy ? '送信中…' : 'この内容で送信'}
          </button>
        </div>
      </div>
    </div>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (next: number) => void }) {
  return (
    <label className="field" style={{ textAlign: 'center' }}>
      <span style={{ fontSize: 11, color: 'var(--ink-500)', fontWeight: 700 }}>{label}</span>
      <input
        className="num" type="number" inputMode="numeric" min={0} max={99} value={value}
        onChange={(event) => onChange(Math.min(99, Math.max(0, Number(event.target.value) || 0)))}
        style={{ height: 52, fontSize: 26, textAlign: 'center', border: '1px solid var(--line-strong)', borderRadius: 10, fontFamily: 'var(--mono)', width: '100%' }}
      />
    </label>
  );
}
