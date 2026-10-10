import type { DB } from '../db.js';
import { asRow, asRows, makeId, nowIso, transaction } from '../db.js';
import { ApiError } from '../http.js';
import { advanceBracket } from './tournament.js';

/**
 * Result confirmation (the second half of "the operator should not have to touch
 * every card"). A player reports the score, and the result only becomes part of
 * the standings when the other player - or the staff - confirms it.
 *
 * `results.status` is the single source of truth for that:
 *   ENTERED    one side reported, waiting for the other side or for staff
 *   DISPUTED   the two sides reported different scores, staff has to decide
 *   CONFIRMED  agreed / staff entered it / auto-confirmed after the timeout
 *   CORRECTED  staff rewrote a confirmed result
 *
 * A match keeps `RESULT_PENDING` while its result is not confirmed, so nothing
 * half-agreed can leak into rankings, brackets or reports: those all read
 * `matches.status = 'COMPLETED'`, and the provisional score lives only on the
 * `results` row.
 */

export interface ResultActor {
  userId: string | null;
  participantId: string | null;
  staff: boolean;
}

export interface BracketNotice {
  created: Array<{ matchId: string; round: number; roundLabel: string; playerAName: string; playerBName: string }>;
  bracketCompleted: boolean;
  phaseChanged: boolean;
}

export interface ResultOutcome {
  state: 'ENTERED' | 'CONFIRMED' | 'DISPUTED';
  matchId: string;
  resultId: string;
  scoreA: number;
  scoreB: number;
  winnerId: string;
  confirmedByMe: boolean;
  autoConfirmed: boolean;
  /** Whose tap is still missing, so the phone and the board can say it out loud. */
  waitingFor: 'OPPONENT' | 'STAFF' | null;
  bracketAdvance: BracketNotice | null;
}

interface MatchRow extends Record<string, any> {
  match_id: string;
  event_id: string;
  status: string;
  player_a_id: string;
  player_b_id: string;
  court_id: string | null;
  row_version: number;
  bracket_id: string | null;
  end_time: string | null;
}

interface ResultRow extends Record<string, any> {
  result_id: string;
  match_id: string;
  score_a: number;
  score_b: number;
  winner_id: string;
  status: string;
  entered_by: string | null;
  entered_by_participant: string | null;
  entered_at: string;
  dispute: string | null;
  auto_confirmed: number;
  row_version: number;
}

interface DisputeClaim {
  scoreA?: number;
  scoreB?: number;
  by?: string | null;
  note?: string | null;
  at?: string;
}

function readMatch(db: DB, eventId: string, matchId: string): MatchRow {
  const match = asRow<MatchRow>(db.prepare('SELECT * FROM matches WHERE match_id = ? AND event_id = ?').get(matchId, eventId));
  if (!match) throw new ApiError(404, 'MATCH_NOT_FOUND', '試合が見つかりません。');
  return match;
}

function readResult(db: DB, matchId: string): ResultRow | null {
  return asRow<ResultRow>(db.prepare('SELECT * FROM results WHERE match_id = ?').get(matchId)) ?? null;
}

function readConfirmTimeout(db: DB, eventId: string): { minutes: number; eventEnded: boolean } {
  const event = asRow<{ result_confirm_timeout_minutes: number; end_time: string; status: string }>(
    db.prepare('SELECT result_confirm_timeout_minutes, end_time, status FROM events WHERE event_id = ?').get(eventId));
  const ended = !event || event.status === 'COMPLETED' || event.status === 'CANCELLED'
    || new Date(event.end_time).getTime() <= Date.now();
  return { minutes: event ? Number(event.result_confirm_timeout_minutes ?? 3) : 3, eventEnded: ended };
}

function winnerOf(scoreA: number, scoreB: number, match: MatchRow): string {
  if (scoreA === scoreB) throw new ApiError(400, 'TIED_SCORE', '同点の結果は登録できません。');
  return scoreA > scoreB ? match.player_a_id : match.player_b_id;
}

function parseClaim(value: unknown): DisputeClaim | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as DisputeClaim; } catch { return null; }
  }
  return value as DisputeClaim;
}

function releaseCourt(db: DB, courtId: string | null, now: string): void {
  if (!courtId) return;
  db.prepare(`UPDATE courts SET status = CASE WHEN enabled = 1 THEN 'AVAILABLE' ELSE 'BLOCKED' END,
    updated_at = ?, row_version = row_version + 1 WHERE court_id = ?`).run(now, courtId);
}

/**
 * Turns a confirmed `results` row into a completed match: score, winner, request
 * closing, court release and the tournament advance happen here and nowhere else,
 * so an unconfirmed result can never move the standings or the draw.
 * Must run inside the caller's transaction.
 */
function completeMatch(db: DB, eventId: string, matchId: string, result: ResultRow, now: string): BracketNotice | null {
  const match = readMatch(db, eventId, matchId);
  const updated = db.prepare(`UPDATE matches SET status = 'COMPLETED', score_a = ?, score_b = ?, winner_id = ?, result_id = ?,
      end_time = COALESCE(end_time, ?), updated_at = ?, row_version = row_version + 1
      WHERE match_id = ? AND status <> 'COMPLETED'`)
    .run(result.score_a, result.score_b, result.winner_id, result.result_id, now, now, matchId);
  if (Number(updated.changes) === 0 && match.status === 'COMPLETED') return null;
  releaseCourt(db, match.court_id, now);
  db.prepare(`UPDATE match_requests SET status = 'MATCHED', matched_match_id = ?, updated_at = ?, row_version = row_version + 1
    WHERE event_id = ? AND status = 'ACTIVE' AND ((requester_id = ? AND target_player_id = ?) OR (requester_id = ? AND target_player_id = ?))`)
    .run(matchId, now, eventId, match.player_a_id, match.player_b_id, match.player_b_id, match.player_a_id);
  const advanced = advanceBracket(db, eventId, matchId, null);
  if (advanced.created.length > 0 || advanced.bracketCompleted) {
    return { created: advanced.created, bracketCompleted: advanced.bracketCompleted, phaseChanged: advanced.phaseChanged };
  }
  return null;
}

/** Marks a result row confirmed and completes its match. Used by every confirm path. */
function confirmRow(db: DB, eventId: string, match: MatchRow, result: ResultRow, actor: ResultActor, now: string, options: { auto?: boolean; corrected?: boolean } = {}): BracketNotice | null {
  const changed = db.prepare(`UPDATE results SET status = ?, confirmed_by = ?, confirmed_at = ?, auto_confirmed = ?,
      updated_at = ?, row_version = row_version + 1 WHERE result_id = ?`)
    .run(options.corrected ? 'CORRECTED' : 'CONFIRMED', actor.userId, now, options.auto ? 1 : 0, now, result.result_id);
  if (Number(changed.changes) === 0) throw new ApiError(409, 'VERSION_CONFLICT', '他の端末で結果が更新されました。');
  db.prepare('UPDATE results SET dispute = NULL WHERE result_id = ?').run(result.result_id);
  return completeMatch(db, eventId, match.match_id, { ...result, status: 'CONFIRMED' }, now);
}

/**
 * Score submission. Staff entries are confirmed on the spot (the operator is the
 * authority); a player's entry waits for the opponent, and matching claims
 * confirm themselves immediately.
 */
export function submitResult(
  db: DB,
  eventId: string,
  matchId: string,
  input: { scoreA: number; scoreB: number; rowVersion: number; note?: string | null },
  actor: ResultActor,
): ResultOutcome {
  const now = nowIso();
  const outcome: { current: ResultOutcome | null } = { current: null };
  transaction(db, () => {
    const match = readMatch(db, eventId, matchId);
    const settled = readResult(db, matchId);
    if (settled && ['CONFIRMED', 'CORRECTED'].includes(String(settled.status)) && !actor.staff) {
      throw new ApiError(409, 'RESULT_ALREADY_CONFIRMED', 'この結果は確定済みです。運営に修正を依頼してください。');
    }
    if (!['PLAYING', 'RESULT_PENDING'].includes(String(match.status))) {
      throw new ApiError(409, 'INVALID_STATE_TRANSITION', 'プレー中または結果待ちの試合のみ結果登録できます。');
    }
    const scoreA = Math.round(input.scoreA);
    const scoreB = Math.round(input.scoreB);
    const winnerId = winnerOf(scoreA, scoreB, match);
    const existing = readResult(db, matchId);
    const timeout = readConfirmTimeout(db, eventId);
    const confirmNow = actor.staff || timeout.minutes === 0;

    // Every entry claims the match row: the client's rowVersion is what makes a
    // second, stale submission fail instead of overwriting the first report.
    const touched = db.prepare(`UPDATE matches SET status = 'RESULT_PENDING', end_time = COALESCE(end_time, ?),
      updated_at = ?, row_version = row_version + 1 WHERE match_id = ? AND status <> 'COMPLETED' AND row_version = ?`)
      .run(now, now, matchId, input.rowVersion);
    if (Number(touched.changes) === 0) throw new ApiError(409, 'VERSION_CONFLICT', '他の端末で結果が登録されました。');


    // --- nothing recorded yet: create the row ----------------------------------
    if (!existing) {
      // The match sits in RESULT_PENDING until a confirmation completes it.
      const resultId = makeId('result');
      db.prepare(`INSERT INTO results (result_id, match_id, score_a, score_b, winner_id, entered_by, entered_by_participant,
          status, entered_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ENTERED', ?, ?)`)
        .run(resultId, matchId, scoreA, scoreB, winnerId, actor.userId, actor.participantId, now, now);
      const created = { ...readResult(db, matchId)!, result_id: resultId } as ResultRow;
      if (confirmNow) {
        const advance = confirmRow(db, eventId, match, created, actor, now, { auto: !actor.staff });
        outcome.current = {
          state: 'CONFIRMED', matchId, resultId, scoreA, scoreB, winnerId,
          confirmedByMe: true, autoConfirmed: !actor.staff, waitingFor: null, bracketAdvance: advance,
        };
        return;
      }
      outcome.current = {
        state: 'ENTERED', matchId, resultId, scoreA, scoreB, winnerId,
        confirmedByMe: false, autoConfirmed: false,
        waitingFor: actor.staff ? 'STAFF' : 'OPPONENT', bracketAdvance: null,
      };
      return;
    }

    // --- a row exists: second claim, own resubmission, or staff override --------
    const mineIsOpponent = actor.participantId !== null && existing.entered_by_participant !== actor.participantId;
    const claim = parseClaim(existing.dispute);

    if (actor.staff) {
      // 運営の上書き確定: whatever the players argued about, staff decides here.
      const changed = db.prepare(`UPDATE results SET score_a = ?, score_b = ?, winner_id = ?, status = 'ENTERED', dispute = NULL,
          entered_by = ?, entered_by_participant = NULL, updated_at = ?, row_version = row_version + 1
          WHERE result_id = ? AND row_version = ?`)
        .run(scoreA, scoreB, winnerId, actor.userId, now, existing.result_id, existing.row_version);
      if (Number(changed.changes) === 0) throw new ApiError(409, 'VERSION_CONFLICT', '他の端末で結果が更新されました。');
      const refreshed = readResult(db, matchId)!;
      const advance = confirmRow(db, eventId, match, refreshed, actor, now, { corrected: existing.status !== 'ENTERED' });
      outcome.current = {
        state: 'CONFIRMED', matchId, resultId: existing.result_id, scoreA, scoreB, winnerId,
        confirmedByMe: true, autoConfirmed: false, waitingFor: null, bracketAdvance: advance,
      };
      return;
    }

    if (!mineIsOpponent) {
      // The same side correcting its own report.
      const agree = claim && Number(claim.scoreA) === scoreA && Number(claim.scoreB) === scoreB;
      const changed = db.prepare(`UPDATE results SET score_a = ?, score_b = ?, winner_id = ?,
          status = ?, updated_at = ?, row_version = row_version + 1
          WHERE result_id = ? AND row_version = ?`)
        .run(scoreA, scoreB, winnerId, agree ? 'ENTERED' : existing.status, now, now, existing.result_id, existing.row_version);
      if (Number(changed.changes) === 0) throw new ApiError(409, 'VERSION_CONFLICT', '他の端末で結果が更新されました。');
      if (agree) {
        const refreshed = readResult(db, matchId)!;
        const advance = confirmRow(db, eventId, match, refreshed, actor, now);
        outcome.current = {
          state: 'CONFIRMED', matchId, resultId: existing.result_id, scoreA, scoreB, winnerId,
          confirmedByMe: true, autoConfirmed: false, waitingFor: null, bracketAdvance: advance,
        };
        return;
      }
      outcome.current = {
        state: String(existing.status) === 'DISPUTED' ? 'DISPUTED' : 'ENTERED',
        matchId, resultId: existing.result_id, scoreA, scoreB, winnerId,
        confirmedByMe: false, autoConfirmed: false,
        waitingFor: String(existing.status) === 'DISPUTED' ? 'STAFF' : 'OPPONENT', bracketAdvance: null,
      };
      return;
    }

    // The other side of the net is reporting.
    const agrees = Number(existing.score_a) === scoreA && Number(existing.score_b) === scoreB;
    if (agrees || confirmNow) {
      const advance = confirmRow(db, eventId, match, existing, actor, now);
      outcome.current = {
        state: 'CONFIRMED', matchId, resultId: existing.result_id, scoreA, scoreB, winnerId,
        confirmedByMe: true, autoConfirmed: false, waitingFor: null, bracketAdvance: advance,
      };
      return;
    }
    // Different numbers: keep both claims and pull the operator in.
    const dispute: DisputeClaim = { scoreA, scoreB, by: actor.participantId, note: input.note ?? null, at: now };
    const changed = db.prepare(`UPDATE results SET status = 'DISPUTED', dispute = ?, updated_at = ?, row_version = row_version + 1
      WHERE result_id = ? AND row_version = ?`).run(JSON.stringify(dispute), now, existing.result_id, existing.row_version);
    if (Number(changed.changes) === 0) throw new ApiError(409, 'VERSION_CONFLICT', '他の端末で結果が更新されました。');
    outcome.current = {
      state: 'DISPUTED', matchId, resultId: existing.result_id,
      scoreA: Number(existing.score_a), scoreB: Number(existing.score_b), winnerId: String(existing.winner_id),
      confirmedByMe: false, autoConfirmed: false, waitingFor: 'STAFF', bracketAdvance: null,
    };
  });
  if (!outcome.current) throw new ApiError(409, 'RESULT_NOT_FOUND', '結果を登録できませんでした。');
  return outcome.current;
}

/**
 * Confirming a reported result: the opponent's tap, a staff tap, or the timeout.
 * A player may never confirm the score they entered themselves.
 */
export function confirmEnteredResult(db: DB, eventId: string, matchId: string, actor: ResultActor, options: { auto?: boolean } = {}): {
  matchId: string; resultId: string; bracketAdvance: BracketNotice | null;
} {
  const now = nowIso();
  const holder: { current: { matchId: string; resultId: string; bracketAdvance: BracketNotice | null } | null } = { current: null };
  transaction(db, () => {
    const match = readMatch(db, eventId, matchId);
    if (match.status === 'COMPLETED') throw new ApiError(409, 'ALREADY_CONFIRMED', 'この結果は確定済みです。');
    if (!['PLAYING', 'RESULT_PENDING'].includes(String(match.status))) {
      throw new ApiError(409, 'INVALID_STATE_TRANSITION', '結果を確定できるのは結果待ちの試合だけです。');
    }
    const result = readResult(db, matchId);
    if (!result) throw new ApiError(404, 'RESULT_NOT_FOUND', '確定できる結果がありません。選手に結果の入力をお願いしてください。');
    if (['CONFIRMED', 'CORRECTED'].includes(String(result.status))) throw new ApiError(409, 'ALREADY_CONFIRMED', 'この結果は確定済みです。');
    if (!actor.staff && !options.auto) {
      if (!actor.participantId || ![match.player_a_id, match.player_b_id].includes(actor.participantId)) {
        throw new ApiError(403, 'FORBIDDEN', '対戦相手または運営のみ確定できます。');
      }
      if (String(result.status) === 'DISPUTED') {
        // 申告が食い違っている間は、選手同士の言い直しでは確定させない。確定すると
        // 「先に申告されたスコア」がそのまま記録になってしまうため、運営に判断させる。
        throw new ApiError(409, 'DISPUTE_REQUIRES_STAFF', '申告が食い違っているため、運営が結果を確定します。コートの係にお伝えください。');
      }
      if (result.entered_by_participant === actor.participantId) {
        throw new ApiError(409, 'SELF_CONFIRM', '自分が入力した結果は確定できません。相手か運営の確定が必要です。');
      }
    }
    const advance = confirmRow(db, eventId, match, result, actor, now, { auto: options.auto === true });
    holder.current = { matchId, resultId: result.result_id, bracketAdvance: advance };
  });
  return holder.current!;
}

/** The other side says "that is not what we played" - staff has to decide. */
export function disputeResult(db: DB, eventId: string, matchId: string, actor: ResultActor, note: string | null): {
  matchId: string; resultId: string; scoreA: number; scoreB: number; claim: DisputeClaim;
} {
  const now = nowIso();
  const holder: { current: { matchId: string; resultId: string; scoreA: number; scoreB: number; claim: DisputeClaim } | null } = { current: null };
  transaction(db, () => {
    const match = readMatch(db, eventId, matchId);
    const result = readResult(db, matchId);
    if (!result) throw new ApiError(404, 'RESULT_NOT_FOUND', '異議を唱える前の結果がありません。');
    if (['CONFIRMED', 'CORRECTED'].includes(String(result.status))) {
      throw new ApiError(409, 'RESULT_ALREADY_CONFIRMED', '確定済みの結果です。運営が修正できます。');
    }
    if (!actor.staff && actor.participantId === result.entered_by_participant) {
      throw new ApiError(409, 'SELF_DISPUTE', '自分が入力した結果は「ちがう」で差し替えられます。');
    }
    const claim: DisputeClaim = { by: actor.participantId, note, at: now };
    db.prepare(`UPDATE results SET status = 'DISPUTED', dispute = ?, updated_at = ?, row_version = row_version + 1
      WHERE result_id = ?`).run(JSON.stringify(claim), now, result.result_id);
    db.prepare(`UPDATE matches SET status = 'RESULT_PENDING', updated_at = ?, row_version = row_version + 1
      WHERE match_id = ? AND status = 'PLAYING'`).run(now, matchId);
    holder.current = { matchId, resultId: result.result_id, scoreA: Number(result.score_a), scoreB: Number(result.score_b), claim };
  });
  return holder.current!;
}

/**
 * The safety net of the whole feature: a report nobody confirms must not hold a
 * court and two players forever. After `result_confirm_timeout_minutes` the entry
 * is confirmed as reported (auto_confirmed = 1). Once the event itself is over,
 * every pending entry - including a disputed one, where the first report wins -
 * is closed out so the hand-in sheet is never half-written.
 */
export function confirmStaleResults(db: DB, eventId: string): { confirmed: number; disputed: number; matchIds: string[] } {
  const { minutes, eventEnded } = readConfirmTimeout(db, eventId);
  const cutoff = new Date(Date.now() - Math.max(0, minutes) * 60_000).toISOString();
  const due = asRows<{ match_id: string; status: string }>(db.prepare(`SELECT m.match_id, r.status
    FROM results r JOIN matches m ON m.match_id = r.match_id
    WHERE m.event_id = ? AND m.status IN ('PLAYING','RESULT_PENDING') AND r.status = 'ENTERED'
      AND (? = 1 OR datetime(r.entered_at) <= datetime(?))
    ORDER BY r.entered_at`).all(eventId, eventEnded ? 1 : 0, cutoff));
  const stuck = eventEnded
    ? asRows<{ match_id: string }>(db.prepare(`SELECT m.match_id FROM results r JOIN matches m ON m.match_id = r.match_id
        WHERE m.event_id = ? AND m.status = 'RESULT_PENDING' AND r.status = 'DISPUTED'`).all(eventId))
    : [];
  if (due.length === 0 && stuck.length === 0) return { confirmed: 0, disputed: 0, matchIds: [] };
  const matchIds: string[] = [];
  let confirmed = 0;
  let disputed = 0;
  const now = nowIso();
  transaction(db, () => {
    for (const row of due) {
      const result = readResult(db, String(row.match_id));
      const match = readMatch(db, eventId, String(row.match_id));
      if (!result || !match || match.status === 'COMPLETED') continue;
      confirmRow(db, eventId, match, result, { userId: null, participantId: null, staff: false }, now, { auto: true });
      confirmed += 1;
      matchIds.push(String(row.match_id));
    }
    if (stuck.length > 0) {
      for (const row of stuck) {
        const result = readResult(db, String(row.match_id));
        const match = readMatch(db, eventId, String(row.match_id));
        if (!result || !match || match.status === 'COMPLETED') continue;
        // 大会終了時に申告不一致が残っていたら、最初の申告を記録として確定させる。
        db.prepare('UPDATE results SET dispute = NULL WHERE result_id = ?').run(result.result_id);
        confirmRow(db, eventId, match, result, { userId: null, participantId: null, staff: false }, now, { auto: true });
        disputed += 1;
        matchIds.push(String(row.match_id));
      }
    }
  });
  return { confirmed, disputed, matchIds };
}

/** Every open (unconfirmed or disputed) result of an event - used by alerts and the report. */
export function listPendingResults(db: DB, eventId: string) {
  return asRows<Record<string, any>>(db.prepare(`SELECT m.match_id, m.status AS match_status, m.player_a_id, m.player_b_id,
      m.class_id, m.court_id, m.updated_at, r.result_id, r.status AS result_status, r.score_a, r.score_b,
      r.entered_at, r.confirmed_at, r.auto_confirmed, r.dispute, r.entered_by_participant,
      pa.name AS player_a_name, pb.name AS player_b_name
    FROM results r JOIN matches m ON m.match_id = r.match_id
    JOIN participants pa ON pa.participant_id = m.player_a_id
    JOIN participants pb ON pb.participant_id = m.player_b_id
    WHERE m.event_id = ? AND m.status IN ('PLAYING','RESULT_PENDING') AND r.status IN ('ENTERED','DISPUTED')
    ORDER BY r.entered_at`).all(eventId));
}
