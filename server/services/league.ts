import type { DB } from '../db.js';
import { asRows } from '../db.js';
import { ApiError } from '../http.js';

interface LeagueEvent {
  event_id: string;
  start_time: string;
  end_time: string;
  status: string;
  default_match_minutes: number;
  result_input_grace_minutes: number;
  safety_margin_minutes: number;
  league_match_count: number;
  league_type: 'FULL_ROUND_ROBIN' | 'LIMITED_ROUND_ROBIN';
}

interface LeagueParticipant {
  participant_id: string;
  name: string;
  class_id: string;
  class_name: string;
  rating: number;
}

export interface LeaguePair {
  classId: string;
  className: string;
  round: number;
  playerAId: string;
  playerAName: string;
  playerBId: string;
  playerBName: string;
  scheduledTime: string;
  estimatedEndTime: string;
  existing: boolean;
  fitsBeforeEnd: boolean;
}

function roundRobin<T>(items: T[]): Array<Array<[T, T]>> {
  const players: Array<T | null> = [...items];
  if (players.length % 2 === 1) players.push(null);
  const rounds: Array<Array<[T, T]>> = [];
  const count = players.length;
  for (let round = 0; round < count - 1; round += 1) {
    const pairs: Array<[T, T]> = [];
    for (let index = 0; index < count / 2; index += 1) {
      const left = players[index];
      const right = players[count - 1 - index];
      if (left !== null && right !== null) pairs.push(round % 2 === 0 ? [left, right] : [right, left]);
    }
    rounds.push(pairs);
    const fixed = players[0];
    const rest = players.slice(1);
    rest.unshift(rest.pop() ?? null);
    players.splice(0, players.length, fixed, ...rest);
  }
  return rounds;
}

export function buildLeaguePreview(db: DB, eventId: string, selectedClassIds?: string[]): {
  pairs: LeaguePair[];
  summary: { participantCount: number; matchCount: number; classCount: number; excludedByEndTime: number; duplicateCount: number };
} {
  const event = db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId) as unknown as LeagueEvent | undefined;
  if (!event) throw new ApiError(404, 'EVENT_NOT_FOUND', 'イベントが見つかりません。');

  const classes = asRows<{ class_id: string; class_name: string }>(db.prepare(`SELECT class_id, class_name FROM classes
    WHERE event_id = ? AND enabled = 1 ORDER BY display_order, class_name`).all(eventId));
  const classFilter = selectedClassIds?.length ? new Set(selectedClassIds) : null;
  const enabledClasses = classes.filter((item) => !classFilter || classFilter.has(item.class_id));
  if (!enabledClasses.length) throw new ApiError(400, 'NO_CLASSES', '対象クラスがありません。');

  const courtCount = Math.max(1, Number((db.prepare(`SELECT COUNT(*) AS count FROM courts
    WHERE event_id = ? AND enabled = 1 AND status NOT IN ('BLOCKED','MAINTENANCE')`).get(eventId) as { count: number }).count));
  const existingPairs = new Set(asRows<{ key: string }>(db.prepare(`SELECT
    CASE WHEN player_a_id < player_b_id THEN player_a_id || ':' || player_b_id ELSE player_b_id || ':' || player_a_id END AS key
    FROM matches WHERE event_id = ? AND phase = 'LEAGUE' AND status NOT IN ('CANCELLED','NO_SHOW')`).all(eventId)).map((row) => row.key));

  const preview: LeaguePair[] = [];
  const baseTime = event.status === 'RUNNING'
    ? Math.max(Date.now(), new Date(event.start_time).getTime())
    : new Date(event.start_time).getTime();
  const durationMs = event.default_match_minutes * 60_000;
  const completionBufferMs = (event.result_input_grace_minutes + event.safety_margin_minutes) * 60_000;
  let globalRoundOffsetMs = 0;
  let participantCount = 0;

  for (const leagueClass of enabledClasses) {
    const participants = asRows<LeagueParticipant>(db.prepare(`SELECT p.participant_id, p.name, p.class_id, c.class_name, p.rating
      FROM participants p JOIN classes c ON c.class_id = p.class_id
      WHERE p.event_id = ? AND p.class_id = ? AND p.active = 1 AND p.checked_in = 1
      ORDER BY p.rating DESC, p.name_kana, p.name`).all(eventId, leagueClass.class_id));
    participantCount += participants.length;
    if (participants.length < 2) continue;
    const allRounds = roundRobin(participants);
    const rounds = event.league_type === 'FULL_ROUND_ROBIN'
      ? allRounds
      : allRounds.slice(0, Math.min(event.league_match_count, allRounds.length));

    rounds.forEach((roundPairs, roundIndex) => {
      const slotsInRound = Math.ceil(roundPairs.length / courtCount);
      roundPairs.forEach(([a, b], pairIndex) => {
        const slot = Math.floor(pairIndex / courtCount);
        const scheduledMs = baseTime + globalRoundOffsetMs + slot * durationMs;
        const estimatedEndMs = scheduledMs + durationMs + completionBufferMs;
        const key = a.participant_id < b.participant_id
          ? `${a.participant_id}:${b.participant_id}` : `${b.participant_id}:${a.participant_id}`;
        preview.push({
          classId: leagueClass.class_id,
          className: leagueClass.class_name,
          round: roundIndex + 1,
          playerAId: a.participant_id,
          playerAName: a.name,
          playerBId: b.participant_id,
          playerBName: b.name,
          scheduledTime: new Date(scheduledMs).toISOString(),
          estimatedEndTime: new Date(estimatedEndMs).toISOString(),
          existing: existingPairs.has(key),
          fitsBeforeEnd: estimatedEndMs <= new Date(event.end_time).getTime(),
        });
      });
      globalRoundOffsetMs += Math.max(1, slotsInRound) * durationMs;
    });
  }

  return {
    pairs: preview,
    summary: {
      participantCount,
      matchCount: preview.filter((pair) => !pair.existing && pair.fitsBeforeEnd).length,
      classCount: enabledClasses.length,
      excludedByEndTime: preview.filter((pair) => !pair.fitsBeforeEnd).length,
      duplicateCount: preview.filter((pair) => pair.existing).length,
    },
  };
}

/**
 * League progress: what the round-robin plan promised each player, versus what
 * actually got on a court. The generator slices `roundRobin()` by the event's
 * `league_type` / `league_match_count`, so the promise is derived the same way
 * instead of guessing `min(matchCount, size - 1)` - with an odd class size the
 * circle method hands the byes to particular players, and only in the first few
 * rounds, so a plain formula would blame players who were never scheduled.
 */
export interface LeaguePlanPlayer {
  participantId: string;
  name: string;
  classId: string;
  className: string;
  /** Cards the plan calls for this player, given who is checked in today. */
  target: number;
}

export interface LeaguePlanClass {
  classId: string;
  className: string;
  size: number;
  roundsPlanned: number;
  pairsPlanned: number;
  /** Wall-clock minutes for the whole plan of this class, at the current court count. */
  minutesPlanned: number;
  /** Average minutes a single round of this class costs (rounds are run in order). */
  minutesPerRound: number;
}

export interface LeaguePlan {
  applicable: boolean;
  leagueType: 'FULL_ROUND_ROBIN' | 'LIMITED_ROUND_ROBIN';
  matchCountSetting: number;
  courtCount: number;
  slotMinutes: number;
  classes: LeaguePlanClass[];
  players: LeaguePlanPlayer[];
  plannedMatches: number;
  /** Minutes the whole plan needs if it started now (classes run back to back). */
  plannedMinutes: number;
}

export interface LeaguePlayerProgress extends LeaguePlanPlayer {
  played: number;
  /** Cards that exist for them but are not finished yet. */
  scheduled: number;
  shortfall: number;
}

export interface LeagueClassProgress extends LeaguePlanClass {
  completed: number;
  inFlight: number;
  cancelled: number;
  roundsFinished: number;
  playersUnderTarget: number;
  worstShortfall: number;
}

export type LeagueProgressStatus = 'NOT_APPLICABLE' | 'ON_TRACK' | 'BEHIND' | 'WONT_FIT';

export interface LeagueProgress {
  status: LeagueProgressStatus;
  applicable: boolean;
  phase: string;
  leagueType: 'FULL_ROUND_ROBIN' | 'LIMITED_ROUND_ROBIN';
  matchCountSetting: number;
  courtCount: number;
  slotMinutes: number;
  classCount: number;
  playerCount: number;
  plannedMatches: number;
  completedMatches: number;
  inFlightMatches: number;
  /** 0..1 - how much of the promised league is already on the board. */
  completionRate: number;
  perPlayer: { avg: number; min: number; max: number; target: number };
  playersUnderTarget: number;
  mostMissing: number;
  /** Rounds still outstanding, and the wall-clock minutes they would need. */
  roundsOutstanding: number;
  minutesNeeded: number;
  minutesRemaining: number;
  classes: LeagueClassProgress[];
  /** Only filled in on the detail endpoint: the players the operator should fix. */
  shortfalls: LeaguePlayerProgress[];
}

function leagueEnabled(event: { event_mode: string }): boolean {
  return event.event_mode === 'LEAGUE_REQUEST' || event.event_mode === 'LEAGUE_TOURNAMENT_REQUEST';
}

/** The promise: who plays whom, how many times, and how long that takes. */
export function computeLeaguePlan(db: DB, eventId: string): LeaguePlan | null {
  const event = db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId) as unknown as LeagueEvent & { event_mode: string } | undefined;
  if (!event || !leagueEnabled(event as never)) return null;
  const courtCount = Math.max(1, Number((db.prepare(`SELECT COUNT(*) AS count FROM courts
    WHERE event_id = ? AND enabled = 1 AND status NOT IN ('BLOCKED','MAINTENANCE')`).get(eventId) as { count: number }).count));
  const slotMinutes = Math.max(1, Number(event.default_match_minutes) + Number(event.result_input_grace_minutes)
    + Number(event.safety_margin_minutes));
  const classes = asRows<{ class_id: string; class_name: string }>(db.prepare(`SELECT class_id, class_name FROM classes
    WHERE event_id = ? AND enabled = 1 ORDER BY display_order, class_name`).all(eventId));
  const plan: LeaguePlan = {
    applicable: true,
    leagueType: event.league_type,
    matchCountSetting: Number(event.league_match_count),
    courtCount,
    slotMinutes,
    classes: [],
    players: [],
    plannedMatches: 0,
    plannedMinutes: 0,
  };
  for (const leagueClass of classes) {
    const participants = asRows<{ participant_id: string; name: string; class_id: string }>(db.prepare(`
      SELECT p.participant_id, p.name, p.class_id FROM participants p
      WHERE p.event_id = ? AND p.class_id = ? AND p.active = 1 AND p.checked_in = 1
      ORDER BY p.rating DESC, p.name_kana, p.name`).all(eventId, leagueClass.class_id));
    if (participants.length < 2) {
      plan.classes.push({
        classId: leagueClass.class_id, className: leagueClass.class_name, size: participants.length,
        roundsPlanned: 0, pairsPlanned: 0, minutesPlanned: 0, minutesPerRound: 0,
      });
      for (const player of participants) {
        plan.players.push({
          participantId: player.participant_id, name: player.name, classId: leagueClass.class_id,
          className: leagueClass.class_name, target: 0,
        });
      }
      continue;
    }
    const allRounds = roundRobin(participants);
    const rounds = event.league_type === 'FULL_ROUND_ROBIN'
      ? allRounds
      : allRounds.slice(0, Math.min(Number(event.league_match_count), allRounds.length));
    const targets = new Map<string, number>();
    let pairsPlanned = 0;
    let minutesPlanned = 0;
    for (const round of rounds) {
      pairsPlanned += round.length;
      minutesPlanned += Math.max(1, Math.ceil(round.length / courtCount)) * slotMinutes;
      for (const [a, b] of round) {
        targets.set(a.participant_id, (targets.get(a.participant_id) ?? 0) + 1);
        targets.set(b.participant_id, (targets.get(b.participant_id) ?? 0) + 1);
      }
    }
    for (const player of participants) {
      plan.players.push({
        participantId: player.participant_id, name: player.name, classId: leagueClass.class_id,
        className: leagueClass.class_name, target: targets.get(player.participant_id) ?? 0,
      });
    }
    plan.classes.push({
      classId: leagueClass.class_id, className: leagueClass.class_name, size: participants.length,
      roundsPlanned: rounds.length, pairsPlanned, minutesPlanned,
      minutesPerRound: rounds.length === 0 ? 0 : Math.round(minutesPlanned / rounds.length),
    });
    plan.plannedMatches += pairsPlanned;
    plan.plannedMinutes += minutesPlanned;
  }
  return plan;
}

export function leagueTargets(plan: LeaguePlan | null): Map<string, number> {
  const map = new Map<string, number>();
  for (const player of plan?.players ?? []) map.set(player.participantId, player.target);
  return map;
}

/** Every league card of the event, bucketed per player and per class. Cancelled
 *  cards are excluded from progress; no-shows stay counted, because a walkover is
 *  still a match the player was promised and got. */
function leagueTally(db: DB, eventId: string) {
  const cards = asRows<Record<string, any>>(db.prepare(`SELECT match_id, status, player_a_id, player_b_id, class_id
    FROM matches WHERE event_id = ? AND phase = 'LEAGUE' AND status <> 'CANCELLED'`).all(eventId));
  const played = new Map<string, number>();
  const scheduled = new Map<string, number>();
  const classCards = new Map<string, { completed: number; inFlight: number; cancelled: number }>();
  for (const card of cards) {
    const status = String(card.status);
    // A walkover is over for both sides: the forfeited player still got the card they
    // were promised, so it settles the plan without counting as a played match.
    const settled = status === 'COMPLETED' || status === 'NO_SHOW';
    const tally = classCards.get(String(card.class_id)) ?? { completed: 0, inFlight: 0, cancelled: 0 };
    if (status === 'COMPLETED') tally.completed += 1;
    else if (status !== 'NO_SHOW') tally.inFlight += 1;
    classCards.set(String(card.class_id), tally);
    for (const id of [String(card.player_a_id), String(card.player_b_id)]) {
      if (settled) played.set(id, (played.get(id) ?? 0) + 1);
      else scheduled.set(id, (scheduled.get(id) ?? 0) + 1);
    }
  }
  return { cards, played, scheduled, classCards };
}

export interface LeagueNumbers {
  target: number;
  played: number;
  scheduled: number;
  shortfall: number;
}

/** Per-player league figures for the roster table (消化 / 計画). */
export function leaguePlayerNumbers(db: DB, eventId: string, plan: LeaguePlan | null = computeLeaguePlan(db, eventId)): Map<string, LeagueNumbers> | null {
  if (!plan) return null;
  const { played, scheduled } = leagueTally(db, eventId);
  const map = new Map<string, LeagueNumbers>();
  for (const player of plan.players) {
    const done = played.get(player.participantId) ?? 0;
    const open = scheduled.get(player.participantId) ?? 0;
    map.set(player.participantId, {
      target: player.target, played: done, scheduled: open, shortfall: Math.max(0, player.target - done - open),
    });
  }
  return map;
}

/** Plan versus reality. `options.detail` adds the per-player shortfall list. */
export function buildLeagueProgress(db: DB, eventId: string, options: { detail?: boolean; plan?: LeaguePlan | null; nowMs?: number } = {}): LeagueProgress {
  const plan = options.plan === undefined ? computeLeaguePlan(db, eventId) : options.plan;
  const event = db.prepare('SELECT event_mode, current_phase, status, end_time FROM events WHERE event_id = ?')
    .get(eventId) as { event_mode: string; current_phase: string; status: string; end_time: string } | undefined;
  const nowMs = options.nowMs ?? Date.now();
  const empty: LeagueProgress = {
    status: 'NOT_APPLICABLE', applicable: false, phase: event?.current_phase ?? 'LEAGUE',
    leagueType: 'LIMITED_ROUND_ROBIN', matchCountSetting: 0, courtCount: 0, slotMinutes: 0,
    classCount: 0, playerCount: 0, plannedMatches: 0, completedMatches: 0, inFlightMatches: 0, completionRate: 0,
    perPlayer: { avg: 0, min: 0, max: 0, target: 0 }, playersUnderTarget: 0, mostMissing: 0,
    roundsOutstanding: 0, minutesNeeded: 0, minutesRemaining: 0, classes: [], shortfalls: [],
  };
  if (!plan || !plan.applicable || !event) return empty;

  const { cards, played, scheduled, classCards } = leagueTally(db, eventId);
  const cancelled = asRows<{ class_id: string; count: number }>(db.prepare(`SELECT class_id, COUNT(*) AS count FROM matches
    WHERE event_id = ? AND phase = 'LEAGUE' AND status IN ('CANCELLED','NO_SHOW') GROUP BY class_id`).all(eventId));
  for (const row of cancelled) {
    const tally = classCards.get(String(row.class_id)) ?? { completed: 0, inFlight: 0, cancelled: 0 };
    tally.cancelled += Number(row.count);
    classCards.set(String(row.class_id), tally);
  }

  const players: LeaguePlayerProgress[] = plan.players.map((player) => {
    const done = played.get(player.participantId) ?? 0;
    const open = scheduled.get(player.participantId) ?? 0;
    return { ...player, played: done, scheduled: open, shortfall: Math.max(0, player.target - done - open) };
  });
  const classes: LeagueClassProgress[] = plan.classes.map((entry) => {
    const own = players.filter((player) => player.classId === entry.classId);
    const tally = classCards.get(entry.classId) ?? { completed: 0, inFlight: 0, cancelled: 0 };
    // A round is only "finished" once every card it promised is off the board.
    const perRound = entry.size >= 2 ? Math.floor(entry.size / 2) : 0;
    return {
      ...entry,
      completed: tally.completed,
      inFlight: tally.inFlight,
      cancelled: tally.cancelled,
      roundsFinished: perRound > 0 ? Math.floor(tally.completed / perRound) : 0,
      playersUnderTarget: own.filter((player) => player.shortfall > 0).length,
      worstShortfall: own.reduce((max, player) => Math.max(max, player.shortfall), 0),
    };
  });

  const counts = players.filter((player) => player.target > 0);
  const avg = counts.length === 0 ? 0 : counts.reduce((sum, player) => sum + player.played, 0) / counts.length;
  const roundsOutstanding = classes.reduce((max, entry) => Math.max(max, entry.worstShortfall), 0);
  // What the outstanding rounds cost: classes are scheduled back to back by the engine.
  const minutesNeeded = classes.reduce((sum, entry) => sum + entry.worstShortfall * entry.minutesPerRound, 0);
  const minutesRemaining = Math.max(0, (Date.parse(event.end_time) - nowMs) / 60_000);
  const under = players.filter((player) => player.shortfall > 0).length;
  const completedInPlan = plan.classes.reduce((sum, entry) => sum + Math.min(entry.pairsPlanned,
    (classCards.get(entry.classId) ?? { completed: 0 }).completed), 0);
  const completionRate = plan.plannedMatches === 0
    ? 1 : Number(Math.min(1, completedInPlan / plan.plannedMatches).toFixed(3));
  let status: LeagueProgressStatus = 'ON_TRACK';
  if (under > 0) status = minutesNeeded <= minutesRemaining ? 'BEHIND' : 'WONT_FIT';
  if (plan.plannedMatches === 0) status = 'NOT_APPLICABLE';

  const shortfalls = options.detail
    ? players.filter((player) => player.shortfall > 0)
      .sort((left, right) => right.shortfall - left.shortfall || left.name.localeCompare(right.name, 'ja')).slice(0, 40)
    : [];
  return {
    status,
    applicable: true,
    phase: event.current_phase,
    leagueType: plan.leagueType,
    matchCountSetting: plan.matchCountSetting,
    courtCount: plan.courtCount,
    slotMinutes: plan.slotMinutes,
    classCount: plan.classes.length,
    playerCount: plan.players.length,
    plannedMatches: plan.plannedMatches,
    completedMatches: [...classCards.values()].reduce((sum, tally) => sum + tally.completed, 0),
    inFlightMatches: [...classCards.values()].reduce((sum, tally) => sum + tally.inFlight, 0),
    completionRate,
    perPlayer: {
      avg: Number(avg.toFixed(2)),
      min: counts.length === 0 ? 0 : Math.min(...counts.map((player) => player.played)),
      max: counts.length === 0 ? 0 : Math.max(...counts.map((player) => player.played)),
      target: counts.length === 0 ? 0 : Math.max(...counts.map((player) => player.target)),
    },
    playersUnderTarget: under,
    mostMissing: players.reduce((max, player) => Math.max(max, player.shortfall), 0),
    roundsOutstanding,
    minutesNeeded: Math.round(minutesNeeded),
    minutesRemaining: Math.round(minutesRemaining),
    classes,
    shortfalls,
  };
}
