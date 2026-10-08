import { useEffect, useMemo, useState } from 'react';
import { Eye, Loader2, PlayCircle } from 'lucide-react';
import { api, ApiError, type ExplainResponse } from '../../api/client';
import type { EngineCandidate, EngineRunResult } from '../../api/types';
import { Chip, Empty, Modal, useToast } from '../ui';

interface Props {
  eventId: string;
  classes: Array<{ classId: string; className: string }>;
  canOperate: boolean;
  /** Set when the operator opens the modal from a court card to ask "why this pair". */
  explainMatchId?: string | null;
  onClose: () => void;
  onChanged: () => void;
}

export const BREAKDOWN_LABEL: Record<string, string> = {
  requestPriority: '対戦希望', waitingScore: '待ち時間', matchCountBalance: '試合数バランス',
  unplayedBonus: '未対戦ボーナス', ratingCompatibility: '実力差', remainingTimeFit: '残り時間',
  recentMatchPenalty: '直近試合ペナルティ', repeatPenalty: '再戦ペナルティ', total: '総合',
};

export function BreakdownChips({ breakdown }: { breakdown: EngineCandidate['breakdown'] }) {
  return (
    <div className="score-grid" style={{ maxWidth: 360 }}>
      {Object.entries(breakdown).filter(([key]) => key !== 'total' && key !== 'notes').map(([key, value]) => (
        <div key={key} className={Number(value) < 0 ? 'neg' : ''}>
          <span>{BREAKDOWN_LABEL[key] ?? key}</span><b>{Number(value) > 0 ? `+${Number(value).toFixed(1)}` : Number(value).toFixed(1)}</b>
        </div>
      ))}
    </div>
  );
}

/**
 * The engine is not a black box here: preview shows the exact ranked list the
 * allocator will consume, and explain answers "why this pair and not another".
 */
export function EngineModal({ eventId, classes, canOperate, explainMatchId, onClose, onChanged }: Props) {
  const toast = useToast();
  const [preview, setPreview] = useState<EngineRunResult | null>(null);
  const [runResult, setRunResult] = useState<EngineRunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [explain, setExplain] = useState<ExplainResponse | null>(null);
  const [classId, setClassId] = useState('');

  async function run(dry: boolean) {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = classId ? { classId } : {};
      if (dry) {
        setPreview(await api.enginePreview(eventId, body));
      } else {
        const result = await api.engineRun(eventId, body);
        setRunResult(result);
        setPreview(result);
        const assigned = result.created.length + result.assignedQueue.length;
        toast.push(assigned > 0
          ? `エンジン実行：新規 ${result.created.length}試合を作成、${result.assignedQueue.length}件をコートへ割当`
          : 'エンジン実行：割当可能なカードはありませんでした');
        onChanged();
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'エンジン実行に失敗しました。');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void run(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [classId]);

  useEffect(() => {
    if (!explainMatchId) { setExplain(null); return; }
    void api.engineExplain(eventId, explainMatchId).then(setExplain).catch(() => setExplain(null));
  }, [eventId, explainMatchId]);

  const candidates = preview?.candidates ?? [];
  const blockedCounts = useMemo(() => Object.entries(preview?.blockedCounts ?? {}).sort((left, right) => right[1] - left[1]), [preview]);

  return (
    <Modal
      title={explainMatchId ? 'このカードが選ばれた理由' : 'マッチングエンジン'}
      subtitle={`評価ペア ${preview?.evaluatedPairs ?? 0}組・空きコート ${preview?.freeCourts ?? 0}面・待機可能 ${preview?.skippedReasons ? '' : ''}`}
      onClose={onClose}
      footer={(
        <>
          {classes.length > 1 && !explainMatchId ? (
            <select value={classId} onChange={(event) => setClassId(event.target.value)} style={{ height: 28, marginRight: 'auto', border: '1px solid var(--line-strong)', borderRadius: 6, padding: '0 8px', fontSize: 12 }}>
              <option value="">全クラス</option>
              {classes.map((item) => <option key={item.classId} value={item.classId}>{item.className}のみ</option>)}
            </select>
          ) : <span style={{ marginRight: 'auto', fontSize: 11, color: 'var(--ink-500)' }}>プレビューは実際の割当と同じ候補順を表示しています</span>}
          <button className="btn" disabled={busy} onClick={() => run(true)}><Eye size={13} />プレビュー再計算</button>
          {canOperate && !explainMatchId ? (
            <button className="btn primary" disabled={busy || candidates.length === 0} onClick={() => run(false)}>
              {busy ? <Loader2 size={13} /> : <PlayCircle size={13} />}エンジン実行で割当
            </button>
          ) : null}
        </>
      )}
    >
      {error ? <div className="notice error">{error}</div> : null}
      {runResult ? (
        <div className="notice info">
          <span>
            実行完了：新規作成 <b>{runResult.created.length}</b> 試合／待機カードのコート割当 <b>{runResult.assignedQueue.length}</b> 件
            {runResult.endedByTimeProtection ? '・終了時刻保護により以降の作成を停止' : ''}
          </span>
        </div>
      ) : null}
      {runResult && runResult.created.length > 0 ? (
        <div style={{ display: 'grid', gap: 4 }}>
          {runResult.created.map((item) => (
            <div key={item.matchId} style={{ fontSize: 11.5, display: 'flex', gap: 8, alignItems: 'center', border: '1px solid var(--ok)', background: 'var(--ok-bg)', borderRadius: 6, padding: '4px 8px' }}>
              <Chip tone="ok">作成</Chip>
              <b>{item.playerAName} × {item.playerBName}</b>
              <span className="muted">{item.courtName}</span>
              <span style={{ marginLeft: 'auto' }} className="num">score {item.score.toFixed(1)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {explain ? (
        <div style={{ border: '1px solid var(--line)', borderRadius: 6, padding: 8, background: 'var(--surface-alt)' }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 5 }}>
            {explain.playerA?.name ?? '?'} × {explain.playerB?.name ?? '?'}
            <span className="muted" style={{ fontWeight: 400, marginLeft: 6 }}>
              {explain.candidateCount ?? 0}組中 {explain.rank ?? '-'}位
            </span>
          </div>
          {explain.breakdown ? (
            <>
              <BreakdownChips breakdown={explain.breakdown} />
              {explain.breakdown.notes?.length ? (
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--ink-700)' }}>{explain.breakdown.notes.map((note) => `・${note}`).join('  ')}</div>
              ) : null}
              <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11, color: 'var(--ink-500)' }}>
                <span className="chip">A {explain.playerA?.played ?? 0}試合・待ち {Math.round(explain.playerA?.waitingMinutes ?? 0)}分</span>
                <span className="chip">B {explain.playerB?.played ?? 0}試合・待ち {Math.round(explain.playerB?.waitingMinutes ?? 0)}分</span>
                <span className="chip">実力差 {Math.abs((explain.playerA?.rating ?? 0) - (explain.playerB?.rating ?? 0))}</span>
              </div>
            </>
          ) : <div style={{ fontSize: 11.5, color: 'var(--ink-500)' }}>この試合はエンジン外（手動作成など）で作られたため採点記録がありません。</div>}
        </div>
      ) : null}
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-500)', marginBottom: 5 }}>
          {explainMatchId ? '次の候補（現在の状況でエンジンが選び順）' : '候補ランキング'}
        </div>
        {candidates.length === 0
          ? <Empty>現在、全ハード条件を満たす対戦カードがありません。待機選手・休憩・コートの空き状況を確認してください。</Empty>
          : (
            <div style={{ display: 'grid', gap: 5 }}>
              {candidates.slice(0, 10).map((candidate, index) => (
                <div
                  key={`${candidate.playerAId}-${candidate.playerBId}`}
                  style={{
                    display: 'grid', gridTemplateColumns: '26px 1fr auto', gap: 8, alignItems: 'center',
                    border: '1px solid var(--line)', borderRadius: 6, padding: '6px 8px',
                    background: index === 0 ? 'var(--blue-050)' : '#fff',
                  }}
                >
                  <span className="num" style={{ fontWeight: 700, color: index === 0 ? 'var(--navy-800)' : 'var(--ink-500)' }}>#{index + 1}</span>
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 700 }}>
                      {candidate.playerAName} <span className="muted" style={{ fontWeight: 400 }}>×</span> {candidate.playerBName}
                    </div>
                    <div style={{ display: 'flex', gap: 5, marginTop: 2, flexWrap: 'wrap' }}>
                      <span className="chip">待ち {Math.round(candidate.pairWaitingMinutes)}分</span>
                      <span className="chip">実力差 {candidate.ratingDiff}</span>
                      {candidate.mutual ? <span className="chip blue">相互希望</span> : null}
                      {candidate.requestPriority ? <span className="chip ok">希望 P{candidate.requestPriority}</span> : null}
                      {candidate.repeats > 0 ? <span className="chip warn">対戦済 {candidate.repeats}回</span> : null}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="num" style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy-800)' }}>{candidate.score.toFixed(1)}</div>
                    {candidate.breakdown.notes?.[0] ? <div style={{ fontSize: 10, color: 'var(--ink-500)', maxWidth: 160 }}>{candidate.breakdown.notes[0]}</div> : null}
                  </div>
                </div>
              ))}
            </div>
          )}
      </div>
      {blockedCounts.length > 0 ? (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-500)', marginBottom: 4 }}>ブロックされたペアの内訳（今パス）</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {blockedCounts.map(([code, count]) => <Chip key={code}>{code} × {count}</Chip>)}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
