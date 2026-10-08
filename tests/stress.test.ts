import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createDatabase, makeId, nowIso, type DB } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { createApp } from '../server/app.js';
import { runEngine } from '../server/services/matching.js';
import { normalizeName } from '../server/seed.js';
import { runIntegrityChecks } from '../server/services/integrity.js';

let db: DB;
let agent: TestAgent;
let ownerId: string;

beforeAll(async () => {
  db = createDatabase(':memory:');
  seedDatabase(db);
  agent = request.agent(createApp(db));
  await agent.post('/api/auth/login').send({ email: 'owner@krsk.local', password: 'krsk-demo' }).expect(200);
  ownerId = (db.prepare("SELECT user_id FROM users WHERE role = 'OWNER' LIMIT 1").get() as { user_id: string }).user_id;
});

afterAll(() => db.close());

interface Scenario {
  participants: number;
  courts: number;
  durationMinutes: number;
  matchMinutes: number;
  tickMinutes: number;
  requestRatio?: number;
}

interface SimResult {
  created: number;
  passes: number;
  filledPasses: number;
  minPlayed: number;
  maxPlayed: number;
  avgPlayed: number;
  maxWaitingMinutes: number;
  courtUtilization: number;
  requestFulfillmentRate: number;
  slowestPassMs: number;
  violations: string[];
}

function createScenarioEvent(scenario: Scenario): { eventId: string; classId: string; startMs: number; endMs: number } {
  const startMs = Date.now();
  const endMs = startMs + scenario.durationMinutes * 60_000;
  const eventId = makeId('evt');
  const now = nowIso();
  db.prepare(`INSERT INTO events (
    event_id, event_name, event_date, venue, start_time, end_time, status, event_mode, current_phase,
    max_participants, entry_fee, description, default_match_minutes, minimum_rest_minutes, created_at, updated_at, created_by
  ) VALUES (?, ?, ?, ?, ?, ?, 'RUNNING', 'REQUEST_ONLY', 'REQUEST', ?, 0, 'stress', ?, 5, ?, ?, ?)`)
    .run(eventId, `STRESS ${scenario.participants}p/${scenario.courts}c`, new Date(startMs).toISOString().slice(0, 10),
      'ストレス会場', new Date(startMs).toISOString(), new Date(endMs).toISOString(), scenario.participants,
      scenario.matchMinutes, now, now, ownerId);

  const classId = makeId('cls');
  db.prepare(`INSERT INTO classes (class_id, event_id, class_name, display_order, enabled, created_at, updated_at)
    VALUES (?, ?, 'OPEN', 1, 1, ?, ?)`).run(classId, eventId, now, now);

  const insert = db.prepare(`INSERT INTO participants (
    participant_id, event_id, name, name_normalized, name_kana, club, grade, gender, category, class_id, rating,
    active, checked_in, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'UNSPECIFIED', 'SINGLES', ?, ?, 1, 1, ?, ?)`);
  for (let index = 0; index < scenario.participants; index += 1) {
    const name = `選手${String(index + 1).padStart(3, '0')}`;
    insert.run(makeId('ptc'), eventId, name, normalizeName(name), name, `club${index % 7}`, `${(index % 6) + 1}年`,
      classId, 900 + (index % 12) * 50, now, now);
  }

  const courtInsert = db.prepare(`INSERT INTO courts (
    court_id, event_id, court_number, court_name, status, available_from, available_to, priority, enabled, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'AVAILABLE', ?, ?, ?, 1, ?, ?)`);
  for (let index = 1; index <= scenario.courts; index += 1) {
    courtInsert.run(makeId('court'), eventId, index, `COURT ${index}`, new Date(startMs).toISOString(),
      new Date(endMs).toISOString(), index, now, now);
  }

  if (scenario.requestRatio) {
    const players = (db.prepare('SELECT participant_id FROM participants WHERE event_id = ? ORDER BY rowid').all(eventId) as Array<{ participant_id: string }>);
    const requestInsert = db.prepare(`INSERT INTO match_requests (
      request_id, event_id, requester_id, target_player_id, priority, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`);
    const wanted = Math.floor(players.length * scenario.requestRatio);
    for (let index = 0; index < wanted; index += 1) {
      const requester = players[index];
      const target = players[(index * 7 + 3) % players.length];
      if (requester.participant_id === target.participant_id) continue;
      requestInsert.run(makeId('req'), eventId, requester.participant_id, target.participant_id, (index % 3) + 1, now, now);
    }
  }

  return { eventId, classId, startMs, endMs };
}

function checkInvariants(eventId: string): string[] {
  return runIntegrityChecks(db, eventId).violations.map((violation) => `${violation.code}:${violation.count}`);
}

function simulate(scenario: Scenario): SimResult {
  const { eventId, startMs, endMs } = createScenarioEvent(scenario);
  const slotMinutes = scenario.matchMinutes + 3 + 5;
  const violations: string[] = [];
  let now = startMs;
  let created = 0;
  let passes = 0;
  let filledPasses = 0;
  let maxWaiting = 0;
  let slowestPassMs = 0;
  let playedMinutes = 0;

  // Finish matches the way the API does — result row plus result_id pointer —
  // otherwise the shared integrity rules are right to report half written rows.
  const openIds = db.prepare(`SELECT match_id, player_a_id FROM matches
    WHERE event_id = ? AND status = 'COURT_ASSIGNED'`);
  const insertResult = db.prepare(`INSERT INTO results (result_id, match_id, score_a, score_b, winner_id, entered_by, status, entered_at, updated_at)
    VALUES (?, ?, 15, 11, ?, ?, 'ENTERED', ?, ?)`);
  const completeOne = db.prepare(`UPDATE matches SET status = 'COMPLETED', score_a = 15, score_b = 11,
    winner_id = player_a_id, result_id = ?, end_time = ?, updated_at = ? WHERE match_id = ?`);

  while (now <= endMs - slotMinutes * 60_000) {
    const startedAt = Date.now();
    const result = runEngine(db, eventId, { nowMs: now });
    slowestPassMs = Math.max(slowestPassMs, Date.now() - startedAt);
    passes += 1;
    created += result.created.length;
    if (result.created.length > 0) filledPasses += 1;
    playedMinutes += result.created.length * scenario.matchMinutes;
    violations.push(...checkInvariants(eventId));

    const rows = db.prepare(`SELECT p.participant_id,
      (SELECT MAX(m.end_time) FROM matches m WHERE m.event_id = p.event_id AND m.status = 'COMPLETED'
        AND p.participant_id IN (m.player_a_id, m.player_b_id)) AS last_end
      FROM participants p WHERE p.event_id = ? AND p.active = 1`).all(eventId) as Array<{ last_end: string | null }>;
    for (const row of rows) {
      const since = row.last_end ? (now - new Date(row.last_end).getTime()) / 60_000 : (now - startMs) / 60_000;
      maxWaiting = Math.max(maxWaiting, since);
    }

    const stamp = new Date(now + scenario.matchMinutes * 60_000).toISOString();
    for (const row of openIds.all(eventId) as Array<{ match_id: string; player_a_id: string }>) {
      const resultId = makeId('result');
      insertResult.run(resultId, row.match_id, row.player_a_id, ownerId, stamp, stamp);
      completeOne.run(resultId, stamp, stamp, row.match_id);
    }
    db.prepare(`UPDATE courts SET status = 'AVAILABLE' WHERE event_id = ?`).run(eventId);
    now += scenario.tickMinutes * 60_000;
  }

  const played = (db.prepare(`SELECT p.participant_id,
    (SELECT COUNT(*) FROM matches m WHERE m.event_id = p.event_id AND m.status = 'COMPLETED'
      AND p.participant_id IN (m.player_a_id, m.player_b_id)) AS played
    FROM participants p WHERE p.event_id = ? AND p.active = 1`).all(eventId) as Array<{ played: number }>).map((row) => Number(row.played));
  const totalPlayed = played.reduce((sum, value) => sum + value, 0);
  const courtMinutes = scenario.courts * ((endMs - startMs) / 60_000);
  const requests = db.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN status = 'MATCHED' THEN 1 ELSE 0 END) AS matched FROM match_requests WHERE event_id = ?`).get(eventId) as { total: number; matched: number | null };

  return {
    created, passes, filledPasses,
    minPlayed: Math.min(...played), maxPlayed: Math.max(...played),
    avgPlayed: Number((totalPlayed / played.length).toFixed(2)),
    maxWaitingMinutes: Number(maxWaiting.toFixed(1)),
    courtUtilization: Number((playedMinutes / courtMinutes).toFixed(3)),
    requestFulfillmentRate: Number(requests.total) === 0 ? 1 : Number(((Number(requests.matched ?? 0) / Number(requests.total))).toFixed(3)),
    slowestPassMs,
    violations: [...new Set(violations)],
  };
}

/**
 * Waiting time cannot go below the rotation the court capacity allows:
 * every tick puts 2 x courts players on court, and the rest rule costs one tick.
 */
function rotationBoundMinutes(scenario: Scenario): number {
  const slotsPerTick = scenario.courts * 2;
  const rotationTicks = Math.ceil(scenario.participants / slotsPerTick) + 1;
  return rotationTicks * scenario.tickMinutes;
}

describe('Phase 3: stress and fairness (spec 43)', () => {
  const scenarios: Scenario[] = [
    { participants: 10, courts: 2, durationMinutes: 120, matchMinutes: 12, tickMinutes: 13 },
    { participants: 20, courts: 4, durationMinutes: 180, matchMinutes: 15, tickMinutes: 16 },
    { participants: 40, courts: 4, durationMinutes: 240, matchMinutes: 15, tickMinutes: 16 },
    { participants: 60, courts: 6, durationMinutes: 240, matchMinutes: 15, tickMinutes: 16 },
    { participants: 100, courts: 8, durationMinutes: 240, matchMinutes: 15, tickMinutes: 16, requestRatio: 0.4 },
  ];

  it.each(scenarios)('runs $participants participants on $courts courts without operator input', (scenario) => {
    const result = simulate(scenario);
    expect(result.violations).toEqual([]);
    expect(result.created).toBeGreaterThan(0);
    expect(result.minPlayed).toBeGreaterThanOrEqual(1);
    expect(result.maxPlayed - result.minPlayed).toBeLessThanOrEqual(2);
    expect(result.avgPlayed).toBeGreaterThan(1.5);
    // Guards against wasting courts: waiting must stay near the capacity bound.
    expect(result.maxWaitingMinutes).toBeLessThanOrEqual(rotationBoundMinutes(scenario));
    expect(result.filledPasses).toBeGreaterThanOrEqual(result.passes * 0.9);
    expect(result.courtUtilization).toBeGreaterThan(0.55);
    expect(result.slowestPassMs).toBeLessThan(1500);
  });

  it('fulfils most explicit requests in a 100 participant event', () => {
    const result = simulate({ participants: 100, courts: 8, durationMinutes: 240, matchMinutes: 15, tickMinutes: 16, requestRatio: 0.4 });
    expect(result.requestFulfillmentRate).toBeGreaterThan(0.5);
    expect(result.violations).toEqual([]);
  });
});
