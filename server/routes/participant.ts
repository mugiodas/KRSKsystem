import { Router, type Response } from 'express';
import type { DB } from '../db.js';
import { asRow, asRows } from '../db.js';
import type { AuthedRequest } from '../auth.js';
import { ApiError, sendData } from '../http.js';
import { ensureEventAccess, requireEvent } from './core.js';
import { loadEngineContext } from '../services/matching.js';
import { calculateRankings } from '../services/ranking.js';
import { roundLabel } from '../services/tournament.js';

function param(req: AuthedRequest, key: string): string {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

const LIVE = ['WAITING', 'CALLED', 'COURT_ASSIGNED', 'PLAYING', 'RESULT_PENDING'];

/**
 * One aggregate call for the participant phone. The smartphone screen needs a
 * dozen facts about a single player; asking a phone on a gym Wi-Fi to issue a
 * dozen requests would be slow and fragile, so the server composes them.
 *
 * Privacy: a PARTICIPANT may only ever read their own row, and the payload
 * deliberately contains no contact details of other participants.
 */
export function createParticipantRouter(db: DB): Router {
  const router = Router();

  router.get('/events/:eventId/me', (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    const event = requireEvent(db, eventId);
    const viewerId = req.auth?.role === 'PARTICIPANT'
      ? req.auth.participantId
      : (typeof req.query.participantId === 'string' ? req.query.participantId : null);
    if (!viewerId) throw new ApiError(400, 'PARTICIPANT_REQUIRED', '参加者アカウントでアクセスしてください。');

    const me = asRow<Record<string, any>>(db.prepare(`SELECT p.*, c.class_name FROM participants p
      LEFT JOIN classes c ON c.class_id = p.class_id WHERE p.participant_id = ? AND p.event_id = ?`).get(viewerId, eventId));
    if (!me) throw new ApiError(404, 'PARTICIPANT_NOT_FOUND', '参加者が見つかりません。');

    const matchRows = asRows<Record<string, any>>(db.prepare(`SELECT m.*, co.court_name, co.court_number,
        pa.name AS player_a_name, pb.name AS player_b_name, cl.class_name
      FROM matches m
      JOIN participants pa ON pa.participant_id = m.player_a_id
      JOIN participants pb ON pb.participant_id = m.player_b_id
      LEFT JOIN courts co ON co.court_id = m.court_id
      LEFT JOIN classes cl ON cl.class_id = m.class_id
      WHERE m.event_id = ? AND ? IN (m.player_a_id, m.player_b_id)
      ORDER BY COALESCE(m.scheduled_time, m.created_at) DESC`).all(eventId, viewerId));

    const completed = matchRows.filter((row) => row.status === 'COMPLETED');
    const wins = completed.filter((row) => row.winner_id === viewerId);
    const next = matchRows.find((row) => row.status === 'CALLED' || row.status === 'COURT_ASSIGNED')
      ?? matchRows.find((row) => row.status === 'PLAYING' || row.status === 'RESULT_PENDING')
      ?? null;
    const queuePosition = matchRows.find((row) => row.status === 'WAITING') ?? null;
    const myRequests = asRows<Record<string, any>>(db.prepare(`SELECT r.*, pt.name AS target_name, pt2.name AS requester_name,
        m.status AS matched_match_status, co.court_name AS matched_court_name, m.scheduled_time AS matched_scheduled_time
      FROM match_requests r
      JOIN participants pt ON pt.participant_id = r.target_player_id
      JOIN participants pt2 ON pt2.participant_id = r.requester_id
      LEFT JOIN matches m ON m.match_id = r.matched_match_id
      LEFT JOIN courts co ON co.court_id = m.court_id
      WHERE r.event_id = ? AND (r.requester_id = ? OR r.target_player_id = ?)
      ORDER BY CASE r.status WHEN 'ACTIVE' THEN 1 WHEN 'MATCHED' THEN 2 ELSE 3 END, r.created_at DESC
      LIMIT 40`).all(eventId, viewerId, viewerId));

    const announcements = asRows<Record<string, any>>(db.prepare(`SELECT a.title, a.body, a.severity, a.created_at, u.display_name AS actor_name
      FROM announcements a LEFT JOIN users u ON u.user_id = a.created_by
      WHERE a.event_id = ? AND a.active = 1
      ORDER BY CASE a.severity WHEN 'URGENT' THEN 1 WHEN 'IMPORTANT' THEN 2 ELSE 3 END, a.created_at DESC LIMIT 10`).all(eventId));

    // Waiting position and estimate come from the live engine context so the
    // phone and the operator board can never disagree.
    const ctx = loadEngineContext(db, eventId);
    const state = ctx.players.get(viewerId);
    const inMatch = state ? ctx.busyPlayerIds.has(viewerId) : false;
    const restReady = state ? ctx.nowMs >= state.restReadyAt : true;
    const waitingOrder = [...ctx.players.values()]
      .filter((player) => !ctx.busyPlayerIds.has(player.participantId))
      .filter((player) => ctx.nowMs >= player.restReadyAt)
      .sort((left, right) => right.waitingMinutes - left.waitingMinutes || left.played - right.played);
    const index = waitingOrder.findIndex((player) => player.participantId === viewerId);
    const courts = ctx.freeCourts.length + ctx.courts.filter((court) => court.busy).length;
    const slotMinutes = ctx.matchSlotMinutes;
    let waitEstimateMinutes: number | null = null;
    if (next && (next.status === 'CALLED' || next.status === 'COURT_ASSIGNED')) waitEstimateMinutes = 0;
    else if (inMatch) waitEstimateMinutes = 0;
    else if (index >= 0) {
      const rounds = Math.floor(index / Math.max(1, courts * 2)) + 1;
      waitEstimateMinutes = Math.round(rounds * slotMinutes);
    } else if (state && !restReady) {
      waitEstimateMinutes = Math.max(1, Math.round((state.restReadyAt - ctx.nowMs) / 60_000));
    }

    // A tournament card is described by its round, not by a waiting position.
    const bracketOf = (row: Record<string, any> | null) => {
      if (!row || !row.bracket_id) return null;
      const bracket = asRow<Record<string, any>>(db.prepare('SELECT rounds, status FROM tournament_brackets WHERE bracket_id = ?')
        .get(String(row.bracket_id)));
      if (!bracket) return null;
      const round = Number(row.bracket_round ?? 0);
      const rounds = Number(bracket.rounds);
      return { round, rounds, roundLabel: roundLabel(rounds, round), bracketStatus: String(bracket.status) };
    };
    const bracketInfo = bracketOf(next) ?? bracketOf(queuePosition);

    const rankings = calculateRankings(db, eventId, me.class_id ? String(me.class_id) : undefined);
    const myRank = rankings.find((row) => row.participantId === viewerId) ?? null;

    sendData(res, {
      participant: {
        participantId: String(me.participant_id), name: String(me.name), className: me.class_name ?? null,
        club: me.club, rating: Number(me.rating), active: Number(me.active) === 1, checkedIn: Number(me.checked_in) === 1,
      },
      event: {
        eventName: String(event.event_name), status: String(event.status), phase: String(event.current_phase),
        startTime: String(event.start_time), endTime: String(event.end_time),
        allowRequest: Number(event.allow_request) === 1, defaultMatchMinutes: Number(event.default_match_minutes),
      },
      today: {
        played: completed.length, wins: wins.length, losses: completed.length - wins.length,
        pointsFor: completed.reduce((sum, row) => sum + Number(row.score_a ?? 0) + Number(row.score_b ?? 0), 0),
        courtsUsed: new Set(completed.map((row) => row.court_id).filter(Boolean)).size,
      },
      rank: myRank ? { rank: myRank.rank, of: rankings.length, winRate: myRank.winRate, pointDifference: myRank.pointDifference } : null,
      nextMatch: next ? {
        matchId: String(next.match_id), status: String(next.status), courtName: next.court_name ?? null,
        courtNumber: next.court_number ?? null, opponentName: next.player_a_id === viewerId ? next.player_b_name : next.player_a_name,
        opponentClub: next.player_a_id === viewerId
          ? (asRow<Record<string, any>>(db.prepare('SELECT club FROM participants WHERE participant_id = ?').get(next.player_b_id))?.club ?? '')
          : (asRow<Record<string, any>>(db.prepare('SELECT club FROM participants WHERE participant_id = ?').get(next.player_a_id))?.club ?? ''),
        scheduledTime: next.scheduled_time ?? null, startTime: next.start_time ?? null,
        phase: String(next.phase), scoreA: next.score_a, scoreB: next.score_b,
        isMineSideA: next.player_a_id === viewerId, bracket: bracketInfo,
      } : queuePosition ? {
        matchId: String(queuePosition.match_id), status: 'WAITING', courtName: null, courtNumber: null,
        opponentName: queuePosition.player_a_id === viewerId ? queuePosition.player_b_name : queuePosition.player_a_name,
        opponentClub: '', scheduledTime: queuePosition.scheduled_time ?? null, startTime: null,
        phase: String(queuePosition.phase), scoreA: null, scoreB: null, isMineSideA: queuePosition.player_a_id === viewerId,
        bracket: bracketInfo,
      } : null,
      waiting: {
        minutes: state ? Number(state.waitingMinutes.toFixed(1)) : 0,
        estimateMinutes: waitEstimateMinutes,
        position: index >= 0 ? index + 1 : null,
        waitingCount: waitingOrder.length,
        restBlocked: Boolean(state && !restReady),
        restReadyInMinutes: state ? Number(Math.max(0, (state.restReadyAt - ctx.nowMs) / 60_000).toFixed(1)) : 0,
        slotMinutes,
        freeCourts: ctx.freeCourts.length,
      },
      history: completed.slice(0, 20).map((row) => ({
        matchId: String(row.match_id), opponentName: row.player_a_id === viewerId ? row.player_b_name : row.player_a_name,
        won: row.winner_id === viewerId, scoreMine: Number((row.player_a_id === viewerId ? row.score_a : row.score_b) ?? 0),
        scoreOpponent: Number((row.player_a_id === viewerId ? row.score_b : row.score_a) ?? 0),
        courtName: row.court_name ?? null, endTime: row.end_time ?? null, phase: String(row.phase),
      })),
      otherMatches: matchRows.filter((row) => LIVE.includes(String(row.status)) && row !== next && row !== queuePosition).map((row) => ({
        matchId: String(row.match_id), status: String(row.status), courtName: row.court_name ?? null,
        scheduledTime: row.scheduled_time ?? null, opponentName: row.player_a_id === viewerId ? row.player_b_name : row.player_a_name,
      })),
      requests: myRequests.map((row) => ({
        requestId: String(row.request_id), targetName: String(row.target_name), requesterName: String(row.requester_name),
        mine: row.requester_id === viewerId, priority: Number(row.priority), status: String(row.status),
        createdAt: String(row.created_at), rowVersion: Number(row.row_version),
        matchedStatus: row.matched_match_status ?? null, matchedCourtName: row.matched_court_name ?? null,
        matchedScheduledTime: row.matched_scheduled_time ?? null,
      })),
      announcements: announcements.map((row) => ({ title: String(row.title), body: String(row.body),
        severity: String(row.severity), createdAt: String(row.created_at), actorName: row.actor_name ?? null })),
    });
  });

  return router;
}
