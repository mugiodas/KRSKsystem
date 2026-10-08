import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { History, Inbox, Radio, Ticket, User } from 'lucide-react';
import { api } from '../../api/client';
import type { MyMatchView, ParticipantRow } from '../../api/types';
import { useSession } from '../../auth/session';
import { NextMatchCard } from '../../components/participant/NextMatchCard';
import { RequestsTab } from '../../components/participant/RequestsTab';
import { HistoryTab } from '../../components/participant/HistoryTab';
import { InfoTab } from '../../components/participant/InfoTab';
import { ResultSheet } from '../../components/participant/ResultSheet';
import { useNow } from '../../state/useEventSnapshot';

type Tab = 'next' | 'requests' | 'history' | 'info';

const TABS: Array<{ key: Tab; label: string; icon: typeof Radio }> = [
  { key: 'next', label: 'つぎの試合', icon: Radio },
  { key: 'requests', label: '対戦希望', icon: Ticket },
  { key: 'history', label: '本日', icon: History },
  { key: 'info', label: '連絡', icon: Inbox },
];

/**
 * Participant phone surface. It is intentionally not the operator board:
 * one decision per screen, 44px+ touch targets, and a bottom tab bar.
 */
export function ParticipantHome() {
  const { session } = useSession();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<MyMatchView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewCandidates, setPreviewCandidates] = useState<ParticipantRow[] | null>(null);
  const [tab, setTab] = useState<Tab>('next');
  const [resultFor, setResultFor] = useState<string | null>(null);
  const nowMs = useNow(1000);
  const previewId = params.get('participantId');
  // A participant is bound to their own event; staff preview through ?eventId=.
  const [eventId, setEventId] = useState(params.get('eventId') ?? 'evt_demo_krsk');
  const resolvedFor = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      if (session?.role === 'PARTICIPANT' && resolvedFor.current !== session.userId) {
        const events = await api.events();
        const target = events[0];
        if (!target) { setError('参加している大会が見つかりません。運営にご確認ください。'); return; }
        resolvedFor.current = session.userId;
        setEventId(target.eventId);
        setView(await api.myView(target.eventId));
        setError(null);
        return;
      }
      setView(await api.myView(eventId, previewId));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '読み込みに失敗しました。');
    }
  }, [session, eventId, previewId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (session?.role !== 'PARTICIPANT' && !previewId) {
      api.participants(eventId).then(setPreviewCandidates).catch(() => setPreviewCandidates([]));
    }
  }, [session?.role, previewId, eventId]);

  const unread = view ? view.announcements.filter((item) => item.severity !== 'INFO').length : 0;
  const pendingRequest = view ? view.requests.filter((request) => request.mine && request.status === 'ACTIVE').length : 0;
  const needsResult = view?.nextMatch && ['PLAYING', 'RESULT_PENDING'].includes(view.nextMatch.status);

  if (session && session.role !== 'PARTICIPANT' && !previewId) {
    return (
      <div className="m-shell" style={{ paddingTop: 12 }}>
        <div className="m-top"><div><div className="m-name">参加者プレビュー</div><div className="m-sub">運営アカウントのため、選手を選んで携帯画面を確認できます</div></div></div>
        <div className="m-body">
          {previewCandidates === null ? <div className="m-item"><div className="t">読み込み中…</div></div> : previewCandidates.slice(0, 20).map((player) => (
            <button key={player.participantId} className="m-pick" onClick={() => setParams({ participantId: player.participantId })}>
              <span><b style={{ fontSize: 15 }}>{player.name}</b><small>{player.className ?? '—'} ・ {player.played}試合 {player.wins}勝</small></span>
              <User size={16} style={{ color: 'var(--ink-500)' }} />
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="m-shell">
        <div className="m-top"><div><div className="m-name">KRSK SYSTEM</div><div className="m-sub">読み込み中…</div></div></div>
        <div className="m-body">{error ? <div className="notice error">{error}</div> : null}</div>
      </div>
    );
  }

  return (
    <div className="m-shell">
      <header className="m-top">
        <div>
          <div className="m-name">{view.participant.name}</div>
          <div className="m-sub">{view.participant.className ?? 'クラス未定'} ・ {view.event.eventName}</div>
        </div>
        <span className="spacer" />
        <span className={`m-badge ${view.participant.checkedIn ? 'ok' : 'warn'}`}>{view.participant.checkedIn ? '出欠OK' : '未チェックイン'}</span>
        {session?.role !== 'PARTICIPANT' ? (
          <button className="m-badge" style={{ border: 0, cursor: 'pointer' }} onClick={() => setParams({})}>終了</button>
        ) : null}
      </header>

      <div className="m-body">
        {error ? <div className="notice error">{error}</div> : null}
        {tab === 'next' ? (
          <>
            <NextMatchCard view={view} nowMs={nowMs} onEnterResult={(matchId) => setResultFor(matchId)} />
            <div className="m-stats">
              <div className="m-stat"><b>{view.today.played}</b><span>本日試合</span></div>
              <div className="m-stat"><b>{view.today.wins}</b><span>勝利</span></div>
              <div className="m-stat"><b>{view.waiting.position ?? '—'}</b><span>待機列の位置</span></div>
            </div>
            <article className="m-card">
              <header>いまの状況</header>
              <section style={{ display: 'grid', gap: 8 }}>
                <div className="m-rest" style={{ background: view.waiting.minutes >= 30 ? 'var(--warn-bg)' : 'var(--info-bg)' }}>
                  <Radio size={15} />
                  <span>
                    {view.waiting.restBlocked
                      ? `休憩中 — あと ${Math.ceil(view.waiting.restReadyInMinutes)}分`
                      : `待機 ${Math.round(view.waiting.minutes)}分 ・ 待機中 ${view.waiting.waitingCount}名 ・ 空きコート ${view.waiting.freeCourts}面`}
                  </span>
                </div>
                {needsResult ? (
                  <button className="m-btn primary" onClick={() => view.nextMatch && setResultFor(view.nextMatch.matchId)}>
                    試合の結果を送る
                  </button>
                ) : (
                  <button className="m-btn ghost" onClick={() => setTab('requests')}>対戦したい相手を選ぶ</button>
                )}
              </section>
            </article>
          </>
        ) : null}
        {tab === 'requests' ? <RequestsTab eventId={eventId} view={view} onChanged={load} canSubmit={view.event.allowRequest && session?.role === 'PARTICIPANT'} /> : null}
        {tab === 'history' ? <HistoryTab view={view} /> : null}
        {tab === 'info' ? <InfoTab view={view} /> : null}
      </div>

      <nav className="m-tabbar">
        {TABS.map((item) => (
          <button key={item.key} aria-selected={tab === item.key} onClick={() => setTab(item.key)}>
            <span className="dot" data-count={item.key === 'info' && unread > 0 ? String(unread) : item.key === 'requests' && pendingRequest > 0 ? String(pendingRequest) : undefined}>
              <item.icon size={19} />
            </span>
            {item.label}
          </button>
        ))}
      </nav>

      {resultFor ? (
        <ResultSheet eventId={eventId} view={view} matchId={resultFor} onClose={() => setResultFor(null)} onSaved={load} />
      ) : null}
    </div>
  );
}
