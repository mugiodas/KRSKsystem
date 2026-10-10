import { Router, type Response } from 'express';
import { z } from 'zod';
import type { DB } from '../db.js';
import { asRows } from '../db.js';
import { requireRole, type AuthedRequest } from '../auth.js';
import { sendData } from '../http.js';
import { audit, ensureEventAccess, requireEvent } from './core.js';
import { evaluateCandidates, loadEngineContext, runEngine } from '../services/matching.js';
import { buildEngineState } from '../services/engineState.js';

function param(req: AuthedRequest, key: string): string {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export { describeWaitingPlayers } from '../services/engineState.js';

export function createEngineRouter(db: DB, afterRun?: (eventId: string) => void): Router {
  const router = Router();

  router.get('/events/:eventId/engine/state', (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    requireEvent(db, eventId);
    sendData(res, buildEngineState(db, eventId, {
      maxPairs: Number(req.query.maxPairs ?? 20),
      participantView: req.auth?.role === 'PARTICIPANT',
    }));
  });

  /**
   * The polled board view. Everything a dashboard tab needs, in one request,
   * with candidate evaluation skipped: the same figures, a fraction of the work.
   */
  router.get('/events/:eventId/engine/snapshot', (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    requireEvent(db, eventId);
    sendData(res, buildEngineState(db, eventId, { light: true, participantView: req.auth?.role === 'PARTICIPANT' }));
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
