import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { clockTime } from '../../lib/time';
import { Chip, Empty } from '../ui';

interface AuditRow {
  auditId: number;
  actorName: string | null;
  entityType: string;
  entityId: string;
  action: string;
  createdAt: string;
  beforeJson: string | null;
  afterJson: string | null;
}

/** Operators need to answer "who changed this match?" while the event runs. */
export function AuditPanel({ eventId }: { eventId: string }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    api.audit(eventId, 120)
      .then((data) => setRows(data as unknown as AuditRow[]))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [eventId]);

  return (
    <section className="panel" id="audit">
      <header className="panel-head">
        <h2>AUDIT LOG</h2>
        <Chip>{rows.length}件</Chip>
        <span className="spacer" />
        <span className="hint">状態遷移・手動上書き・結果修正の記録</span>
      </header>
      <div className="panel-body" style={{ padding: 0, maxHeight: '58vh' }}>
        {loading ? <Empty>読込中…</Empty> : rows.length === 0 ? <Empty>まだ記録がありません。</Empty> : (
          <table className="grid-table">
            <thead>
              <tr>
                <th style={{ width: 56 }}>時刻</th>
                <th style={{ width: 110 }}>操作者</th>
                <th style={{ width: 88 }}>対象</th>
                <th style={{ width: 110 }}>操作</th>
                <th>詳細</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.auditId} style={{ cursor: 'pointer' }} onClick={() => setExpanded(expanded === row.auditId ? null : row.auditId)}>
                  <td className="num muted">{clockTime(row.createdAt)}</td>
                  <td>{row.actorName ?? 'システム'}</td>
                  <td><Chip>{row.entityType}</Chip></td>
                  <td><b style={{ fontSize: 11.5 }}>{row.action}</b></td>
                  <td className="muted" style={{ fontSize: 11, fontFamily: 'var(--mono)' }}>
                    {expanded === row.auditId
                      ? <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 10.5 }}>{`before: ${row.beforeJson ?? '-'}\nafter: ${row.afterJson ?? '-'}`}</pre>
                      : row.entityId}
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
