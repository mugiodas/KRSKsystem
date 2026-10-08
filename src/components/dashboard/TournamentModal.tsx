import { useEffect, useState } from 'react';
import { CalendarClock, Loader2, Network } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { TournamentPreview, TournamentPreviewClass } from '../../api/types';
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
 * Preview before Generate, exactly like the league switch: the operator sees the seeded
 * draw, the bye list, the round count and the projected playing time, and nothing is
 * written to the database until a class is confirmed here.
 */
export function TournamentModal({ eventId, canOperate, endTime, onClose, onGenerated }: Props) {
  const toast = useToast();
  const [preview, setPreview] = useState<TournamentPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setPreview(await api.tournamentPreview(eventId));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'プレビューの生成に失敗しました。');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [eventId]);

  const playable = (preview?.classes ?? []).filter((entry) => entry.reason === null);

  async function generate(classes: TournamentPreviewClass[]) {
    if (classes.length === 0) return;
    setGenerating(classes.map((entry) => entry.classId).join(','));
    try {
      let cards = 0;
      let walkovers = 0;
      for (const entry of classes) {
        const result = await api.tournamentGenerate(eventId, entry.classId);
        cards += result.created.length;
        walkovers += result.walkovers.length;
      }
      toast.push(`トーナメント表を作成しました（初回カード ${cards}枚・不戦勝 ${walkovers}名）`);
      onGenerated();
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '生成に失敗しました。');
    } finally {
      setGenerating(null);
    }
  }

  return (
    <Modal
      title="トーナメント表 生成プレビュー"
      subtitle="シード順・不戦勝・終了時刻の見込みを確認してから確定します"
      onClose={onClose}
      size="wide"
      footer={(
        <>
          <button className="btn" onClick={() => void load()}>やり直す</button>
          <span style={{ marginRight: 'auto', fontSize: 11, color: 'var(--ink-500)' }}>
            {preview ? `${playable.length}クラス / 決勝まで ${preview.summary.matchCount}枚 / 1ラウンド ${preview.summary.perRoundMinutes}分` : ''}
          </span>
          {canOperate ? (
            <button className="btn primary" disabled={loading || generating !== null || playable.length === 0} onClick={() => void generate(playable)}>
              {generating !== null ? <Loader2 size={13} /> : <Network size={13} />}Generate Bracket（{playable.length}クラス）
            </button>
          ) : <span className="chip warn">生成権限がありません</span>}
        </>
      )}
    >
      {error ? <div className="notice error">{error}</div> : null}
      {loading ? <Empty>ドローを計算しています…</Empty> : !preview ? <Empty>プレビューを作成できませんでした。</Empty> : (
        <>
          <div className="kv">
            <div><dt>クラス数</dt><dd>{preview.summary.classCount}</dd></div>
            <div><dt>チェックイン済</dt><dd>{preview.summary.entrants}</dd></div>
            <div><dt>必要試合数</dt><dd style={{ color: 'var(--navy-800)' }}>{preview.summary.matchCount}</dd></div>
            <div><dt>1ラウンド見込</dt><dd>{preview.summary.perRoundMinutes}分</dd></div>
            <div><dt>大会終了</dt><dd>{clockTime(endTime)}</dd></div>
            <div><dt>作れないクラス</dt><dd style={{ color: preview.summary.blockedClasses > 0 ? 'var(--urgent)' : undefined }}>
              {preview.summary.blockedClasses}
            </dd></div>
          </div>
          {preview.classes.map((entry) => (
            <section key={entry.classId} className="bkt-preview">
              <header>
                <b>{entry.className}</b>
                <span className="muted">
                  {entry.entrants.length}名 → {entry.size}ドロー・{entry.rounds}回戦・優勝まで {entry.requiredMatches}枚（約 {entry.estimatedMinutes}分）
                </span>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                  {entry.reason
                    ? <Chip tone="urgent"><CalendarClock size={11} />作れません</Chip>
                    : <Chip tone="ok">終了時刻に内</Chip>}
                  {canOperate && entry.reason === null ? (
                    <button className="btn sm primary" disabled={generating !== null} onClick={() => void generate([entry])}>
                      このクラスを生成
                    </button>
                  ) : null}
                </span>
              </header>
              {entry.reason ? <div className="notice warn">{entry.reason}</div> : null}
              <ol className="bkt-seedline">
                {entry.entrants.map((entrant) => (
                  <li key={entrant.participantId}>
                    <span className="num">{entrant.seed}</span>
                    <span className="name">{entrant.name}</span>
                    {entrant.seed <= entry.byes ? <Chip>1回戦 不戦勝</Chip> : null}
                  </li>
                ))}
              </ol>
              <p className="hint">
                初回で作られるカードは {entry.roundOneCards}枚、不戦勝 {entry.byes}名は上位シードに割り当たります。
                次のカードは両側の勝者が決まった時点で自動生成され、コート割当は通常エンジンが既存キューと同じ列で面倒を見ます。
              </p>
            </section>
          ))}
        </>
      )}
    </Modal>
  );
}
