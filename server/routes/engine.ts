import { Router, type Response } from 'express';
import { z } from 'zod';
import type { DB } from '../db.js';
import { asRows } from '../db.js';
import { requireRole, type AuthedRequest } from '../auth.js';
import { sendData } from '../http.js';
import { audit, ensureEventAccess, requireEvent } from './core.js';
import { evaluateCandidates, loadEngineContext, runEngine, type EngineContext } from '../services/matching.js';

function param(req: AuthedRequest, key: string): string {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

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

export function createEngineRouter(db: DB, afterRun?: (eventId: string) => void): Router {
  const router = Router();

  router.get('/events/:eventId/engine/state', (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    requireEvent(db, eventId);
    const ctx = loadEngineContext(db, eventId);
    const { candidates, blocked, blockedCounts, eligible, reportLimit } = evaluateCandidates(ctx, { maxPairs: 20 });
    const isParticipant = req.auth?.role === 'PARTICIPANT';
    sendData(res, {
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
      eligibleCount: eligible.length,
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
      waitingPlayers: isParticipant
        ? describeWaitingPlayers(ctx).map((player) => ({
          participantId: player.participantId, name: player.name, waitingMinutes: player.waitingMinutes,
          played: player.played, restReady: player.restReady,
        }))
        : describeWaitingPlayers(ctx),
      evaluatedPairs: candidates.length,
      candidates: isParticipant ? [] : candidates.slice(0, reportLimit),
      blocked: isParticipant ? [] : blocked,
      blockedCounts: isParticipant ? {} : blockedCounts,
      weights: {
        requestPriority: ctx.event.weight_request_priority, waiting: ctx.event.weight_waiting,
        matchBalance: ctx.event.weight_match_balance, unplayed: ctx.event.weight_unplayed,
        rating: ctx.event.weight_rating, timeFit: ctx.event.weight_time_fit,
        recentPenalty: ctx.event.penalty_recent, repeatPenalty: ctx.event.penalty_repeat,
      },
    });
  });

  router.post('/events/:eventId/engine/preview', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    requireEvent(db, eventId);
    const input = z.object({ classId: z.string().nullable().optional(), maxPairs: z.number().int().min(1).max(200).optional() }).parse(req.body ?? {});
    const result = runEngine(db, eventId, {
      dryRun: true, classId: input.classId ?? null, maxPairs: input.maxPairs, actorId: req.auth?.userId ?? null,
    });
    sendData(res, result);
  });

  router.post('/events/:eventId/engine/run', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    requireEvent(db, eventId);
    const input = z.object({
      classId: z.string().nullable().optional(), maxPairs: z.number().int().min(1).max(200).optional(),
      force: z.boolean().optional(),
    }).parse(req.body ?? {});
    const result = runEngine(db, eventId, {
      classId: input.classId ?? null, maxPairs: input.maxPairs, force: input.force, actorId: req.auth?.userId ?? null,
    });
    audit(db, req, eventId, 'ENGINE', eventId, 'RUN', undefined, {
      assigned: result.assignedQueue.length, created: result.created.length, skipped: result.skippedReasons,
    });
    sendData(res, result);
    if (afterRun) queueMicrotask(() => afterRun(eventId));
  });

  /** Transparency endpoint: why one pair beat every other pair right now. */
  router.get('/events/:eventId/engine/explain', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    requireEvent(db, eventId);
    const ctx = loadEngineContext(db, eventId);
    const { candidates } = evaluateCandidates(ctx, { maxPairs: 60 });
    const reported = candidates.slice(0, 60);
    const pair = asRows<{ match_id: string; player_a_id: string; player_b_id: string }>(db.prepare(`SELECT match_id, player_a_id, player_b_id
      FROM matches WHERE match_id = ? AND event_id = ?`).all(String(req.query.matchId ?? ''), eventId));
    if (!pair[0]) {
      sendData(res, { candidates: reported.slice(0, 10) });
      return;
    }
    const a = ctx.players.get(pair[0].player_a_id);
    const b = ctx.players.get(pair[0].player_b_id);
    const match = reported.find((candidate) => (candidate.playerAId === pair[0].player_a_id && candidate.playerBId === pair[0].player_b_id)
      || (candidate.playerAId === pair[0].player_b_id && candidate.playerBId === pair[0].player_a_id));
    sendData(res, {
      matchId: pair[0].match_id,
      playerA: a ? { participantId: a.participantId, name: a.name, played: a.played, waitingMinutes: Number(a.waitingMinutes.toFixed(1)), rating: a.rating } : null,
      playerB: b ? { participantId: b.participantId, name: b.name, played: b.played, waitingMinutes: Number(b.waitingMinutes.toFixed(1)), rating: b.rating } : null,
      breakdown: match?.breakdown ?? null,
      rank: match ? reported.findIndex((candidate) => candidate === match) + 1 : null,
      candidateCount: reported.length,
    });
  });

  return router;
}
