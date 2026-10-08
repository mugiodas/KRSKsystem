import type { DB } from '../db.js';
import { asRows, makeId, nowIso, pairKey, transaction } from '../db.js';
import { ApiError } from '../http.js';

export type MatchStatus = 'WAITING' | 'CALLED' | 'COURT_ASSIGNED' | 'PLAYING' | 'RESULT_PENDING'
  | 'COMPLETED' | 'CANCELLED' | 'DISPUTED' | 'NO_SHOW';

export const OPEN_STATUSES: MatchStatus[] = ['WAITING', 'CALLED', 'COURT_ASSIGNED', 'PLAYING', 'RESULT_PENDING'];
export const BLOCKING_STATUSES: MatchStatus[] = ['CALLED', 'COURT_ASSIGNED', 'PLAYING', 'RESULT_PENDING'];

interface EventSettings {
  event_id: string;
  event_name: string;
  status: string;
  current_phase: string;
  start_time: string;
  end_time: string;
  event_mode: string;
  default_match_minutes: number;
  minimum_rest_minutes: number;
  maximum_rest_minutes: number;
  result_input_grace_minutes: number;
  safety_margin_minutes: number;
  allow_request: number;
  allow_rematch: number;
  allow_same_day_repeat: number;
  auto_court_assignment: number;
  auto_engine_enabled: number;
  weight_request_priority: number;
  weight_waiting: number;
  weight_match_balance: number;
  weight_unplayed: number;
  weight_rating: number;
  weight_time_fit: number;
  penalty_recent: number;
  penalty_repeat: number;
}

interface PlayerState {
  participantId: string;
  name: string;
  classId: string | null;
  className: string | null;
  rating: number;
  played: number;
  wins: number;
  lastEndTime: number | null;
  waitingMinutes: number;
  restReadyAt: number;
}

interface CourtState {
  courtId: string;
  courtNumber: number;
  courtName: string;
  priority: number;
  status: string;
  availableFrom: number;
  availableTo: number;
  busy: boolean;
}

interface QueueMatch {
  matchId: string;
  phase: string;
  classId: string | null;
  playerAId: string;
  playerBId: string;
  scheduledTime: string | null;
  rowVersion: number;
  pairKey: string;
}

interface ActiveRequest {
  requestId: string;
  requesterId: string;
  targetPlayerId: string;
  priority: number;
}

export interface ScoreBreakdown {
  requestPriority: number;
  waitingScore: number;
  matchCountBalance: number;
  unplayedBonus: number;
  ratingCompatibility: number;
  remainingTimeFit: number;
  recentMatchPenalty: number;
  repeatPenalty: number;
  total: number;
  notes: string[];
}

export interface Candidate {
  playerAId: string;
  playerAName: string;
  playerBId: string;
  playerBName: string;
  classId: string | null;
  className: string | null;
  mutual: boolean;
  requestPriority: 1 | 2 | 3 | null;
  repeats: number;
  ratingDiff: number;
  pairWaitingMinutes: number;
  restGapMinutes: number;
  breakdown: ScoreBreakdown;
  score: number;
}

export interface BlockedCandidate extends Omit<Candidate, 'breakdown' | 'score'> {
  reason: string;
  reasonLabel: string;
}

export interface EngineRunResult {
  ranAt: string;
  engineEnabled: boolean;
  phase: string;
  freeCourts: number;
  assignedQueue: Array<{ matchId: string; courtId: string; courtName: string; playerAName: string; playerBName: string }>;
  created: Array<{ matchId: string; courtId: string; courtName: string; playerAName: string; playerBName: string; score: number }>;
  candidates: Candidate[];
  evaluatedPairs: number;
  blocked: BlockedCandidate[];
  blockedCounts: Record<string, number>;
  skippedReasons: Record<string, number>;
  endedByTimeProtection: boolean;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Points awarded to a pair whose waiting time equals the event average.
 * Waiting is scored relative to the field, so the same weights work for a
 * 10 player session and a 100 player session.
 */
export const WAITING_SCALE = 45;

export function loadEventSettings(db: DB, eventId: string): EventSettings {
  const event = asRows<EventSettings>(db.prepare('SELECT * FROM events WHERE event_id = ?').all(eventId));
  if (!event[0]) throw new ApiError(404, 'EVENT_NOT_FOUND', 'イベントが見つかりません。');
  return event[0];
}

export interface EngineContext {
  event: EventSettings;
  nowMs: number;
  endTimeMs: number;
  players: Map<string, PlayerState>;
  courts: CourtState[];
  freeCourts: CourtState[];
  busyPlayerIds: Set<string>;
  busyCourtIds: Set<string>;
  openPairKeys: Set<string>;
  queue: QueueMatch[];
  requests: ActiveRequest[];
  requestMap: Map<string, ActiveRequest[]>;
  headToHead: Map<string, number>;
  maxPlayed: number;
  avgWaitingMinutes: number;
  remainingMinutes: number;
  matchSlotMinutes: number;
  timeProtected: boolean;
}

/**
 * Loads every fact the engine needs in one pass. Keeping this separate from the
 * decision logic makes the engine testable and keeps scoring deterministic.
 */
export function loadEngineContext(db: DB, eventId: string, nowMs = Date.now()): EngineContext {
  const event = loadEventSettings(db, eventId);
  const endTimeMs = new Date(event.end_time).getTime();
  const startMs = new Date(event.start_time).getTime();
  const matchSlotMinutes = Number(event.default_match_minutes)
    + Number(event.result_input_grace_minutes) + Number(event.safety_margin_minutes);
  const remainingMinutes = (endTimeMs - nowMs) / 60_000;

  const participantRows = asRows<{
    participant_id: string; name: string; class_id: string | null; class_name: string | null; rating: number;
  }>(db.prepare(`SELECT p.participant_id, p.name, p.class_id, c.class_name, p.rating
    FROM participants p LEFT JOIN classes c ON c.class_id = p.class_id
    WHERE p.event_id = ? AND p.active = 1 AND p.checked_in = 1
    ORDER BY p.created_at, p.rowid`).all(eventId));

  const finishedRows = asRows<{
    player_a_id: string; player_b_id: string; winner_id: string | null; end_time: string | null; status: string;
  }>(db.prepare(`SELECT player_a_id, player_b_id, winner_id, end_time, status FROM matches
    WHERE event_id = ? AND status IN ('COMPLETED','NO_SHOW','CANCELLED')`).all(eventId));

  const openRows = asRows<{
    match_id: string; player_a_id: string; player_b_id: string; court_id: string | null; status: string;
  }>(db.prepare(`SELECT match_id, player_a_id, player_b_id, court_id, status FROM matches
    WHERE event_id = ? AND status IN ('WAITING','CALLED','COURT_ASSIGNED','PLAYING','RESULT_PENDING')`).all(eventId));

  const busyPlayerIds = new Set<string>();
  const busyCourtIds = new Set<string>();
  const openPairKeys = new Set<string>();
  for (const row of openRows) {
    openPairKeys.add(pairKey(row.player_a_id, row.player_b_id));
    if (BLOCKING_STATUSES.includes(row.status as MatchStatus)) {
      busyPlayerIds.add(row.player_a_id);
      busyPlayerIds.add(row.player_b_id);
      if (row.court_id) busyCourtIds.add(row.court_id);
    }
  }

  const played = new Map<string, number>();
  const wins = new Map<string, number>();
  const lastEnd = new Map<string, number>();
  const headToHead = new Map<string, number>();
  for (const row of finishedRows) {
    const endedAt = row.end_time ? new Date(row.end_time).getTime() : null;
    for (const playerId of [row.player_a_id, row.player_b_id]) {
      if (row.status === 'COMPLETED') {
        played.set(playerId, (played.get(playerId) ?? 0) + 1);
        if (row.winner_id === playerId) wins.set(playerId, (wins.get(playerId) ?? 0) + 1);
      }
      if (endedAt) lastEnd.set(playerId, Math.max(lastEnd.get(playerId) ?? 0, endedAt));
    }
    if (row.status === 'COMPLETED') {
      const key = pairKey(row.player_a_id, row.player_b_id);
      headToHead.set(key, (headToHead.get(key) ?? 0) + 1);
    }
  }

  const restMs = Number(event.minimum_rest_minutes) * 60_000;
  const players = new Map<string, PlayerState>();
  for (const row of participantRows) {
    const last = lastEnd.get(row.participant_id) ?? null;
    const waitingSince = last ?? Math.max(startMs, nowMs - 6 * 3_600_000);
    players.set(row.participant_id, {
      participantId: row.participant_id,
      name: row.name,
      classId: row.class_id,
      className: row.class_name,
      rating: Number(row.rating),
      played: played.get(row.participant_id) ?? 0,
      wins: wins.get(row.participant_id) ?? 0,
      lastEndTime: last,
      waitingMinutes: Math.max(0, (nowMs - waitingSince) / 60_000),
      restReadyAt: last ? last + restMs : 0,
    });
  }

  const courtRows = asRows<{
    court_id: string; court_number: number; court_name: string; priority: number; status: string;
    available_from: string; available_to: string; enabled: number;
  }>(db.prepare(`SELECT * FROM courts WHERE event_id = ? ORDER BY priority, court_number`).all(eventId));
  const courts: CourtState[] = courtRows
    .filter((court) => court.enabled === 1 && court.status !== 'BLOCKED' && court.status !== 'MAINTENANCE')
    .map((court) => ({
      courtId: court.court_id,
      courtNumber: Number(court.court_number),
      courtName: court.court_name,
      priority: Number(court.priority),
      status: court.status,
      availableFrom: new Date(court.available_from).getTime(),
      availableTo: new Date(court.available_to).getTime(),
      busy: busyCourtIds.has(court.court_id),
    }));
  const freeCourts = courts.filter((court) => !court.busy && court.availableFrom <= nowMs && court.availableTo >= nowMs + Number(event.default_match_minutes) * 60_000);

  const queue = asRows<{
    match_id: string; phase: string; class_id: string | null; player_a_id: string; player_b_id: string;
    scheduled_time: string | null; row_version: number; pair_key: string | null;
  }>(db.prepare(`SELECT match_id, phase, class_id, player_a_id, player_b_id, scheduled_time, row_version, pair_key
    FROM matches WHERE event_id = ? AND status = 'WAITING' ORDER BY COALESCE(scheduled_time, created_at), created_at`).all(eventId))
    .filter((row) => !busyPlayerIds.has(row.player_a_id) && !busyPlayerIds.has(row.player_b_id))
    .map((row) => ({
      matchId: row.match_id, phase: row.phase, classId: row.class_id, playerAId: row.player_a_id,
      playerBId: row.player_b_id, scheduledTime: row.scheduled_time, rowVersion: Number(row.row_version),
      pairKey: row.pair_key ?? pairKey(row.player_a_id, row.player_b_id),
    }));

  const requests = asRows<ActiveRequest>(db.prepare(`SELECT request_id AS requestId, requester_id AS requesterId,
    target_player_id AS targetPlayerId, priority FROM match_requests WHERE event_id = ? AND status = 'ACTIVE'`).all(eventId))
    .map((request) => ({ ...request, priority: Number(request.priority) }));
  const requestMap = new Map<string, ActiveRequest[]>();
  for (const request of requests) {
    const key = pairKey(request.requesterId, request.targetPlayerId);
    requestMap.set(key, [...(requestMap.get(key) ?? []), request]);
  }

  const maxPlayed = Math.max(1, ...[...players.values()].map((player) => player.played));
  const idle = [...players.values()].filter((player) => !busyPlayerIds.has(player.participantId));
  const avgWaitingMinutes = idle.length
    ? idle.reduce((sum, player) => sum + player.waitingMinutes, 0) / idle.length
    : 0;

  return {
    event, nowMs, endTimeMs, players, courts, freeCourts, busyPlayerIds, busyCourtIds, openPairKeys, queue,
    requests: [...requestMap.values()].flat(), requestMap, headToHead, maxPlayed, avgWaitingMinutes,
    remainingMinutes, matchSlotMinutes, timeProtected: remainingMinutes < matchSlotMinutes,
  };
}

export interface HardConstraintResult { ok: boolean; reason?: string; reasonLabel?: string }

/** Spec 28: hard constraints are evaluated before any scoring happens. */
export interface ConstraintOptions {
  /** True when validating a match that already exists in the queue. */
  ignoreOpenPair?: boolean;
  /** True when the operator explicitly overrides rest or court availability. */
  force?: boolean;
}

export function checkHardConstraints(
  ctx: EngineContext, playerA: PlayerState, playerB: PlayerState, options: ConstraintOptions = {},
): HardConstraintResult {
  if (!playerA || !playerB) return { ok: false, reason: 'PLAYER_MISSING', reasonLabel: '選手データが見つかりません' };
  if (playerA.participantId === playerB.participantId) return { ok: false, reason: 'SAME_PLAYER', reasonLabel: '同一選手' };
  if (ctx.busyPlayerIds.has(playerA.participantId) || ctx.busyPlayerIds.has(playerB.participantId)) {
    return { ok: false, reason: 'PLAYER_IN_MATCH', reasonLabel: '試合中' };
  }
  const restGap = Math.max(ctx.nowMs - playerA.restReadyAt, ctx.nowMs - playerB.restReadyAt);
  if (restGap < 0 && !options.force) return { ok: false, reason: 'REST_REQUIRED', reasonLabel: '休憩中' };
  if (ctx.timeProtected) return { ok: false, reason: 'END_TIME_PROTECTED', reasonLabel: '終了時刻保護' };
  if (!ctx.freeCourts.length) return { ok: false, reason: 'NO_FREE_COURT', reasonLabel: '空きコートなし' };
  const repeats = ctx.headToHead.get(pairKey(playerA.participantId, playerB.participantId)) ?? 0;
  const hasRequest = (ctx.requestMap.get(pairKey(playerA.participantId, playerB.participantId)) ?? []).length > 0;
  if (repeats > 0 && !hasRequest && !ctx.event.allow_rematch) {
    return { ok: false, reason: 'REMATCH_NOT_ALLOWED', reasonLabel: '再戦不可設定' };
  }
  if (repeats > 0 && !hasRequest && !ctx.event.allow_same_day_repeat) {
    return { ok: false, reason: 'SAME_DAY_REPEAT_BLOCKED', reasonLabel: '当日再戦不可' };
  }
  if (!options.ignoreOpenPair && ctx.openPairKeys.has(pairKey(playerA.participantId, playerB.participantId))) {
    return { ok: false, reason: 'ALREADY_QUEUED', reasonLabel: '待機試合あり' };
  }
  return { ok: true };
}

function requestFactor(priority: number): number {
  return priority === 1 ? 1 : priority === 2 ? 0.62 : 0.34;
}

/** Spec 19-27: weighted, fully configurable scoring of one candidate pair. */
export function scoreCandidate(ctx: EngineContext, playerA: PlayerState, playerB: PlayerState): { score: number; breakdown: ScoreBreakdown } {
  const { event } = ctx;
  const notes: string[] = [];
  const key = pairKey(playerA.participantId, playerB.participantId);
  const pairRequests = ctx.requestMap.get(key) ?? [];
  const mutual = pairRequests.length >= 2
    && pairRequests.some((r) => r.requesterId === playerA.participantId)
    && pairRequests.some((r) => r.requesterId === playerB.participantId);
  const bestPriority = pairRequests.length ? Math.min(...pairRequests.map((r) => r.priority)) : null;

  const requestPriority = pairRequests.reduce((total, request) => total + event.weight_request_priority * requestFactor(request.priority), 0)
    + (mutual ? event.weight_request_priority * 0.45 : 0);
  if (pairRequests.length) notes.push(mutual ? '双方の対戦希望' : `対戦希望 P${bestPriority}`);

  const pairWaiting = (playerA.waitingMinutes + playerB.waitingMinutes) / 2;
  const waitingRatio = (minutes: number): number => clamp(minutes / Math.max(1, ctx.avgWaitingMinutes), 0, 3);
  const ratioA = waitingRatio(playerA.waitingMinutes);
  const ratioB = waitingRatio(playerB.waitingMinutes);
  // Relative to the field, so a 100 player event rotates as fairly as a 10 player one.
  const waitingScore = event.weight_waiting * WAITING_SCALE
    * (0.6 * (ratioA + ratioB) / 2 + 0.4 * Math.max(ratioA, ratioB));
  if (pairWaiting >= 20) notes.push(`待ち ${Math.round(pairWaiting)}分（平均比 ${Math.max(ratioA, ratioB).toFixed(2)}）`);

  const deficit = (2 * ctx.maxPlayed - playerA.played - playerB.played) / (2 * ctx.maxPlayed);
  const closeness = 1 - Math.abs(playerA.played - playerB.played) / ctx.maxPlayed;
  const matchCountBalance = event.weight_match_balance * (deficit * 0.7 + closeness * 0.3);
  if (deficit > 0.25) notes.push(`試合数 ${playerA.played}/${playerB.played}`);

  const repeats = ctx.headToHead.get(key) ?? 0;
  const unplayedBonus = repeats === 0 ? event.weight_unplayed : event.weight_unplayed * Math.max(0, 1 - repeats * 0.45);
  if (repeats === 0) notes.push('未対戦');

  const ratingDiff = Math.abs(playerA.rating - playerB.rating);
  const ratingExcess = Math.max(0, ratingDiff - 120) / 300;
  const ratingCompatibility = event.weight_rating * (1 - clamp(ratingExcess, 0, 1));
  if (ratingDiff > 200) notes.push(`実力差 ${ratingDiff}`);

  const urgency = clamp(45 / Math.max(5, ctx.remainingMinutes), 0.35, 1);
  const restGapMinutes = Math.max(
    0, (Math.max(playerA.restReadyAt, playerB.restReadyAt) - ctx.nowMs) / 60_000,
  );
  const remainingTimeFit = event.weight_time_fit * (1 - clamp(restGapMinutes / 15, 0, 1)) * urgency;
  if (ctx.remainingMinutes < 60) notes.push(`残り ${Math.round(ctx.remainingMinutes)}分`);

  const recentFor = (player: PlayerState): number => {
    if (!player.lastEndTime) return 0;
    const since = ctx.nowMs - player.lastEndTime;
    const window = Math.max(1, event.minimum_rest_minutes * 2.2) * 60_000;
    return since < window ? event.penalty_recent * (1 - since / window) : 0;
  };
  const recentMatchPenalty = recentFor(playerA) + recentFor(playerB);
  if (recentMatchPenalty > event.penalty_recent * 0.4) notes.push('直後の再戦');

  const strongRequest = pairRequests.some((r) => r.priority === 1);
  const repeatPenalty = repeats === 0 ? 0
    : event.penalty_repeat * Math.min(3, repeats) * (strongRequest ? 0 : 0.85) * (mutual ? 0.55 : 1);
  if (repeats > 0) notes.push(`${repeats}回目の再戦`);

  const total = requestPriority + waitingScore + matchCountBalance + unplayedBonus + ratingCompatibility
    + remainingTimeFit - recentMatchPenalty - repeatPenalty;

  return {
    score: Number(total.toFixed(4)),
    breakdown: {
      requestPriority: round(requestPriority), waitingScore: round(waitingScore),
      matchCountBalance: round(matchCountBalance), unplayedBonus: round(unplayedBonus),
      ratingCompatibility: round(ratingCompatibility), remainingTimeFit: round(remainingTimeFit),
      recentMatchPenalty: round(recentMatchPenalty), repeatPenalty: round(repeatPenalty),
      total: round(total), notes,
    },
  };
}

const round = (value: number): number => Number(value.toFixed(3));

export interface EvaluateOptions {
  /** Maximum pairs reported back to the caller; assignment itself sees every feasible pair. */
  maxPairs?: number;
  /** Restrict to one class when the operator runs a class-scoped engine pass. */
  classId?: string | null;
}

/**
 * Player level starvation order. It never decides a match on its own; it only
 * bounds how many participants enter the O(n^2) pair scoring so a 200 player
 * event still responds instantly. The most starved players are always kept.
 */
export function starvationRank(ctx: EngineContext, player: PlayerState): number {
  const hasRequest = ctx.requests.some((request) => request.requesterId === player.participantId
    || request.targetPlayerId === player.participantId);
  const deficit = (ctx.maxPlayed - player.played) / ctx.maxPlayed;
  return player.waitingMinutes + deficit * 30 + (hasRequest ? 8 : 0);
}

export function poolLimitFor(ctx: EngineContext): number {
  return Math.min(160, Math.max(48, ctx.freeCourts.length * 10));
}

export function evaluateCandidates(
  ctx: EngineContext,
  options: EvaluateOptions = {},
): {
  candidates: Candidate[]; blocked: BlockedCandidate[]; blockedCounts: Record<string, number>;
  eligible: PlayerState[]; reportLimit: number;
} {
  const eligibleAll = [...ctx.players.values()].filter((player) => !ctx.busyPlayerIds.has(player.participantId))
    .filter((player) => !options.classId || player.classId === options.classId);
  const poolLimit = poolLimitFor(ctx);
  const eligible = eligibleAll.length > poolLimit
    ? [...eligibleAll].sort((left, right) => starvationRank(ctx, right) - starvationRank(ctx, left)
        || right.waitingMinutes - left.waitingMinutes
        || left.participantId.localeCompare(right.participantId)).slice(0, poolLimit)
    : eligibleAll;
  const candidates: Candidate[] = [];
  const blocked: BlockedCandidate[] = [];
  const blockedReasons = new Map<string, number>();

  for (let i = 0; i < eligible.length; i += 1) {
    for (let j = i + 1; j < eligible.length; j += 1) {
      const a = eligible[i];
      const b = eligible[j];
      const constraint = checkHardConstraints(ctx, a, b);
      if (!constraint.ok) {
        const reason = constraint.reason ?? 'BLOCKED';
        blockedReasons.set(reason, (blockedReasons.get(reason) ?? 0) + 1);
        if (reason !== 'ALREADY_QUEUED' && reason !== 'PLAYER_IN_MATCH' && blocked.length < 60) {
          blocked.push(describePair(ctx, a, b, reason, constraint.reasonLabel ?? reason));
        }
        continue;
      }
      const { score, breakdown } = scoreCandidate(ctx, a, b);
      candidates.push({ ...describePairBase(ctx, a, b), breakdown, score });
    }
  }

  candidates.sort((left, right) => right.score - left.score
    || right.pairWaitingMinutes - left.pairWaitingMinutes
    || left.playerAId.localeCompare(right.playerAId) || left.playerBId.localeCompare(right.playerBId));

  const blockedCounts: Record<string, number> = {};
  for (const [reason, count] of blockedReasons) blockedCounts[reason] = count;
  return {
    candidates,
    blocked: blocked.sort((l, r) => r.pairWaitingMinutes - l.pairWaitingMinutes).slice(0, 25),
    blockedCounts,
    eligible,
    reportLimit: options.maxPairs ?? 40,
  };
}

function describePairBase(ctx: EngineContext, a: PlayerState, b: PlayerState) {
  const key = pairKey(a.participantId, b.participantId);
  const pairRequests = ctx.requestMap.get(key) ?? [];
  const mutual = pairRequests.length >= 2;
  return {
    playerAId: a.participantId, playerAName: a.name, playerBId: b.participantId, playerBName: b.name,
    classId: a.classId, className: a.className, mutual,
    requestPriority: (pairRequests.length ? Math.min(...pairRequests.map((r) => r.priority)) : null) as 1 | 2 | 3 | null,
    repeats: ctx.headToHead.get(key) ?? 0,
    ratingDiff: Math.abs(a.rating - b.rating),
    pairWaitingMinutes: Number(((a.waitingMinutes + b.waitingMinutes) / 2).toFixed(1)),
    restGapMinutes: Number((Math.max(0, (Math.max(a.restReadyAt, b.restReadyAt) - ctx.nowMs) / 60_000)).toFixed(1)),
  };
}

function describePair(ctx: EngineContext, a: PlayerState, b: PlayerState, reason: string, reasonLabel: string): BlockedCandidate {
  return { ...describePairBase(ctx, a, b), reason, reasonLabel };
}

export interface RunEngineOptions extends EvaluateOptions {
  dryRun?: boolean;
  actorId?: string | null;
  force?: boolean;
  /** Virtual clock; lets tests and simulations replay an event timeline. */
  nowMs?: number;
}

/**
 * Spec 29 + 30: one engine pass. Assigns already-queued matches to free courts
 * first, then creates new REQUEST-phase matches from the best scoring candidates.
 */
export function runEngine(db: DB, eventId: string, options: RunEngineOptions = {}): EngineRunResult {
  const nowMs = options.nowMs ?? Date.now();
  const ctx = loadEngineContext(db, eventId, nowMs);
  const dryRun = options.dryRun === true;
  const { candidates, blocked, blockedCounts, reportLimit } = evaluateCandidates(ctx, options);
  const skippedReasons: Record<string, number> = {};
  const assignedQueue: EngineRunResult['assignedQueue'] = [];
  const created: EngineRunResult['created'] = [];

  if (ctx.event.status === 'COMPLETED' || ctx.event.status === 'CANCELLED') {
    skippedReasons.EVENT_CLOSED = 1;
    return finish(ctx, dryRun, assignedQueue, created, candidates, blocked, blockedCounts, skippedReasons, reportLimit);
  }
  if (!ctx.event.auto_engine_enabled && !options.force) {
    skippedReasons.ENGINE_DISABLED = 1;
    return finish(ctx, dryRun, assignedQueue, created, candidates, blocked, blockedCounts, skippedReasons, reportLimit);
  }
  if (!ctx.event.auto_court_assignment && !options.force) {
    skippedReasons.AUTO_ASSIGN_DISABLED = 1;
    return finish(ctx, dryRun, assignedQueue, created, candidates, blocked, blockedCounts, skippedReasons, reportLimit);
  }

  const usedCourtIds = new Set<string>();
  const usedPlayerIds = new Set<string>();
  const usedPairKeys = new Set<string>();
  const stamp = new Date(nowMs).toISOString();

  const pickCourt = (): CourtState | undefined => ctx.freeCourts.find((court) => !usedCourtIds.has(court.courtId));

  // 1) Queue first: pre-generated league matches must not starve request matches.
  const queuedOrder = [...ctx.queue]
    .filter((match) => ctx.players.has(match.playerAId) && ctx.players.has(match.playerBId))
    .sort((left, right) => {
      const waitOf = (match: QueueMatch): number => Math.max(
        ctx.players.get(match.playerAId)?.waitingMinutes ?? 0,
        ctx.players.get(match.playerBId)?.waitingMinutes ?? 0,
      );
      return waitOf(right) - waitOf(left)
        || new Date(left.scheduledTime ?? 0).getTime() - new Date(right.scheduledTime ?? 0).getTime();
    });

  if (!dryRun) {
    transaction(db, () => {
      for (const match of queuedOrder) {
        const court = pickCourt();
        if (!court) break;
        const a = ctx.players.get(match.playerAId);
        const b = ctx.players.get(match.playerBId);
        if (!a || !b || usedPlayerIds.has(a.participantId) || usedPlayerIds.has(b.participantId)) continue;
        if (!checkHardConstraints(ctx, a, b, { ignoreOpenPair: true }).ok) {
          skippedReasons.QUEUE_CONSTRAINT = (skippedReasons.QUEUE_CONSTRAINT ?? 0) + 1;
          continue;
        }
        const changed = db.prepare(`UPDATE matches SET status = 'COURT_ASSIGNED', court_id = ?, scheduled_time = ?,
          called_time = ?, pair_key = ?, source = CASE WHEN source = 'MANUAL' THEN 'MANUAL' ELSE 'AUTO' END,
          updated_at = ?, row_version = row_version + 1 WHERE match_id = ? AND status = 'WAITING' AND row_version = ?`)
          .run(court.courtId, stamp, stamp, match.pairKey, stamp, match.matchId, match.rowVersion);
        if (Number(changed.changes) === 0) {
          skippedReasons.QUEUE_CONFLICT = (skippedReasons.QUEUE_CONFLICT ?? 0) + 1;
          continue;
        }
        db.prepare(`UPDATE courts SET status = 'CALLING', updated_at = ?, row_version = row_version + 1 WHERE court_id = ?`)
          .run(stamp, court.courtId);
        usedCourtIds.add(court.courtId);
        usedPlayerIds.add(a.participantId);
        usedPlayerIds.add(b.participantId);
        usedPairKeys.add(match.pairKey);
        assignedQueue.push({ matchId: match.matchId, courtId: court.courtId, courtName: court.courtName, playerAName: a.name, playerBName: b.name });
      }

      // 2) Request phase: create new matches from the ranked candidates.
      // While a bracket is open the draw owns the floor: courts go to its queue only,
      // so a free-for-all request card can never steal a semi-final's court.
      const openBrackets = Number((db.prepare(`SELECT COUNT(*) AS total FROM tournament_brackets
        WHERE event_id = ? AND status = 'OPEN'`).get(eventId) as { total: number }).total);
      const bracketOpen = ctx.event.current_phase === 'TOURNAMENT' && openBrackets > 0;
      const canCreateRequests = ctx.event.allow_request === 1 && !bracketOpen
        && (ctx.event.event_mode !== 'LEAGUE_REQUEST' || ctx.event.current_phase === 'REQUEST' || ctx.queue.length === 0);
      if (canCreateRequests) {
        for (const candidate of candidates) {
          const court = pickCourt();
          if (!court) break;
          if (usedPlayerIds.has(candidate.playerAId) || usedPlayerIds.has(candidate.playerBId)) continue;
          const key = pairKey(candidate.playerAId, candidate.playerBId);
          if (usedPairKeys.has(key)) continue;
          const a = ctx.players.get(candidate.playerAId);
          const b = ctx.players.get(candidate.playerBId);
          if (!a || !b) continue;
          if (!checkHardConstraints(ctx, a, b).ok) continue;

          const matchId = makeId('match');
          db.prepare(`INSERT INTO matches (
            match_id, event_id, phase, class_id, player_a_id, player_b_id, scheduled_time, called_time,
            court_id, status, source, priority_score, pair_key, score_breakdown, created_by, created_at, updated_at
          ) VALUES (?, ?, 'REQUEST', ?, ?, ?, ?, ?, ?, 'COURT_ASSIGNED', ?, ?, ?, ?, ?, ?, ?)`)
            .run(matchId, eventId, candidate.classId, candidate.playerAId, candidate.playerBId, stamp, stamp,
              court.courtId, candidate.requestPriority ? 'REQUEST' : 'AUTO', candidate.score, key,
              JSON.stringify(candidate.breakdown), options.actorId ?? null, stamp, stamp);
          db.prepare(`UPDATE courts SET status = 'CALLING', updated_at = ?, row_version = row_version + 1 WHERE court_id = ?`)
            .run(stamp, court.courtId);
          if (candidate.requestPriority) {
            db.prepare(`UPDATE match_requests SET status = 'MATCHED', matched_match_id = ?, updated_at = ?, row_version = row_version + 1
              WHERE event_id = ? AND status = 'ACTIVE' AND ((requester_id = ? AND target_player_id = ?) OR (requester_id = ? AND target_player_id = ?))`)
              .run(matchId, stamp, eventId, candidate.playerAId, candidate.playerBId, candidate.playerBId, candidate.playerAId);
          }
          usedCourtIds.add(court.courtId);
          usedPlayerIds.add(candidate.playerAId);
          usedPlayerIds.add(candidate.playerBId);
          usedPairKeys.add(key);
          created.push({ matchId, courtId: court.courtId, courtName: court.courtName, playerAName: a.name, playerBName: b.name, score: candidate.score });
        }
      } else if (bracketOpen) {
        skippedReasons.BRACKET_OPEN = 1;
      } else if (ctx.event.allow_request === 0) {
        skippedReasons.REQUEST_DISABLED = 1;
      }
    });
  } else {
    for (const candidate of candidates) {
      if (usedPlayerIds.has(candidate.playerAId) || usedPlayerIds.has(candidate.playerBId)) continue;
      const court = pickCourt();
      if (!court) break;
      usedCourtIds.add(court.courtId);
      usedPlayerIds.add(candidate.playerAId);
      usedPlayerIds.add(candidate.playerBId);
      created.push({
        matchId: 'dry-run', courtId: court.courtId, courtName: court.courtName,
        playerAName: candidate.playerAName, playerBName: candidate.playerBName, score: candidate.score,
      });
    }
  }

  return finish(ctx, dryRun, assignedQueue, created, candidates, blocked, blockedCounts, skippedReasons, reportLimit);
}

function finish(
  ctx: EngineContext, dryRun: boolean,
  assignedQueue: EngineRunResult['assignedQueue'], created: EngineRunResult['created'],
  candidates: Candidate[], blocked: BlockedCandidate[], blockedCounts: Record<string, number>,
  skippedReasons: Record<string, number>, reportLimit = 12,
): EngineRunResult {
  if (ctx.timeProtected) skippedReasons.END_TIME_PROTECTED = (skippedReasons.END_TIME_PROTECTED ?? 0) + 1;
  if (!ctx.freeCourts.length) skippedReasons.NO_FREE_COURT = (skippedReasons.NO_FREE_COURT ?? 0) + 1;
  return {
    ranAt: new Date(ctx.nowMs).toISOString(),
    engineEnabled: ctx.event.auto_engine_enabled === 1,
    phase: ctx.event.current_phase,
    freeCourts: ctx.freeCourts.length,
    assignedQueue: dryRun ? [] : assignedQueue,
    created,
    evaluatedPairs: candidates.length,
    candidates: candidates.slice(0, Math.min(reportLimit, 12)),
    blocked: blocked.slice(0, 10),
    blockedCounts,
    skippedReasons,
    endedByTimeProtection: ctx.timeProtected,
  };
}
