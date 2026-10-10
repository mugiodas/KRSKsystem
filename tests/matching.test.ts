import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createDatabase, type DB } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { createApp } from '../server/app.js';
import { deactivate, makeEvent, patchEvent, seedCompletedMatch, seedWaitingMatch, setRating, type TestEvent } from './helpers.js';

let db: DB;
let agent: TestAgent;

beforeAll(async () => {
  db = createDatabase(':memory:');
  seedDatabase(db);
  agent = request.agent(createApp(db));
  await agent.post('/api/auth/login').send({ email: 'owner@krsk.local', password: 'krsk-demo' }).expect(200);
});

afterAll(() => db.close());

async function run(eventId: string, body: Record<string, unknown> = {}): Promise<any> {
  const response = await agent.post(`/api/events/${eventId}/engine/run`).send(body).expect(200);
  return response.body.data;
}

async function stateOf(eventId: string): Promise<any> {
  return (await agent.get(`/api/events/${eventId}/engine/state`).expect(200)).body.data;
}

/** Gives each player one finished match against a retired opponent, fixing waiting time. */
async function historyWithWaiting(
  event: TestEvent, waitingMinutes: Record<string, number>, extraPlayers: string[],
): Promise<void> {
  for (const name of extraPlayers) {
    const row = await agent.post(`/api/events/${event.eventId}/participants`).send({
      name, classId: event.classId, rating: 1000,
    }).expect(201);
    (event.players as Record<string, string>)[name] = row.body.data.participantId;
  }
  extraPlayers.forEach((extra, index) => {
    const target = Object.keys(waitingMinutes)[index];
    if (!target) return;
    seedCompletedMatch(db, event.eventId, event.players[target], event.players[extra], {
      endedMinutesAgo: waitingMinutes[target], classId: event.classId,
    });
    deactivate(db, event.players[extra]);
  });
}

describe('Phase 3: matching engine', () => {
  it('prefers the pair that has waited longest', async () => {
    const event = await makeEvent(agent, db, { playerNames: ['A', 'B', 'C', 'D'], courtCount: 1 });
    await historyWithWaiting(event, { A: 45, B: 40, C: 20, D: 15 }, ['E', 'F', 'G', 'H']);
    const result = await run(event.eventId);
    expect(result.created).toHaveLength(1);
    expect([result.created[0].playerAName, result.created[0].playerBName].sort()).toEqual(['A', 'B']);
    expect(result.candidates).toHaveLength(6);
    expect(result.candidates[0].breakdown.waitingScore).toBeGreaterThan(result.candidates.at(-1).breakdown.waitingScore);
  });

  it('balances match counts so lightly played participants are picked first', async () => {
    const event = await makeEvent(agent, db, { playerNames: ['A', 'B', 'C'], courtCount: 1 });
    const retired = ['E', 'F', 'G', 'H', 'I', 'J', 'K'];
    for (const name of retired) {
      const row = await agent.post(`/api/events/${event.eventId}/participants`).send({
        name, classId: event.classId, rating: 1000,
      }).expect(201);
      event.players[name] = row.body.data.participantId;
    }
    for (let i = 0; i < 5; i += 1) seedCompletedMatch(db, event.eventId, event.players.A, event.players[retired[i]], { endedMinutesAgo: 20, classId: event.classId });
    seedCompletedMatch(db, event.eventId, event.players.B, event.players[retired[5]], { endedMinutesAgo: 20, classId: event.classId });
    seedCompletedMatch(db, event.eventId, event.players.C, event.players[retired[6]], { endedMinutesAgo: 20, classId: event.classId });
    retired.forEach((name) => deactivate(db, event.players[name]));

    const result = await run(event.eventId);
    expect(result.created).toHaveLength(1);
    expect([result.created[0].playerAName, result.created[0].playerBName].sort()).toEqual(['B', 'C']);
    const state = await stateOf(event.eventId);
    expect(state.waitingPlayers.find((p: any) => p.name === 'A').played).toBe(5);
  });

  it('lets a priority 1 request beat a longer waiting pair', async () => {
    const event = await makeEvent(agent, db, { playerNames: ['A', 'B', 'C', 'D'], courtCount: 1 });
    await historyWithWaiting(event, { A: 45, B: 40, C: 20, D: 18 }, ['E', 'F', 'G', 'H']);
    await agent.post(`/api/events/${event.eventId}/requests`).send({
      requesterId: event.players.C, targetPlayerId: event.players.D, priority: 1,
    }).expect(201);
    const result = await run(event.eventId);
    expect([result.created[0].playerAName, result.created[0].playerBName].sort()).toEqual(['C', 'D']);
    expect(result.candidates[0].breakdown.requestPriority).toBeGreaterThan(0);
    expect(result.candidates[0].mutual).toBe(false);
  });

  it('rewards mutual requests and marks the request as matched', async () => {
    const event = await makeEvent(agent, db, { playerNames: ['A', 'B', 'C', 'D'], courtCount: 1 });
    await historyWithWaiting(event, { A: 45, B: 40, C: 20, D: 18 }, ['E', 'F', 'G', 'H']);
    await agent.post(`/api/events/${event.eventId}/requests`).send({ requesterId: event.players.C, targetPlayerId: event.players.D, priority: 3 }).expect(201);
    await agent.post(`/api/events/${event.eventId}/requests`).send({ requesterId: event.players.D, targetPlayerId: event.players.C, priority: 3 }).expect(201);
    const result = await run(event.eventId);
    expect([result.created[0].playerAName, result.created[0].playerBName].sort()).toEqual(['C', 'D']);
    expect(result.candidates[0].mutual).toBe(true);
    const requests = await agent.get(`/api/events/${event.eventId}/requests`).expect(200);
    expect(requests.body.data.every((row: any) => row.status === 'MATCHED')).toBe(true);
  });

  it('penalises rematches and blocks them entirely when rematch is disabled', async () => {
    const event = await makeEvent(agent, db, { playerNames: ['A', 'B'], courtCount: 1 });
    seedCompletedMatch(db, event.eventId, event.players.A, event.players.B, { endedMinutesAgo: 30, classId: event.classId });
    const result = await run(event.eventId);
    expect(result.created).toHaveLength(0);
    expect(result.blockedCounts.REMATCH_NOT_ALLOWED).toBe(1);
    expect(result.blocked[0].reason).toBe('REMATCH_NOT_ALLOWED');
    expect(result.blocked[0].repeats).toBe(1);

    const third = await agent.post(`/api/events/${event.eventId}/participants`).send({
      name: 'C', classId: event.classId, rating: 1000,
    }).expect(201);
    event.players.C = third.body.data.participantId;

    await patchEvent(agent, event.eventId, { allowRematch: true, allowSameDayRepeat: true });
    const relaxed = await run(event.eventId);
    const scores = Object.fromEntries(relaxed.candidates.map((c: any) => [[c.playerAName, c.playerBName].sort().join('-'), c.score]));
    expect(scores['A-C']).toBeGreaterThan(scores['A-B']);
    const ab = relaxed.candidates.find((c: any) => [c.playerAName, c.playerBName].sort().join('-') === 'A-B');
    expect(ab.breakdown.repeatPenalty).toBeGreaterThan(0);
    const ac = relaxed.candidates.find((c: any) => [c.playerAName, c.playerBName].sort().join('-') === 'A-C');
    expect(ab.breakdown.unplayedBonus).toBeLessThan(ac.breakdown.unplayedBonus);
    expect([relaxed.created[0].playerAName, relaxed.created[0].playerBName]).not.toEqual(expect.arrayContaining(['A', 'B']));
  });

  it('allows a strongly requested rematch despite the repeat penalty', async () => {
    const event = await makeEvent(agent, db, { playerNames: ['A', 'B', 'C'], courtCount: 1 });
    seedCompletedMatch(db, event.eventId, event.players.A, event.players.B, { endedMinutesAgo: 30, classId: event.classId });
    await patchEvent(agent, event.eventId, { allowRematch: true, allowSameDayRepeat: true });
    await agent.post(`/api/events/${event.eventId}/requests`).send({ requesterId: event.players.A, targetPlayerId: event.players.B, priority: 1 }).expect(201);
    const result = await run(event.eventId);
    expect([result.created[0].playerAName, result.created[0].playerBName].sort()).toEqual(['A', 'B']);
    expect(result.candidates[0].breakdown.repeatPenalty).toBe(0);
  });

  it('avoids large rating gaps unless another factor is stronger', async () => {
    const event = await makeEvent(agent, db, { playerNames: ['A', 'B', 'C', 'D'], courtCount: 1 });
    setRating(db, event.players.A, 1500);
    setRating(db, event.players.B, 1480);
    setRating(db, event.players.C, 900);
    setRating(db, event.players.D, 920);
    const result = await run(event.eventId);
    const pair = [result.created[0].playerAName, result.created[0].playerBName].sort().join('-');
    expect(['A-B', 'C-D']).toContain(pair);
    const stored = await agent.get(`/api/events/${event.eventId}/matches/${result.created[0].matchId}`).expect(200);
    await agent.post(`/api/events/${event.eventId}/matches/${result.created[0].matchId}/action`).send({
      action: 'CANCEL', rowVersion: stored.body.data.rowVersion,
    }).expect(200);

    await agent.post(`/api/events/${event.eventId}/requests`).send({ requesterId: event.players.C, targetPlayerId: event.players.A, priority: 1 }).expect(201);
    const overridden = await run(event.eventId);
    const nextPair = [overridden.created[0].playerAName, overridden.created[0].playerBName].sort().join('-');
    expect(nextPair).toBe('A-C');
    expect(overridden.candidates[0].breakdown.ratingCompatibility).toBe(0);
    expect(overridden.candidates[0].breakdown.requestPriority).toBeGreaterThan(0);
  });

  it('protects the event end time and refuses to create late matches', async () => {
    const event = await makeEvent(agent, db, {
      playerNames: ['A', 'B'], courtCount: 1, startedMinutesAgo: 0, durationMinutes: 12,
    });
    const result = await run(event.eventId);
    expect(result.created).toHaveLength(0);
    expect(result.endedByTimeProtection).toBe(true);
    expect(result.skippedReasons.END_TIME_PROTECTED).toBeGreaterThan(0);
    expect(result.blockedCounts.END_TIME_PROTECTED).toBeGreaterThan(0);
  });

  it('creates nothing when every court is busy and fills every free court otherwise', async () => {
    const event = await makeEvent(agent, db, { playerNames: ['A', 'B', 'C', 'D'], courtCount: 2 });
    const busy = seedWaitingMatch(db, event.eventId, event.players.A, event.players.B, event.classId);
    await agent.post(`/api/events/${event.eventId}/matches/${busy}/action`).send({
      action: 'ASSIGN', courtId: event.courtIds[0], rowVersion: 1,
    }).expect(200);
    await agent.post(`/api/events/${event.eventId}/matches/${busy}/action`).send({ action: 'START', rowVersion: 2, force: true }).expect(200);

    const oneCourt = await run(event.eventId);
    expect(oneCourt.freeCourts).toBe(1);
    expect(oneCourt.created).toHaveLength(1);
    expect([oneCourt.created[0].playerAName, oneCourt.created[0].playerBName].sort()).toEqual(['C', 'D']);

    const noneFree = await run(event.eventId);
    expect(noneFree.created).toHaveLength(0);
    expect(noneFree.freeCourts).toBe(0);
    expect(noneFree.skippedReasons.NO_FREE_COURT).toBeGreaterThan(0);
  });

  it('keeps players out of two matches and honours minimum rest', async () => {
    const event = await makeEvent(agent, db, { playerNames: ['A', 'B', 'C', 'D'], courtCount: 2 });
    await patchEvent(agent, event.eventId, { minimumRestMinutes: 10 });
    seedCompletedMatch(db, event.eventId, event.players.A, event.players.B, { endedMinutesAgo: 2, classId: event.classId });
    const result = await run(event.eventId);
    expect(result.created).toHaveLength(1);
    expect([result.created[0].playerAName, result.created[0].playerBName].sort()).toEqual(['C', 'D']);
    expect(result.blockedCounts.REST_REQUIRED).toBeGreaterThan(0);
    const state = await stateOf(event.eventId);
    expect(state.waitingPlayers.find((p: any) => p.name === 'A').restReady).toBe(false);
  });

  it('assigns queued league matches before generating new request matches', async () => {
    const event = await makeEvent(agent, db, { playerNames: ['A', 'B', 'C', 'D'], courtCount: 1, settings: { eventMode: 'LEAGUE_REQUEST' } });
    await patchEvent(agent, event.eventId, { currentPhase: 'LEAGUE' });
    const queued = seedWaitingMatch(db, event.eventId, event.players.A, event.players.B, event.classId);
    await agent.post(`/api/events/${event.eventId}/requests`).send({ requesterId: event.players.C, targetPlayerId: event.players.D, priority: 1 }).expect(201);
    const result = await run(event.eventId);
    expect(result.assignedQueue).toHaveLength(1);
    expect(result.assignedQueue[0].matchId).toBe(queued);
    expect(result.created).toHaveLength(0);
    const match = (await agent.get(`/api/events/${event.eventId}/matches/${queued}`).expect(200)).body.data;
    expect(match.status).toBe('COURT_ASSIGNED');
    expect(match.courtId).toBe(event.courtIds[0]);
  });

  it('never stores two open matches for the same pair even under concurrent runs', async () => {
    const event = await makeEvent(agent, db, { playerNames: ['A', 'B'], courtCount: 2 });
    const [first, second] = await Promise.all([run(event.eventId), run(event.eventId)]);
    const totalCreated = first.created.length + second.created.length;
    expect(totalCreated).toBe(1);
    const openMatches = (await agent.get(`/api/events/${event.eventId}/matches?status=COURT_ASSIGNED`).expect(200)).body.data;
    expect(openMatches).toHaveLength(1);
  });

  it('reruns automatically after a result is entered', async () => {
    const event = await makeEvent(agent, db, { playerNames: ['A', 'B', 'C', 'D'], courtCount: 1 });
    const first = await run(event.eventId);
    expect(first.created).toHaveLength(1);
    const firstPair = [first.created[0].playerAName, first.created[0].playerBName].sort();
    const matchId = first.created[0].matchId;
    const detail = await agent.get(`/api/events/${event.eventId}/matches/${matchId}`).expect(200);
    await agent.post(`/api/events/${event.eventId}/matches/${matchId}/action`).send({
      action: 'START', rowVersion: detail.body.data.rowVersion, force: true,
    }).expect(200);
    const started = await agent.get(`/api/events/${event.eventId}/matches/${matchId}`).expect(200);
    await agent.post(`/api/events/${event.eventId}/matches/${matchId}/result`).send({
      scoreA: 15, scoreB: 9, rowVersion: started.body.data.rowVersion,
    }).expect(201);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const queued = (await agent.get(`/api/events/${event.eventId}/matches?status=COURT_ASSIGNED`).expect(200)).body.data;
    expect(queued).toHaveLength(1);
    const remaining = ['A', 'B', 'C', 'D'].filter((name) => !firstPair.includes(name));
    expect([queued[0].playerAName, queued[0].playerBName].sort()).toEqual(remaining);
    expect(queued[0].playerAName).not.toBe(first.created[0].playerAName);
    const state = await stateOf(event.eventId);
    expect(state.busyPlayerCount).toBe(2);
    expect(state.freeCourtCount).toBe(0);
  });

  it('reports candidate explanations with every weighted component', async () => {
    const event = await makeEvent(agent, db, { playerNames: ['A', 'B', 'C'], courtCount: 1 });
    await agent.post(`/api/events/${event.eventId}/requests`).send({ requesterId: event.players.A, targetPlayerId: event.players.B, priority: 2 }).expect(201);
    const result = await run(event.eventId, { force: false });
    const top = result.candidates[0];
    expect(top.breakdown).toMatchObject({
      requestPriority: expect.any(Number), waitingScore: expect.any(Number),
      matchCountBalance: expect.any(Number), unplayedBonus: expect.any(Number),
      ratingCompatibility: expect.any(Number), remainingTimeFit: expect.any(Number),
      recentMatchPenalty: expect.any(Number), repeatPenalty: expect.any(Number),
    });
    const stored = await agent.get(`/api/events/${event.eventId}/matches/${result.created[0].matchId}`).expect(200);
    expect(stored.body.data.source).toBe('REQUEST');
    expect(stored.body.data.priorityScore).toBeGreaterThan(0);
    expect(stored.body.data.scoreBreakdown.notes.length).toBeGreaterThan(0);
  });

  it('respects a changed weight configuration', async () => {
    const event = await makeEvent(agent, db, { playerNames: ['A', 'B', 'C', 'D'], courtCount: 1 });
    await historyWithWaiting(event, { A: 45, B: 40, C: 20, D: 18 }, ['E', 'F', 'G', 'H']);
    const defaultRun = await run(event.eventId);
    expect([defaultRun.created[0].playerAName, defaultRun.created[0].playerBName].sort()).toEqual(['A', 'B']);
    const finished = await agent.get(`/api/events/${event.eventId}/matches/${defaultRun.created[0].matchId}`).expect(200);
    await agent.post(`/api/events/${event.eventId}/matches/${defaultRun.created[0].matchId}/action`).send({
      action: 'CANCEL', rowVersion: finished.body.data.rowVersion,
    }).expect(200);

    await patchEvent(agent, event.eventId, { weightWaiting: 0, weightRequestPriority: 80 });
    await agent.post(`/api/events/${event.eventId}/requests`).send({ requesterId: event.players.C, targetPlayerId: event.players.D, priority: 1 }).expect(201);
    const weighted = await run(event.eventId);
    expect([weighted.created[0].playerAName, weighted.created[0].playerBName].sort()).toEqual(['C', 'D']);
  });

  it('stops generating matches once the event is completed', async () => {
    const event = await makeEvent(agent, db, { playerNames: ['A', 'B'], courtCount: 1 });
    const current = await agent.get(`/api/events/${event.eventId}`).expect(200);
    await agent.post(`/api/events/${event.eventId}/status`).send({ status: 'COMPLETED', rowVersion: current.body.data.rowVersion }).expect(200);
    const result = await run(event.eventId);
    expect(result.created).toHaveLength(0);
    expect(result.skippedReasons.EVENT_CLOSED).toBe(1);
  });
});

describe('Phase 3: match requests', () => {
  it('lets a participant request, cancel and never request themselves', async () => {
    const event = await makeEvent(agent, db, { playerNames: ['古谷 莉歩', '山本 悠真', '田中 美羽'], courtCount: 1 });
    const participant = request.agent(createApp(db));
    db.prepare(`INSERT INTO users (user_id, email, display_name, password_hash, role, participant_id, active, created_at, updated_at)
      VALUES ('usr_test_p', 'player@test.local', '参加者', (SELECT password_hash FROM users LIMIT 1), 'PARTICIPANT', ?, 1, ?, ?)`)
      .run(event.players['古谷 莉歩'], new Date().toISOString(), new Date().toISOString());
    await participant.post('/api/auth/login').send({ email: 'player@test.local', password: 'krsk-demo' }).expect(200);

    await participant.post(`/api/events/${event.eventId}/requests`).send({
      requesterId: event.players['山本 悠真'], targetPlayerId: event.players['田中 美羽'], priority: 1,
    }).expect(403);

    await participant.post(`/api/events/${event.eventId}/requests`).send({
      targetPlayerId: event.players['古谷 莉歩'], priority: 2,
    }).expect(400);

    const created = await participant.post(`/api/events/${event.eventId}/requests`).send({
      targetPlayerId: event.players['山本 悠真'], priority: 1,
    }).expect(201);
    expect(created.body.data.own).toBe(true);

    await participant.post(`/api/events/${event.eventId}/requests`).send({
      targetPlayerId: event.players['山本 悠真'], priority: 3,
    }).expect(409);

    const listed = await participant.get(`/api/events/${event.eventId}/requests`).expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].targetName).toBe('山本 悠真');
    expect(listed.body.data[0].requesterName).toBe('古谷 莉歩');

    const updated = await participant.patch(`/api/events/${event.eventId}/requests/${created.body.data.requestId}`).send({
      priority: 3, rowVersion: created.body.data.rowVersion,
    }).expect(200);
    expect(updated.body.data.priority).toBe(3);
    await participant.patch(`/api/events/${event.eventId}/requests/${created.body.data.requestId}`).send({
      priority: 1, rowVersion: created.body.data.rowVersion,
    }).expect(409);

    const cancelled = await participant.patch(`/api/events/${event.eventId}/requests/${created.body.data.requestId}`).send({
      status: 'CANCELLED', rowVersion: updated.body.data.rowVersion,
    }).expect(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');

    const suggestions = await participant.get(`/api/events/${event.eventId}/requests/suggestions`).expect(200);
    expect(suggestions.body.data[0]).not.toHaveProperty('rating');
    expect(suggestions.body.data).toHaveLength(2);
  });

  it('rejects requests for unknown or disabled participants and closed events', async () => {
    const event = await makeEvent(agent, db, { playerNames: ['A', 'B'], courtCount: 1 });
    await agent.post(`/api/events/${event.eventId}/requests`).send({
      requesterId: event.players.A, targetPlayerId: 'ptc_missing', priority: 1,
    }).expect(400);
    deactivate(db, event.players.B);
    await agent.post(`/api/events/${event.eventId}/requests`).send({
      requesterId: event.players.A, targetPlayerId: event.players.B, priority: 1,
    }).expect(400);
    const disabled = await makeEvent(agent, db, { playerNames: ['A', 'B'], courtCount: 1, settings: { allowRequest: false } });
    await agent.post(`/api/events/${disabled.eventId}/requests`).send({
      requesterId: disabled.players.A, targetPlayerId: disabled.players.B, priority: 1,
    }).expect(403);
  });
});
