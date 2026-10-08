import { Router, type Response } from 'express';
import type { DB } from '../db.js';
import { requireRole, type AuthedRequest } from '../auth.js';
import { sendData } from '../http.js';
import { ensureEventAccess, readCourts, readEventDetail, readParticipants, requireEvent } from './core.js';
import { readMatches } from './matches.js';
import { readRequests } from './requests.js';
import { buildEngineState } from '../services/engineState.js';

function param(req: AuthedRequest, key: string): string {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

const LIVE_STATUSES = ['WAITING', 'CALLED', 'COURT_ASSIGNED', 'PLAYING', 'RESULT_PENDING'];
/** Anything the operator acted on in this window still belongs on the board. */
const RECENT_WINDOW_MS = 30 * 60_000;

/**
 * One request that carries everything the operator board needs. The board used to
 * issue six requests per poll, i.e. fifteen round trips a minute per laptop on venue
 * Wi-Fi, and re-download the whole match list while doing it. The engine section is
 * built in light mode (no pairwise candidate scoring), which is what makes a single
 * combined call cheap enough to poll.
 */
export function createSnapshotRouter(db: DB): Router {
  const router = Router();

  router.get('/events/:eventId/snapshot', requireRole('OWNER', 'ADMIN', 'VIEWER'), (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    requireEvent(db, eventId);
    // A polling board must never be served from a cache or an intermediary.
    res.setHeader('cache-control', 'no-store');
    const allMatches = readMatches(db, eventId, { limit: 500 });
    const nowMs = Date.now();
    const recent = allMatches.filter((match) => LIVE_STATUSES.includes(String(match.status))
      || nowMs - Date.parse(String(match.updated_at)) < RECENT_WINDOW_MS);
    sendData(res, {
      eventId,
      fetchedAt: new Date(nowMs).toISOString(),
      event: readEventDetail(db, eventId),
      courts: readCourts(db, eventId),
      matches: recent,
      allMatches,
      participants: readParticipants(db, eventId, { league: true }),
      requests: readRequests(db, eventId),
      engine: buildEngineState(db, eventId, { light: true }),
    });
  });

  return router;
}
