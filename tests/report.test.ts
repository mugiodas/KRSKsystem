import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createDatabase, makeId, nowIso, pairKey, type DB } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { createApp } from '../server/app.js';
import { makeEvent, patchEvent, seedCompletedMatch } from './helpers.js';
import { runIntegrityChecks } from '../server/services/integrity.js';

let db: DB;
let agent: TestAgent;

beforeAll(async () => {
  db = createDatabase(':memory:');
  seedDatabase(db);
  agent = request.agent(createApp(db));
  await agent.post('/api/auth/login').send({ email: 'owner@krsk.local', password: 'krsk-demo' }).expect(200);
});

afterAll(() => db.close());

/**
 * Phase 6: the report must be arithmetically right, the integrity switch must
 * actually catch broken rows, and simultaneous operator actions must not be
 * able to corrupt state.
 */
describe('Phase 6: event report', () => {
  it('counts matches, waiting time, utilisation and fairness from stored results', async () => {
    const fixture = await makeEvent(agent, db, { playerNames: ['A', 'B', 'C', 'D'], courtCount: 1, durationMinutes: 240 });
    const { eventId, players, classId, courtIds } = fixture;
    // Three finished matches, each 12 minutes long, with a 28 minute gap after.
    seedCompletedMatch(db, eventId, players.A, players.B, { endedMinutesAgo: 60, scoreA: 15, scoreB: 10, classId });
    seedCompletedMatch(db, eventId, players.C, players.D, { endedMinutesAgo: 60, scoreA: 15, scoreB: 12, classId });
    seedCompletedMatch(db, eventId, players.A, players.C, { endedMinutesAgo: 20, scoreA: 21, scoreB: 19, classId });
    // The helper writes history directly; attach it to the court the way play would.
    db.prepare(`UPDATE matches SET court_id = ? WHERE event_id = ?`).run(courtIds[0], eventId);

    const report = (await agent.get(`/api/events/${eventId}/report`).expect(200)).body.data;
    expect(report.participants.registered).toBe(4);
    expect(report.matches.total).toBe(3);
    expect(report.matches.completed).toBe(3);
    expect(report.matchCount).toMatchObject({ total: 6, min: 1, max: 2, spread: 1, zeroMatchPlayers: 0 });
    expect(report.matchCount.avg).toBeCloseTo(1.5, 2);

    const rowA = report.rows.find((row: { name: string }) => row.name === 'A');
    expect(rowA.played).toBe(2);
    expect(rowA.wins).toBe(2);
    expect(rowA.pointsFor).toBe(36);
    expect(rowA.pointsAgainst).toBe(29);
    // A waited from the end of match 1 (60m ago) to the start of match 3 (32m ago).
    expect(rowA.totalWaitingMinutes).toBeCloseTo(28, 0);
    expect(rowA.longestWaitingMinutes).toBeCloseTo(28, 0);

    const rowD = report.rows.find((row: { name: string }) => row.name === 'D');
    expect(rowD.totalWaitingMinutes).toBe(0);

    expect(report.waiting.maxMinutes).toBeCloseTo(28, 0);
    expect(report.waiting.avgMinutes).toBeCloseTo(14, 0);

    // One court, 240 minute window, 3 x 12 minutes of play.
    expect(report.courts.count).toBe(1);
    expect(report.courts.busyMinutes).toBeCloseTo(36, 0);
    expect(report.courts.utilization).toBeCloseTo(0.15, 2);
    expect(report.courts.perCourt[0].matches).toBe(3);

    expect(report.fairness.playedStdDev).toBeCloseTo(0.5, 2);
    expect(report.automation.createdAuto).toBe(3);
    expect(report.integrity.clean).toBe(true);
    expect(report.integrity.violations).toEqual([]);
    expect(report.standings[0].rows[0]).toMatchObject({ rank: 1, name: 'A', wins: 2 });
  });

  it('counts realised waiting, not time until a match that has not started', async () => {
    const fixture = await makeEvent(agent, db, { playerNames: ['X', 'Y', 'Z'], courtCount: 1 });
    const { eventId, players, classId } = fixture;
    seedCompletedMatch(db, eventId, players.X, players.Y, { endedMinutesAgo: 60, scoreA: 21, scoreB: 14, classId });
    // X is queued for a match two hours from now. That is not waiting yet, so it must
    // not inflate the post-event figure, while both players stay "idle" at report time.
    const seedWait = db.prepare(`INSERT INTO matches (
        match_id, event_id, phase, player_a_id, player_b_id, scheduled_time, status, source, priority_score, pair_key, created_at, updated_at
      ) VALUES (?, ?, 'LEAGUE', ?, ?, ?, 'WAITING', 'AUTO', 0, ?, ?, ?)`);
    seedWait.run(makeId('match'), eventId, players.X, players.Z, new Date(Date.now() + 120 * 60_000).toISOString(),
      pairKey(players.X, players.Z), nowIso(), nowIso());

    const report = (await agent.get(`/api/events/${eventId}/report`).expect(200)).body.data;
    const byName = new Map<string, Record<string, number>>(report.rows.map((row: { name: string }) => [row.name, row as unknown as Record<string, number>]));
    expect(byName.get('X')?.totalWaitingMinutes).toBe(0);
    expect(byName.get('X')?.longestWaitingMinutes).toBe(0);
    expect(report.waiting.samples).toBe(0);
    // X is still waiting for that future match, so the live figure does see them,
    // while Z has no finished match to measure an idle period from and is left out.
    expect(report.waiting.idlePlayers).toBe(2);
    expect(report.waiting.longestIdleMinutes).toBeGreaterThanOrEqual(55);
  });

  it('keeps the fairness score inside its documented range', async () => {
    // One player carries the whole event, so the raw formula would go far below zero.
    const fixture = await makeEvent(agent, db, { playerNames: ['Solo', 'A', 'B'], courtCount: 1 });
    const { eventId, players, classId } = fixture;
    [40, 80, 120, 160, 200].forEach((endedMinutesAgo, index) => {
      seedCompletedMatch(db, eventId, players.Solo, index % 2 === 0 ? players.A : players.B, { endedMinutesAgo, scoreA: 21, scoreB: 5, classId });
    });
    const report = (await agent.get(`/api/events/${eventId}/report`).expect(200)).body.data;
    expect(report.fairness.balanceScore).toBeGreaterThanOrEqual(0);
    expect(report.fairness.balanceScore).toBeLessThanOrEqual(1);
    expect(report.fairness.mostPlayed).toContain('5試合');
    expect(report.matchCount.zeroMatchPlayers).toBe(0);   // every player appears at least once
  });

  it('reports request fulfilment and no-shows', async () => {
    const fixture = await makeEvent(agent, db, { playerNames: ['P', 'Q', 'R'], courtCount: 1 });
    const { eventId, players } = fixture;
    await agent.post(`/api/events/${eventId}/requests`).send({ requesterId: players.P, targetPlayerId: players.R, priority: 1 }).expect(201);
    await agent.post(`/api/events/${eventId}/requests`).send({ requesterId: players.Q, targetPlayerId: players.R, priority: 2 }).expect(201);
    db.prepare(`UPDATE match_requests SET status = 'MATCHED', matched_match_id = ? WHERE event_id = ? AND requester_id = ?`)
      .run(seedCompletedMatch(db, eventId, players.P, players.R, { endedMinutesAgo: 5 }), eventId, players.P);
    const matchId = makeId('match');
    db.prepare(`INSERT INTO matches (match_id, event_id, phase, player_a_id, player_b_id, status, source, priority_score, pair_key, created_at, updated_at)
      VALUES (?, ?, 'REQUEST', ?, ?, 'NO_SHOW', 'ADMIN', 0, ?, ?, ?)`)
      .run(matchId, eventId, players.Q, players.R, pairKey(players.Q, players.R), nowIso(), nowIso());

    const report = (await agent.get(`/api/events/${eventId}/report`).expect(200)).body.data;
    expect(report.requests.total).toBe(2);
    expect(report.requests.matched).toBe(1);
    expect(report.requests.fulfillmentRate).toBeCloseTo(0.5, 3);
    // Both sides of the no-show match are affected, not only the absentee.
    expect(report.noShows).toMatchObject({ count: 1, affectedPlayers: 2 });
    expect(report.matches.noShow).toBe(1);
  });

  it('keeps the JSON contract the dashboard type mirrors', async () => {
    const fixture = await makeEvent(agent, db, { playerNames: ['A', 'B'], courtCount: 1 });
    const report = (await agent.get(`/api/events/${fixture.eventId}/report`).expect(200)).body.data;
    // src/api/types.ts mirrors this shape by hand, so an accidental rename has to fail here.
    expect(Object.keys(report).sort()).toEqual([
      'automation', 'courts', 'eventDate', 'eventId', 'eventMode', 'eventName', 'fairness',
      'generatedAt', 'integrity', 'matchCount', 'matches', 'noShows', 'participants', 'phase',
      'requests', 'rows', 'standings', 'status', 'tournament', 'venue', 'waiting', 'window',
    ]);
    expect(Object.keys(report.courts).sort()).toEqual(['availableMinutes', 'busyMinutes', 'count', 'perCourt', 'utilization']);
    expect(Object.keys(report.requests).sort()).toEqual(['active', 'cancelled', 'expired', 'fulfillmentRate', 'matched', 'total']);
    expect(Object.keys(report.matchCount).sort()).toEqual(['avg', 'histogram', 'max', 'min', 'spread', 'total', 'zeroMatchPlayers']);
    expect(Object.keys(report.rows[0]).sort()).toEqual([
      'checkedIn', 'className', 'club', 'longestWaitingMinutes', 'name', 'noShows', 'participantId',
      'pointDifference', 'pointsAgainst', 'pointsFor', 'played', 'rating', 'requestCount',
      'requestFulfilled', 'totalWaitingMinutes', 'winRate', 'wins', 'losses',
    ].sort());
    expect(report.integrity).toMatchObject({ checks: 18, clean: true, violations: [] });
    expect(report.courts.perCourt[0]).toHaveProperty('courtName');
  });

  it('exports a CSV a spreadsheet can open, and keeps it staff only', async () => {
    const fixture = await makeEvent(agent, db, { playerNames: ['X', 'Y'], courtCount: 1 });
    seedCompletedMatch(db, fixture.eventId, fixture.players.X, fixture.players.Y, { endedMinutesAgo: 10, scoreA: 21, scoreB: 18 });

    const csv = await agent.get(`/api/events/${fixture.eventId}/report.csv`).expect(200).buffer(true).parse((res: any, done: any) => {
      res.setEncoding('utf8');
      let text = '';
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => done(null, text));
    });
    const body = String((csv as unknown as { body: string }).body);
    expect(body.startsWith('\ufeff')).toBe(true);          // BOM so Excel reads Japanese
    expect(body).toContain('選手名,クラス,所属,試合数,勝利,敗北,勝率');
    expect(body).toContain('X,');
    expect(body).toContain('21,18');
    expect(body).toContain('コート,試合数,稼働分,稼働率');

    const participant = request.agent(createApp(db));
    await participant.post('/api/auth/login').send({ email: 'p01@demo.local', password: 'demo' });
    await participant.get(`/api/events/${fixture.eventId}/report`).expect(403);
    await participant.get(`/api/events/${fixture.eventId}/report.csv`).expect(403);
  });

  it('flags a half written result as a critical integrity failure', async () => {
    const fixture = await makeEvent(agent, db, { playerNames: ['M', 'N'], courtCount: 1 });
    const { eventId, players } = fixture;
    const matchId = seedCompletedMatch(db, eventId, players.M, players.N, { endedMinutesAgo: 4 });

    // A result row attached to a match that never completed is exactly the kind
    // of phantom write the spec forbids, so the checker has to see it.
    const waitingId = makeId('match');
    db.prepare(`INSERT INTO matches (match_id, event_id, phase, player_a_id, player_b_id, status, source, priority_score, pair_key, created_at, updated_at)
      VALUES (?, ?, 'LEAGUE', ?, ?, 'WAITING', 'AUTO', 0, ?, ?, ?)`)
      .run(waitingId, eventId, players.M, players.N, pairKey(players.M, players.N), nowIso(), nowIso());
    const resultId = makeId('result');
    db.prepare(`INSERT INTO results (result_id, match_id, score_a, score_b, winner_id, entered_by, status, entered_at, updated_at)
      VALUES (?, ?, 15, 3, ?, (SELECT user_id FROM users LIMIT 1), 'ENTERED', ?, ?)`)
      .run(resultId, waitingId, players.M, nowIso(), nowIso());

    const report = (await agent.get(`/api/events/${eventId}/report`).expect(200)).body.data;
    expect(report.integrity.clean).toBe(false);
    expect(report.integrity.violations.map((item: { code: string }) => item.code)).toContain('ORPHAN_RESULT');

    const qa = (await agent.get(`/api/events/${eventId}/integrity`).expect(200)).body.data;
    expect(qa.clean).toBe(false);
    expect(qa.violations[0].severity).toBe('CRITICAL');

    // Cleaning the row restores the green state, proving the check is data driven.
    db.prepare('DELETE FROM results WHERE result_id = ?').run(resultId);
    expect(runIntegrityChecks(db, eventId).violations).toEqual([]);
    expect(matchId).toBeTruthy();
  });

  it('survives simultaneous result entry, court change and match creation', async () => {
    const fixture = await makeEvent(agent, db, { playerNames: ['S1', 'S2', 'S3', 'S4'], courtCount: 2 });
    const { eventId, players, courtIds } = fixture;
    await patchEvent(agent, eventId, { autoEngineEnabled: false, autoCourtAssignment: false });

    const matchId = makeId('match');
    const created = nowIso();
    db.prepare(`INSERT INTO matches (match_id, event_id, phase, player_a_id, player_b_id, court_id, start_time, status, source, priority_score, pair_key, created_at, updated_at)
      VALUES (?, ?, 'LEAGUE', ?, ?, ?, ?, 'PLAYING', 'AUTO', 0, ?, ?, ?)`)
      .run(matchId, eventId, players.S1, players.S2, courtIds[0], created, pairKey(players.S1, players.S2), created, created);

    // Two operators submit a score for the same match at the same time.
    const current = (await agent.get(`/api/events/${eventId}/matches/${matchId}`).expect(200)).body.data;
    const payloads = [
      { scoreA: 21, scoreB: 19, rowVersion: current.rowVersion },
      { scoreA: 15, scoreB: 7, rowVersion: current.rowVersion },
    ];
    const results = await Promise.all(payloads.map((payload) => agent.post(`/api/events/${eventId}/matches/${matchId}/result`).send(payload)));
    const accepted = results.filter((response) => response.status === 201);
    const rejected = results.filter((response) => response.status === 409);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // Whichever guard fires first, the second writer must be refused, never merged.
    expect(['VERSION_CONFLICT', 'INVALID_STATE_TRANSITION']).toContain(rejected[0].body.error.code);
    const stored = db.prepare(`SELECT COUNT(*) AS total FROM results WHERE match_id = ?`).get(matchId) as { total: number };
    expect(Number(stored.total)).toBe(1);
    expect(accepted[0].body.data.scoreA).toBe(21);

    // Two operators create the same card at the same time: only one may exist.
    const duplicate = await Promise.all([0, 1].map(() => agent.post(`/api/events/${eventId}/matches`)
      .send({ playerAId: players.S3, playerBId: players.S4, courtId: courtIds[1] })));
    const createdCount = duplicate.filter((response) => response.status === 201).length;
    expect(createdCount).toBe(1);
    expect(duplicate.filter((response) => response.status === 409).length).toBe(1);

    // Put two live cards on a collision course for the same court. The queued
    // S3 x S4 card is cancelled first so its pair can be re-queued as WAITING.
    const queued = duplicate.find((response) => response.status === 201)?.body.data;
    await agent.post(`/api/events/${eventId}/matches/${queued.matchId}/action`)
      .send({ action: 'CANCEL', rowVersion: queued.rowVersion }).expect(200);
    await patchEvent(agent, eventId, { minimumRestMinutes: 0 });
    db.prepare(`UPDATE courts SET status = 'AVAILABLE' WHERE event_id = ?`).run(eventId);
    const insertWaiting = db.prepare(`INSERT INTO matches (
        match_id, event_id, phase, player_a_id, player_b_id, status, source, priority_score, pair_key, created_at, updated_at
      ) VALUES (?, ?, 'LEAGUE', ?, ?, 'WAITING', 'AUTO', 0, ?, ?, ?)`);
    const waitingA = makeId('match');
    const waitingB = makeId('match');
    insertWaiting.run(waitingA, eventId, players.S3, players.S4, pairKey(players.S3, players.S4), nowIso(), nowIso());
    insertWaiting.run(waitingB, eventId, players.S1, players.S2, pairKey(players.S1, players.S2), nowIso(), nowIso());

    const racing = await Promise.all([
      agent.post(`/api/events/${eventId}/matches/${waitingA}/action`).send({ action: 'ASSIGN', courtId: courtIds[0], rowVersion: 1 }),
      agent.post(`/api/events/${eventId}/matches/${waitingB}/action`).send({ action: 'ASSIGN', courtId: courtIds[0], rowVersion: 1 }),
    ]);
    expect(racing.filter((response) => response.status === 200)).toHaveLength(1);
    expect(racing.filter((response) => response.status === 409)).toHaveLength(1);
    const occupants = db.prepare(`SELECT COUNT(*) AS total FROM matches WHERE court_id = ?
      AND status IN ('COURT_ASSIGNED','PLAYING','RESULT_PENDING')`).get(courtIds[0]) as { total: number };
    expect(Number(occupants.total)).toBe(1);
    // No double booking, no stale court flag, no half written match survived the race.
    expect(runIntegrityChecks(db, eventId).violations).toEqual([]);
  });
});
