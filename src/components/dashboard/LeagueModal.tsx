import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Loader2, Wand2 } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { LeaguePreview } from '../../api/types';
import { clockTime } from '../../lib/time';
import { Chip, Empty, Modal, useToast } from '../ui';

interface Props {
  eventId: string;
  canOperate: boolean;
  endTime: string;
  onClose: () => void;
  onGenerated: () => void;
}

/**
 * Spec requires a preview before any league generation. Nothing is written to
 * the database until the operator confirms this exact list.
 */
export function LeagueModal({ eventId, canOperate, endTime, onClose, onGenerated }: Props) {
  const toast = useToast();
  const [preview, setPreview] = useState<LeaguePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grouped, setGrouped] = useState(true);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setPreview(await api.leaguePreview(eventId));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'プレビューの生成に失敗しました。');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [eventId]);

  const creatable = preview?.pairs.filter((pair) => !pair.existing && pair.fitsBeforeEnd) ?? [];
  const rounds = useMemo(() => {
    const map = new Map<number, typeof creatable>();
    for (const pair of creatable) map.set(pair.round, [...(map.get(pair.round) ?? []), pair]);
    return [...map.entries()].sort((left, right) => left[0] - right[0]);
  }, [creatable]);

  async function generate() {
    setGenerating(true);
    try {
      const result = await api.leagueGenerate(eventId);
      toast.push(`リーグ戦 ${result.createdCount}試合を作成しました（重複 ${result.skippedDuplicate}・時間切れ ${result.skippedEndTime}）`);
      onGenerated();
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '生成に失敗しました。');
    } finally {
      setGenerating(false);
    }
  }

  return (
    <Modal
      title="リーグ戦 生成プレビュー"
      subtitle="確定するまで大会データには何も書き込まれません"
      onClose={onClose}
      footer={(
        <>
          <button className="btn" onClick={() => void load()}>やり直す</button>
          <span style={{ marginRight: 'auto', fontSize: 11, color: 'var(--ink-500)' }}>
            {preview ? `全 ${preview.pairs.length}カード中 ${creatable.length}件を新規作成` : ''}
          </span>
          {canOperate ? (
            <button className="btn primary" disabled={loading || generating || creatable.length === 0} onClick={generate}>
              {generating ? <Loader2 size={13} /> : <Wand2 size={13} />}Generate Matches（{creatable.length}）
            </button>
          ) : <span className="chip warn">生成権限がありません</span>}
        </>
      )}
    >
      {error ? <div className="notice error">{error}</div> : null}
      {loading ? <Empty>ラウンドロビンを計算しています…</Empty> : !preview ? <Empty>プレビューを作成できませんでした。</Empty> : (
        <>
          <div className="kv">
            <div><dt>参加者</dt><dd>{preview.summary.participantCount}</dd></div>
            <div><dt>クラス数</dt><dd>{preview.summary.classCount}</dd></div>
            <div><dt>作成予定</dt><dd style={{ color: 'var(--navy-800)' }}>{preview.summary.matchCount}</dd></div>
            <div><dt>既存と重複</dt><dd>{preview.summary.duplicateCount}</dd></div>
            <div><dt>時間切れ除外</dt><dd style={{ color: preview.summary.excludedByEndTime > 0 ? 'var(--urgent)' : undefined }}>{preview.summary.excludedByEndTime}</dd></div>
            <div><dt>大会終了</dt><dd>{clockTime(endTime)}</dd></div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label className="hint" style={{ display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={grouped} onChange={(event) => setGrouped(event.target.checked)} style={{ margin: 0 }} />
              ラウンドごとにまとめる
            </label>
            <span className="spacer" style={{ flex: '1 1 auto' }} />
            {preview.summary.excludedByEndTime > 0 ? (
              <Chip tone="warn"><CalendarClock size={11} />終了時刻に間に合わない {preview.summary.excludedByEndTime}件はスキップされます</Chip>
            ) : <Chip tone="ok">全カードが終了時刻に収まります</Chip>}
          </div>
          <div style={{ maxHeight: '46vh', overflow: 'auto', border: '1px solid var(--line)', borderRadius: 6 }}>
            <table className="grid-table">
              <thead>
                <tr>
                  <th style={{ width: 64 }}>R</th>
                  <th style={{ width: 66 }}>クラス</th>
                  <th>対戦カード</th>
                  <th style={{ width: 62 }}>予定</th>
                  <th style={{ width: 62 }}>終了見込</th>
                  <th style={{ width: 68 }}>状態</th>
                </tr>
              </thead>
              <tbody>
                {(grouped ? rounds.flatMap(([round, pairs]) => pairs.map((pair) => ({ ...pair, roundLabel: `R${round}` })))
                  : preview.pairs.map((pair) => ({ ...pair, roundLabel: `R${pair.round}` })))
                  .slice(0, 400)
                  .map((pair, index) => {
                    const skip = pair.existing || !pair.fitsBeforeEnd;
                    return (
                      <tr key={`${pair.round}-${pair.playerAId}-${pair.playerBId}-${index}`} style={{ opacity: skip ? 0.55 : 1 }}>
                        <td className="num muted">{pair.roundLabel}</td>
                        <td className="muted">{pair.className}</td>
                        <td><span className="name">{pair.playerAName}</span><span className="muted"> × </span><span className="name">{pair.playerBName}</span></td>
                        <td className="num muted">{clockTime(pair.scheduledTime)}</td>
                        <td className="num muted">{clockTime(pair.estimatedEndTime)}</td>
                        <td>{pair.existing ? <Chip>作成済</Chip> : !pair.fitsBeforeEnd ? <Chip tone="urgent">時間外</Chip> : <Chip tone="ok">作成</Chip>}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
