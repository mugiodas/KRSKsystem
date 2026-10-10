import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Loader2, Wand2 } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { LeaguePreview, LeagueProgress } from '../../api/types';
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
  const [progress, setProgress] = useState<LeagueProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grouped, setGrouped] = useState(true);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextPreview, nextProgress] = await Promise.all([api.leaguePreview(eventId), api.leagueProgress(eventId)]);
      setPreview(nextPreview);
      setProgress(nextProgress);
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
          {progress && progress.applicable ? <LeagueProgressBox progress={progress} /> : null}
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

const fmtMinutes = (value: number) => (value >= 60 ? `${Math.floor(value / 60)}時間${Math.round(value % 60)}分` : `${Math.round(value)}分`);

/**
 * Plan vs reality for the league phase, straight from the same round-robin slicing the
 * generator uses. Generation is only half the job: the operator also needs to know
 * whether the promised cards can still be played before the hall closes.
 */
function LeagueProgressBox({ progress }: { progress: LeagueProgress }) {
  const roundsPlanned = progress.classes.reduce((sum, entry) => sum + entry.roundsPlanned, 0);
  const roundsFinished = progress.classes.reduce((sum, entry) => sum + entry.roundsFinished, 0);
  const listed = progress.shortfalls.slice(0, 8);
  const tone = progress.status === 'WONT_FIT' ? 'urgent' : progress.status === 'BEHIND' ? 'warn' : 'ok';
  return (
    <div className="league-progress">
      <div className="league-progress-head">
        <div>
          <span className="label">いまの消化</span>
          <span className="num big">{progress.completedMatches}/{progress.plannedMatches}試</span>
          <span className="muted">
            {Math.round(progress.completionRate * 100)}% ・ {roundsFinished}/{roundsPlanned}回戦完了 ・
            {progress.courtCount}コート ・ 1回戦 約{fmtMinutes(progress.slotMinutes)}
          </span>
        </div>
        <Chip tone={tone}>
          {progress.status === 'ON_TRACK' ? '計画どおり'
            : progress.status === 'BEHIND' ? `計画より ${progress.roundsOutstanding}回戦 遅れ`
              : '残り時間で消化しきれない'}
        </Chip>
      </div>
      <div className="league-progress-bar"><i style={{ width: `${Math.min(100, progress.completionRate * 100)}%` }} /></div>
      {progress.playersUnderTarget > 0 ? (
        <div className="league-shortfall">
          <b>計画に届いていない選手 {progress.playersUnderTarget}名</b>
          <ul>
            {listed.map((row) => (
              <li key={row.participantId}>
                <span className="name">{row.name}</span>
                <span className="muted">{row.className}</span>
                <span className="num">{row.played + row.scheduled}/{row.target}試</span>
                <span className="miss">不足 {row.shortfall}試</span>
              </li>
            ))}
          </ul>
          {progress.shortfalls.length > listed.length ? (
            <span className="muted">他 {progress.shortfalls.length - listed.length}名</span>
          ) : null}
          <p className="hint">
            必要 {fmtMinutes(progress.minutesNeeded)} / 残り {fmtMinutes(progress.minutesRemaining)}。
            {progress.status === 'WONT_FIT'
              ? ' コートを増やす、設定で計画試数を減らす、またはリーグ戦をここで終了して対戦希望に切り替えてください。'
              : ' 自動マッチングは試合数の少ない選手を優遇してカードを作りますが、計画自体を変えるには設定の「リーグ戦試数」を調整してください。'}
          </p>
        </div>
      ) : (
        <p className="hint">全選手の計画消化が揃っています（作成済みまたは予定のカードを含めて {progress.plannedMatches}試）。</p>
      )}
    </div>
  );
}
