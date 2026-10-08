import { useEffect, useMemo, useState } from 'react';
import { Hand, Plus, Send } from 'lucide-react';
import { api, ApiError, type SuggestionRow } from '../../api/client';
import type { MyMatchView } from '../../api/types';
import { formatDateTime } from '../../lib/time';

const PRIORITY: Array<{ value: 1 | 2 | 3; label: string; hint: string }> = [
  { value: 1, label: '強く希望', hint: 'エンジンが大きく加点' },
  { value: 2, label: '希望', hint: '標準' },
  { value: 3, label: '余裕があれば', hint: '軽め' },
];

export function RequestsTab({ eventId, view, onChanged, canSubmit }: { eventId: string; view: MyMatchView; onChanged: () => void; canSubmit: boolean }) {
  const [picking, setPicking] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestionRow[]>([]);
  const [query, setQuery] = useState('');
  const [priority, setPriority] = useState<1 | 2 | 3>(2);
  const [target, setTarget] = useState<SuggestionRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!picking) return;
    api.suggestions(eventId).then(setSuggestions).catch((caught) => setError(caught instanceof ApiError ? caught.message : '候補を取得できませんでした。'));
  }, [picking, eventId]);

  const list = useMemo(() => {
    const mine = new Set(view.requests.filter((request) => request.status === 'ACTIVE').map((request) => request.targetName));
    return suggestions
      .filter((row) => !mine.has(row.name))
      .filter((row) => !query.trim() || row.name.includes(query.trim()) || (row.className ?? '').includes(query.trim()));
  }, [suggestions, view.requests, query]);

  async function send() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await api.createRequest(eventId, target.participantId, priority);
      setPicking(false); setTarget(null); onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '送信に失敗しました。');
    } finally { setBusy(false); }
  }

  async function cancel(requestId: string, rowVersion: number) {
    try { await api.cancelRequest(eventId, requestId, rowVersion); onChanged(); }
    catch (caught) { setError(caught instanceof ApiError ? caught.message : '取消に失敗しました。'); }
  }

  if (picking) {
    return (
      <div style={{ display: 'grid', gap: 10 }}>
        <article className="m-card">
          <header>誰とやりたいですか？</header>
          <section>
            <input
              placeholder="名前であたりを絞る" value={query} onChange={(event) => setQuery(event.target.value)}
              style={{ width: '100%', height: 42, border: '1px solid var(--line-strong)', borderRadius: 10, padding: '0 12px', fontSize: 15 }}
            />
            <p style={{ fontSize: 11.5, color: 'var(--ink-500)', marginTop: 8 }}>
              対戦が少なく、実力が近く、あなたも指名されている相手から順に表示しています。
            </p>
          </section>
        </article>
        <div className="m-picker">
          {list.length === 0 ? <div className="m-item"><div className="t">候補がみつかりません</div></div> : list.slice(0, 40).map((row) => (
            <button key={row.participantId} className="m-pick" aria-pressed={target?.participantId === row.participantId} onClick={() => setTarget(row)}>
              <span>
                <b style={{ fontSize: 15 }}>{row.name}</b>
                <small>{row.className ?? 'クラスなし'}{row.rating !== undefined ? ` ・ レート ${row.rating}` : ''} ・ これまで {row.played}試合</small>
                <small>{row.headToHead > 0 ? `対戦 ${row.headToHead}回` : '対戦実績なし'}{row.requestedPriority ? ' ・ 相手からも希望あり' : ''}</small>
              </span>
              {row.requestedPriority ? <span className="m-badge ok">相互</span> : null}
            </button>
          ))}
        </div>
        <article className="m-card">
          <header>希望の強さ</header>
          <section>
            <div className="m-seg">
              {PRIORITY.map((option) => (
                <button key={option.value} aria-pressed={priority === option.value} onClick={() => setPriority(option.value)}>
                  {option.label}
                  <span style={{ display: 'block', fontSize: 9.5, fontWeight: 500, opacity: 0.8 }}>{option.hint}</span>
                </button>
              ))}
            </div>
          </section>
        </article>
        {error ? <div className="notice error">{error}</div> : null}
        <div className="m-sheet-actions" style={{ position: 'sticky', bottom: 76 }}>
          <div style={{ display: 'grid', gap: 8 }}>
            <button className="m-btn primary" disabled={!target || busy} onClick={send}><Send size={16} />{target ? `${target.name} へ希望を送る` : '相手を選んでください'}</button>
            <button className="m-btn ghost" onClick={() => { setPicking(false); setError(null); }}>やめる</button>
          </div>
        </div>
      </div>
    );
  }

  const mine = view.requests.filter((request) => request.mine);
  const incoming = view.requests.filter((request) => !request.mine && request.status === 'ACTIVE');

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {view.event.allowRequest && canSubmit ? (
        <button className="m-btn primary" onClick={() => setPicking(true)}><Plus size={16} />対戦したい相手を選ぶ</button>
      ) : (
        <div className="m-notice INFO">この大会では対戦希望の受付を終了しています。</div>
      )}

      <article className="m-card">
        <header>あなたの希望（{mine.length}件）</header>
        <section>
          {mine.length === 0 ? <p style={{ fontSize: 13, color: 'var(--ink-500)' }}>まだ希望はありません。希望はマッチングの材料になり、待機時間と試合数のバランスと合わせて運営エンジンが判断します。</p> : (
            <div className="m-list">
              {mine.map((request) => (
                <div key={request.requestId} className="m-item" style={{ borderLeft: `4px solid ${request.status === 'MATCHED' ? 'var(--ok)' : 'var(--line-strong)'}` }}>
                  <div>
                    <div className="t">{request.targetName} と</div>
                    <div className="s">
                      {request.status === 'MATCHED'
                        ? `成立 — ${request.matchedCourtName ?? 'コート割当済'}${request.matchedScheduledTime ? ` ${formatDateTime(request.matchedScheduledTime)}` : ''}`
                        : request.status === 'ACTIVE' ? '待機中 ・ 相手からも希望があれば優先されます' : `キャンセル済み`}
                    </div>
                  </div>
                  {request.status === 'ACTIVE' ? (
                    <button className="m-btn ghost" style={{ minHeight: 34, padding: '0 10px', fontSize: 12 }} onClick={() => cancel(request.requestId, request.rowVersion)}>
                      <Hand size={13} />取下げ
                    </button>
                  ) : <span className="score" style={{ fontSize: 12, color: request.status === 'MATCHED' ? 'var(--ok)' : 'var(--ink-500)' }}>
                    {request.status === 'MATCHED' ? '決定' : '—'}
                  </span>}
                </div>
              ))}
            </div>
          )}
        </section>
      </article>

      {incoming.length > 0 ? (
        <article className="m-card">
          <header>あなたへの希望（{incoming.length}件）</header>
          <section>
            <div className="m-list">
              {incoming.map((request) => (
                <div key={request.requestId} className="m-item">
                  <div>
                    <div className="t">{request.requesterName} から</div>
                    <div className="s">相手に指名されています — 成立すると両方に同じカードが出ます</div>
                  </div>
                  <span className="score" style={{ fontSize: 12, color: 'var(--ink-500)' }}>{request.priority === 1 ? '強く' : '希望'}</span>
                </div>
              ))}
            </div>
          </section>
        </article>
      ) : null}
      {error && !picking ? <div className="notice error">{error}</div> : null}
    </div>
  );
}
