import { Router, type Response } from 'express';
import { z } from 'zod';
import type { DB } from '../db.js';
import { requireRole, type AuthedRequest } from '../auth.js';
import { sendData } from '../http.js';
import { audit, ensureEventAccess, requireEvent } from './core.js';
import { buildTournamentPreview, deleteBracket, generateTournament, getBracket, listBrackets, rebalanceBracket } from '../services/tournament.js';

function param(req: AuthedRequest, key: string): string {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

/**
 * Tournament endpoints (event mode C). The preview comes first on purpose: the operator
 * has to see the draw - seeds, byes, round count and whether it still fits before the
 * end time - before any card is created.
 */
export function createTournamentRouter(db: DB, afterRun?: (eventId: string) => void): Router {
  const router = Router();

  router.get('/events/:eventId/tournament/preview', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    requireEvent(db, eventId);
    const classIds = Array.isArray(req.query.classId) ? req.query.classId.map(String)
      : typeof req.query.classId === 'string' ? [req.query.classId] : undefined;
    sendData(res, buildTournamentPreview(db, eventId, classIds));
  });

  router.get('/events/:eventId/tournament', (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    requireEvent(db, eventId);
    sendData(res, listBrackets(db, eventId));
  });

  router.get('/events/:eventId/tournament/:bracketId', (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    sendData(res, getBracket(db, param(req, 'bracketId')));
  });

  router.post('/events/:eventId/tournament/generate', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    const input = z.object({ classId: z.string().min(1) }).parse(req.body ?? {});
    const result = generateTournament(db, eventId, { classId: input.classId, actorId: req.auth?.userId ?? null });
    audit(db, req, eventId, 'TOURNAMENT', result.bracket.bracketId, 'GENERATE', undefined, {
      classId: input.classId,
      size: result.bracket.size,
      rounds: result.bracket.rounds,
      created: result.created.map((entry) => entry.matchId),
      walkovers: result.walkovers.length,
    });
    sendData(res, result, 201);
    if (afterRun) queueMicrotask(() => afterRun(eventId));
  });

  router.post('/events/:eventId/tournament/:bracketId/rebalance', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    const result = rebalanceBracket(db, eventId, param(req, 'bracketId'), req.auth?.userId ?? null);
    audit(db, req, eventId, 'TOURNAMENT', param(req, 'bracketId'), 'REBALANCE', undefined, result);
    sendData(res, { ...result, bracket: getBracket(db, param(req, 'bracketId')) });
  });

  router.delete('/events/:eventId/tournament/:bracketId', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    const result = deleteBracket(db, eventId, param(req, 'bracketId'), req.auth?.userId ?? null);
    audit(db, req, eventId, 'TOURNAMENT', param(req, 'bracketId'), 'DELETE', undefined, result);
    sendData(res, result);
  });

  return router;
}
