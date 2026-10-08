import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createDatabase, type DB } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { createApp } from '../server/app.js';
import { makeEvent, seedCompletedMatch } from './helpers.js';

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
 * The board polls one endpoint instead of six, so that endpoint has to return
 * exactly what the six returned - no fewer fields, no different ordering.
 */
describe('Phase 6: board snapshot endpoint', () => {
  it('matches the individual endpoints it replaces', async () => {
    const fixture = await makeEvent(agent, db, { playerNames: ['A', 'B', 'C', 'D'], courtCount: 2 });
    const { eventId, players, classId } = fixture;
    seedCompletedMatch(db, eventId, players.A, players.B, { endedMinutesAgo: 10, scoreA: 21, scoreB: 15, classId });

    const snapshot = (await agent.get(`/api/events/${eventId}/snapshot`).expect(200)).body.data;
    const [event, courts, matches, participants, requests] = await Promise.all([
      agent.get(`/api/events/${eventId}`).expect(200),
      agent.get(`/api/events/${eventId}/courts`).expect(200),
      agent.get(`/api/events/${eventId}/matches?limit=500`).expect(200),
      agent.get(`/api/events/${eventId}/participants`).expect(200),
      agent.get(`/api/events/${eventId}/requests`).expect(200),
    ]);
    expect(snapshot.event).toEqual(event.body.data);
    expect(snapshot.courts).toEqual(courts.body.data);
    expect(snapshot.allMatches).toEqual(matches.body.data);
    expect(snapshot.participants).toEqual(participants.body.data);
    expect(snapshot.requests).toEqual(requests.body.data);
    expect(snapshot.eventId).toBe(eventId);
    expect(snapshot.fetchedAt).toBeTruthy();
  });

  it('keeps only live or recently touched matches on the board itself', async () => {
    const fixture = await makeEvent(agent, db, { playerNames: ['A', 'B', 'C', 'D'], courtCount: 2 });
    const { eventId, players, classId } = fixture;
    // Older than the 30 minute board window, so it belongs in history only.
  const stale = seedCompletedMatch(db, eventId, players.A, players.B, { endedMinutesAgo: 200, scoreA: 21, scoreB: 15, classId });
    const fresh = seedCompletedMatch(db, eventId, players.C, players.D, { endedMinutesAgo: 4, scoreA: 21, scoreB: 11, classId });

    const snapshot = (await agent.get(`/api/events/${eventId}/snapshot`).expect(200)).body.data;
    const boardIds = snapshot.matches.map((match: { matchId: string }) => match.matchId);
    expect(boardIds).toContain(fresh);
    expect(boardIds).not.toContain(stale);
    expect(snapshot.allMatches.map((match: { matchId: string }) => match.matchId)).toContain(stale);
  });

  it('skips candidate scoring but still reports the queue', async () => {
    const fixture = await makeEvent(agent, db, { playerNames: ['A', 'B', 'C', 'D'], courtCount: 2 });
    const { eventId, players } = fixture;
    const snapshot = (await agent.get(`/api/events/${eventId}/snapshot`).expect(200)).body.data;
    const full = (await agent.get(`/api/events/${eventId}/engine/state`).expect(200)).body.data;
    // The polled board does not need scored candidates; the modal fetches them itself.
    expect(snapshot.engine.evaluatedPairs).toBeNull();
    expect(snapshot.engine.candidates).toEqual([]);
    expect(full.evaluatedPairs).toBeGreaterThan(0);
    expect(snapshot.engine.waitingPlayers.length).toBe(full.waitingPlayers.length);
    expect(snapshot.engine.queue).toEqual(full.queue);
    expect(snapshot.engine.freeCourtCount).toBe(full.freeCourtCount);
    expect(snapshot.engine.remainingMinutes).toBe(full.remainingMinutes);
    expect(snapshot.engine.eligibleCount).toBeGreaterThan(0);
    expect(snapshot.engine.waitingPlayers[0]).toMatchObject({ name: expect.any(String), restReady: true });
    expect(players).toBeTruthy();
  });

  it('compresses the polled snapshot and still refuses to cache it', async () => {
    const fixture = await makeEvent(agent, db, { playerNames: ['A', 'B', 'C', 'D'], courtCount: 2 });
    const plain = (await agent.get(`/api/events/${fixture.eventId}/snapshot`).expect(200)).body.data;
    const packed = await agent.get(`/api/events/${fixture.eventId}/snapshot`)
      .set('accept-encoding', 'gzip').expect(200);
    expect(packed.headers['content-encoding']).toBe('gzip');
    expect(packed.headers.vary).toContain('accept-encoding');
    expect(packed.headers['cache-control']).toBe('no-store');
    // Whatever the transport does, the board must receive identical data. The two
    // timestamps are allowed to differ, since each call reports its own clock.
    expect({ ...packed.body.data, fetchedAt: plain.fetchedAt, engine: undefined })
      .toEqual({ ...plain, fetchedAt: plain.fetchedAt, engine: undefined });
    expect(packed.body.data.engine.queue).toEqual(plain.engine.queue);
    // Small answers are not worth compressing.
    const health = await agent.get('/api/health').set('accept-encoding', 'gzip').expect(200);
    expect(health.headers['content-encoding']).toBeUndefined();
  });

  it('is not available to participants, who keep their own narrow view', async () => {
    const guest = request.agent(createApp(db));
    await guest.post('/api/auth/login').send({ email: 'p01@demo.local', password: 'demo' }).expect(200);
    const denied = await guest.get('/api/events/evt_demo_krsk/snapshot');
    expect(denied.status).toBe(403);
    const mine = await guest.get('/api/events/evt_demo_krsk/me').expect(200);
    expect(mine.body.data.participant.name).toBeTruthy();
  });
});
