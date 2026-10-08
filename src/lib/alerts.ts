import type { CourtRow, EngineState, EventDetail, MatchRow, ParticipantRow, RequestRow } from '../api/types';
import { minutesBetween, parseIso } from './time';

export type AlertSeverity = 'URGENT' | 'IMPORTANT' | 'INFO';

export interface DashboardAlert {
  id: string;
  severity: AlertSeverity;
  kind: 'MISSING_RESULT' | 'RESULT_UNCONFIRMED' | 'RESULT_DISPUTED' | 'LONG_WAIT' | 'IDLE_COURT' | 'DELAY'
    | 'NO_SHOW' | 'UNDER_MATCHED' | 'LEAGUE_BEHIND' | 'TIME_PROTECTED' | 'ENGINE_OFF' | 'REQUEST_WAITING';
  title: string;
  detail: string;
  /** Deep link target so the operator can act from the alert itself. */
  matchId?: string;
  courtId?: string;
  participantIds?: string[];
}

const ACTIVE = ['CALLED', 'COURT_ASSIGNED', 'PLAYING', 'RESULT_PENDING'];

/**
 * Alerts exist to tell the operator that something is actually wrong.
 * Every rule below is derived from persisted state; nothing fires on
 * "queue not empty" style noise because the engine clears that on its own.
 */
export function buildAlerts(input: {
  event: EventDetail;
  courts: CourtRow[];
  matches: MatchRow[];
  participants: ParticipantRow[];
  requests: RequestRow[];
  engine: EngineState | null;
  nowMs: number;
}): DashboardAlert[] {
  const { event, courts, matches, participants, requests, engine, nowMs } = input;
  const alerts: DashboardAlert[] = [];
  const resultGrace = Number(event.resultInputGraceMinutes ?? 3);

  const confirmTimeout = Number(event.resultConfirmTimeoutMinutes ?? 3);

  // 1) A finished match keeps its court locked until the score is settled. What is
  //    missing differs: nobody has reported, one side reported and the other has not
  //    tapped yet, or the two reports disagree.
  const pendingAlerts: DashboardAlert[] = [];
  matches
    .filter((match) => match.status === 'RESULT_PENDING')
    .map((match) => {
      const since = parseIso(match.resultEnteredAt ?? match.endTime ?? match.updatedAt);
      const waited = since === null ? 0 : minutesBetween(since, nowMs);
      return { match, waited };
    })
    .sort((left, right) => right.waited - left.waited)
    .forEach(({ match, waited }) => {
      const claim = match.reportedScoreA !== null && match.reportedScoreA !== undefined
        ? `${match.reportedScoreA}-${match.reportedScoreB}` : null;
      if (match.resultStatus === 'DISPUTED') {
        pendingAlerts.push({
          id: `dispute-${match.matchId}`,
          severity: 'URGENT',
          kind: 'RESULT_DISPUTED',
          title: '結果の申告が食い違っています',
          detail: `${match.playerAName} × ${match.playerBName}／運営がスコアを決めてください`,
          matchId: match.matchId,
          courtId: match.courtId ?? undefined,
        });
        return;
      }
      if (match.resultStatus === 'ENTERED') {
        // The opponent still has their own window to confirm; that is not a problem.
        if (waited <= confirmTimeout) return;
        pendingAlerts.push({
          id: `unconfirmed-${match.matchId}`,
          severity: waited > confirmTimeout * 2 ? 'URGENT' : 'IMPORTANT',
          kind: 'RESULT_UNCONFIRMED',
          title: '確定されない結果が待っています',
          detail: `${match.playerAName} × ${match.playerBName}／申告 ${claim ?? '—'} が ${Math.round(waited)}分そのまま（コート確保中）`,
          matchId: match.matchId,
          courtId: match.courtId ?? undefined,
        });
        return;
      }
      if (waited > resultGrace) {
        pendingAlerts.push({
          id: `result-${match.matchId}`,
          severity: waited > 10 ? 'URGENT' : 'IMPORTANT',
          kind: 'MISSING_RESULT',
          title: '結果が未入力です',
          detail: `${match.courtName ?? 'コート未定'} ${match.playerAName} × ${match.playerBName}／終了 ${Math.round(waited)}分前`,
          matchId: match.matchId,
          courtId: match.courtId ?? undefined,
        });
      }
    });
  alerts.push(...pendingAlerts.slice(0, 6));

  // 2) Players waiting 30+ minutes.
  const longWait = (engine?.waitingPlayers ?? []).filter((player) => player.waitingMinutes >= 30);
  if (longWait.length > 0) {
    const worst = longWait[0];
    alerts.push({
      id: 'long-wait',
      severity: worst.waitingMinutes >= 50 ? 'URGENT' : 'IMPORTANT',
      kind: 'LONG_WAIT',
      title: `${longWait.length}名が30分以上待っています`,
      detail: `最長 ${Math.round(worst.waitingMinutes)}分（${worst.name}・${worst.played}試合）`,
      participantIds: longWait.slice(0, 12).map((player) => player.participantId),
    });
  }

  // 3) A free court while players are ready to play is wasted capacity.
  const freeEnabled = courts.filter((court) => court.enabled === 1 && !ACTIVE.includes(String(matchStatusOfCourt(court, matches)))
    && ['AVAILABLE', 'RESERVED'].includes(court.status));
  const readyCount = (engine?.waitingPlayers ?? []).filter((player) => player.restReady).length;
  const queuedMatches = matches.filter((match) => match.status === 'WAITING' || match.status === 'CALLED').length;
  if (freeEnabled.length > 0 && (readyCount >= 2 || queuedMatches > 0)) {
    const canAutoRun = engine ? engine.engineEnabled && engine.autoCourtAssignment : false;
    alerts.push({
      id: 'idle-court',
      severity: freeEnabled.length >= 2 ? 'URGENT' : 'IMPORTANT',
      kind: 'IDLE_COURT',
      title: `空きコート ${freeEnabled.length}面`,
      detail: `待機可能 ${readyCount}名／待機試合 ${queuedMatches}件${canAutoRun ? '' : '・自動割当が止まっています'}`,
      courtId: freeEnabled[0].courtId,
    });
  }

  // 4) Called but not started on time.
  matches
    .filter((match) => match.status === 'CALLED' || (match.status === 'COURT_ASSIGNED' && !match.startTime))
    .map((match) => {
      const planned = parseIso(match.scheduledTime ?? match.calledTime);
      return { match, late: planned === null ? 0 : minutesBetween(planned, nowMs) };
    })
    .filter((item) => item.late > 5)
    .sort((left, right) => right.late - left.late)
    .slice(0, 4)
    .forEach(({ match, late }) => {
      alerts.push({
        id: `delay-${match.matchId}`,
        severity: late > 15 ? 'URGENT' : 'IMPORTANT',
        kind: 'DELAY',
        title: '試合が開始されていません',
        detail: `${match.playerAName} × ${match.playerBName}／予定から ${Math.round(late)}分経過`,
        matchId: match.matchId,
      });
    });

  // 5) Recent no-shows still need a follow-up decision.
  const noShows = matches.filter((match) => match.status === 'NO_SHOW'
    && (parseIso(match.updatedAt) ?? 0) > nowMs - 30 * 60_000);
  if (noShows.length > 0) {
    alerts.push({
      id: 'no-show',
      severity: 'IMPORTANT',
      kind: 'NO_SHOW',
      title: `ノーショー ${noShows.length}件`,
      detail: `${noShows[0].playerAName} × ${noShows[0].playerBName} など（30分以内）`,
      matchId: noShows[0].matchId,
    });
  }

  // 6) The league plan. The event's own round robin says how many cards each player was
  //    promised, so a shortfall is only reported against that promise - and cards that
  //    already exist (queued or in play) count towards it, because the operator does not
  //    need a second warning for a match that is already on the board.
  const startedMs = parseIso(event.startTime) ?? nowMs;
  const elapsed = minutesBetween(startedMs, nowMs);
  const league = event.league;
  if (league?.applicable && event.status === 'RUNNING' && league.status !== 'ON_TRACK') {
    const short = participants
      .filter((player) => (player.leagueShortfall ?? 0) > 0)
      .sort((left, right) => (right.leagueShortfall ?? 0) - (left.leagueShortfall ?? 0));
    const names = short.slice(0, 4)
      .map((player) => `${player.name} ${player.leaguePlayed ?? 0}/${player.leagueTarget ?? 0}試`).join('、');
    alerts.push({
      id: 'league-behind',
      severity: league.status === 'WONT_FIT' ? 'URGENT' : 'IMPORTANT',
      kind: 'LEAGUE_BEHIND',
      title: league.status === 'WONT_FIT'
        ? `リーグの計画が残り時間で消化できません（${league.playersUnderTarget}名・最大 ${league.mostMissing}試不足）`
        : `リーグが計画より遅れています（${league.completedMatches}/${league.plannedMatches}試消化）`,
      detail: [
        `必要 ${league.minutesNeeded}分 / 残り ${league.minutesRemaining}分`,
        league.courtCount > 0 ? `${league.courtCount}コート・1回戦 約${league.slotMinutes}分` : '',
        names,
      ].filter(Boolean).join(' ・ '),
      participantIds: short.map((player) => player.participantId),
    });
  } else if (!league?.applicable && elapsed > 45) {
    // No league plan to fall behind on, so fall back to the crude "still at zero" rule.
    const idle = participants.filter((player) => player.active === 1 && player.checkedIn === 1 && player.played === 0);
    if (idle.length > 0) {
      alerts.push({
        id: 'under-matched',
        severity: 'IMPORTANT',
        kind: 'UNDER_MATCHED',
        title: `まだ一度も試合をしていない選手が ${idle.length}名`,
        detail: idle.slice(0, 5).map((player) => player.name).join('、'),
        participantIds: idle.map((player) => player.participantId),
      });
    }
  }

  // 7) End time protection active: no new match can be created.
  if (engine?.timeProtected) {
    alerts.push({
      id: 'time-protected',
      severity: 'INFO',
      kind: 'TIME_PROTECTED',
      title: '終了時刻保護のため新規試合は作成していません',
      detail: `残り ${Math.max(0, Math.round(engine.remainingMinutes))}分・1試合枠 ${engine.matchSlotMinutes}分`,
    });
  }

  // 8) Automation switched off means the operator is now the scheduler.
  if (engine && !engine.engineEnabled) {
    alerts.push({
      id: 'engine-off',
      severity: 'INFO',
      kind: 'ENGINE_OFF',
      title: '自動マッチングが停止中です',
      detail: '手動で待機試合を処理するか、設定から自動進行を再開してください。',
    });
  }

  // 9) Requests that have been waiting for a long time.
  const staleRequests = requests.filter((request) => request.status === 'ACTIVE'
    && (parseIso(request.createdAt) ?? nowMs) < nowMs - 25 * 60_000);
  if (staleRequests.length > 0) {
    alerts.push({
      id: 'request-waiting',
      severity: 'INFO',
      kind: 'REQUEST_WAITING',
      title: `叶っていない対戦希望が ${staleRequests.length}件`,
      detail: `${staleRequests[0].requesterName} → ${staleRequests[0].targetName} など`,
    });
  }

  const weight: Record<AlertSeverity, number> = { URGENT: 0, IMPORTANT: 1, INFO: 2 };
  return alerts.sort((left, right) => weight[left.severity] - weight[right.severity]);
}

function matchStatusOfCourt(court: CourtRow, matches: MatchRow[]): string | null {
  const match = matches.find((item) => item.courtId === court.courtId && ACTIVE.includes(item.status));
  return match ? match.status : null;
}
