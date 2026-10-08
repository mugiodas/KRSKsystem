import { Router, type Response } from 'express';
import { z } from 'zod';
import type { DB } from '../db.js';
import { asRow, asRows, makeId, nowIso } from '../db.js';
import { requireRole, type AuthedRequest } from '../auth.js';
import { ApiError, sendData } from '../http.js';
import { audit, ensureEventAccess, requireEvent } from './core.js';

function param(req: AuthedRequest, key: string): string {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

/**
 * Announcements are the operator's one-way channel to participants. The
 * participant phone reads them from the same table the dashboard writes to,
 * so a notice posted at the desk appears on the court side immediately.
 */
export function createAnnouncementRouter(db: DB): Router {
  const router = Router();

  router.get('/events/:eventId/announcements', (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    requireEvent(db, eventId);
    const activeOnly = req.query.all !== 'true';
    sendData(res, asRows(db.prepare(`SELECT a.*, u.display_name AS actor_name FROM announcements a
      LEFT JOIN users u ON u.user_id = a.created_by
      WHERE a.event_id = ? AND (? = 0 OR a.active = 1)
      ORDER BY CASE a.severity WHEN 'URGENT' THEN 1 WHEN 'IMPORTANT' THEN 2 ELSE 3 END, a.created_at DESC
      LIMIT 50`).all(eventId, activeOnly ? 1 : 0)));
  });

  router.post('/events/:eventId/announcements', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    const event = requireEvent(db, eventId);
    if (['COMPLETED', 'CANCELLED'].includes(String(event.status))) throw new ApiError(409, 'EVENT_CLOSED', '終了した大会ではお知らせできません。');
    const input = z.object({
      title: z.string().trim().min(1).max(80),
      body: z.string().trim().min(1).max(600),
      severity: z.enum(['INFO', 'IMPORTANT', 'URGENT']).default('INFO'),
    }).parse(req.body);
    const id = makeId('ann');
    const now = nowIso();
    db.prepare(`INSERT INTO announcements (announcement_id, event_id, title, body, severity, active, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(id, eventId, input.title, input.body, input.severity, req.auth?.userId ?? null, now, now);
    audit(db, req, eventId, 'ANNOUNCEMENT', id, 'CREATE', undefined, input);
    sendData(res, db.prepare('SELECT * FROM announcements WHERE announcement_id = ?').get(id), 201);
  });

  router.patch('/events/:eventId/announcements/:announcementId', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    requireEvent(db, param(req, 'eventId'));
    const before = asRow<Record<string, unknown>>(db.prepare('SELECT * FROM announcements WHERE announcement_id = ? AND event_id = ?')
      .get(param(req, 'announcementId'), param(req, 'eventId')));
    if (!before) throw new ApiError(404, 'ANNOUNCEMENT_NOT_FOUND', 'お知らせが見つかりません。');
    const input = z.object({ active: z.boolean().optional(), title: z.string().trim().min(1).max(80).optional(),
      body: z.string().trim().min(1).max(600).optional(), severity: z.enum(['INFO', 'IMPORTANT', 'URGENT']).optional() }).parse(req.body);
    const map: Record<string, string> = { active: 'active', title: 'title', body: 'body', severity: 'severity' };
    const entries = Object.entries(input);
    if (entries.length > 0) {
      db.prepare(`UPDATE announcements SET ${entries.map(([key]) => `${map[key]} = ?`).join(', ')}, updated_at = ? WHERE announcement_id = ?`)
        .run(...entries.map(([, value]) => typeof value === 'boolean' ? Number(value) : value), nowIso(), param(req, 'announcementId'));
    }
    const after = db.prepare('SELECT * FROM announcements WHERE announcement_id = ?').get(param(req, 'announcementId'));
    audit(db, req, param(req, 'eventId'), 'ANNOUNCEMENT', param(req, 'announcementId'), 'UPDATE', before, after);
    sendData(res, after);
  });

  return router;
}
