import { Router, type Response } from 'express';
import { z } from 'zod';
import type { DB } from '../db.js';
import { asRow, asRows, makeId, nowIso, transaction } from '../db.js';
import type { AuthedRequest } from '../auth.js';
import { requireRole } from '../auth.js';
import { ApiError, sendData } from '../http.js';
import { normalizeName } from '../seed.js';
import { buildLeagueProgress, leaguePlayerNumbers } from '../services/league.js';

const eventModes = ['LEAGUE_REQUEST', 'REQUEST_ONLY', 'LEAGUE_TOURNAMENT_REQUEST'] as const;
const eventStatuses = ['DRAFT', 'READY', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED'] as const;
const phases = ['LEAGUE', 'TOURNAMENT', 'REQUEST'] as const;
const courtStatuses = ['AVAILABLE', 'RESERVED', 'CALLING', 'PLAYING', 'RESULT_PENDING', 'BLOCKED', 'MAINTENANCE'] as const;

const eventInput = z.object({
  eventName: z.string().trim().min(1).max(120),
  eventDate: z.string().date(),
  venue: z.string().trim().min(1).max(160),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  eventMode: z.enum(eventModes).default('LEAGUE_REQUEST'),
  maxParticipants: z.number().int().min(2).max(500).default(60),
  entryFee: z.number().int().min(0).default(0),
  description: z.string().max(2000).default(''),
}).refine((input) => new Date(input.endTime) > new Date(input.startTime), {
  path: ['endTime'], message: '終了時刻は開始時刻より後にしてください。',
});

const eventPatch = z.object({
  eventName: z.string().trim().min(1).max(120).optional(),
  eventDate: z.string().date().optional(),
  venue: z.string().trim().min(1).max(160).optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  eventMode: z.enum(eventModes).optional(),
  currentPhase: z.enum(phases).optional(),
  maxParticipants: z.number().int().min(2).max(500).optional(),
  entryFee: z.number().int().min(0).optional(),
  description: z.string().max(2000).optional(),
  defaultMatchMinutes: z.number().int().min(3).max(120).optional(),
  minimumRestMinutes: z.number().int().min(0).max(120).optional(),
  maximumRestMinutes: z.number().int().min(1).max(300).optional(),
  resultInputGraceMinutes: z.number().int().min(0).max(30).optional(),
  resultConfirmTimeoutMinutes: z.number().int().min(0).max(60).optional(),
  lateMatchCutoffMinutes: z.number().int().min(0).max(60).optional(),
  safetyMarginMinutes: z.number().int().min(0).max(60).optional(),
  leagueMatchCount: z.number().int().min(1).max(50).optional(),
  leagueType: z.enum(['FULL_ROUND_ROBIN', 'LIMITED_ROUND_ROBIN']).optional(),
  allowRequest: z.boolean().optional(),
  allowRematch: z.boolean().optional(),
  allowSameDayRepeat: z.boolean().optional(),
  autoCourtAssignment: z.boolean().optional(),
  autoRematch: z.boolean().optional(),
  noShowEnabled: z.boolean().optional(),
  notificationEnabled: z.boolean().optional(),
  autoEngineEnabled: z.boolean().optional(),
  weightRequestPriority: z.number().min(0).max(100).optional(),
  weightWaiting: z.number().min(0).max(20).optional(),
  weightMatchBalance: z.number().min(0).max(100).optional(),
  weightUnplayed: z.number().min(0).max(100).optional(),
  weightRating: z.number().min(0).max(100).optional(),
  weightTimeFit: z.number().min(0).max(100).optional(),
  penaltyRecent: z.number().min(0).max(100).optional(),
  penaltyRepeat: z.number().min(0).max(100).optional(),
  rowVersion: z.number().int().positive(),
});

const eventColumnMap: Record<string, string> = {
  eventName: 'event_name', eventDate: 'event_date', venue: 'venue', startTime: 'start_time', endTime: 'end_time',
  eventMode: 'event_mode', currentPhase: 'current_phase', maxParticipants: 'max_participants', entryFee: 'entry_fee',
  description: 'description', defaultMatchMinutes: 'default_match_minutes', minimumRestMinutes: 'minimum_rest_minutes',
  maximumRestMinutes: 'maximum_rest_minutes', resultInputGraceMinutes: 'result_input_grace_minutes',
  resultConfirmTimeoutMinutes: 'result_confirm_timeout_minutes',
  lateMatchCutoffMinutes: 'late_match_cutoff_minutes', safetyMarginMinutes: 'safety_margin_minutes',
  leagueMatchCount: 'league_match_count', leagueType: 'league_type', allowRequest: 'allow_request',
  allowRematch: 'allow_rematch', allowSameDayRepeat: 'allow_same_day_repeat', autoCourtAssignment: 'auto_court_assignment',
  autoRematch: 'auto_rematch', noShowEnabled: 'no_show_enabled', notificationEnabled: 'notification_enabled',
  autoEngineEnabled: 'auto_engine_enabled', weightRequestPriority: 'weight_request_priority', weightWaiting: 'weight_waiting',
  weightMatchBalance: 'weight_match_balance', weightUnplayed: 'weight_unplayed', weightRating: 'weight_rating',
  weightTimeFit: 'weight_time_fit', penaltyRecent: 'penalty_recent', penaltyRepeat: 'penalty_repeat',
};

function booleanToSql(value: unknown): any {
  return typeof value === 'boolean' ? Number(value) : value;
}

function param(req: AuthedRequest, key: string): string {
  const value = req.params[key];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function ensureEventAccess(db: DB, req: AuthedRequest, eventId: string): void {
  if (!req.auth) throw new ApiError(401, 'UNAUTHENTICATED', 'ログインが必要です。');
  if (req.auth.role !== 'PARTICIPANT') return;
  const allowed = req.auth.participantId
    ? db.prepare('SELECT 1 FROM participants WHERE participant_id = ? AND event_id = ?').get(req.auth.participantId, eventId)
    : undefined;
  if (!allowed) throw new ApiError(403, 'FORBIDDEN', 'このイベントを閲覧できません。');
}

function requireEvent(db: DB, eventId: string): Record<string, unknown> {
  const event = asRow<Record<string, unknown>>(db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId));
  if (!event) throw new ApiError(404, 'EVENT_NOT_FOUND', 'イベントが見つかりません。');
  return event;
}

function audit(db: DB, req: AuthedRequest, eventId: string, entityType: string, entityId: string, action: string, before?: unknown, after?: unknown): void {
  db.prepare(`INSERT INTO audit_logs (event_id, actor_id, entity_type, entity_id, action, before_json, after_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(eventId, req.auth?.userId ?? null, entityType, entityId, action,
      before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), nowIso());
}

/**
 * The reads below are shared with the polled snapshot endpoint, so the board and
 * the individual endpoints can never drift apart on what a row contains.
 */
export function readEventDetail(db: DB, eventId: string) {
  const event = requireEvent(db, eventId);
  const classes = asRows(db.prepare('SELECT * FROM classes WHERE event_id = ? ORDER BY display_order, class_name').all(eventId));
  const summary = db.prepare(`SELECT
    (SELECT COUNT(*) FROM participants WHERE event_id = ? AND active = 1) AS participant_count,
    (SELECT COUNT(*) FROM participants WHERE event_id = ? AND active = 1 AND checked_in = 1) AS checked_in_count,
    (SELECT COUNT(*) FROM courts WHERE event_id = ? AND enabled = 1) AS court_count,
    (SELECT COUNT(*) FROM matches WHERE event_id = ?) AS match_count,
    (SELECT COUNT(*) FROM matches WHERE event_id = ? AND status = 'COMPLETED') AS completed_match_count
  `).get(eventId, eventId, eventId, eventId, eventId);
  return { ...event, classes, summary, league: buildLeagueProgress(db, eventId) };
}

export function readCourts(db: DB, eventId: string) {
  return asRows(db.prepare(`SELECT c.*,
    (SELECT match_id FROM matches m WHERE m.court_id = c.court_id AND m.status IN ('COURT_ASSIGNED','PLAYING','RESULT_PENDING') ORDER BY m.updated_at DESC LIMIT 1) AS current_match_id
    FROM courts c WHERE c.event_id = ? ORDER BY c.priority, c.court_number`).all(eventId));
}

export function readParticipants(db: DB, eventId: string, options: { search?: string | null; active?: number | null; classId?: string | null; league?: boolean } = {}) {
  const search = options.search ? `%${options.search}%` : '%';
  const active = options.active ?? null;
  const classId = options.classId ?? null;
  // played/wins used to be two correlated COUNT subqueries per participant, which
  // cost ~45ms per poll once a 400 player event had a few hundred finished matches.
  // One pre-aggregated pass over the event's matches is the same answer, far cheaper.
  const rows = asRows<Record<string, any>>(db.prepare(`SELECT p.*, c.class_name,
    COALESCE(stats.played, 0) AS played, COALESCE(stats.wins, 0) AS wins
    FROM participants p
    LEFT JOIN classes c ON c.class_id = p.class_id
    LEFT JOIN (
      SELECT entrant.participant_id,
        COUNT(*) AS played,
        SUM(CASE WHEN entrant.winner_id = entrant.participant_id THEN 1 ELSE 0 END) AS wins
      FROM (
        SELECT m.player_a_id AS participant_id, m.winner_id FROM matches m WHERE m.event_id = ? AND m.status = 'COMPLETED'
        UNION ALL
        SELECT m.player_b_id AS participant_id, m.winner_id FROM matches m WHERE m.event_id = ? AND m.status = 'COMPLETED'
      ) entrant
      GROUP BY entrant.participant_id
    ) stats ON stats.participant_id = p.participant_id
    WHERE p.event_id = ? AND (p.name LIKE ? OR p.name_kana LIKE ? OR p.club LIKE ?)
    AND (? IS NULL OR p.active = ?) AND (? IS NULL OR p.class_id = ?)
    ORDER BY p.active DESC, c.display_order, p.name_kana, p.name`).all(
      eventId, eventId, eventId, search, search, search, active, active, classId, classId,
    ));
  // The league promise lives in the round-robin plan, not in a column, so the roster
  // row carries it next to `played` and the board can show 消化/計画 without a 2nd call.
  if (options.league) {
    const numbers = leaguePlayerNumbers(db, eventId);
    for (const row of rows) {
      const value = numbers?.get(String(row.participant_id));
      row.league_target = value?.target ?? 0;
      row.league_played = value?.played ?? 0;
      row.league_scheduled = value?.scheduled ?? 0;
      row.league_shortfall = value?.shortfall ?? 0;
    }
  }
  return rows;
}

export function createCoreRouter(db: DB): Router {
  const router = Router();

  router.get('/events', (req: AuthedRequest, res: Response) => {
    const participantFilter = req.auth?.role === 'PARTICIPANT' ? 'WHERE e.event_id = (SELECT event_id FROM participants WHERE participant_id = ?)' : '';
    const params = req.auth?.role === 'PARTICIPANT' ? [req.auth.participantId] : [];
    const events = asRows(db.prepare(`
      SELECT e.*,
        (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.event_id AND p.active = 1) AS participant_count,
        (SELECT COUNT(*) FROM courts c WHERE c.event_id = e.event_id AND c.enabled = 1) AS court_count,
        (SELECT COUNT(*) FROM matches m WHERE m.event_id = e.event_id) AS match_count,
        (SELECT COUNT(*) FROM matches m WHERE m.event_id = e.event_id AND m.status = 'COMPLETED') AS completed_match_count
      FROM events e ${participantFilter} ORDER BY e.event_date DESC, e.start_time DESC
    `).all(...params));
    sendData(res, events);
  });

  router.post('/events', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    const input = eventInput.parse(req.body);
    const id = makeId('evt');
    const now = nowIso();
    const phase = input.eventMode === 'REQUEST_ONLY' ? 'REQUEST' : 'LEAGUE';
    db.prepare(`INSERT INTO events (
      event_id, event_name, event_date, venue, start_time, end_time, status, event_mode, current_phase,
      max_participants, entry_fee, description, created_at, updated_at, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.eventName, input.eventDate, input.venue, input.startTime, input.endTime, input.eventMode, phase,
        input.maxParticipants, input.entryFee, input.description, now, now, req.auth?.userId ?? null);
    const createdEvent = requireEvent(db, id);
    audit(db, req, id, 'EVENT', id, 'CREATE', undefined, createdEvent);
    sendData(res, createdEvent, 201);
  });

  router.get('/events/:eventId', (req: AuthedRequest, res: Response) => {
    ensureEventAccess(db, req, param(req, 'eventId'));
    sendData(res, readEventDetail(db, param(req, 'eventId')));
  });

  router.patch('/events/:eventId', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    const before = requireEvent(db, eventId);
    const input = eventPatch.parse(req.body);
    const startTime = input.startTime ?? String(before.start_time);
    const endTime = input.endTime ?? String(before.end_time);
    if (new Date(endTime) <= new Date(startTime)) throw new ApiError(400, 'INVALID_TIME_RANGE', '終了時刻は開始時刻より後にしてください。');
    const entries = Object.entries(input).filter(([key]) => key !== 'rowVersion');
    if (entries.length === 0) return sendData(res, before);
    const assignments = entries.map(([key]) => `${eventColumnMap[key]} = ?`).join(', ');
    const values = entries.map(([, value]) => booleanToSql(value));
    const result = db.prepare(`UPDATE events SET ${assignments}, updated_at = ?, row_version = row_version + 1
      WHERE event_id = ? AND row_version = ?`).run(...values, nowIso(), eventId, input.rowVersion);
    if (Number(result.changes) === 0) throw new ApiError(409, 'VERSION_CONFLICT', '他の端末でイベントが更新されました。再読み込みしてください。');
    const after = requireEvent(db, eventId);
    audit(db, req, eventId, 'EVENT', eventId, 'UPDATE', before, after);
    sendData(res, after);
  });

  router.post('/events/:eventId/status', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    const { status, rowVersion } = z.object({ status: z.enum(eventStatuses), rowVersion: z.number().int().positive() }).parse(req.body);
    const event = requireEvent(db, param(req, 'eventId'));
    const current = String(event.status);
    const allowed: Record<string, string[]> = {
      DRAFT: ['READY', 'RUNNING', 'CANCELLED'], READY: ['DRAFT', 'RUNNING', 'CANCELLED'],
      RUNNING: ['PAUSED', 'COMPLETED', 'CANCELLED'], PAUSED: ['RUNNING', 'COMPLETED', 'CANCELLED'],
      COMPLETED: [], CANCELLED: [],
    };
    if (status !== current && !allowed[current]?.includes(status)) {
      throw new ApiError(409, 'INVALID_STATE_TRANSITION', `${current} から ${status} へは変更できません。`);
    }
    const result = db.prepare('UPDATE events SET status = ?, updated_at = ?, row_version = row_version + 1 WHERE event_id = ? AND row_version = ?')
      .run(status, nowIso(), param(req, 'eventId'), rowVersion);
    if (Number(result.changes) === 0) throw new ApiError(409, 'VERSION_CONFLICT', '他の端末でイベントが更新されました。');
    const after = requireEvent(db, param(req, 'eventId'));
    audit(db, req, param(req, 'eventId'), 'EVENT', param(req, 'eventId'), `STATUS_${status}`, event, after);
    sendData(res, after);
  });

  router.get('/events/:eventId/classes', (req: AuthedRequest, res: Response) => {
    ensureEventAccess(db, req, param(req, 'eventId'));
    requireEvent(db, param(req, 'eventId'));
    sendData(res, asRows(db.prepare('SELECT * FROM classes WHERE event_id = ? ORDER BY display_order, class_name').all(param(req, 'eventId'))));
  });

  router.post('/events/:eventId/classes', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    requireEvent(db, param(req, 'eventId'));
    const input = z.object({
      className: z.string().trim().min(1).max(80), displayOrder: z.number().int().default(0),
      description: z.string().max(500).default(''), enabled: z.boolean().default(true),
    }).parse(req.body);
    const id = makeId('cls');
    const now = nowIso();
    db.prepare(`INSERT INTO classes (class_id, event_id, class_name, display_order, description, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, param(req, 'eventId'), input.className, input.displayOrder, input.description, Number(input.enabled), now, now);
    const row = db.prepare('SELECT * FROM classes WHERE class_id = ?').get(id);
    audit(db, req, param(req, 'eventId'), 'CLASS', id, 'CREATE', undefined, row);
    sendData(res, row, 201);
  });

  router.patch('/events/:eventId/classes/:classId', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    requireEvent(db, param(req, 'eventId'));
    const before = asRow<Record<string, unknown>>(db.prepare('SELECT * FROM classes WHERE class_id = ? AND event_id = ?').get(param(req, 'classId'), param(req, 'eventId')));
    if (!before) throw new ApiError(404, 'CLASS_NOT_FOUND', 'クラスが見つかりません。');
    const input = z.object({
      className: z.string().trim().min(1).max(80).optional(), displayOrder: z.number().int().optional(),
      description: z.string().max(500).optional(), enabled: z.boolean().optional(),
    }).parse(req.body);
    const map: Record<string, string> = { className: 'class_name', displayOrder: 'display_order', description: 'description', enabled: 'enabled' };
    const entries = Object.entries(input);
    if (entries.length) db.prepare(`UPDATE classes SET ${entries.map(([key]) => `${map[key]} = ?`).join(', ')}, updated_at = ? WHERE class_id = ?`)
      .run(...entries.map(([, value]) => booleanToSql(value)), nowIso(), param(req, 'classId'));
    const after = db.prepare('SELECT * FROM classes WHERE class_id = ?').get(param(req, 'classId'));
    audit(db, req, param(req, 'eventId'), 'CLASS', param(req, 'classId'), 'UPDATE', before, after);
    sendData(res, after);
  });

  router.delete('/events/:eventId/classes/:classId', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    requireEvent(db, param(req, 'eventId'));
    const row = db.prepare('SELECT * FROM classes WHERE class_id = ? AND event_id = ?').get(param(req, 'classId'), param(req, 'eventId'));
    if (!row) throw new ApiError(404, 'CLASS_NOT_FOUND', 'クラスが見つかりません。');
    db.prepare('DELETE FROM classes WHERE class_id = ?').run(param(req, 'classId'));
    audit(db, req, param(req, 'eventId'), 'CLASS', param(req, 'classId'), 'DELETE', row, undefined);
    res.status(204).end();
  });

  router.get('/events/:eventId/participants', (req: AuthedRequest, res: Response) => {
    ensureEventAccess(db, req, param(req, 'eventId'));
    requireEvent(db, param(req, 'eventId'));
    const rows = readParticipants(db, param(req, 'eventId'), {
      search: typeof req.query.search === 'string' ? req.query.search.trim() : null,
      active: req.query.active === undefined ? null : req.query.active === 'true' ? 1 : 0,
      classId: typeof req.query.classId === 'string' ? req.query.classId : null,
      league: true,
    });
    if (req.auth?.role === 'PARTICIPANT') {
      const safeRows = rows.map((row) => {
        const { name_kana: _kana, row_version: _version, ...safe } = row as Record<string, unknown>;
        return safe;
      });
      return sendData(res, safeRows);
    }
    sendData(res, rows);
  });

  router.post('/events/:eventId/participants', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    const event = requireEvent(db, param(req, 'eventId'));
    const input = z.object({
      name: z.string().trim().min(1).max(80), nameKana: z.string().trim().max(120).default(''),
      club: z.string().trim().max(120).default(''), grade: z.string().trim().max(30).default(''),
      gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED']).default('UNSPECIFIED'),
      category: z.string().trim().max(50).default('SINGLES'), classId: z.string().nullable().default(null),
      rating: z.number().int().min(0).max(5000).default(1000), checkedIn: z.boolean().default(true),
    }).parse(req.body);
    const count = Number((db.prepare('SELECT COUNT(*) AS count FROM participants WHERE event_id = ? AND active = 1').get(param(req, 'eventId')) as { count: number }).count);
    if (count >= Number(event.max_participants)) throw new ApiError(409, 'EVENT_FULL', 'イベントの定員に達しています。');
    const id = makeId('ptc');
    const now = nowIso();
    db.prepare(`INSERT INTO participants (
      participant_id, event_id, name, name_normalized, name_kana, club, grade, gender, category, class_id, rating,
      active, checked_in, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run(id, param(req, 'eventId'), input.name, normalizeName(input.name), input.nameKana, input.club, input.grade,
        input.gender, input.category, input.classId, input.rating, Number(input.checkedIn), now, now);
    const row = db.prepare('SELECT * FROM participants WHERE participant_id = ?').get(id);
    audit(db, req, param(req, 'eventId'), 'PARTICIPANT', id, 'CREATE', undefined, row);
    sendData(res, row, 201);
  });

  router.patch('/events/:eventId/participants/:participantId', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    requireEvent(db, param(req, 'eventId'));
    const before = asRow<Record<string, unknown>>(db.prepare('SELECT * FROM participants WHERE participant_id = ? AND event_id = ?').get(param(req, 'participantId'), param(req, 'eventId')));
    if (!before) throw new ApiError(404, 'PARTICIPANT_NOT_FOUND', '参加者が見つかりません。');
    const input = z.object({
      name: z.string().trim().min(1).max(80).optional(), nameKana: z.string().trim().max(120).optional(),
      club: z.string().trim().max(120).optional(), grade: z.string().trim().max(30).optional(),
      gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED']).optional(), category: z.string().trim().max(50).optional(),
      classId: z.string().nullable().optional(), rating: z.number().int().min(0).max(5000).optional(),
      active: z.boolean().optional(), checkedIn: z.boolean().optional(), rowVersion: z.number().int().positive(),
    }).parse(req.body);
    if (input.active === false) {
      const busy = db.prepare(`SELECT 1 FROM matches WHERE event_id = ? AND ? IN (player_a_id, player_b_id)
        AND status IN ('CALLED','COURT_ASSIGNED','PLAYING','RESULT_PENDING')`).get(param(req, 'eventId'), param(req, 'participantId'));
      if (busy) throw new ApiError(409, 'PARTICIPANT_BUSY', '進行中の試合があるため無効化できません。');
    }
    const map: Record<string, string> = {
      name: 'name', nameKana: 'name_kana', club: 'club', grade: 'grade', gender: 'gender', category: 'category',
      classId: 'class_id', rating: 'rating', active: 'active', checkedIn: 'checked_in',
    };
    const entries = Object.entries(input).filter(([key]) => key !== 'rowVersion');
    if (input.name) entries.push(['nameNormalized', normalizeName(input.name)]);
    map.nameNormalized = 'name_normalized';
    if (entries.length) {
      const result = db.prepare(`UPDATE participants SET ${entries.map(([key]) => `${map[key]} = ?`).join(', ')},
        updated_at = ?, row_version = row_version + 1 WHERE participant_id = ? AND event_id = ? AND row_version = ?`)
        .run(...entries.map(([, value]) => booleanToSql(value)), nowIso(), param(req, 'participantId'), param(req, 'eventId'), input.rowVersion);
      if (Number(result.changes) === 0) throw new ApiError(409, 'VERSION_CONFLICT', '他の端末で参加者が更新されました。');
    }
    const after = db.prepare('SELECT * FROM participants WHERE participant_id = ?').get(param(req, 'participantId'));
    audit(db, req, param(req, 'eventId'), 'PARTICIPANT', param(req, 'participantId'), 'UPDATE', before, after);
    sendData(res, after);
  });

  router.get('/events/:eventId/courts', (req: AuthedRequest, res: Response) => {
    ensureEventAccess(db, req, param(req, 'eventId'));
    requireEvent(db, param(req, 'eventId'));
    sendData(res, readCourts(db, param(req, 'eventId')));
  });

  router.post('/events/:eventId/courts', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    const event = requireEvent(db, param(req, 'eventId'));
    const input = z.object({
      courtNumber: z.number().int().positive(), courtName: z.string().trim().min(1).max(80),
      availableFrom: z.string().datetime().default(String(event.start_time)), availableTo: z.string().datetime().default(String(event.end_time)),
      priority: z.number().int().min(1).max(100).default(1), enabled: z.boolean().default(true),
    }).refine((value) => new Date(value.availableTo) > new Date(value.availableFrom), { path: ['availableTo'], message: '利用終了は開始より後にしてください。' }).parse(req.body);
    const id = makeId('court');
    const now = nowIso();
    db.prepare(`INSERT INTO courts (court_id, event_id, court_number, court_name, status, available_from, available_to, priority, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'AVAILABLE', ?, ?, ?, ?, ?, ?)`)
      .run(id, param(req, 'eventId'), input.courtNumber, input.courtName, input.availableFrom, input.availableTo,
        input.priority, Number(input.enabled), now, now);
    const row = db.prepare('SELECT * FROM courts WHERE court_id = ?').get(id);
    audit(db, req, param(req, 'eventId'), 'COURT', id, 'CREATE', undefined, row);
    sendData(res, row, 201);
  });

  router.patch('/events/:eventId/courts/:courtId', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    requireEvent(db, param(req, 'eventId'));
    const before = asRow<Record<string, unknown>>(db.prepare('SELECT * FROM courts WHERE court_id = ? AND event_id = ?').get(param(req, 'courtId'), param(req, 'eventId')));
    if (!before) throw new ApiError(404, 'COURT_NOT_FOUND', 'コートが見つかりません。');
    const input = z.object({
      courtNumber: z.number().int().positive().optional(), courtName: z.string().trim().min(1).max(80).optional(),
      status: z.enum(courtStatuses).optional(), availableFrom: z.string().datetime().optional(), availableTo: z.string().datetime().optional(),
      priority: z.number().int().min(1).max(100).optional(), enabled: z.boolean().optional(), rowVersion: z.number().int().positive(),
    }).parse(req.body);
    if (input.enabled === false || input.status === 'BLOCKED' || input.status === 'MAINTENANCE') {
      const busy = db.prepare(`SELECT 1 FROM matches WHERE court_id = ? AND status IN ('COURT_ASSIGNED','PLAYING','RESULT_PENDING')`).get(param(req, 'courtId'));
      if (busy) throw new ApiError(409, 'COURT_BUSY', '進行中の試合があるためコートを停止できません。');
    }
    const from = input.availableFrom ?? String(before.available_from);
    const to = input.availableTo ?? String(before.available_to);
    if (new Date(to) <= new Date(from)) throw new ApiError(400, 'INVALID_TIME_RANGE', '利用終了は開始より後にしてください。');
    const map: Record<string, string> = { courtNumber: 'court_number', courtName: 'court_name', status: 'status', availableFrom: 'available_from', availableTo: 'available_to', priority: 'priority', enabled: 'enabled' };
    const entries = Object.entries(input).filter(([key]) => key !== 'rowVersion');
    const result = db.prepare(`UPDATE courts SET ${entries.map(([key]) => `${map[key]} = ?`).join(', ') || 'updated_at = updated_at'},
      updated_at = ?, row_version = row_version + 1 WHERE court_id = ? AND event_id = ? AND row_version = ?`)
      .run(...entries.map(([, value]) => booleanToSql(value)), nowIso(), param(req, 'courtId'), param(req, 'eventId'), input.rowVersion);
    if (Number(result.changes) === 0) throw new ApiError(409, 'VERSION_CONFLICT', '他の端末でコートが更新されました。');
    const after = db.prepare('SELECT * FROM courts WHERE court_id = ?').get(param(req, 'courtId'));
    audit(db, req, param(req, 'eventId'), 'COURT', param(req, 'courtId'), 'UPDATE', before, after);
    sendData(res, after);
  });

  router.get('/events/:eventId/audit', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    requireEvent(db, param(req, 'eventId'));
    sendData(res, asRows(db.prepare(`SELECT a.*, u.display_name AS actor_name FROM audit_logs a
      LEFT JOIN users u ON u.user_id = a.actor_id WHERE a.event_id = ? ORDER BY a.created_at DESC LIMIT 200`).all(param(req, 'eventId'))));
  });

  return router;
}

export { ensureEventAccess, requireEvent, audit };
