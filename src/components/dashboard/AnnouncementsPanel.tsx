import { useCallback, useEffect, useMemo, useState } from 'react';
import { Megaphone, Send, Zap } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { AnnouncementRow } from '../../api/types';
import { CLOSING_NOTICE_WINDOW_MINUTES, type QuickBroadcast } from '../../lib/alerts';
import { formatDateTime, minutesBetween, parseIso } from '../../lib/time';
import { Chip, Empty, useToast } from '../ui';

/** A card still waiting on somebody: the court it occupies and who owes what. */
export interface PendingCard {
  courtName: string;
  label: string;
}

interface Props {
  eventId: string;
  canOperate: boolean;
  /** Event end time (ISO) — the closing notice states the real remaining minutes. */
  endTime?: string;
  /** The same clock the board counts on, so the number matches what is on screen. */
  nowMs?: number;
  /** RESULT_PENDING cards: the players owe a score. */
  resultPending?: PendingCard[];
  /** ENTERED claims: the opponent owes a confirmation. */
  unconfirmed?: PendingCard[];
  /** An alert sent the operator here with a template already chosen. */
  preselect?: QuickBroadcast | null;
  onPreselect?: (value: QuickBroadcast | null) => void;
}

const SEVERITIES: Array<AnnouncementRow['severity']> = ['INFO', 'IMPORTANT', 'URGENT'];
const SEVERITY_LABEL: Record<AnnouncementRow['severity'], string> = { INFO: '連絡', IMPORTANT: '重要', URGENT: '緊急' };
interface QuickTemplate {
  key: QuickBroadcast;
  title: string;
  body: string;
  severity: AnnouncementRow['severity'];
  why: string;
}

/** Lists the courts involved without turning the notice into a wall of names. */
function courtList(cards: PendingCard[]): string {
  const named = cards.slice(0, 3).map((card) => card.courtName).join('・');
  const rest = cards.length - 3;
  return rest > 0 ? `${named} 他${rest}面` : named;
}

/**
 * Whatever the operator posts here is what the participant phone shows in its
 * 連絡 tab — one write path, one read path, no separate broadcast system.
 *
 * Three notices cover almost every event, and their wording depends on numbers
 * that only the board knows (minutes left, how many courts are blocked), so they
 * are built here from live data and go out on one click.
 */
export function AnnouncementsPanel({
  eventId, canOperate, endTime, nowMs, resultPending = [], unconfirmed = [], preselect = null, onPreselect,
}: Props) {
  const toast = useToast();
  const [rows, setRows] = useState<AnnouncementRow[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<AnnouncementRow['severity']>('INFO');
  const [busy, setBusy] = useState<QuickBroadcast | 'manual' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api.announcements(eventId, true).then(setRows).catch(() => setRows([])), [eventId]);
  useEffect(() => { void load(); }, [load]);

  const templates = useMemo<QuickTemplate[]>(() => {
    const foundry: QuickTemplate[] = [];
    const remaining = endTime ? minutesBetween(nowMs ?? Date.now(), parseIso(endTime) ?? nowMs ?? Date.now()) : null;
    // Only once it is actually close — the same window the alert uses, so the
    // panel never offers a notice that the board would not have flagged.
    if (remaining !== null && remaining > 0 && remaining <= CLOSING_NOTICE_WINDOW_MINUTES) {
      foundry.push({
        key: 'CLOSING',
        title: '終了時刻が迫っています',
        body: `本日の試合は残り約${Math.round(remaining)}分で終了します。いまコートのカードを最終試合として、終了時刻までに結果入力と相手の確認をお願いします。これ以上新しい試合は作成しません。`,
        severity: 'IMPORTANT',
        why: `終了時刻まで残り ${Math.round(remaining)}分`,
      });
    }
    if (resultPending.length > 0) {
      foundry.push({
        key: 'RESULTS',
        title: '結果の入力をお願いします',
        body: `結果が未入力の試合が${resultPending.length}件あります（${courtList(resultPending)}）。スコアの入力と相手の確認ができるまでコートは空きません。`,
        severity: 'IMPORTANT',
        why: `${resultPending.length}面が結果待ち`,
      });
    }
    if (unconfirmed.length > 0) {
      foundry.push({
        key: 'UNCONFIRMED',
        title: '結果の確定をお願いします',
        body: `相手の確定待ちの試合が${unconfirmed.length}件あります（${courtList(unconfirmed)}）。申告内容に間違いがなければ「これで確定」を押してください。確定するまでコートは空きません。`,
        severity: 'URGENT',
        why: `${unconfirmed.length}件が確定待ち`,
      });
    }
    return foundry;
  }, [endTime, nowMs, resultPending, unconfirmed]);

  // Arriving from an alert pre-fills the composer instead of firing blind.
  useEffect(() => {
    const template = preselect ? templates.find((item) => item.key === preselect) : undefined;
    if (!template) return;
    setTitle(template.title);
    setBody(template.body);
    setSeverity(template.severity);
    onPreselect?.(null);
    document.getElementById('announcements')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [preselect, templates, onPreselect]);

  const post = useCallback(async (sendTitle: string, sendBody: string, sendSeverity: AnnouncementRow['severity']) => {
    setError(null);
    try {
      await api.createAnnouncement(eventId, sendTitle, sendBody, sendSeverity);
      await load();
      toast.push('お知らせを配信しました。参加者画面へ即座に反映されます。');
      return true;
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '配信に失敗しました。');
      return false;
    }
  }, [eventId, load, toast]);

  async function send() {
    setBusy('manual');
    const sent = await post(title.trim(), body.trim(), severity);
    if (sent) { setTitle(''); setBody(''); setSeverity('INFO'); }
    setBusy(null);
  }

  async function sendQuick(template: QuickTemplate) {
    setBusy(template.key);
    await post(template.title, template.body, template.severity);
    setBusy(null);
  }

  async function toggle(row: AnnouncementRow) {
    await api.patchAnnouncement(eventId, row.announcementId, { active: row.active === 1 ? 0 : 1 });
    await load();
  }

  return (
    <section className="panel" id="announcements">
      <header className="panel-head">
        <h2>ANNOUNCEMENTS</h2>
        <Chip>{rows.filter((row) => row.active === 1).length} 配信中</Chip>
        <span className="spacer" />
        <span className="hint">参加者のスマホ画面「連絡」に表示されます</span>
      </header>
      <div className="panel-body">
        {error ? <div className="notice error" style={{ marginBottom: 8 }}>{error}</div> : null}
        {canOperate && templates.length > 0 ? (
          <div className="quick-cast" data-testid="quick-cast">
            <div className="quick-cast-head">
              <Zap size={12} />
              <span>ワンクリック配信</span>
              <span className="hint">数字は現在のボードから自動で入ります</span>
            </div>
            {templates.map((template) => (
              <div className="quick-cast-row" data-quick={template.key} key={template.key}>
                <div className="quick-cast-text">
                  <b>{template.title}<Chip tone={template.severity === 'URGENT' ? 'urgent' : 'warn'}>{SEVERITY_LABEL[template.severity]}</Chip></b>
                  <span className="quick-cast-body">{template.body}</span>
                </div>
                <div className="quick-cast-side">
                  <span className="hint">{template.why}</span>
                  <button className="btn primary sm" disabled={busy !== null} onClick={() => void sendQuick(template)}>
                    <Send size={11} />配信
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {canOperate ? (
          <div style={{ display: 'grid', gap: 6, marginBottom: 10, padding: 8, border: '1px dashed var(--line-strong)', borderRadius: 8, background: 'var(--surface-alt)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 6 }}>
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="タイトル（例：17:30で試合作成を終了します）"
                style={{ height: 30, border: '1px solid var(--line-strong)', borderRadius: 6, padding: '0 8px', fontSize: 12.5 }} />
              <select value={severity} onChange={(event) => setSeverity(event.target.value as AnnouncementRow['severity'])}
                style={{ height: 30, border: '1px solid var(--line-strong)', borderRadius: 6, padding: '0 6px', fontSize: 12 }}>
                {SEVERITIES.map((item) => <option key={item} value={item}>{SEVERITY_LABEL[item]}</option>)}
              </select>
            </div>
            <textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="本文" rows={2}
              style={{ border: '1px solid var(--line-strong)', borderRadius: 6, padding: '6px 8px', fontSize: 12.5, resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button className="btn primary sm" disabled={busy !== null || !title.trim() || !body.trim()} onClick={send}><Send size={12} />配信する</button>
              <span className="hint" style={{ fontSize: 11 }}>URGENT にすると参加者画面のタブにバッジが出ます</span>
            </div>
          </div>
        ) : null}
        {rows.length === 0 ? <Empty><Megaphone size={14} /> まだお知らせはありません。</Empty> : (
          <table className="grid-table">
            <thead>
              <tr>
                <th style={{ width: 62 }}>種別</th>
                <th>タイトル / 本文</th>
                <th style={{ width: 110 }}>配信者</th>
                <th style={{ width: 104 }}>時刻</th>
                <th style={{ width: 66 }}>状態</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.announcementId} style={{ opacity: row.active === 1 ? 1 : 0.5 }}>
                  <td><Chip tone={row.severity === 'URGENT' ? 'urgent' : row.severity === 'IMPORTANT' ? 'warn' : 'blue'}>{SEVERITY_LABEL[row.severity]}</Chip></td>
                  <td>
                    <b style={{ fontSize: 12.5 }}>{row.title}</b>
                    <div className="muted" style={{ fontSize: 11.5 }}>{row.body}</div>
                  </td>
                  <td className="muted" style={{ fontSize: 11 }}>{row.actorName ?? '—'}</td>
                  <td className="muted" style={{ fontSize: 11 }}>{formatDateTime(row.createdAt)}</td>
                  <td>
                    {canOperate ? (
                      <button className="btn sm subtle" onClick={() => void toggle(row)}>{row.active === 1 ? '非表示' : '再表示'}</button>
                    ) : <Chip tone={row.active === 1 ? 'ok' : ''}>{row.active === 1 ? '表示中' : '停止'}</Chip>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
