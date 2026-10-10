import type { DB } from '../server/db.js';
import { makeId, nowIso, pairKey } from '../server/db.js';

export interface TestEvent {
  eventId: string;
  classId: string;
  courtIds: string[];
  players: Record<string, string>;
  startMs: number;
  endMs: number;
}

export interface MakeEventOptions {
  playerNames?: string[];
  courtCount?: number;
  startedMinutesAgo?: number;
  durationMinutes?: number;
  settings?: Record<string, unknown>;
  eventMode?: 'LEAGUE_REQUEST' | 'REQUEST_ONLY' | 'LEAGUE_TOURNAMENT_REQUEST';
}

/** Creates a running event with a class, players and courts for engine tests. */
export async function makeEvent(
  agent: any,
  db: DB,
  options: MakeEventOptions = {},
): Promise<TestEvent> {
  const {
    playerNames = ['A', 'B', 'C', 'D'],
    courtCount = 1,
    startedMinutesAgo = 60,
    durationMinutes = 240,
    settings = {},
    eventMode = 'REQUEST_ONLY',
  } = options;
  const start = new Date(Date.now() - startedMinutesAgo * 60_000);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const created = await agent.post('/api/events').send({
    eventName: `Engine ${Math.random().toString(36).slice(2, 8)}`,
    eventDate: start.toISOString().slice(0, 10),
    venue: 'テスト会場',
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    eventMode,
    maxParticipants: 200,
  }).expect(201);
  const eventId = created.body.data.eventId;
  await agent.post(`/api/events/${eventId}/status`).send({
    status: 'RUNNING', rowVersion: created.body.data.rowVersion,
  }).expect(200);
  if (Object.keys(settings).length) {
    const current = await agent.get(`/api/events/${eventId}`).expect(200);
    await agent.patch(`/api/events/${eventId}`).send({ ...settings, rowVersion: current.body.data.rowVersion }).expect(200);
  }
  const classRow = await agent.post(`/api/events/${eventId}/classes`).send({ className: 'OPEN' }).expect(201);
  const classId = classRow.body.data.classId;

  const players: Record<string, string> = {};
  for (const name of playerNames) {
    const row = await agent.post(`/api/events/${eventId}/participants`).send({
      name, nameKana: name, classId, rating: 1000,
    }).expect(201);
    players[name] = row.body.data.participantId;
  }

  const courtIds: string[] = [];
  for (let index = 1; index <= courtCount; index += 1) {
    const row = await agent.post(`/api/events/${eventId}/courts`).send({
      courtNumber: index, courtName: `COURT ${index}`,
      availableFrom: start.toISOString(), availableTo: end.toISOString(), priority: index,
    }).expect(201);
    courtIds.push(row.body.data.courtId);
  }

  return { eventId, classId, courtIds, players, startMs: start.getTime(), endMs: end.getTime() };
}

/** Records a finished match directly so tests control waiting time and head-to-head history. */
export function seedCompletedMatch(
  db: DB,
  eventId: string,
  playerAId: string,
  playerBId: string,
  options: { endedMinutesAgo?: number; scoreA?: number; scoreB?: number; classId?: string | null } = {},
): string {
  const { endedMinutesAgo = 30, scoreA = 15, scoreB = 10, classId = null } = options;
  const matchId = makeId('match');
  const resultId = makeId('result');
  const end = new Date(Date.now() - endedMinutesAgo * 60_000).toISOString();
  const start = new Date(Date.now() - (endedMinutesAgo + 12) * 60_000).toISOString();
  const winnerId = scoreA > scoreB ? playerAId : playerBId;
  db.prepare(`INSERT INTO matches (
    match_id, event_id, phase, class_id, player_a_id, player_b_id, scheduled_time, called_time, start_time, end_time,
    status, source, priority_score, pair_key, score_a, score_b, winner_id, result_id, created_at, updated_at
  ) VALUES (?, ?, 'LEAGUE', ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', 'AUTO', 0, ?, ?, ?, ?, ?, ?, ?)`)
    .run(matchId, eventId, classId, playerAId, playerBId, start, start, start, end,
      pairKey(playerAId, playerBId), scoreA, scoreB, winnerId, resultId, start, end);
  const enteredBy = (db.prepare('SELECT user_id FROM users ORDER BY created_at LIMIT 1').get() as { user_id?: string } | undefined)?.user_id;
  if (enteredBy) {
    db.prepare(`INSERT INTO results (result_id, match_id, score_a, score_b, winner_id, entered_by, status, entered_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, ?)`).run(resultId, matchId, scoreA, scoreB, winnerId, enteredBy, end, end);
  }
  return matchId;
}

/** Adds a waiting (queue) match without a court. */
export function seedWaitingMatch(db: DB, eventId: string, playerAId: string, playerBId: string, classId: string | null = null): string {
  const matchId = makeId('match');
  const now = nowIso();
  db.prepare(`INSERT INTO matches (
    match_id, event_id, phase, class_id, player_a_id, player_b_id, scheduled_time, status, source,
    priority_score, pair_key, created_at, updated_at
  ) VALUES (?, ?, 'LEAGUE', ?, ?, ?, ?, 'WAITING', 'AUTO', 0, ?, ?, ?)`)
    .run(matchId, eventId, classId, playerAId, playerBId, now, pairKey(playerAId, playerBId), now, now);
  return matchId;
}

export function setRating(db: DB, participantId: string, rating: number): void {
  db.prepare('UPDATE participants SET rating = ?, updated_at = ? WHERE participant_id = ?').run(rating, nowIso(), participantId);
}

export function deactivate(db: DB, participantId: string): void {
  db.prepare('UPDATE participants SET active = 0, updated_at = ? WHERE participant_id = ?').run(nowIso(), participantId);
}

export async function patchEvent(agent: any, eventId: string, settings: Record<string, unknown>): Promise<any> {
  const current = await agent.get(`/api/events/${eventId}`).expect(200);
  const response = await agent.patch(`/api/events/${eventId}`).send({ ...settings, rowVersion: current.body.data.rowVersion });
  if (response.status !== 200) throw new Error(`patchEvent failed ${response.status}: ${JSON.stringify(response.body)}`);
  return response.body.data;
}
