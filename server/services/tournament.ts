import type { DB } from '../db.js';
import { asRow, asRows, makeId, nowIso, pairKey, transaction } from '../db.js';
import { ApiError } from '../http.js';
import { calculateRankings } from './ranking.js';

/**
 * Single elimination brackets for event mode C (LEAGUE → TOURNAMENT → REQUEST).
 *
 * Only resolved pairings are written as matches. An undecided slot does not exist as a
 * card, and a bye is not a fake opponent either: the advancing player is remembered in
 * the bracket structure and the next round's card appears the moment both of its
 * feeders are known. That keeps the "no phantom entity" rule intact while the bracket
 * still plays itself out without an operator pushing each round.
 */

const BYE = null;

interface BracketRow {
  bracket_id: string;
  event_id: string;
  class_id: string;
  size: number;
  rounds: number;
  status: string;
  winner_id: string | null;
}

interface SeedRow { slot: number; participant_id: string; name: string; seed: number }

interface MatchSlotRow {
  match_id: string;
  bracket_round: number;
  bracket_slot: number;
  player_a_id: string;
  player_b_id: string;
  status: string;
  winner_id: string | null;
  score_a: number | null;
  score_b: number | null;
  court_id: string | null;
  court_name: string | null;
  scheduled_time: string | null;
}

interface Board {
  bracket: BracketRow;
  /** round-1 slot -> participant id (an absent slot is a bye) */
  seeds: Map<number, string>;
  /** participant id -> published seed number, for display only */
  seedNumbers: Map<string, number>;
  names: Map<string, string>;
  /** `${round}:${index}` -> match */
  slots: Map<string, MatchSlotRow>;
  size: number;
  rounds: number;
}

const slotKey = (round: number, index: number) => `${round}:${index}`;

/** Standard seeding order: slot i holds the seed that plays the mirror seed first. */
export function bracketOrder(size: number): number[] {
  let order = [0, 1];
  while (order.length < size) {
    const span = order.length * 2;
    const next: number[] = [];
    for (const seed of order) {
      next.push(seed, span - 1 - seed);
    }
    order = next;
  }
  return order.slice(0, size);
}

function bracketSize(count: number): number {
  let size = 2;
  while (size < count) size *= 2;
  return size;
}

function loadBoard(db: DB, bracketId: string): Board {
  const bracket = asRow<BracketRow>(db.prepare('SELECT * FROM tournament_brackets WHERE bracket_id = ?').get(bracketId));
  if (!bracket) throw new ApiError(404, 'BRACKET_NOT_FOUND', 'トーナメント表が見つかりません。');
  const seeds = new Map<number, string>();
  const names = new Map<string, string>();
  const seedNumbers = new Map<string, number>();
  for (const row of asRows<SeedRow>(db.prepare(`SELECT s.slot, s.participant_id, s.seed, p.name
    FROM tournament_seeds s JOIN participants p ON p.participant_id = s.participant_id
    WHERE s.bracket_id = ? ORDER BY s.slot`).all(bracketId))) {
    seeds.set(Number(row.slot), row.participant_id);
    names.set(row.participant_id, row.name);
    seedNumbers.set(row.participant_id, Number(row.seed));
  }
  const slots = new Map<string, MatchSlotRow>();
  for (const row of asRows<MatchSlotRow>(db.prepare(`SELECT m.match_id, m.bracket_round, m.bracket_slot, m.player_a_id, m.player_b_id,
      m.status, m.winner_id, m.score_a, m.score_b, m.court_id, c.court_name, m.scheduled_time
      FROM matches m LEFT JOIN courts c ON c.court_id = m.court_id
      WHERE m.bracket_id = ?`).all(bracketId))) {
    slots.set(slotKey(Number(row.bracket_round), Number(row.bracket_slot)), row);
  }
  return { bracket, seeds, seedNumbers, names, slots, size: Number(bracket.size), rounds: Number(bracket.rounds) };
}

/**
 * Who occupies the given feeder of `round`. Round 1 feeds from the seed slots, later
 * rounds from the previous round's match. A missing card means the feeder walkovered.
 */
function feeder(board: Board, round: number, index: number): string | null {
  if (round === 1) return board.seeds.get(index) ?? BYE;
  const match = board.slots.get(slotKey(round - 1, index));
  if (match) return match.winner_id;
  const upper = feeder(board, round - 1, index * 2);
  const lower = feeder(board, round - 1, index * 2 + 1);
  if (upper && lower) return BYE;   // both sides alive but no card: cannot happen in a healthy bracket
  return upper ?? lower ?? BYE;
}

/**
 * Opens every bracket card that can be played right now: both feeders decided (a match
 * winner or a bye walkover). Called after generation, after each result and by the
 * manual rebalance, so a chain of byes deep in the draw still produces its card.
 */
function openResolvableSlots(db: DB, bracketId: string, actorId: string | null | undefined, source: 'AUTO' | 'MANUAL'): Array<{ matchId: string; round: number; roundLabel: string; playerAName: string; playerBName: string }> {
  const created: Array<{ matchId: string; round: number; roundLabel: string; playerAName: string; playerBName: string }> = [];
  for (let pass = 0; pass < 8; pass += 1) {
    const board = loadBoard(db, bracketId);
    let added = 0;
    for (let round = 1; round <= board.rounds; round += 1) {
      for (let slot = 0; slot < matchesInRound(board, round); slot += 1) {
        if (board.slots.has(slotKey(round, slot))) continue;
        const a = feeder(board, round, slot * 2);
        const b = feeder(board, round, slot * 2 + 1);
        if (!a || !b) continue;
        const stamp = nowIso();
        const matchId = makeId('match');
        db.prepare(`INSERT INTO matches (
            match_id, event_id, phase, class_id, player_a_id, player_b_id, scheduled_time, status, source,
            priority_score, pair_key, bracket_id, bracket_round, bracket_slot, created_by, created_at, updated_at
          ) VALUES (?, ?, 'TOURNAMENT', ?, ?, ?, ?, 'WAITING', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(matchId, board.bracket.event_id, board.bracket.class_id, a, b, stamp, source,
            600 + (board.rounds - round) * 10, pairKey(a, b), bracketId, round, slot, actorId ?? null, stamp, stamp);
        board.slots.set(slotKey(round, slot), {
          match_id: matchId, bracket_round: round, bracket_slot: slot, player_a_id: a, player_b_id: b,
          status: 'WAITING', winner_id: null, score_a: null, score_b: null, court_id: null, court_name: null,
          scheduled_time: stamp,
        });
        created.push({
          matchId, round, roundLabel: roundLabel(board.rounds, round),
          playerAName: board.names.get(a) ?? a, playerBName: board.names.get(b) ?? b,
        });
        added += 1;
      }
    }
    if (added === 0) break;
  }
  return created;
}

function matchesInRound(board: Board, round: number): number {
  return Math.max(1, Math.floor(board.size / 2 ** round));
}

export function roundLabel(rounds: number, round: number): string {
  const fromEnd = rounds - round;
  if (fromEnd === 0) return '決勝';
  if (fromEnd === 1) return '準決勝';
  if (fromEnd === 2) return '準々決勝';
  return `${round}回戦`;
}

export interface BracketPairing {
  round: number;
  roundLabel: string;
  slot: number;
  matchId: string | null;
  playerAId: string | null;
  playerAName: string | null;
  playerBId: string | null;
  playerBName: string | null;
  status: string | null;
  scoreA: number | null;
  scoreB: number | null;
  winnerId: string | null;
  courtName: string | null;
  scheduledTime: string | null;
  bye: boolean;
}

export interface BracketView {
  bracketId: string;
  eventId: string;
  classId: string;
  className: string | null;
  format: string;
  size: number;
  rounds: number;
  status: string;
  winnerId: string | null;
  winnerName: string | null;
  entrants: Array<{ participantId: string; name: string; seed: number; slot: number }>;
  byes: number;
  decidedMatches: number;
  requiredMatches: number;
  pairings: BracketPairing[];
}

function viewOf(board: Board, className: string | null): BracketView {
  const pairings: BracketPairing[] = [];
  for (let round = 1; round <= board.rounds; round += 1) {
    for (let slot = 0; slot < matchesInRound(board, round); slot += 1) {
      const playerAId = feeder(board, round, slot * 2);
      const playerBId = feeder(board, round, slot * 2 + 1);
      const match = board.slots.get(slotKey(round, slot));
      pairings.push({
        round,
        roundLabel: roundLabel(board.rounds, round),
        slot,
        matchId: match?.match_id ?? null,
        playerAId,
        playerAName: playerAId ? (board.names.get(playerAId) ?? null) : null,
        playerBId,
        playerBName: playerBId ? (board.names.get(playerBId) ?? null) : null,
        status: match?.status ?? null,
        scoreA: match?.score_a ?? null,
        scoreB: match?.score_b ?? null,
        winnerId: match?.winner_id ?? null,
        courtName: match?.court_name ?? null,
        scheduledTime: match?.scheduled_time ?? null,
        bye: playerAId === null || playerBId === null,
      });
    }
  }
  const entrants = [...board.seeds.entries()]
    .map(([slot, participantId]) => ({
      slot,
      participantId,
      name: board.names.get(participantId) ?? '',
      seed: board.seedNumbers.get(participantId) ?? slot + 1,
    }))
    .sort((left, right) => left.slot - right.slot);
  return {
    bracketId: board.bracket.bracket_id,
    eventId: board.bracket.event_id,
    classId: board.bracket.class_id,
    className,
    format: 'SINGLE_ELIM',
    size: board.size,
    rounds: board.rounds,
    status: board.bracket.status,
    winnerId: board.bracket.winner_id,
    winnerName: board.bracket.winner_id ? (board.names.get(board.bracket.winner_id) ?? null) : null,
    entrants,
    byes: board.size - board.seeds.size,
    decidedMatches: [...board.slots.values()].filter((match) => match.winner_id).length,
    requiredMatches: Math.max(1, board.seeds.size - 1),
    pairings,
  };
}

export function getBracket(db: DB, bracketId: string): BracketView {
  const board = loadBoard(db, bracketId);
  const className = (db.prepare('SELECT class_name FROM classes WHERE class_id = ?').get(board.bracket.class_id) as { class_name?: string } | undefined)?.class_name ?? null;
  return viewOf(board, className);
}

export function listBrackets(db: DB, eventId: string): BracketView[] {
  const rows = asRows<{ bracket_id: string }>(db.prepare('SELECT bracket_id FROM tournament_brackets WHERE event_id = ? ORDER BY created_at').all(eventId));
  return rows.map((row) => getBracket(db, row.bracket_id));
}

interface PreviewClass {
  classId: string;
  className: string;
  entrants: Array<{ participantId: string; name: string; seed: number; rating: number }>;
  size: number;
  rounds: number;
  byes: number;
  requiredMatches: number;
  roundOneCards: number;
  estimatedMinutes: number;
  fitsBeforeEnd: boolean;
  reason: string | null;
}

export interface TournamentPreview {
  classes: PreviewClass[];
  summary: { classCount: number; entrants: number; matchCount: number; blockedClasses: number; fitsBeforeEnd: boolean; perRoundMinutes: number };
}

/**
 * The preview the operator must see before `Generate Matches`: bracket shape, seed
 * list, bye count and whether the whole draw can still finish inside the event window.
 */
export function buildTournamentPreview(db: DB, eventId: string, classIds?: string[]): TournamentPreview {
  const event = asRow<Record<string, any>>(db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId));
  if (!event) throw new ApiError(404, 'EVENT_NOT_FOUND', 'イベントが見つかりません。');
  const classes = asRows<{ class_id: string; class_name: string }>(db.prepare(`SELECT class_id, class_name FROM classes
    WHERE event_id = ? AND enabled = 1 ORDER BY display_order, class_name`).all(eventId));
  const wanted = classIds?.length ? new Set(classIds) : null;
  const targets = classes.filter((item) => !wanted || wanted.has(item.class_id));
  if (targets.length === 0) throw new ApiError(400, 'NO_CLASSES', '対象クラスがありません。');

  const matchMinutes = Number(event.default_match_minutes);
  const turnoverMinutes = Number(event.result_input_grace_minutes) + 2;
  const perRoundMinutes = matchMinutes + turnoverMinutes;
  const endMs = new Date(String(event.end_time)).getTime();
  const safetyMs = Number(event.safety_margin_minutes) * 60_000;
  const startMs = event.status === 'RUNNING' ? Math.max(Date.now(), new Date(String(event.start_time)).getTime()) : new Date(String(event.start_time)).getTime();

  const previewClasses: PreviewClass[] = [];
  for (const clazz of targets) {
    const ranked = calculateRankings(db, eventId, clazz.class_id)
      .filter((row) => row.classId === clazz.class_id);
    const entrants = asRows<{ participant_id: string; name: string; rating: number }>(db.prepare(`SELECT p.participant_id, p.name, p.rating
      FROM participants p WHERE p.event_id = ? AND p.class_id = ? AND p.active = 1 AND p.checked_in = 1
      ORDER BY p.name_kana, p.name`).all(eventId, clazz.class_id));
    const orderedIds = ranked.map((row) => row.participantId);
    const sorted = [...entrants].sort((left, right) => {
      const leftIndex = orderedIds.indexOf(left.participant_id);
      const rightIndex = orderedIds.indexOf(right.participant_id);
      if (leftIndex >= 0 && rightIndex >= 0) return leftIndex - rightIndex;
      if (leftIndex >= 0) return -1;
      if (rightIndex >= 0) return 1;
      return right.rating - left.rating || left.name.localeCompare(right.name, 'ja');
    }).map((row, index) => ({ participantId: row.participant_id, name: row.name, seed: index + 1, rating: Number(row.rating) }));

    const size = bracketSize(Math.max(2, sorted.length));
    const rounds = Math.round(Math.log2(size));
    const existing = db.prepare(`SELECT COUNT(*) AS count FROM tournament_brackets WHERE event_id = ? AND class_id = ? AND status = 'OPEN'`)
      .get(eventId, clazz.class_id) as { count: number };
    const required = Math.max(0, sorted.length - 1);
    const roundOneCards = Math.max(0, Math.floor(size / 2) - Math.max(0, size - sorted.length));
    const estimatedMinutes = rounds * perRoundMinutes;
    const fitsBeforeEnd = startMs + estimatedMinutes * 60_000 + safetyMs <= endMs;
    let reason: string | null = null;
    if (sorted.length < 2) reason = '参加者が2名未満です';
    else if (Number(existing.count) > 0) reason = 'このクラスには既に進行中のトーナメント表があります';
    else if (!fitsBeforeEnd) reason = `終了時刻までに全${rounds}ラウンド（約${estimatedMinutes}分）が終わりません`;
    previewClasses.push({
      classId: clazz.class_id,
      className: clazz.class_name,
      entrants: sorted,
      size,
      rounds,
      byes: size - sorted.length,
      requiredMatches: required,
      roundOneCards,
      estimatedMinutes,
      fitsBeforeEnd: reason === null,
      reason,
    });
  }

  return {
    classes: previewClasses,
    summary: {
      classCount: previewClasses.length,
      entrants: previewClasses.reduce((total, item) => total + item.entrants.length, 0),
      matchCount: previewClasses.filter((item) => item.reason === null).reduce((total, item) => total + item.requiredMatches, 0),
      blockedClasses: previewClasses.filter((item) => item.reason !== null).length,
      fitsBeforeEnd: previewClasses.some((item) => item.reason === null),
      perRoundMinutes,
    },
  };
}

export interface GenerateResult {
  bracket: BracketView;
  created: Array<{ matchId: string; round: number; roundLabel: string; playerAName: string; playerBName: string }>;
  walkovers: Array<{ participantName: string; intoRound: number; roundLabel: string }>;
}

/** Creates the bracket, its seeds and the first round's playable cards. */
export function generateTournament(db: DB, eventId: string, options: { classId: string; actorId?: string | null; nowMs?: number }): GenerateResult {
  const event = asRow<Record<string, any>>(db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId));
  if (!event) throw new ApiError(404, 'EVENT_NOT_FOUND', 'イベントが見つかりません。');
  if (['COMPLETED', 'CANCELLED'].includes(String(event.status))) {
    throw new ApiError(409, 'EVENT_CLOSED', '終了したイベントではトーナメント表を作れません。');
  }
  const clazz = asRow<{ class_id: string; class_name: string }>(db.prepare('SELECT class_id, class_name FROM classes WHERE class_id = ? AND event_id = ?')
    .get(options.classId, eventId));
  if (!clazz) throw new ApiError(404, 'CLASS_NOT_FOUND', 'クラスが見つかりません。');
  const open = asRow<{ bracket_id: string }>(db.prepare(`SELECT bracket_id FROM tournament_brackets WHERE event_id = ? AND class_id = ? AND status = 'OPEN'`)
    .get(eventId, clazz.class_id));
  if (open) throw new ApiError(409, 'BRACKET_EXISTS', 'このクラスには既に進行中のトーナメント表があります。');

  const preview = buildTournamentPreview(db, eventId, [clazz.class_id]).classes[0];
  if (preview.entrants.length < 2) throw new ApiError(400, 'NOT_ENOUGH_PLAYERS', preview.reason ?? '参加者が2名未満です。');
  if (!preview.fitsBeforeEnd) throw new ApiError(409, 'TOURNAMENT_WONT_FIT', preview.reason ?? '終了時刻までに終わります。');

  const stamp = nowIso();
  const bracketId = makeId('bracket');
  const created: GenerateResult['created'] = [];
  const walkovers: GenerateResult['walkovers'] = [];

  transaction(db, () => {
    db.prepare(`INSERT INTO tournament_brackets (bracket_id, event_id, class_id, format, size, rounds, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'SINGLE_ELIM', ?, ?, 'OPEN', ?, ?, ?)`)
      .run(bracketId, eventId, clazz.class_id, preview.size, preview.rounds, options.actorId ?? null, stamp, stamp);

    // Seed slots follow the standard draw order, so byes always sit against top seeds.
    const order = bracketOrder(preview.size);
    const byParticipant = new Map(preview.entrants.map((entry) => [entry.participantId, entry]));
    const seedInsert = db.prepare('INSERT INTO tournament_seeds (bracket_id, slot, participant_id, seed) VALUES (?, ?, ?, ?)');
    const participantsBySlot = new Map<number, string>();
    order.forEach((seedIndex, slot) => {
      const entrant = preview.entrants[seedIndex];
      if (!entrant) return;   // that slot is a bye
      seedInsert.run(bracketId, slot, entrant.participantId, entrant.seed);
      participantsBySlot.set(slot, entrant.participantId);
    });

    const firstRoundMatches = Math.floor(preview.size / 2);
    for (let slot = 0; slot < firstRoundMatches; slot += 1) {
      const a = participantsBySlot.get(slot * 2);
      const b = participantsBySlot.get(slot * 2 + 1);
      if (a && b) continue;
      if (a || b) {
        walkovers.push({
          participantName: byParticipant.get((a ?? b) as string)?.name ?? String(a ?? b),
          intoRound: 2,
          roundLabel: roundLabel(preview.rounds, 2),
        });
      }
    }
    // Every pair of real seeds becomes a card, including the ones that meet only
    // after a chain of byes deeper in the draw.
    created.push(...openResolvableSlots(db, bracketId, options.actorId ?? null, 'AUTO'));

    if (String(event.event_mode) === 'LEAGUE_TOURNAMENT_REQUEST' && String(event.current_phase) !== 'TOURNAMENT') {
      db.prepare(`UPDATE events SET current_phase = 'TOURNAMENT', updated_at = ?, row_version = row_version + 1 WHERE event_id = ?`)
        .run(stamp, eventId);
    }
  });

  return { bracket: getBracket(db, bracketId), created, walkovers };
}

/**
 * Called inside the same transaction as a bracket match's result. Advances the winner,
 * opens the next round's card when both feeders are known, and closes the bracket (and
 * hands the event back to the request phase) once the final is decided.
 */
export function advanceBracket(db: DB, eventId: string, matchId: string, actorId?: string | null): {
  created: Array<{ matchId: string; round: number; roundLabel: string; playerAName: string; playerBName: string }>;
  bracketId: string | null;
  bracketCompleted: boolean;
  phaseChanged: boolean;
} {
  const owned = asRow<{ bracket_id: string | null }>(db.prepare('SELECT bracket_id FROM matches WHERE match_id = ? AND event_id = ?').get(matchId, eventId));
  if (!owned?.bracket_id) return { created: [], bracketId: null, bracketCompleted: false, phaseChanged: false };
  const board = loadBoard(db, owned.bracket_id);
  const finished = asRow<MatchSlotRow>(db.prepare(`SELECT m.match_id, m.bracket_round, m.bracket_slot, m.player_a_id, m.player_b_id, m.status, m.winner_id,
      m.score_a, m.score_b, m.court_id, c.court_name
    FROM matches m LEFT JOIN courts c ON c.court_id = m.court_id WHERE m.match_id = ?`).get(matchId));
  if (!finished || finished.bracket_round === null || finished.bracket_slot === null) {
    return { created: [], bracketId: owned.bracket_id, bracketCompleted: false, phaseChanged: false };
  }
  const round = Number(finished.bracket_round);
  const slot = Number(finished.bracket_slot);
  const stamp = nowIso();
  const created: GenerateResult['created'] = [];
  let bracketCompleted = false;
  let phaseChanged = false;

  // No transaction of its own: the result route already holds one, and a bracket must
  // never be advanced separately from the score that decided it.
  if (round >= board.rounds) {
    if (board.bracket.status !== 'COMPLETED') {
      db.prepare(`UPDATE tournament_brackets SET status = 'COMPLETED', winner_id = ?, updated_at = ?, row_version = row_version + 1 WHERE bracket_id = ?`)
        .run(finished.winner_id, stamp, board.bracket.bracket_id);
      const moved = db.prepare(`UPDATE events SET current_phase = 'REQUEST', updated_at = ?, row_version = row_version + 1
        WHERE event_id = ? AND event_mode = 'LEAGUE_TOURNAMENT_REQUEST' AND current_phase = 'TOURNAMENT'`).run(stamp, eventId);
      phaseChanged = Number(moved.changes) > 0;
      bracketCompleted = true;
    }
  } else {
    // The written winner is visible to the fresh board the loader reads, so any card
    // that just became playable is opened here - including chains of byes.
    created.push(...openResolvableSlots(db, board.bracket.bracket_id, actorId, 'AUTO'));
  }

  return { created, bracketId: owned.bracket_id, bracketCompleted, phaseChanged };
}

/**
 * A bracket card must not simply disappear: cancelling it, or declaring a no-show
 * without a winner, would strand every round behind it. A walkover is recorded as a
 * result instead (21-0), which also advances the opponent.
 */
export function assertBracketTerminable(match: Record<string, any>, action: string): void {
  if (match.bracket_id) {
    throw new ApiError(409, 'BRACKET_CARD_LOCKED',
      `トーナメント表のカードに ${action} は使えません。不戦勝は結果（例: 21-0）として入力するか、トーナメント表を削除してください。`);
  }
}

export function deleteBracket(db: DB, eventId: string, bracketId: string, actorId?: string | null): { cancelledMatches: number } {
  const board = loadBoard(db, bracketId);
  if (board.bracket.event_id !== eventId) throw new ApiError(404, 'BRACKET_NOT_FOUND', 'トーナメント表が見つかりません。');
  const stamp = nowIso();
  let cancelledMatches = 0;
  transaction(db, () => {
    const live = asRows<{ match_id: string; status: string }>(db.prepare(`SELECT match_id, status FROM matches WHERE bracket_id = ?
      AND status IN ('WAITING','CALLED','COURT_ASSIGNED','PLAYING','RESULT_PENDING','DISPUTED')`).all(bracketId));
    cancelledMatches = live.length;
    if (live.some((row) => row.status !== 'WAITING' && row.status !== 'CALLED' && row.status !== 'DISPUTED')) {
      throw new ApiError(409, 'BRACKET_IN_PLAY', '進行中の試合があるためトーナメント表を削除できません。');
    }
    for (const row of live) {
      db.prepare(`UPDATE matches SET status = 'CANCELLED', source = 'MANUAL', updated_at = ?, row_version = row_version + 1 WHERE match_id = ?`)
        .run(stamp, row.match_id);
    }
    db.prepare(`DELETE FROM tournament_seeds WHERE bracket_id = ?`).run(bracketId);
    db.prepare(`DELETE FROM tournament_brackets WHERE bracket_id = ?`).run(bracketId);
    db.prepare(`UPDATE events SET current_phase = 'LEAGUE', updated_at = ?, row_version = row_version + 1
      WHERE event_id = ? AND current_phase = 'TOURNAMENT'`).run(stamp, eventId);
    void actorId;
  });
  return { cancelledMatches };
}

/** Manual recovery: recompute the next round for a bracket, creating anything missed. */
export function rebalanceBracket(db: DB, eventId: string, bracketId: string, actorId?: string | null): { created: number } {
  const board = loadBoard(db, bracketId);
  if (board.bracket.event_id !== eventId) throw new ApiError(404, 'BRACKET_NOT_FOUND', 'トーナメント表が見つかりません。');
  let created = 0;
  transaction(db, () => {
    created = openResolvableSlots(db, bracketId, actorId ?? null, 'MANUAL').length;
    // A decided final has to close its bracket and hand the floor back to requests.
    const fresh = loadBoard(db, bracketId);
    if (fresh.bracket.status === 'OPEN') {
      const final = fresh.slots.get(slotKey(fresh.rounds, 0));
      if (final?.winner_id) {
        const stamp = nowIso();
        db.prepare(`UPDATE tournament_brackets SET status = 'COMPLETED', winner_id = ?, updated_at = ?, row_version = row_version + 1 WHERE bracket_id = ?`)
          .run(final.winner_id, stamp, bracketId);
        db.prepare(`UPDATE events SET current_phase = 'REQUEST', updated_at = ?, row_version = row_version + 1
          WHERE event_id = ? AND event_mode = 'LEAGUE_TOURNAMENT_REQUEST' AND current_phase = 'TOURNAMENT'`).run(stamp, eventId);
      }
    }
  });
  return { created };
}

/**
 * A corrected score can change which player advances. While the next card has not been
 * called it is simply re-pointed at the new winner; once that card is on court the
 * operator has to resolve it too, so the request is refused rather than silently
 * rewriting live state. `previousWinnerId` is the winner as recorded before the edit.
 * Runs inside the caller's transaction, like the result write it belongs to.
 */
export function retargetBracket(db: DB, eventId: string, matchId: string, previousWinnerId: string | null, actorId?: string | null): { updated: boolean; closed: boolean } {
  const head = asRow<{ bracket_id: string | null; bracket_round: number | null; bracket_slot: number | null; winner_id: string | null }>(
    db.prepare('SELECT bracket_id, bracket_round, bracket_slot, winner_id FROM matches WHERE match_id = ? AND event_id = ?').get(matchId, eventId));
  if (!head?.bracket_id || head.bracket_round === null || head.bracket_slot === null) return { updated: false, closed: false };
  const board = loadBoard(db, head.bracket_id);
  const round = Number(head.bracket_round);
  const slot = Number(head.bracket_slot);
  const newWinnerId = head.winner_id;
  const stamp = nowIso();
  let updated = false;
  let closed = false;

  if (round >= board.rounds) {
    // The final: the bracket's champion has to follow the corrected score.
    const changed = db.prepare(`UPDATE tournament_brackets SET winner_id = ?, updated_at = ?, row_version = row_version + 1
      WHERE bracket_id = ? AND status = 'COMPLETED'`).run(newWinnerId, stamp, board.bracket.bracket_id);
    closed = Number(changed.changes) > 0;
  } else {
    const next = board.slots.get(slotKey(round + 1, Math.floor(slot / 2)));
    // Nothing was opened from this card yet, so there is nothing to re-point.
    if (next) {
      if (next.status !== 'WAITING' && next.status !== 'CALLED') {
        throw new ApiError(409, 'BRACKET_ADVANCED', '次のラウンドが既に進行中のため、勝者を変更できません。');
      }
      const otherId = next.player_a_id === previousWinnerId ? next.player_b_id : next.player_a_id;
      if (!newWinnerId || otherId === newWinnerId) {
        throw new ApiError(409, 'BRACKET_ADVANCED', '勝者を差し替えられませんでした。次のラウンドのカードを先に修正してください。');
      }
      const aId = next.player_a_id === previousWinnerId ? newWinnerId : otherId;
      const bId = next.player_a_id === previousWinnerId ? otherId : newWinnerId;
      db.prepare(`UPDATE matches SET player_a_id = ?, player_b_id = ?, pair_key = ?, updated_at = ?, row_version = row_version + 1
        WHERE match_id = ?`).run(aId, bId, pairKey(aId, bId), stamp, next.match_id);
      updated = true;
    }
  }
  void actorId;
  return { updated, closed };
}
