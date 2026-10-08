import { Router, type Response } from 'express';
import { z } from 'zod';
import type { DB } from '../db.js';
import { asRow, asRows, makeId, nowIso, pairKey, transaction } from '../db.js';
import { requireRole, type AuthedRequest } from '../auth.js';
import { ApiError, sendData } from '../http.js';
import { audit, ensureEventAccess, requireEvent } from './core.js';
import { buildLeaguePreview } from '../services/league.js';
import { assertBracketTerminable, retargetBracket } from '../services/tournament.js';
import { confirmEnteredResult, confirmStaleResults, disputeResult, submitResult, type ResultActor } from '../services/results.js';
import { calculateRankings } from '../services/ranking.js';

const activeStatuses = ['CALLED', 'COURT_ASSIGNED', 'PLAYING', 'RESULT_PENDING'];
const terminalStatuses = ['COMPLETED', 'CANCELLED', 'NO_SHOW'];

function param(req: AuthedRequest, key: string): string {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

  const resultColumns = `res.status AS result_status, res.result_id AS result_row_id,
    res.entered_at AS result_entered_at, res.confirmed_at AS result_confirmed_at,
    res.entered_by_participant AS result_entered_by_participant, res.auto_confirmed AS result_auto_confirmed,
    res.score_a AS reported_score_a, res.score_b AS reported_score_b, res.dispute AS result_dispute`;

/** A pending report travels with the card, so every screen can say what is missing. */
function attachResultShape(row: Record<string, any>): Record<string, any> {
  if (row.result_dispute) {
    try { row.result_dispute = JSON.parse(String(row.result_dispute)); } catch { /* leave as text */ }
  }
  return row;
}

function getMatch(db: DB, matchId: string, eventId?: string): Record<string, any> {
  const row = asRow<Record<string, any>>(db.prepare(`SELECT m.*,
    pa.name AS player_a_name, pa.club AS player_a_club, pb.name AS player_b_name, pb.club AS player_b_club,
    c.court_name, c.court_number, cl.class_name, ${resultColumns}
    FROM matches m
    JOIN participants pa ON pa.participant_id = m.player_a_id
    JOIN participants pb ON pb.participant_id = m.player_b_id
    LEFT JOIN courts c ON c.court_id = m.court_id
    LEFT JOIN classes cl ON cl.class_id = m.class_id
    LEFT JOIN results res ON res.match_id = m.match_id
    WHERE m.match_id = ? AND (? IS NULL OR m.event_id = ?)`)
    .get(matchId, eventId ?? null, eventId ?? null));
  if (!row) throw new ApiError(404, 'MATCH_NOT_FOUND', '試合が見つかりません。');
  if (row.score_breakdown) {
    try { row.score_breakdown = JSON.parse(String(row.score_breakdown)); } catch { /* keep raw audit data */ }
  }
  return attachResultShape(row);
}

function ensureMatchAccess(req: AuthedRequest, match: Record<string, any>): void {
  if (req.auth?.role !== 'PARTICIPANT') return;
  if (!req.auth.participantId || ![match.player_a_id, match.player_b_id].includes(req.auth.participantId)) {
    throw new ApiError(403, 'FORBIDDEN', '自分の試合のみ閲覧できます。');
  }
}

function releaseCourt(db: DB, courtId: string | null, now = nowIso()): void {
  if (!courtId) return;
  db.prepare(`UPDATE courts SET status = CASE WHEN enabled = 1 THEN 'AVAILABLE' ELSE 'BLOCKED' END,
    updated_at = ?, row_version = row_version + 1 WHERE court_id = ?`).run(now, courtId);
}

function validatePlayers(db: DB, eventId: string, playerAId: string, playerBId: string): void {
  if (playerAId === playerBId) throw new ApiError(400, 'SAME_PARTICIPANT', '同じ選手同士の試合は作成できません。');
  const players = Number((db.prepare(`SELECT COUNT(*) AS count FROM participants
    WHERE event_id = ? AND participant_id IN (?, ?) AND active = 1 AND checked_in = 1`).get(eventId, playerAId, playerBId) as { count: number }).count);
  if (players !== 2) throw new ApiError(400, 'INVALID_PARTICIPANT', '有効かつチェックイン済みの選手を選択してください。');
}

function assertEndTime(event: Record<string, unknown>, requestedStart?: string | null): void {
  const base = requestedStart ? new Date(requestedStart).getTime() : Math.max(Date.now(), new Date(String(event.start_time)).getTime());
  const estimate = base + (Number(event.default_match_minutes) + Number(event.result_input_grace_minutes) + Number(event.safety_margin_minutes)) * 60_000;
  if (estimate > new Date(String(event.end_time)).getTime()) {
    throw new ApiError(409, 'END_TIME_PROTECTED', '終了予定時刻を超える可能性があるため、新しい試合は作成できません。');
  }
}

function assertAssignmentConstraints(db: DB, event: Record<string, unknown>, match: Record<string, any>, courtId: string, force = false): void {
  const court = asRow<Record<string, any>>(db.prepare('SELECT * FROM courts WHERE court_id = ? AND event_id = ?').get(courtId, match.event_id));
  if (!court || !court.enabled || ['BLOCKED', 'MAINTENANCE'].includes(court.status)) {
    throw new ApiError(400, 'COURT_UNAVAILABLE', '利用可能なコートを選択してください。');
  }
  const busyCourt = db.prepare(`SELECT 1 FROM matches WHERE match_id <> ? AND court_id = ?
    AND status IN ('COURT_ASSIGNED','PLAYING','RESULT_PENDING')`).get(match.match_id, courtId);
  if (busyCourt) throw new ApiError(409, 'COURT_BUSY', 'コートはすでに使用中です。');
  const busyPlayer = db.prepare(`SELECT 1 FROM matches WHERE match_id <> ? AND event_id = ?
    AND status IN ('CALLED','COURT_ASSIGNED','PLAYING','RESULT_PENDING')
    AND (player_a_id IN (?, ?) OR player_b_id IN (?, ?))`).get(
      match.match_id, match.event_id, match.player_a_id, match.player_b_id, match.player_a_id, match.player_b_id,
    );
  if (busyPlayer) throw new ApiError(409, 'PARTICIPANT_BUSY', '選手はすでに別の進行中試合に入っています。');
  if (!force) {
    const last = asRows<{ participant_id: string; last_end: string }>(db.prepare(`SELECT participant_id, MAX(end_time) AS last_end FROM (
      SELECT player_a_id AS participant_id, end_time FROM matches WHERE event_id = ? AND status = 'COMPLETED' AND player_a_id IN (?, ?)
      UNION ALL SELECT player_b_id, end_time FROM matches WHERE event_id = ? AND status = 'COMPLETED' AND player_b_id IN (?, ?)
    ) GROUP BY participant_id`).all(match.event_id, match.player_a_id, match.player_b_id, match.event_id, match.player_a_id, match.player_b_id));
    const minimumRestMs = Number(event.minimum_rest_minutes) * 60_000;
    if (last.some((row) => row.last_end && Date.now() - new Date(row.last_end).getTime() < minimumRestMs)) {
      throw new ApiError(409, 'REST_TIME_REQUIRED', '最低休憩時間を満たしていません。');
    }
  }
  assertEndTime(event, nowIso());
}

/** Who is acting: staff confirm by themselves, a player is bound to their own card. */
function describeActor(req: AuthedRequest): ResultActor {
  return {
    userId: req.auth?.userId ?? null,
    participantId: req.auth?.role === 'PARTICIPANT' ? (req.auth.participantId ?? null) : null,
    staff: req.auth?.role !== 'PARTICIPANT',
  };
}

function parseScore(input: { scoreA: number; scoreB: number }, match: Record<string, any>): { winnerId: string } {
  if (input.scoreA === input.scoreB) throw new ApiError(400, 'TIED_SCORE', '同点の結果は登録できません。');
  return { winnerId: input.scoreA > input.scoreB ? match.player_a_id : match.player_b_id };
}

/** One match query for both the list endpoint and the snapshot, so the board
 * never shows different fields than the endpoint it replaced. */
export function readMatches(db: DB, eventId: string, options: {
  status?: string | null; phase?: string | null; participantId?: string | null; limit?: number;
} = {}) {
  const status = options.status ?? null;
  const phase = options.phase ?? null;
  const participantId = options.participantId ?? null;
  const limit = Math.min(500, Math.max(1, options.limit ?? 200));
  const rows = asRows<Record<string, any>>(db.prepare(`SELECT m.*,
    pa.name AS player_a_name, pb.name AS player_b_name, pa.club AS player_a_club, pb.club AS player_b_club,
    c.court_name, c.court_number, cl.class_name, ${resultColumns}
    FROM matches m JOIN participants pa ON pa.participant_id = m.player_a_id
    JOIN participants pb ON pb.participant_id = m.player_b_id
    LEFT JOIN courts c ON c.court_id = m.court_id LEFT JOIN classes cl ON cl.class_id = m.class_id
    LEFT JOIN results res ON res.match_id = m.match_id
    WHERE m.event_id = ? AND (? IS NULL OR m.status = ?) AND (? IS NULL OR m.phase = ?)
    AND (? IS NULL OR ? IN (m.player_a_id, m.player_b_id))
    ORDER BY CASE m.status WHEN 'PLAYING' THEN 1 WHEN 'RESULT_PENDING' THEN 2 WHEN 'COURT_ASSIGNED' THEN 3 WHEN 'CALLED' THEN 4 WHEN 'WAITING' THEN 5 ELSE 6 END,
      COALESCE(m.scheduled_time, m.created_at), m.created_at LIMIT ?`).all(
        eventId, status, status, phase, phase, participantId, participantId, limit,
      ));
  rows.forEach((row) => {
    if (row.score_breakdown) {
      try { row.score_breakdown = JSON.parse(row.score_breakdown); } catch { /* no-op */ }
    }
    attachResultShape(row);
  });
  return rows;
}

export function createMatchRouter(db: DB, afterCompletion?: (eventId: string) => void): Router {
  const router = Router();

  router.post('/events/:eventId/league/preview', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    requireEvent(db, param(req, 'eventId'));
    const { classIds } = z.object({ classIds: z.array(z.string()).optional() }).parse(req.body ?? {});
    sendData(res, buildLeaguePreview(db, param(req, 'eventId'), classIds));
  });

  router.post('/events/:eventId/league/generate', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    const event = requireEvent(db, eventId);
    if (event.status === 'COMPLETED' || event.status === 'CANCELLED') throw new ApiError(409, 'EVENT_CLOSED', '終了したイベントには試合を追加できません。');
    const { classIds } = z.object({ classIds: z.array(z.string()).optional() }).parse(req.body ?? {});
    const preview = buildLeaguePreview(db, eventId, classIds);
    const creatable = preview.pairs.filter((pair) => !pair.existing && pair.fitsBeforeEnd);
    const createdIds = transaction(db, () => {
      const insert = db.prepare(`INSERT INTO matches (
        match_id, event_id, phase, class_id, player_a_id, player_b_id, scheduled_time, status, source,
        priority_score, pair_key, created_by, created_at, updated_at
      ) VALUES (?, ?, 'LEAGUE', ?, ?, ?, ?, 'WAITING', 'AUTO', 0, ?, ?, ?, ?)`);
      return creatable.map((pair) => {
        const id = makeId('match');
        const now = nowIso();
        insert.run(id, eventId, pair.classId, pair.playerAId, pair.playerBId, pair.scheduledTime,
          pairKey(pair.playerAId, pair.playerBId), req.auth?.userId ?? null, now, now);
        return id;
      });
    });
    audit(db, req, eventId, 'LEAGUE', eventId, 'GENERATE', undefined, { createdCount: createdIds.length, matchIds: createdIds });
    sendData(res, { createdCount: createdIds.length, skippedDuplicate: preview.summary.duplicateCount, skippedEndTime: preview.summary.excludedByEndTime, matchIds: createdIds }, 201);
  });

  router.get('/events/:eventId/matches', (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    requireEvent(db, eventId);
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const phase = typeof req.query.phase === 'string' ? req.query.phase : null;
    const participantId = req.auth?.role === 'PARTICIPANT' ? req.auth.participantId : typeof req.query.participantId === 'string' ? req.query.participantId : null;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 200)));
    const rows = readMatches(db, eventId, { status, phase, participantId, limit });
    sendData(res, rows);
  });

  router.get('/events/:eventId/matches/:matchId', (req: AuthedRequest, res: Response) => {
    ensureEventAccess(db, req, param(req, 'eventId'));
    const match = getMatch(db, param(req, 'matchId'), param(req, 'eventId'));
    ensureMatchAccess(req, match);
    const result = db.prepare('SELECT * FROM results WHERE match_id = ?').get(match.match_id);
    sendData(res, { ...match, result: result ? attachResultShape({ ...result }) : null });
  });

  router.post('/events/:eventId/matches', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    const event = requireEvent(db, eventId);
    if (['COMPLETED', 'CANCELLED'].includes(String(event.status))) throw new ApiError(409, 'EVENT_CLOSED', '終了したイベントには試合を追加できません。');
    const input = z.object({
      phase: z.enum(['LEAGUE', 'REQUEST', 'TOURNAMENT']).default(String(event.current_phase) as 'LEAGUE'),
      classId: z.string().nullable().default(null), playerAId: z.string(), playerBId: z.string(),
      scheduledTime: z.string().datetime().nullable().default(null), courtId: z.string().nullable().default(null),
      priorityScore: z.number().default(0), force: z.boolean().default(false),
    }).parse(req.body);
    validatePlayers(db, eventId, input.playerAId, input.playerBId);
    assertEndTime(event, input.scheduledTime);
    const id = makeId('match');
    const now = nowIso();
    const initialStatus = input.courtId ? 'COURT_ASSIGNED' : 'WAITING';
    const shell = { match_id: id, event_id: eventId, player_a_id: input.playerAId, player_b_id: input.playerBId };
    if (input.courtId) assertAssignmentConstraints(db, event, shell, input.courtId, input.force && req.auth?.role === 'OWNER');
    transaction(db, () => {
      db.prepare(`INSERT INTO matches (
        match_id, event_id, phase, class_id, player_a_id, player_b_id, scheduled_time, court_id, status, source,
        priority_score, pair_key, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', ?, ?, ?, ?, ?)`)
        .run(id, eventId, input.phase, input.classId, input.playerAId, input.playerBId, input.scheduledTime,
          input.courtId, initialStatus, input.priorityScore, pairKey(input.playerAId, input.playerBId),
          req.auth?.userId ?? null, now, now);
      if (input.courtId) db.prepare("UPDATE courts SET status = 'CALLING', updated_at = ?, row_version = row_version + 1 WHERE court_id = ?")
        .run(now, input.courtId);
    });
    const match = getMatch(db, id);
    audit(db, req, eventId, 'MATCH', id, 'CREATE_MANUAL', undefined, match);
    sendData(res, match, 201);
  });

  router.patch('/events/:eventId/matches/:matchId', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    const before = getMatch(db, param(req, 'matchId'), eventId);
    if (terminalStatuses.includes(before.status)) throw new ApiError(409, 'MATCH_TERMINAL', '終了済みの試合は変更できません。結果修正を利用してください。');
    const input = z.object({
      playerAId: z.string().optional(), playerBId: z.string().optional(), courtId: z.string().nullable().optional(),
      scheduledTime: z.string().datetime().nullable().optional(), priorityScore: z.number().optional(),
      rowVersion: z.number().int().positive(), force: z.boolean().default(false),
    }).parse(req.body);
    const playerAId = input.playerAId ?? before.player_a_id;
    const playerBId = input.playerBId ?? before.player_b_id;
    if ((input.playerAId || input.playerBId) && !['WAITING', 'CALLED'].includes(before.status)) {
      throw new ApiError(409, 'INVALID_STATE_TRANSITION', '選手変更は待機中または招集中の試合のみ可能です。');
    }
    validatePlayers(db, eventId, playerAId, playerBId);
    const event = requireEvent(db, eventId);
    const courtId = input.courtId === undefined ? before.court_id : input.courtId;
    if (courtId && activeStatuses.includes(before.status)) {
      assertAssignmentConstraints(db, event, { ...before, player_a_id: playerAId, player_b_id: playerBId }, courtId, input.force && req.auth?.role === 'OWNER');
    }
    const map: Record<string, string> = { playerAId: 'player_a_id', playerBId: 'player_b_id', courtId: 'court_id', scheduledTime: 'scheduled_time', priorityScore: 'priority_score' };
    const entries = Object.entries(input).filter(([key]) => !['rowVersion', 'force'].includes(key));
    if (input.playerAId || input.playerBId) entries.push(['pairKey', pairKey(playerAId, playerBId)]);
    map.pairKey = 'pair_key';
    transaction(db, () => {
      const result = db.prepare(`UPDATE matches SET ${entries.map(([key]) => `${map[key]} = ?`).join(', ') || 'updated_at = updated_at'},
        source = 'MANUAL', updated_at = ?, row_version = row_version + 1 WHERE match_id = ? AND row_version = ?`)
        .run(...entries.map(([, value]) => value as any), nowIso(), before.match_id, input.rowVersion);
      if (Number(result.changes) === 0) throw new ApiError(409, 'VERSION_CONFLICT', '他の端末で試合が更新されました。');
      if (input.courtId !== undefined && input.courtId !== before.court_id) {
        releaseCourt(db, before.court_id);
        if (input.courtId) db.prepare("UPDATE courts SET status = 'CALLING', updated_at = ?, row_version = row_version + 1 WHERE court_id = ?")
          .run(nowIso(), input.courtId);
      }
    });
    const after = getMatch(db, before.match_id);
    audit(db, req, eventId, 'MATCH', before.match_id, 'OVERRIDE', before, after);
    sendData(res, after);
  });

  router.post('/events/:eventId/matches/:matchId/action', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    const match = getMatch(db, param(req, 'matchId'), eventId);
    const input = z.object({
      action: z.enum(['CALL', 'ASSIGN', 'START', 'FINISH', 'CANCEL', 'NO_SHOW']),
      courtId: z.string().optional(), rowVersion: z.number().int().positive(), force: z.boolean().default(false),
    }).parse(req.body);
    const transitions: Record<string, { from: string[]; to: string }> = {
      CALL: { from: ['WAITING'], to: 'CALLED' }, ASSIGN: { from: ['WAITING', 'CALLED'], to: 'COURT_ASSIGNED' },
      START: { from: ['COURT_ASSIGNED'], to: 'PLAYING' }, FINISH: { from: ['PLAYING'], to: 'RESULT_PENDING' },
      CANCEL: { from: ['WAITING', 'CALLED', 'COURT_ASSIGNED', 'PLAYING', 'RESULT_PENDING', 'DISPUTED'], to: 'CANCELLED' },
      NO_SHOW: { from: ['WAITING', 'CALLED', 'COURT_ASSIGNED'], to: 'NO_SHOW' },
    };
    const transition = transitions[input.action];
    if (!transition.from.includes(match.status)) {
      throw new ApiError(409, 'INVALID_STATE_TRANSITION', `${match.status} の試合に ${input.action} は実行できません。`);
    }
    const event = requireEvent(db, eventId);
    if (['CANCEL', 'NO_SHOW'].includes(input.action)) assertBracketTerminable(match, input.action);
    const courtId = input.courtId ?? match.court_id;
    if (['ASSIGN', 'START'].includes(input.action)) {
      if (!courtId) throw new ApiError(400, 'COURT_REQUIRED', 'コートを選択してください。');
      assertAssignmentConstraints(db, event, match, courtId, input.force && req.auth?.role === 'OWNER');
    }
    const now = nowIso();
    transaction(db, () => {
      const fields: string[] = ['status = ?', 'updated_at = ?', 'row_version = row_version + 1'];
      const values: any[] = [transition.to, now];
      if (input.action === 'CALL') { fields.push('called_time = ?'); values.push(now); }
      if (input.action === 'ASSIGN') { fields.push('court_id = ?', 'called_time = COALESCE(called_time, ?)'); values.push(courtId, now); }
      if (input.action === 'START') { fields.push('court_id = ?', 'start_time = ?', 'called_time = COALESCE(called_time, ?)'); values.push(courtId, now, now); }
      if (input.action === 'FINISH') { fields.push('end_time = ?'); values.push(now); }
      if (['CANCEL', 'NO_SHOW'].includes(input.action)) fields.push("source = 'MANUAL'");
      values.push(match.match_id, input.rowVersion);
      const result = db.prepare(`UPDATE matches SET ${fields.join(', ')} WHERE match_id = ? AND row_version = ?`).run(...values);
      if (Number(result.changes) === 0) throw new ApiError(409, 'VERSION_CONFLICT', '他の端末で試合が更新されました。');
      if (courtId) {
        if (input.action === 'ASSIGN') db.prepare("UPDATE courts SET status = 'CALLING', updated_at = ?, row_version = row_version + 1 WHERE court_id = ?").run(now, courtId);
        if (input.action === 'START') db.prepare("UPDATE courts SET status = 'PLAYING', updated_at = ?, row_version = row_version + 1 WHERE court_id = ?").run(now, courtId);
        if (input.action === 'FINISH') db.prepare("UPDATE courts SET status = 'RESULT_PENDING', updated_at = ?, row_version = row_version + 1 WHERE court_id = ?").run(now, courtId);
      }
      if (['CANCEL', 'NO_SHOW'].includes(input.action)) releaseCourt(db, match.court_id, now);
    });
    const after = getMatch(db, match.match_id);
    audit(db, req, eventId, 'MATCH', match.match_id, input.action, match, after);
    sendData(res, after);
  });

  router.post('/events/:eventId/matches/:matchId/result', (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    const match = getMatch(db, param(req, 'matchId'), eventId);
    ensureMatchAccess(req, match);
    const input = z.object({
      scoreA: z.number().int().min(0).max(99), scoreB: z.number().int().min(0).max(99),
      rowVersion: z.number().int().positive(), note: z.string().trim().max(200).nullish(),
    }).parse(req.body);
    const actor = describeActor(req);
    const outcome = submitResult(db, eventId, match.match_id, input, actor);
    const after = getMatch(db, match.match_id);
    audit(db, req, eventId, 'RESULT', outcome.resultId, outcome.state === 'ENTERED' ? 'SUBMIT' : outcome.state === 'DISPUTED' ? 'DISPUTE' : 'ENTER', {
      scoreA: input.scoreA, scoreB: input.scoreB,
    }, {
      state: outcome.state, winnerId: outcome.winnerId, autoConfirmed: outcome.autoConfirmed, waitingFor: outcome.waitingFor,
      bracket: outcome.bracketAdvance ? {
        created: outcome.bracketAdvance.created, completed: outcome.bracketAdvance.bracketCompleted, phaseChanged: outcome.bracketAdvance.phaseChanged,
      } : undefined,
    });
    sendData(res, {
      ...after, resultStatus: outcome.state, confirmed: outcome.state === 'CONFIRMED',
      bracketAdvance: outcome.bracketAdvance,
    }, 201);
    // Only a confirmed result frees a court and moves the draw, so the engine is
    // woken up on that path (and on the auto-confirm of a timeout, which the
    // caller cannot know about from the response alone).
    if (outcome.state === 'CONFIRMED' && afterCompletion) queueMicrotask(() => afterCompletion(eventId));
  });

  router.patch('/events/:eventId/matches/:matchId/result', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    const match = getMatch(db, param(req, 'matchId'), eventId);
    const result = asRow<Record<string, any>>(db.prepare('SELECT * FROM results WHERE match_id = ?').get(match.match_id));
    if (!result) throw new ApiError(404, 'RESULT_NOT_FOUND', '結果が見つかりません。');
    const input = z.object({ scoreA: z.number().int().min(0).max(99), scoreB: z.number().int().min(0).max(99), rowVersion: z.number().int().positive() }).parse(req.body);
    // A result the players have not settled yet is decided by staff: rewriting it
    // confirms it, which is the resolution path for a disputed pair of claims.
    if (match.status !== 'COMPLETED') {
      const outcome = submitResult(db, eventId, match.match_id, input, describeActor(req));
      audit(db, req, eventId, 'RESULT', outcome.resultId, 'CORRECT', result, {
        scoreA: input.scoreA, scoreB: input.scoreB, winnerId: outcome.winnerId, resolved: true,
      });
      sendData(res, { ...getMatch(db, match.match_id), resultStatus: outcome.state, bracketAdvance: outcome.bracketAdvance });
      if (afterCompletion) queueMicrotask(() => afterCompletion(eventId));
      return;
    }
    const { winnerId } = parseScore(input, match);
    const now = nowIso();
    transaction(db, () => {
      const changed = db.prepare(`UPDATE results SET score_a = ?, score_b = ?, winner_id = ?, status = 'CORRECTED', updated_at = ?, row_version = row_version + 1
        WHERE result_id = ? AND row_version = ?`).run(input.scoreA, input.scoreB, winnerId, now, result.result_id, input.rowVersion);
      if (Number(changed.changes) === 0) throw new ApiError(409, 'VERSION_CONFLICT', '他の端末で結果が更新されました。');
      db.prepare(`UPDATE matches SET score_a = ?, score_b = ?, winner_id = ?, source = 'MANUAL', updated_at = ?, row_version = row_version + 1 WHERE match_id = ?`)
        .run(input.scoreA, input.scoreB, winnerId, now, match.match_id);
      if (result.winner_id !== winnerId) {
        retargetBracket(db, eventId, match.match_id, String(result.winner_id ?? ''), req.auth?.userId ?? null);
      }
    });
    audit(db, req, eventId, 'RESULT', result.result_id, 'CORRECT', result, { scoreA: input.scoreA, scoreB: input.scoreB, winnerId });
    sendData(res, db.prepare('SELECT * FROM results WHERE result_id = ?').get(result.result_id));
  });

  router.post('/events/:eventId/matches/:matchId/result/confirm', (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    const match = getMatch(db, param(req, 'matchId'), eventId);
    ensureMatchAccess(req, match);
    const input = z.object({ rowVersion: z.number().int().positive().optional() }).parse(req.body ?? {});
    const confirmed = confirmEnteredResult(db, eventId, match.match_id, describeActor(req));
    const after = getMatch(db, match.match_id);
    audit(db, req, eventId, 'RESULT', confirmed.resultId, 'CONFIRM', { rowVersion: input.rowVersion ?? null }, {
      matchId: match.match_id, winnerId: after.winner_id,
      bracket: confirmed.bracketAdvance ? { created: confirmed.bracketAdvance.created, completed: confirmed.bracketAdvance.bracketCompleted } : undefined,
    });
    sendData(res, { ...after, resultStatus: 'CONFIRMED', bracketAdvance: confirmed.bracketAdvance });
    if (afterCompletion) queueMicrotask(() => afterCompletion(eventId));
  });

  router.post('/events/:eventId/matches/:matchId/result/reject', (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    const match = getMatch(db, param(req, 'matchId'), eventId);
    ensureMatchAccess(req, match);
    const input = z.object({ note: z.string().trim().min(1).max(200).nullish() }).parse(req.body ?? {});
    const rejected = disputeResult(db, eventId, match.match_id, describeActor(req), input.note ?? null);
    audit(db, req, eventId, 'RESULT', rejected.resultId, 'REJECT', undefined, { claim: rejected.claim });
    sendData(res, { ...getMatch(db, match.match_id), resultStatus: 'DISPUTED', claim: rejected.claim });
  });

  router.post('/events/:eventId/results/sweep', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    const swept = confirmStaleResults(db, eventId);
    if (swept.confirmed + swept.disputed > 0) {
      audit(db, req, eventId, 'RESULT', eventId, 'AUTO_CONFIRM', undefined, swept);
      if (afterCompletion) queueMicrotask(() => afterCompletion(eventId));
    }
    sendData(res, swept);
  });

  router.get('/events/:eventId/rankings', (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    const classId = typeof req.query.classId === 'string' ? req.query.classId : undefined;
    sendData(res, calculateRankings(db, eventId, classId));
  });

  return router;
}

export { getMatch, assertEndTime, assertAssignmentConstraints, releaseCourt, validatePlayers };
