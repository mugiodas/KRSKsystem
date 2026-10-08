import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Activity, BarChart3, ClipboardList, ListChecks, LogOut, Radio, RefreshCw, Settings2, Smartphone, Wand2, Zap, ZapOff } from 'lucide-react';
import { api, ApiError } from '../api/client';
import type { DashboardAlert } from '../lib/alerts';
import type { EngineState } from '../api/types';
import { buildAlerts } from '../lib/alerts';
import { useEventSnapshot, useNow } from '../state/useEventSnapshot';
import { useSession } from '../auth/session';
import { AlertRail } from '../components/dashboard/AlertRail';
import { CourtLive } from '../components/dashboard/CourtLive';
import { MatchQueue } from '../components/dashboard/MatchQueue';
import { ParticipantStatus } from '../components/dashboard/ParticipantStatus';
import { ResultModal } from '../components/dashboard/ResultModal';
import { EngineModal } from '../components/dashboard/EngineModal';
import { LeagueModal } from '../components/dashboard/LeagueModal';
import { ManualMatchModal } from '../components/dashboard/ManualMatchModal';
import { SettingsModal } from '../components/dashboard/SettingsModal';
import { RankingPanel } from '../components/dashboard/RankingPanel';
import { RequestPanel } from '../components/dashboard/RequestPanel';
import { AuditPanel } from '../components/dashboard/AuditPanel';
import { Chip, SEVERITY_LABEL, useToast } from '../components/ui';
import { clockTime, minutesBetween, parseIso } from '../lib/time';

type Modal =
  | { type: 'result'; matchId: string; mode: 'enter' | 'correct' }
  | { type: 'engine'; explainMatchId?: string | null }
  | { type: 'league' }
  | { type: 'manual' }
  | { type: 'settings' }
  | null;

export function DashboardPage() {
  const { eventId = '' } = useParams();
  const { session, canOperate, signOut } = useSession();
  const { snapshot, error, refresh, activeMatches } = useEventSnapshot(eventId || null);
  const toast = useToast();
  const navigate = useNavigate();
  const nowMs = useNow(1000);
  const [modal, setModal] = useState<Modal>(null);
  const [tab, setTab] = useState<'board' | 'ranking' | 'requests' | 'audit'>('board');
  const [selected, setSelected] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  const alerts = useMemo<DashboardAlert[]>(() => {
    if (!snapshot) return [];
    return buildAlerts({
      event: snapshot.event, courts: snapshot.courts, matches: snapshot.matches,
      participants: snapshot.participants, requests: snapshot.requests, engine: snapshot.engine, nowMs,
    });
  }, [snapshot, nowMs]);

  const matchById = useMemo(() => new Map((snapshot?.allMatches ?? []).map((match) => [match.matchId, match])), [snapshot]);
  const modalMatch = modal && 'matchId' in modal && modal.matchId ? matchById.get(modal.matchId) : undefined;

  const act = useCallback(async (label: string, action: () => Promise<unknown>) => {
    try {
      await action();
      await refresh({ silent: true });
      toast.push(label);
    } catch (caught) {
      toast.push(caught instanceof ApiError ? caught.message : `${label}に失敗しました`, 'error');
      await refresh({ silent: true });
    }
  }, [refresh, toast]);

  const runEngineNow = useCallback(async () => {
    setRunning(true);
    try {
      const result = await api.engineRun(eventId);
      const assigned = result.created.length + result.assignedQueue.length;
      toast.push(assigned > 0 ? `エンジン実行：${result.created.length}試合作成・${result.assignedQueue.length}件割当` : 'エンジン実行：割当可能なカードはありません');
      await refresh({ silent: true });
    } catch (caught) {
      toast.push(caught instanceof ApiError ? caught.message : 'エンジン実行に失敗しました', 'error');
    } finally {
      setRunning(false);
    }
  }, [eventId, refresh, toast]);

  const jumpToAlert = useCallback((alert: DashboardAlert) => {
    if (alert.matchId && matchById.get(alert.matchId)?.status === 'RESULT_PENDING') {
      setModal({ type: 'result', matchId: alert.matchId, mode: 'enter' });
      return;
    }
    const target = alert.matchId ? 'queue' : alert.kind === 'UNDER_MATCHED' || alert.kind === 'LONG_WAIT' ? 'participants' : alert.kind === 'REQUEST_WAITING' ? 'queue' : 'courts';
    if (target === 'queue' && alerts.some((item) => item.kind === 'REQUEST_WAITING') && alert.kind === 'REQUEST_WAITING') {
      setTab('requests');
      return;
    }
    document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [matchById, alerts]);

  // Keyboard shortcuts keep the operator's hands on the board during a rally.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === 'e' && canOperate) void runEngineNow();
      if (event.key === 'r') void refresh();
      if (event.key === 'Escape') setModal(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canOperate, runEngineNow, refresh]);

  if (!snapshot) {
    return (
      <div style={{ padding: 24 }}>
        {error ? <div className="notice error">{error} <button className="btn sm" onClick={() => refresh()}>再試行</button></div>
          : <div className="notice info">大会データを読み込んでいます…</div>}
      </div>
    );
  }

  const { event, courts, participants, engine } = snapshot;
  const startMs = parseIso(event.startTime);
  const endMs = parseIso(event.endTime);
  const elapsed = startMs === null ? 0 : Math.max(0, minutesBetween(startMs, nowMs));
  const remaining = endMs === null ? 0 : Math.max(0, minutesBetween(nowMs, endMs));
  const playing = activeMatches.filter((match) => match.status === 'PLAYING').length;
  const pendingResult = activeMatches.filter((match) => match.status === 'RESULT_PENDING').length;
  const waitingCount = engine?.waitingPlayers.length ?? 0;
  const freeCourts = courts.filter((court) => court.enabled === 1 && !activeMatches.some((match) => match.courtId === court.courtId));
  const dataAgeSeconds = Math.round((nowMs - snapshot.fetchedAt) / 1000);

  const toggleSelect = (participantId: string) => setSelected((current) => (
    current.includes(participantId) ? current.filter((id) => id !== participantId) : [...current.slice(-1), participantId]
  ));

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><b>KRSK SYSTEM</b><span>OPERATION BOARD</span></div>
        <div className="event-title">
          {event.eventName}
          <span style={{ opacity: 0.65, marginLeft: 8, fontSize: 11 }}>{event.venue}</span>
        </div>
        <Chip tone={event.status === 'RUNNING' ? 'ok' : event.status === 'PAUSED' ? 'warn' : 'blue'} dot>
          {SEVERITY_LABEL[event.status] ?? event.status}
        </Chip>
        <Chip>{event.eventMode === 'LEAGUE_REQUEST' ? 'リーグ→希望' : event.eventMode === 'REQUEST_ONLY' ? '希望制' : 'リーグ→大会→希望'}</Chip>
        <Chip tone={event.currentPhase === 'LEAGUE' ? 'blue' : ''}>現フェーズ {event.currentPhase === 'LEAGUE' ? 'リーグ' : event.currentPhase === 'TOURNAMENT' ? '大会' : '希望'}</Chip>

        <div className="stat" title="大会開始からの経過／残り時間">
          <b>{elapsed >= 0 ? `${Math.floor(elapsed / 60)}:${String(Math.round(elapsed % 60)).padStart(2, '0')}` : '--'}</b>
          <span>経過 / 残り {Math.floor(remaining / 60)}:{String(Math.round(remaining % 60)).padStart(2, '0')}</span>
        </div>
        <div className="stat"><b>{courts.filter((court) => court.enabled === 1).length - freeCourts.length}/{courts.filter((court) => court.enabled === 1).length}</b><span>稼働コート</span></div>
        <div className="stat"><b>{playing}</b><span>試合中</span></div>
        <div className="stat"><b className={pendingResult > 0 ? '' : ''} style={{ color: pendingResult > 0 ? '#ffd166' : undefined }}>{pendingResult}</b><span>結果待ち</span></div>
        <div className="stat"><b>{waitingCount}</b><span>待機者</span></div>
        <div className="stat"><b>{event.summary.completedMatchCount}</b><span>完了試合</span></div>

        <span className="spacer" />
        <span style={{ fontSize: 10.5, opacity: 0.6 }} title="最終更新からの秒数">{dataAgeSeconds}s 前更新</span>
        <div className="actions">
          <button className="btn ghost" onClick={() => void refresh()} title="更新 (R)"><RefreshCw size={13} /></button>
          {canOperate ? (
            <button className="btn ghost" onClick={() => void runEngineNow()} disabled={running} title="マッチングエンジンを実行 (E)">
              {engine?.engineEnabled === false ? <ZapOff size={13} /> : <Zap size={13} />}エンジン実行
            </button>
          ) : null}
          {canOperate ? <button className="btn ghost" onClick={() => setModal({ type: 'engine', explainMatchId: null })}><ListChecks size={13} />候補プレビュー</button> : null}
          {canOperate && event.eventMode !== 'REQUEST_ONLY' ? <button className="btn ghost" onClick={() => setModal({ type: 'league' })}><Wand2 size={13} />リーグ生成</button> : null}
          {canOperate ? <button className="btn ghost" onClick={() => setModal({ type: 'manual' })}><ClipboardList size={13} />手動作成</button> : null}
          {canOperate ? <button className="btn ghost" onClick={() => setModal({ type: 'settings' })}><Settings2 size={13} /></button> : null}
          <button className="btn ghost" onClick={() => navigate(`/m`)} title="参加者ビューを開く"><Smartphone size={13} /></button>
          <span style={{ fontSize: 11, opacity: 0.8, marginLeft: 4 }}>{session?.displayName}（{session?.role}）</span>
          <button className="btn ghost" onClick={() => void signOut().then(() => navigate('/login'))}><LogOut size={13} />ログアウト</button>
        </div>
      </header>

      <div className="shell-body">
        <div className="dash">
          <AlertRail alerts={tab === 'board' ? alerts : []} onJump={jumpToAlert} loading={false} />

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="tabs">
              <button aria-selected={tab === 'board'} onClick={() => setTab('board')}><Activity size={11} style={{ verticalAlign: -1 }} /> 運用ボード</button>
              <button aria-selected={tab === 'ranking'} onClick={() => setTab('ranking')}><BarChart3 size={11} style={{ verticalAlign: -1 }} /> 順位表</button>
              <button aria-selected={tab === 'requests'} onClick={() => setTab('requests')}>対戦希望</button>
              {canOperate ? <button aria-selected={tab === 'audit'} onClick={() => setTab('audit')}>操作ログ</button> : null}
            </div>
            {event.autoEngineEnabled === 1 ? (
              <Chip tone="ok" dot><Radio size={10} /> 自動進行 ON：結果入力で次のカードを自動割当</Chip>
            ) : (
              <Chip tone="warn" dot>自動進行 OFF：手動でエンジンを押す必要があります</Chip>
            )}
            {engine?.timeProtected ? <Chip tone="urgent" dot>終了時刻保護中（残り {Math.round(engine.remainingMinutes)}分）</Chip> : null}
            {alerts.filter((alert) => alert.severity === 'URGENT').length > 0 ? (
              <Chip tone="urgent">要即時対応 {alerts.filter((alert) => alert.severity === 'URGENT').length}</Chip>
            ) : null}
          </div>

          {tab === 'board' ? (
            <>
              <div className="dash-row main">
                <CourtLive
                  courts={courts}
                  matches={activeMatches}
                  nowMs={nowMs}
                  canOperate={canOperate}
                  matchMinutes={Number(event.defaultMatchMinutes) + Number(event.resultInputGraceMinutes) + 1}
                  onStart={(match) => void act('試合を開始しました', () => api.matchAction(eventId, match.matchId, 'START', match.rowVersion, { courtId: match.courtId }))}
                  onFinish={(match) => void act('試合を終了しました。結果入力してください。', () => api.matchAction(eventId, match.matchId, 'FINISH', match.rowVersion))}
                  onResult={(match) => setModal({ type: 'result', matchId: match.matchId, mode: match.status === 'COMPLETED' ? 'correct' : 'enter' })}
                  onCall={(match) => void act('コートを呼出しました', () => api.matchAction(eventId, match.matchId, 'ASSIGN', match.rowVersion, { courtId: match.courtId }))}
                  onManualAssign={(match, courtId) => void act('コートを移動しました', () => api.patchMatch(eventId, match.matchId, { courtId, rowVersion: match.rowVersion }))}
                />
                <div style={{ display: 'grid', gap: 10, minHeight: 0 }}>
                  <MatchQueue
                    matches={snapshot.matches}
                    requests={snapshot.requests}
                    nowMs={nowMs}
                    canOperate={canOperate}
                    timeProtected={Boolean(engine?.timeProtected)}
                    freeCourts={freeCourts.map((court) => ({ courtId: court.courtId, courtName: court.courtName }))}
                    onCall={(match) => void act('呼出しました', () => api.matchAction(eventId, match.matchId, 'CALL', match.rowVersion))}
                    onAssign={(match, courtId) => void act('コート割当しました', () => api.matchAction(eventId, match.matchId, 'ASSIGN', match.rowVersion, { courtId }))}
                    onCancel={(match) => void act('試合をキャンセルしました', () => api.matchAction(eventId, match.matchId, 'CANCEL', match.rowVersion))}
                    onNoShow={(match) => void act('ノーショー扱いにしました', () => api.matchAction(eventId, match.matchId, 'NO_SHOW', match.rowVersion))}
                  />
                  <EngineHint engine={engine} nowMs={nowMs} />
                </div>
              </div>
              <ParticipantStatus
                participants={participants}
                engine={engine}
                matches={activeMatches}
                requests={snapshot.requests}
                selectedIds={selected}
                onToggleSelect={toggleSelect}
              />
              {selected.length === 2 && canOperate ? (
                <div className="notice info" style={{ position: 'sticky', bottom: 8 }}>
                  <span>2名を選択中です。</span>
                  <button className="btn sm primary" onClick={() => { setModal({ type: 'manual' }); }}>この2名で手動対戦カードを作成</button>
                  <button className="btn sm" onClick={() => setSelected([])}>解除</button>
                </div>
              ) : null}
            </>
          ) : null}
          {tab === 'ranking' ? <RankingPanel eventId={eventId} participants={participants} /> : null}
          {tab === 'requests' ? (
            <RequestPanel eventId={eventId} requests={snapshot.requests} matches={snapshot.allMatches} canOperate={canOperate} onChanged={() => refresh({ silent: true })} />
          ) : null}
          {tab === 'audit' && canOperate ? <AuditPanel eventId={eventId} /> : null}
        </div>
      </div>

      {modal?.type === 'result' && modalMatch ? (
        <ResultModal
          eventId={eventId} match={modalMatch} mode={modal.mode}
          targetMinutes={Number(event.defaultMatchMinutes)}
          onDone={() => refresh({ silent: true })} onClose={() => setModal(null)}
        />
      ) : null}
      {modal?.type === 'engine' ? (
        <EngineModal
          eventId={eventId} classes={event.classes} canOperate={canOperate}
          explainMatchId={modal.explainMatchId ?? null}
          onClose={() => setModal(null)} onChanged={() => refresh({ silent: true })}
        />
      ) : null}
      {modal?.type === 'league' ? (
        <LeagueModal eventId={eventId} canOperate={canOperate} endTime={event.endTime} onClose={() => setModal(null)} onGenerated={() => refresh({ silent: true })} />
      ) : null}
      {modal?.type === 'manual' ? (
        <ManualMatchModal
          eventId={eventId} participants={participants} courts={courts} matches={snapshot.allMatches}
          presetPlayerIds={selected} isOwner={session?.role === 'OWNER'}
          onClose={() => setModal(null)}
          onCreated={(match) => { setSelected([]); refresh({ silent: true }); if (canOperate) setModal({ type: 'result', matchId: match.matchId, mode: 'enter' }); }}
        />
      ) : null}
      {modal?.type === 'settings' ? (
        <SettingsModal event={event} onClose={() => setModal(null)} onSaved={() => refresh({ silent: true })} />
      ) : null}
    </div>
  );
}

function EngineHint({ engine, nowMs }: { engine: EngineState | null; nowMs: number }) {
  if (!engine) return null;
  const nextSlot = engine.queue[0];
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>ENGINE</h2>
        <span className="spacer" />
        <span className="hint">評価 {engine.evaluatedPairs}組・{clockTime(engine.ranAt)} 時点（{Math.round(minutesBetween(parseIso(engine.ranAt) ?? nowMs, nowMs))}分前）</span>
      </header>
      <div className="panel-body">
        <div className="kv">
          <div><dt>出場可能</dt><dd>{engine.eligibleCount}</dd></div>
          <div><dt>試合中/呼出</dt><dd>{engine.busyPlayerCount}</dd></div>
          <div><dt>空きコート</dt><dd>{engine.freeCourtCount}</dd></div>
          <div><dt>キュー</dt><dd>{engine.queue.length}</dd></div>
          <div><dt>1試合枠</dt><dd>{engine.matchSlotMinutes}分</dd></div>
          <div><dt>残り</dt><dd style={{ color: engine.remainingMinutes < 30 ? 'var(--urgent)' : undefined }}>{Math.round(engine.remainingMinutes)}分</dd></div>
        </div>
        {nextSlot ? (
          <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--ink-700)' }}>
            次のキュー：<b>{nextSlot.playerAName} × {nextSlot.playerBName}</b>（{nextSlot.phase === 'LEAGUE' ? 'リーグ' : '希望'}・{clockTime(nextSlot.scheduledTime)} 予定）
          </div>
        ) : (
          <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--ink-500)' }}>キューは空です。待機選手がいればエンジンが新しいカードを作成します。</div>
        )}
      </div>
    </section>
  );
}
