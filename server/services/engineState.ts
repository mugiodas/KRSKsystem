import type { DB } from '../db.js';
import { evaluateCandidates, loadEngineContext, type EngineContext } from './matching.js';

/**
 * Waiting queue for the board and the phone. Kept next to the state builder so
 * both the engine endpoint and the polled snapshot describe it identically.
 */
export function describeWaitingPlayers(ctx: EngineContext) {
  return [...ctx.players.values()]
    .filter((player) => !ctx.busyPlayerIds.has(player.participantId))
    .map((player) => ({
      participantId: player.participantId,
      name: player.name,
      className: player.className,
      rating: player.rating,
      played: player.played,
      wins: player.wins,
      waitingMinutes: Number(player.waitingMinutes.toFixed(1)),
      lastEndTime: player.lastEndTime ? new Date(player.lastEndTime).toISOString() : null,
      restReady: ctx.nowMs >= player.restReadyAt,
      restReadyInMinutes: Number((Math.max(0, (player.restReadyAt - ctx.nowMs) / 60_000)).toFixed(1)),
      activeRequests: ctx.requests.filter((request) => request.requesterId === player.participantId
        || request.targetPlayerId === player.participantId).length,
    }))
    .sort((left, right) => right.waitingMinutes - left.waitingMinutes || left.played - right.played);
}

export interface EngineStateOptions {
  /**
   * Light mode skips pairwise candidate evaluation, which is by far the most
   * expensive part of the state. The polled board snapshot uses it because it
   * only needs the queue and the waiting list; the engine modal asks for the
   * full state on demand.
   */
  light?: boolean;
  maxPairs?: number;
  /** Participants may not read other people's ratings or blocked candidates. */
  participantView?: boolean;
}

/** The engine's view of "right now", assembled from one context load. */
export function buildEngineState(db: DB, eventId: string, options: EngineStateOptions = {}) {
  const ctx = loadEngineContext(db, eventId);
  const light = options.light ?? false;
  const participantView = options.participantView ?? false;
  const evaluated = light ? null : evaluateCandidates(ctx, { maxPairs: options.maxPairs ?? 20 });
  const waitingPlayers = describeWaitingPlayers(ctx);
  const visibleWaiting = participantView
    ? waitingPlayers.map((player) => ({
      participantId: player.participantId, name: player.name, waitingMinutes: player.waitingMinutes,
      played: player.played, restReady: player.restReady,
    }))
    : waitingPlayers;

  return {
    ranAt: new Date(ctx.nowMs).toISOString(),
    eventId,
    eventName: ctx.event.event_name,
    phase: ctx.event.current_phase,
    eventMode: ctx.event.event_mode,
    eventStatus: ctx.event.status,
    engineEnabled: ctx.event.auto_engine_enabled === 1,
    autoCourtAssignment: ctx.event.auto_court_assignment === 1,
    allowRequest: ctx.event.allow_request === 1,
    remainingMinutes: Number(ctx.remainingMinutes.toFixed(1)),
    matchSlotMinutes: ctx.matchSlotMinutes,
    timeProtected: ctx.timeProtected,
    // Without candidate evaluation "eligible" means ready and idle right now.
    eligibleCount: evaluated ? evaluated.eligible.length : visibleWaiting.filter((player) => player.restReady).length,
    busyPlayerCount: ctx.busyPlayerIds.size,
    courts: ctx.courts.map((court) => ({
      courtId: court.courtId, courtNumber: court.courtNumber, courtName: court.courtName,
      status: court.status, busy: court.busy, free: ctx.freeCourts.some((item) => item.courtId === court.courtId),
    })),
    freeCourtCount: ctx.freeCourts.length,
    queue: ctx.queue.map((match) => ({
      matchId: match.matchId, phase: match.phase,
      playerAName: ctx.players.get(match.playerAId)?.name ?? match.playerAId,
      playerBName: ctx.players.get(match.playerBId)?.name ?? match.playerBId,
      scheduledTime: match.scheduledTime,
    })),
    waitingPlayers: visibleWaiting,
    evaluatedPairs: evaluated ? evaluated.candidates.length : null,
    candidates: evaluated && !participantView ? evaluated.candidates.slice(0, evaluated.reportLimit) : [],
    blocked: evaluated && !participantView ? evaluated.blocked : [],
    blockedCounts: evaluated && !participantView ? evaluated.blockedCounts : {},
    weights: {
      requestPriority: ctx.event.weight_request_priority, waiting: ctx.event.weight_waiting,
      matchBalance: ctx.event.weight_match_balance, unplayed: ctx.event.weight_unplayed,
      rating: ctx.event.weight_rating, timeFit: ctx.event.weight_time_fit,
      recentPenalty: ctx.event.penalty_recent, repeatPenalty: ctx.event.penalty_repeat,
    },
  };
}
