import { useMemo, useState } from 'react';
import { Loader2, Pause, Play, StopCircle } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { EventDetail } from '../../api/types';
import { Chip, Modal, useToast } from '../ui';

interface Props {
  event: EventDetail;
  onClose: () => void;
  onSaved: () => void;
}

interface WeightField {
  key: keyof EventDetail;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  negative?: boolean;
}

const WEIGHTS: WeightField[] = [
  { key: 'weightRequestPriority', label: '対戦希望', hint: '希望が叶ったカードの加点', min: 0, max: 100, step: 1 },
  { key: 'weightWaiting', label: '待ち時間', hint: '大会平均に対する待機の強さ', min: 0, max: 20, step: 0.1 },
  { key: 'weightMatchBalance', label: '試合数バランス', hint: '試合数の差を埋める力', min: 0, max: 100, step: 1 },
  { key: 'weightUnplayed', label: '未対戦ボーナス', hint: 'まだ組んでいない相手', min: 0, max: 100, step: 1 },
  { key: 'weightRating', label: '実力差', hint: 'レーティングが近いほど加点', min: 0, max: 100, step: 1 },
  { key: 'weightTimeFit', label: '残り時間適合', hint: '終了時刻に収まる余地', min: 0, max: 100, step: 1 },
  { key: 'penaltyRecent', label: '直近試合ペナルティ', hint: 'たった今終わった選手の減点', min: 0, max: 100, step: 1, negative: true },
  { key: 'penaltyRepeat', label: '再戦ペナルティ', hint: '同一カードの反復を抑制', min: 0, max: 100, step: 1, negative: true },
];

const FLAGS: Array<{ key: keyof EventDetail; label: string; hint: string }> = [
  { key: 'autoEngineEnabled', label: '自動マッチング', hint: '結果入力や手動更新の後にエンジンを自動で回す' },
  { key: 'autoCourtAssignment', label: 'コートの自動割当', hint: '待機カードを空きコートへ自動で載せる' },
  { key: 'allowRequest', label: '対戦希望を受け付ける', hint: '参加者画面から希望を出せる' },
  { key: 'allowRematch', label: '再戦を許可', hint: '同じカードの再作成を認める' },
  { key: 'noShowEnabled', label: 'ノーショー判定', hint: '呼出後に未集合ならノーショー扱い' },
];

/**
 * Every engine weight is per event, so the same build runs a relaxed school
 * session and a competitive tournament without a code change.
 */
export function SettingsModal({ event, onClose, onSaved }: Props) {
  const toast = useToast();
  const [draft, setDraft] = useState<Record<string, number>>(() => Object.fromEntries(
    WEIGHTS.map((field) => [field.key, Number(event[field.key])]),
  ));
  const [flags, setFlags] = useState<Record<string, boolean>>(() => Object.fromEntries(
    FLAGS.map((field) => [field.key, Number(event[field.key]) === 1]),
  ));
  const [numbers, setNumbers] = useState({
    defaultMatchMinutes: Number(event.defaultMatchMinutes),
    minimumRestMinutes: Number(event.minimumRestMinutes),
    resultInputGraceMinutes: Number(event.resultInputGraceMinutes),
    resultConfirmTimeoutMinutes: Number(event.resultConfirmTimeoutMinutes ?? 3),
    safetyMarginMinutes: Number(event.safetyMarginMinutes),
    leagueMatchCount: Number(event.leagueMatchCount),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(() => Object.entries(draft).some(([key, value]) => Number(event[key as keyof EventDetail]) !== value)
    || Object.entries(flags).some(([key, value]) => (Number(event[key as keyof EventDetail]) === 1) !== value), [draft, flags, event]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patchEvent(event.eventId, { rowVersion: event.rowVersion, ...draft, ...flags, ...numbers });
      toast.push('大会設定を保存しました。次のエンジン実行から反映されます。');
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '設定の保存に失敗しました。');
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: string) {
    setBusy(true);
    try {
      await api.setStatus(event.eventId, status, event.rowVersion);
      toast.push(`大会ステータスを ${status} に変更しました。`);
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'ステータス変更に失敗しました。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="大会設定 / エンジン重み"
      subtitle="変更はこのイベントにのみ適用されます"
      onClose={onClose}
      footer={(
        <>
          <span style={{ marginRight: 'auto', display: 'flex', gap: 6 }}>
            {event.status !== 'RUNNING' && event.status !== 'COMPLETED' ? (
              <button className="btn" disabled={busy} onClick={() => setStatus('RUNNING')}><Play size={13} />開催中にする</button>
            ) : null}
            {event.status === 'RUNNING' ? (
              <button className="btn" disabled={busy} onClick={() => setStatus('PAUSED')}><Pause size={13} />一時停止</button>
            ) : null}
            {event.status === 'PAUSED' ? (
              <button className="btn" disabled={busy} onClick={() => setStatus('RUNNING')}><Play size={13} />再開</button>
            ) : null}
            {event.status !== 'COMPLETED' ? (
              <button className="btn danger" disabled={busy} onClick={() => setStatus('COMPLETED')}><StopCircle size={13} />大会を終了</button>
            ) : null}
          </span>
          <button className="btn" onClick={onClose}>閉じる</button>
          <button className="btn primary" disabled={!dirty || busy} onClick={save}>{busy ? <Loader2 size={13} /> : null}保存</button>
        </>
      )}
    >
      {error ? <div className="notice error">{error}</div> : null}
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-500)', marginBottom: 6 }}>MatchScore の重み</div>
        <div style={{ display: 'grid', gap: 6 }}>
          {WEIGHTS.map((field) => (
            <div key={String(field.key)} style={{ display: 'grid', gridTemplateColumns: '150px 1fr 74px', gap: 8, alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700 }}>{field.label}{field.negative ? <span style={{ color: 'var(--urgent)', marginLeft: 3 }}>−</span> : <span style={{ color: 'var(--ok)', marginLeft: 3 }}>+</span>}</div>
                <div style={{ fontSize: 10.5, color: 'var(--ink-500)' }}>{field.hint}</div>
              </div>
              <input
                type="range" min={field.min} max={field.max} step={field.step} value={draft[field.key]}
                onChange={(event2) => setDraft((current) => ({ ...current, [field.key]: Number(event2.target.value) }))}
              />
              <input
                className="num" type="number" min={field.min} max={field.max} step={field.step} value={draft[field.key]}
                onChange={(event2) => setDraft((current) => ({ ...current, [field.key]: Number(event2.target.value) }))}
                style={{ height: 26, border: '1px solid var(--line-strong)', borderRadius: 4, textAlign: 'center', fontFamily: 'var(--mono)' }}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="kv">
        {([['defaultMatchMinutes', '1試合(分)'], ['minimumRestMinutes', '最低休憩(分)'], ['resultInputGraceMinutes', '結果入力猶予(分)'], ['resultConfirmTimeoutMinutes', '結果の自動確定(分)'],
          ['safetyMarginMinutes', '安全マージン(分)'], ['leagueMatchCount', 'リーグ試合数/人']] as const).map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>
              <input
                className="num" type="number" min={0} max={180} value={numbers[key]}
                onChange={(event2) => setNumbers((current) => ({ ...current, [key]: Number(event2.target.value) }))}
                style={{ width: 62, height: 24, border: '1px solid var(--line-strong)', borderRadius: 4, textAlign: 'center', fontFamily: 'var(--mono)' }}
              />
            </dd>
          </div>
        ))}
      </div>
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-500)', marginBottom: 6 }}>運用スイッチ</div>
        <div style={{ display: 'grid', gap: 4 }}>
          {FLAGS.map((field) => (
            <label key={String(field.key)} style={{ display: 'grid', gridTemplateColumns: '18px 1fr auto', gap: 8, alignItems: 'center', padding: '4px 6px', border: '1px solid var(--line)', borderRadius: 5, cursor: 'pointer' }}>
              <input
                type="checkbox" checked={flags[field.key]} style={{ margin: 0 }}
                onChange={(event2) => setFlags((current) => ({ ...current, [field.key]: event2.target.checked }))}
              />
              <span><b style={{ fontSize: 12 }}>{field.label}</b><span style={{ fontSize: 10.5, color: 'var(--ink-500)', marginLeft: 6 }}>{field.hint}</span></span>
              <Chip tone={flags[field.key] ? 'ok' : ''}>{flags[field.key] ? 'ON' : 'OFF'}</Chip>
            </label>
          ))}
        </div>
      </div>
      <div className="notice info">
        <span>
          現在：1試合 {event.defaultMatchMinutes}分 + 結果入力 {event.resultInputGraceMinutes}分 + 安全マージン {event.safetyMarginMinutes}分
          ＝ <b>{Number(event.defaultMatchMinutes) + Number(event.resultInputGraceMinutes) + Number(event.safetyMarginMinutes)}分</b> を1枠として終了時刻保護に使用します。
        </span>
      </div>
    </Modal>
  );
}
