import { Router, type Response } from 'express';
import { z } from 'zod';
import type { DB } from '../db.js';
import { asRow, asRows, makeId, nowIso } from '../db.js';
import type { AuthedRequest } from '../auth.js';
import { ApiError, sendData } from '../http.js';
import { audit, ensureEventAccess, requireEvent } from './core.js';

function param(req: AuthedRequest, key: string): string {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

const requestSelect = `SELECT r.request_id, r.event_id, r.requester_id, r.target_player_id, r.priority, r.status,
  r.matched_match_id, r.created_at, r.updated_at, r.row_version,
  pr.name AS requester_name, pt.name AS target_name, ct.class_name AS target_class_name,
  m.status AS matched_match_status, c.court_name AS matched_court_name
  FROM match_requests r
  JOIN participants pr ON pr.participant_id = r.requester_id
  JOIN participants pt ON pt.participant_id = r.target_player_id
  LEFT JOIN classes ct ON ct.class_id = pt.class_id
  LEFT JOIN matches m ON m.match_id = r.matched_match_id
  LEFT JOIN courts c ON c.court_id = m.court_id`;

/** Shared with the snapshot endpoint so both list exactly the same requests. */
export function readRequests(db: DB, eventId: string, status: string | null = null) {
  return asRows<Record<string, any>>(db.prepare(`${requestSelect}
    WHERE r.event_id = ? AND (? IS NULL OR r.status = ?)
    ORDER BY CASE r.status WHEN 'ACTIVE' THEN 1 WHEN 'MATCHED' THEN 2 ELSE 3 END, r.priority, r.created_at DESC
    LIMIT 300`).all(eventId, status, status));
}

/** Participants may only see the identity fields they need to choose an opponent. */
function sanitize(row: Record<string, any>, role: string, viewerId: string | null): Record<string, any> {
  if (role !== 'PARTICIPANT') return row;
  const own = row.requester_id === viewerId || row.target_player_id === viewerId;
  const safe: Record<string, any> = {
    requestId: row.request_id, eventId: row.event_id, requesterId: row.requester_id,
    requesterName: row.requester_name, targetPlayerId: row.target_player_id, targetName: row.target_name,
    targetClassName: row.target_class_name, priority: Number(row.priority), status: row.status,
    createdAt: row.created_at, rowVersion: Number(row.row_version), own,
  };
  if (own) {
    safe.matchedMatchId = row.matched_match_id;
    safe.matchedMatchStatus = row.matched_match_status;
    safe.matchedCourtName = row.matched_court_name;
  }
  return safe;
}

export function createRequestRouter(db: DB): Router {
  const router = Router();

  router.get('/events/:eventId/requests', (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    requireEvent(db, eventId);
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const rows = readRequests(db, eventId, status);
    const role = req.auth?.role ?? 'VIEWER';
    const viewerId = req.auth?.participantId ?? null;
    const visible = role === 'PARTICIPANT'
      ? rows.filter((row) => row.requester_id === viewerId || row.target_player_id === viewerId)
      : rows;
    sendData(res, visible.map((row) => sanitize(row, role, viewerId)));
  });

  router.post('/events/:eventId/requests', (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    const event = requireEvent(db, eventId);
    if (Number(event.allow_request) !== 1) throw new ApiError(403, 'REQUEST_DISABLED', 'このイベントは対戦希望を受け付けていません。');
    if (['COMPLETED', 'CANCELLED'].includes(String(event.status))) throw new ApiError(409, 'EVENT_CLOSED', 'イベントは終了しています。');
    const input = z.object({
      requesterId: z.string().optional(), targetPlayerId: z.string(),
      priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
    }).parse(req.body);

    const role = req.auth?.role ?? 'VIEWER';
    const requesterId = role === 'PARTICIPANT' ? req.auth?.participantId : input.requesterId ?? req.auth?.participantId;
    if (!requesterId) throw new ApiError(400, 'REQUESTER_REQUIRED', '希望を出す選手を指定してください。');
    if (role === 'PARTICIPANT' && input.requesterId && input.requesterId !== req.auth?.participantId) {
      throw new ApiError(403, 'FORBIDDEN', '自分の対戦希望のみ登録できます。');
    }
    if (requesterId === input.targetPlayerId) throw new ApiError(400, 'SELF_REQUEST', '自分自身への対戦希望は登録できません。');

    const players = Number((db.prepare(`SELECT COUNT(*) AS count FROM participants
      WHERE event_id = ? AND participant_id IN (?, ?) AND active = 1`).get(eventId, requesterId, input.targetPlayerId) as { count: number }).count);
    if (players !== 2) throw new ApiError(400, 'INVALID_PARTICIPANT', 'このイベントの有効な選手を指定してください。');

    const id = makeId('req');
    const now = nowIso();
    db.prepare(`INSERT INTO match_requests (request_id, event_id, requester_id, target_player_id, priority, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`)
      .run(id, eventId, requesterId, input.targetPlayerId, input.priority, now, now);
    const row = asRow<Record<string, any>>(db.prepare(`${requestSelect} WHERE r.request_id = ?`).get(id));
    audit(db, req, eventId, 'REQUEST', id, 'CREATE', undefined, row);
    sendData(res, sanitize(row ?? {}, role, req.auth?.participantId ?? null), 201);
  });

  router.patch('/events/:eventId/requests/:requestId', (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    const before = asRow<Record<string, any>>(db.prepare(`${requestSelect} WHERE r.request_id = ? AND r.event_id = ?`)
      .get(param(req, 'requestId'), eventId));
    if (!before) throw new ApiError(404, 'REQUEST_NOT_FOUND', '対戦希望が見つかりません。');
    const role = req.auth?.role ?? 'VIEWER';
    if (role === 'PARTICIPANT' && before.requester_id !== req.auth?.participantId) {
      throw new ApiError(403, 'FORBIDDEN', '自分の対戦希望のみ変更できます。');
    }
    const input = z.object({
      priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      status: z.enum(['ACTIVE', 'CANCELLED']).optional(),
      rowVersion: z.number().int().positive(),
    }).parse(req.body);
    if (before.status === 'MATCHED' && input.status === 'ACTIVE') {
      throw new ApiError(409, 'ALREADY_MATCHED', '成立済みの希望は再開できません。');
    }
    const fields: string[] = ['updated_at = ?', 'row_version = row_version + 1'];
    const values: any[] = [nowIso()];
    if (input.priority !== undefined) { fields.push('priority = ?'); values.push(input.priority); }
    if (input.status !== undefined) { fields.push('status = ?'); values.push(input.status); }
    values.push(before.request_id, input.rowVersion);
    const changed = db.prepare(`UPDATE match_requests SET ${fields.join(', ')} WHERE request_id = ? AND row_version = ?`).run(...values);
    if (Number(changed.changes) === 0) throw new ApiError(409, 'VERSION_CONFLICT', '他の端末で対戦希望が更新されました。');
    const after = asRow<Record<string, any>>(db.prepare(`${requestSelect} WHERE r.request_id = ?`).get(before.request_id));
    audit(db, req, eventId, 'REQUEST', before.request_id, 'UPDATE', before, after);
    sendData(res, sanitize(after ?? {}, role, req.auth?.participantId ?? null));
  });

  router.delete('/events/:eventId/requests/:requestId', (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    const before = asRow<Record<string, any>>(db.prepare(`${requestSelect} WHERE r.request_id = ? AND r.event_id = ?`)
      .get(param(req, 'requestId'), eventId));
    if (!before) throw new ApiError(404, 'REQUEST_NOT_FOUND', '対戦希望が見つかりません。');
    const role = req.auth?.role ?? 'VIEWER';
    if (role === 'PARTICIPANT' && before.requester_id !== req.auth?.participantId) {
      throw new ApiError(403, 'FORBIDDEN', '自分の対戦希望のみ削除できます。');
    }
    db.prepare('DELETE FROM match_requests WHERE request_id = ?').run(before.request_id);
    audit(db, req, eventId, 'REQUEST', before.request_id, 'DELETE', before, undefined);
    res.status(204).end();
  });

  /** Operator helper: suggest opponents for a participant, ordered by the engine score. */
  router.get('/events/:eventId/requests/suggestions', (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    const participantId = typeof req.query.participantId === 'string' ? req.query.participantId : req.auth?.participantId;
    if (!participantId) throw new ApiError(400, 'PARTICIPANT_REQUIRED', '選手を指定してください。');
    const opponents = asRows<Record<string, any>>(db.prepare(`SELECT p.participant_id, p.name, c.class_name, p.rating,
      (SELECT COUNT(*) FROM matches m WHERE m.event_id = p.event_id AND m.status = 'COMPLETED'
        AND p.participant_id IN (m.player_a_id, m.player_b_id)) AS played,
      (SELECT COUNT(*) FROM matches m WHERE m.event_id = p.event_id AND m.status = 'COMPLETED'
        AND m.player_a_id IN (p.participant_id, ?) AND m.player_b_id IN (p.participant_id, ?)) AS head_to_head,
      (SELECT MIN(r.priority) FROM match_requests r WHERE r.event_id = p.event_id AND r.status = 'ACTIVE'
        AND ((r.requester_id = ? AND r.target_player_id = p.participant_id) OR (r.requester_id = p.participant_id AND r.target_player_id = ?))) AS requested_priority
      FROM participants p LEFT JOIN classes c ON c.class_id = p.class_id
      WHERE p.event_id = ? AND p.active = 1 AND p.participant_id <> ?
      ORDER BY requested_priority IS NULL, head_to_head, ABS(p.rating - (SELECT rating FROM participants WHERE participant_id = ?)), p.name`).all(
        participantId, participantId, participantId, participantId, eventId, participantId, participantId,
      ));
    const role = req.auth?.role ?? 'VIEWER';
    sendData(res, opponents.map((row) => (role === 'PARTICIPANT' ? {
      participantId: row.participant_id, name: row.name, className: row.class_name,
      played: Number(row.played), headToHead: Number(row.head_to_head),
      requestedPriority: row.requested_priority === null ? null : Number(row.requested_priority),
    } : {
      participantId: row.participant_id, name: row.name, className: row.class_name, rating: Number(row.rating),
      played: Number(row.played), headToHead: Number(row.head_to_head),
      requestedPriority: row.requested_priority === null ? null : Number(row.requested_priority),
    })));
  });

  return router;
}
