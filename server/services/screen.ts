import type { DB } from '../db.js';
import { asRows } from '../db.js';
import { ApiError } from '../http.js';
import { calculateRankings } from './ranking.js';
import { buildLeagueProgress } from './league.js';
import { roundLabel } from './tournament.js';

/**
 * The projector board (会場スクリーン). One read-only projection of the event,
 * designed for a TV across the hall: big type, no controls, no login.
 *
 * Privacy is the reason this is its own payload instead of the operator snapshot:
 * it carries names on cards and standings, and nothing else - no participant ids,
 * emails, clubs, ratings, notes, settings, or integrity findings. A screen can be
 * photographed by anyone in the hall, so the board only ever shows what the hall is
 * already being told out loud.
 */

export interface ScreenMatch {
  status: string;
  phase: string;
  roundName: string | null;
  playerAName: string;
  playerBName: string;
  scoreA: number | null;
  scoreB: number | null;
  scheduledTime: string | null;
  startTime: string | null;
  endTime: string | null;
  /** Set while the players have not settled their report (see results.status). */
  resultStatus: 'ENTERED' | 'CONFIRMED' | 'DISPUTED' | 'CORRECTED' | null;
}

export interface ScreenCourt {
  courtNumber: number;
  courtName: string;
  /** The court's own state (AVAILABLE / CALLING / PLAYING / RESULT_PENDING / BLOCKED). */
  status: string;
  available: boolean;
  match: ScreenMatch | null;
  /** Minutes left in the slot the board counts down; null when nothing is timed. */
  endsInMinutes: number | null;
  /** How far past the slot estimate the court is (0 while it still fits). */
  overMinutes: number;
}

export interface ScreenEntry {
  title: string;
  body: string;
  severity: string;
  at: string;
}

export interface ScreenBoard {
  eventId: string;
  eventName: string;
  eventDate: string;
  venue: string;
  status: string;
  phase: string;
  startTime: string;
  endTime: string;
  /** Server clock, so a TV that never slept still shows the right countdown. */
  serverTime: string;
  nowMs: number;
  elapsedMinutes: number;
  remainingMinutes: number;
  progress: { completedMatches: number; openMatches: number; courtsBusy: number; courtsTotal: number };
  league: { status: string; completedMatches: number; plannedMatches: number; completionRate: number } | null;
  courts: ScreenCourt[];
  /** What the callers are about to read out: queued cards, in engine order. */
  upNext: Array<{ players: string; courtName: string | null; etaMinutes: number | null }>;
  results: Array<{ winner: string; loser: string; score: string; at: string | null }>;
  standings: Array<{ className: string; rows: Array<{ rank: number; name: string; played: number; wins: number; pointDifference: number }> }>;
  brackets: Array<{ className: string; size: number; status: string; roundName: string | null; decided: number; total: number; champion: string | null }>;
  announcements: ScreenEntry[];
}

// "Open" on the board includes the queue: a hall wants to see that cards are still
// to come, not only the ones standing on a court.
const OPEN = ['WAITING', 'CALLED', 'COURT_ASSIGNED', 'PLAYING', 'RESULT_PENDING'];

export function buildScreenBoard(db: DB, eventId: string, nowMs = Date.now()): ScreenBoard {
  const event = asRows<Record<string, any>>(db.prepare('SELECT * FROM events WHERE event_id = ?').all(eventId))[0];
  if (!event) throw new ApiError(404, 'EVENT_NOT_FOUND', 'イベントが見つかりません。');
  const startMs = Date.parse(String(event.start_time));
  const endMs = Date.parse(String(event.end_time));
  const defaultMinutes = Number(event.default_match_minutes) ?? 15;
  const grace = Number(event.result_input_grace_minutes ?? 3) + Number(event.safety_margin_minutes ?? 5);

  const courtRows = asRows<Record<string, any>>(db.prepare(`
    SELECT c.court_number, c.court_name, c.status AS court_status, c.priority, c.enabled,
      m.match_id, m.status AS match_status, m.phase, m.score_a, m.score_b, m.scheduled_time,
      m.start_time, m.end_time, m.bracket_round, m.bracket_id, tb.rounds AS bracket_rounds,
      pa.name AS name_a, pb.name AS name_b, r.status AS result_status
    FROM courts c
    LEFT JOIN matches m ON m.match_id = (
      SELECT candidate.match_id FROM matches candidate WHERE candidate.court_id = c.court_id
        AND candidate.status IN ('CALLED','COURT_ASSIGNED','PLAYING','RESULT_PENDING')
      ORDER BY candidate.updated_at DESC LIMIT 1)
    LEFT JOIN tournament_brackets tb ON tb.bracket_id = m.bracket_id
    LEFT JOIN participants pa ON pa.participant_id = m.player_a_id
    LEFT JOIN participants pb ON pb.participant_id = m.player_b_id
    LEFT JOIN results r ON r.match_id = m.match_id
    WHERE c.event_id = ? AND c.enabled = 1
    ORDER BY c.priority, c.court_number`).all(eventId));

  const courts: ScreenCourt[] = courtRows.map((row) => {
    const match = row.match_id ? {
      status: String(row.match_status),
      phase: String(row.phase),
      roundName: row.bracket_round && row.bracket_rounds
        ? roundLabel(Number(row.bracket_rounds), Number(row.bracket_round))
        : String(row.phase) === 'LEAGUE' ? 'リーグ' : null,
      playerAName: String(row.name_a ?? '—'),
      playerBName: String(row.name_b ?? '—'),
      scoreA: row.score_a === null || row.score_a === undefined ? null : Number(row.score_a),
      scoreB: row.score_b === null || row.score_b === undefined ? null : Number(row.score_b),
      scheduledTime: row.scheduled_time ? String(row.scheduled_time) : null,
      startTime: row.start_time ? String(row.start_time) : null,
      endTime: row.end_time ? String(row.end_time) : null,
      resultStatus: row.result_status ? String(row.result_status) as ScreenMatch['resultStatus'] : null,
    } satisfies ScreenMatch : null;
    // Only a card that is actually on the court gets a countdown: RESULT_PENDING keeps
    // running so the hall can see the score is still being settled. Once the slot has
    // passed the board stops counting down and says 延長 instead of a negative number.
    const anchor = match && (match.status === 'PLAYING' || match.status === 'RESULT_PENDING')
      ? Date.parse(match.startTime ?? match.scheduledTime ?? '') : Number.NaN;
    const endsAt = Number.isFinite(anchor) ? anchor + (defaultMinutes + grace) * 60_000 : null;
    const minutesLeft = endsAt === null ? null : Math.round((endsAt - nowMs) / 60_000);
    const endsInMinutes = minutesLeft === null || minutesLeft < 0 ? null : minutesLeft;
    const overMinutes = endsAt === null || nowMs <= endsAt ? 0 : Math.round((nowMs - endsAt) / 60_000);
    return {
      courtNumber: Number(row.court_number),
      courtName: String(row.court_name),
      status: String(row.court_status),
      available: ['AVAILABLE', 'RESERVED', 'CALLING', 'PLAYING', 'RESULT_PENDING'].includes(String(row.court_status)),
      match,
      endsInMinutes,
      overMinutes,
    };
  });

  const upNextRows = asRows<Record<string, any>>(db.prepare(`
    SELECT m.status, m.scheduled_time, m.priority_score, pa.name AS name_a, pb.name AS name_b, c.court_name
    FROM matches m
    LEFT JOIN participants pa ON pa.participant_id = m.player_a_id
    LEFT JOIN participants pb ON pb.participant_id = m.player_b_id
    LEFT JOIN courts c ON c.court_id = m.court_id
    WHERE m.event_id = ? AND m.status IN ('WAITING','CALLED')
    ORDER BY CASE WHEN m.status = 'CALLED' THEN 0 ELSE 1 END, m.scheduled_time, m.priority_score DESC, m.created_at
    LIMIT 6`).all(eventId));
  const upNext = upNextRows.map((row) => ({
    players: `${String(row.name_a ?? '—')} ・ ${String(row.name_b ?? '—')}`,
    courtName: row.court_name ? String(row.court_name) : null,
    etaMinutes: row.scheduled_time ? Math.max(0, Math.round((Date.parse(String(row.scheduled_time)) - nowMs) / 60_000)) : null,
  }));

  // A result only reaches the board once the players (or staff) settled it, so the
  // screen never shows a score that the next round of pairings was not built on.
  const resultRows = asRows<Record<string, any>>(db.prepare(`
    SELECT m.score_a, m.score_b, m.winner_id, m.end_time, pa.name AS name_a, pb.name AS name_b
    FROM matches m
    LEFT JOIN participants pa ON pa.participant_id = m.player_a_id
    LEFT JOIN participants pb ON pb.participant_id = m.player_b_id
    WHERE m.event_id = ? AND m.status = 'COMPLETED' AND m.score_a IS NOT NULL
    ORDER BY m.end_time DESC, m.updated_at DESC LIMIT 8`).all(eventId));
  const results = resultRows.map((row) => {
    const scoreA = Number(row.score_a);
    const scoreB = Number(row.score_b);
    const aWins = scoreA >= scoreB;
    return {
      winner: String((aWins ? row.name_a : row.name_b) ?? '—'),
      loser: String((aWins ? row.name_b : row.name_a) ?? '—'),
      score: `${scoreA}-${scoreB}`,
      at: row.end_time ? String(row.end_time) : null,
    };
  });

  const classes = asRows<{ class_id: string; class_name: string }>(db.prepare(`SELECT class_id, class_name FROM classes
    WHERE event_id = ? AND enabled = 1 ORDER BY display_order, class_name`).all(eventId));
  const standings = classes.map((clazz) => {
    const rows = calculateRankings(db, eventId, clazz.class_id)
      .filter((row) => row.played > 0)
      .slice(0, 6)
      .map((row) => ({ rank: row.rank, name: row.participantName, played: row.played, wins: row.wins, pointDifference: row.pointDifference }));
    return { className: clazz.class_name, rows };
  }).filter((entry) => entry.rows.length > 0);

  const bracketRows = asRows<Record<string, any>>(db.prepare(`
    SELECT c.class_name, b.size, b.rounds, b.status, b.winner_id,
      (SELECT COUNT(*) FROM matches m WHERE m.bracket_id = b.bracket_id AND m.status NOT IN ('CANCELLED')) AS total,
      (SELECT COUNT(*) FROM matches m WHERE m.bracket_id = b.bracket_id AND m.status = 'COMPLETED') AS decided,
      (SELECT MAX(m.bracket_round) FROM matches m WHERE m.bracket_id = b.bracket_id AND m.status IN ('WAITING','CALLED','COURT_ASSIGNED','PLAYING','RESULT_PENDING')) AS open_round,
      w.name AS winner_name
    FROM tournament_brackets b
    LEFT JOIN classes c ON c.class_id = b.class_id
    LEFT JOIN participants w ON w.participant_id = b.winner_id
    WHERE b.event_id = ? AND b.status <> 'CANCELLED' ORDER BY c.display_order, b.created_at`).all(eventId));
  const brackets = bracketRows.map((row) => ({
    className: String(row.class_name ?? '—'),
    size: Number(row.size),
    status: String(row.status),
    roundName: row.open_round ? roundLabel(Number(row.rounds), Number(row.open_round)) : null,
    decided: Number(row.decided),
    total: Number(row.total),
    champion: row.winner_name ? String(row.winner_name) : null,
  }));

  const announcements = asRows<Record<string, any>>(db.prepare(`SELECT title, body, severity, created_at
    FROM announcements WHERE event_id = ? AND active = 1 ORDER BY
      CASE severity WHEN 'URGENT' THEN 0 WHEN 'IMPORTANT' THEN 1 ELSE 2 END, created_at DESC LIMIT 4`).all(eventId))
    .map((row) => ({
      title: String(row.title), body: String(row.body), severity: String(row.severity), at: String(row.created_at),
    }));

  const openMatches = Number((db.prepare(`SELECT COUNT(*) AS count FROM matches WHERE event_id = ? AND status IN (${OPEN.map(() => '?').join(',')})`)
    .get(eventId, ...OPEN) as { count: number }).count);
  const completedMatches = Number((db.prepare(`SELECT COUNT(*) AS count FROM matches WHERE event_id = ? AND status = 'COMPLETED'`)
    .get(eventId) as { count: number }).count);
  const league = buildLeagueProgress(db, eventId, { nowMs });

  return {
    eventId,
    eventName: String(event.event_name),
    eventDate: String(event.event_date),
    venue: String(event.venue ?? ''),
    status: String(event.status),
    phase: String(event.current_phase),
    startTime: String(event.start_time),
    endTime: String(event.end_time),
    serverTime: new Date(nowMs).toISOString(),
    nowMs,
    elapsedMinutes: Number.isFinite(startMs) ? Math.max(0, Math.round((nowMs - startMs) / 60_000)) : 0,
    remainingMinutes: Number.isFinite(endMs) ? Math.max(0, Math.round((endMs - nowMs) / 60_000)) : 0,
    progress: {
      completedMatches,
      openMatches,
      courtsBusy: courts.filter((court) => court.match !== null).length,
      courtsTotal: courts.length,
    },
    league: league.applicable
      ? { status: league.status, completedMatches: league.completedMatches, plannedMatches: league.plannedMatches, completionRate: league.completionRate }
      : null,
    courts,
    upNext,
    results,
    standings,
    brackets,
    announcements,
  };
}
