import { Router, type Request, type Response } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DB } from '../db.js';
import { asRow, nowIso } from '../db.js';
import { requireRole, type AuthedRequest } from '../auth.js';
import { ApiError, sendData } from '../http.js';
import { audit, ensureEventAccess, requireEvent } from './core.js';
import { buildScreenBoard } from '../services/screen.js';

function param(req: AuthedRequest | Request, key: string): string {
  const value = (req.params as Record<string, string | string[]>)[key];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

/**
 * Tokens are compared as sha-256 digests with a constant-time check: the board is
 * polled by a TV every few seconds from an unauthenticated path, so the only thing
 * between the hall and the event data is this string.
 */
function digest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function tokenMatches(expected: string | null | undefined, given: string): boolean {
  if (!expected) return false;
  const left = digest(expected);
  const right = digest(given);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Staff side: preview the board, and mint / revoke the published link. */
export function createScreenRouter(db: DB): Router {
  const router = Router();

  router.get('/events/:eventId/screen', (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    // The staff preview repeats the published token, so it is event scoped like
    // everything else on the board.
    ensureEventAccess(db, req, eventId);
    const event = requireEvent(db, eventId);
    sendData(res, {
      ...buildScreenBoard(db, eventId),
      screen: {
        enabled: Boolean(event.screen_token),
        // The token is only ever shown to staff, who are the ones that must paste
        // the address into the TV browser.
        token: event.screen_token ? String(event.screen_token) : null,
        path: event.screen_token ? `/screen/${eventId}?t=${String(event.screen_token)}` : null,
      },
    });
  });

  router.post('/events/:eventId/screen/token', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    requireEvent(db, eventId);
    const token = randomBytes(9).toString('base64url');
    const now = nowIso();
    db.prepare('UPDATE events SET screen_token = ?, updated_at = ? WHERE event_id = ?').run(token, now, eventId);
    audit(db, req, eventId, 'SCREEN', eventId, 'ISSUE', undefined, { token });
    sendData(res, { token, path: `/screen/${eventId}?t=${token}` }, 201);
  });

  router.delete('/events/:eventId/screen/token', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    requireEvent(db, eventId);
    const before = asRow<Record<string, unknown>>(db.prepare('SELECT screen_token FROM events WHERE event_id = ?').get(eventId));
    db.prepare('UPDATE events SET screen_token = NULL, updated_at = ? WHERE event_id = ?').run(nowIso(), eventId);
    audit(db, req, eventId, 'SCREEN', eventId, 'REVOKE', before, undefined);
    sendData(res, { token: null, path: null });
  });

  return router;
}

/**
 * The published board. Mounted outside the session middleware on purpose: a
 * projector in the hall has no account, only the link the operator printed.
 * Draft events are refused so a roster cannot leak before the day starts.
 */
export function createPublicScreenRouter(db: DB): Router {
  const router = Router();

  router.get('/screen/:eventId', (req: Request, res: Response) => {
    const eventId = param(req, 'eventId');
    const given = typeof req.query.t === 'string' ? req.query.t : '';
    const event = asRow<Record<string, unknown>>(db.prepare('SELECT event_id, status, screen_token FROM events WHERE event_id = ?')
      .get(eventId));
    if (!event || !tokenMatches(event.screen_token as string | null, given)) {
      // Same answer for "no such event" and "wrong link": the endpoint must not
      // turn into a way to enumerate event ids.
      throw new ApiError(403, 'SCREEN_LINK_INVALID', '表示用リンクが無効です。運営に確認してください。');
    }
    if (String(event.status) === 'DRAFT') throw new ApiError(409, 'SCREEN_NOT_STARTED', '準備中のため表示できません。');
    // A TV left on all day polls this; never let a proxy serve a stale board.
    res.setHeader('cache-control', 'no-store');
    sendData(res, buildScreenBoard(db, eventId));
  });

  return router;
}
