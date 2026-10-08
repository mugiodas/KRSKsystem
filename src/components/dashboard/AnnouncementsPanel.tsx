import { useCallback, useEffect, useState } from 'react';
import { Megaphone, Send } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { AnnouncementRow } from '../../api/types';
import { formatDateTime } from '../../lib/time';
import { Chip, Empty, useToast } from '../ui';

interface Props {
  eventId: string;
  canOperate: boolean;
}

const SEVERITIES: Array<AnnouncementRow['severity']> = ['INFO', 'IMPORTANT', 'URGENT'];
const SEVERITY_LABEL: Record<string, string> = { INFO: '連絡', IMPORTANT: '重要', URGENT: '緊急' };

/**
 * Whatever the operator posts here is what the participant phone shows in its
 * 連絡 tab — one write path, one read path, no separate broadcast system.
 */
export function AnnouncementsPanel({ eventId, canOperate }: Props) {
  const toast = useToast();
  const [rows, setRows] = useState<AnnouncementRow[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<AnnouncementRow['severity']>('INFO');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api.announcements(eventId, true).then(setRows).catch(() => setRows([])), [eventId]);
  useEffect(() => { void load(); }, [load]);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await api.createAnnouncement(eventId, title.trim(), body.trim(), severity);
      setTitle(''); setBody(''); setSeverity('INFO');
      await load();
      toast.push('お知らせを配信しました。参加者画面へ即座に反映されます。');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '配信に失敗しました。');
    } finally {
      setBusy(false);
    }
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
              <button className="btn primary sm" disabled={busy || !title.trim() || !body.trim()} onClick={send}><Send size={12} />配信する</button>
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
