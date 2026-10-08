import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createDatabase, type DB } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { createApp } from '../server/app.js';

let db: DB;
let agent: TestAgent;
let eventId: string;
let classId: string;
let courtId: string;
const players: string[] = [];

beforeAll(async () => {
  db = createDatabase(':memory:');
  seedDatabase(db);
  agent = request.agent(createApp(db));
  await agent.post('/api/auth/login').send({ email: 'owner@krsk.local', password: 'krsk-demo' }).expect(200);
  const start = new Date(Date.now() - 10 * 60_000);
  const end = new Date(Date.now() + 4 * 60 * 60_000);
  const event = await agent.post('/api/events').send({
    eventName: 'Phase 2 テスト', eventDate: start.toISOString().slice(0, 10), venue: 'テスト会場',
    startTime: start.toISOString(), endTime: end.toISOString(), eventMode: 'LEAGUE_REQUEST', maxParticipants: 10,
  }).expect(201);
  eventId = event.body.data.eventId;
  const started = await agent.post(`/api/events/${eventId}/status`).send({ status: 'RUNNING', rowVersion: event.body.data.rowVersion }).expect(200);
  // Phase 2 exercises the match lifecycle by hand, so the automatic engine stays off here.
  await agent.patch(`/api/events/${eventId}`).send({ autoEngineEnabled: false, rowVersion: started.body.data.rowVersion }).expect(200);
  classId = (await agent.post(`/api/events/${eventId}/classes`).send({ className: 'A' }).expect(201)).body.data.classId;
  for (let i = 1; i <= 4; i += 1) {
    const participant = await agent.post(`/api/events/${eventId}/participants`).send({
      name: `選手 ${i}`, classId, rating: 1000 + i * 20,
    }).expect(201);
    players.push(participant.body.data.participantId);
  }
  courtId = (await agent.post(`/api/events/${eventId}/courts`).send({
    courtNumber: 1, courtName: 'COURT 1', availableFrom: start.toISOString(), availableTo: end.toISOString(),
  }).expect(201)).body.data.courtId;
});

afterAll(() => db.close());

describe('Phase 2: match, result and ranking', () => {
  it('previews league fixtures before persisting and generates a balanced round robin', async () => {
    const preview = await agent.post(`/api/events/${eventId}/league/preview`).send({ classIds: [classId] }).expect(200);
    expect(preview.body.data.pairs).toHaveLength(6);
    expect(preview.body.data.summary.matchCount).toBe(6);
    expect(Number((db.prepare('SELECT COUNT(*) count FROM matches WHERE event_id = ?').get(eventId) as any).count)).toBe(0);

    const generated = await agent.post(`/api/events/${eventId}/league/generate`).send({ classIds: [classId] }).expect(201);
    expect(generated.body.data.createdCount).toBe(6);
    const duplicate = await agent.post(`/api/events/${eventId}/league/generate`).send({ classIds: [classId] }).expect(201);
    expect(duplicate.body.data.createdCount).toBe(0);
    expect(duplicate.body.data.skippedDuplicate).toBe(6);
  });

  it('assigns, starts, finishes and completes a match while releasing the court', async () => {
    const matches = await agent.get(`/api/events/${eventId}/matches?status=WAITING`).expect(200);
    const match = matches.body.data[0];
    const assigned = await agent.post(`/api/events/${eventId}/matches/${match.matchId}/action`).send({
      action: 'ASSIGN', courtId, rowVersion: match.rowVersion,
    }).expect(200);
    expect(assigned.body.data.status).toBe('COURT_ASSIGNED');
    const started = await agent.post(`/api/events/${eventId}/matches/${match.matchId}/action`).send({
      action: 'START', rowVersion: assigned.body.data.rowVersion,
    }).expect(200);
    expect(started.body.data.status).toBe('PLAYING');
    const pending = await agent.post(`/api/events/${eventId}/matches/${match.matchId}/action`).send({
      action: 'FINISH', rowVersion: started.body.data.rowVersion,
    }).expect(200);
    expect(pending.body.data.status).toBe('RESULT_PENDING');
    const completed = await agent.post(`/api/events/${eventId}/matches/${match.matchId}/result`).send({
      scoreA: 15, scoreB: 10, rowVersion: pending.body.data.rowVersion,
    }).expect(201);
    expect(completed.body.data.status).toBe('COMPLETED');
    expect(completed.body.data.winnerId).toBe(match.playerAId);
    const court = (await agent.get(`/api/events/${eventId}/courts`).expect(200)).body.data[0];
    expect(court.status).toBe('AVAILABLE');
  });

  it('prevents double result registration from stale concurrent clients', async () => {
    // A fifth player has no league fixture yet, so this pair is free for a manual match.
    const extra = await agent.post(`/api/events/${eventId}/participants`).send({
      name: '選手 5', classId, rating: 1000,
    }).expect(201);
    await agent.post(`/api/events/${eventId}/matches`).send({
      playerAId: players[2], playerBId: extra.body.data.participantId, phase: 'LEAGUE',
    }).expect(201);
    await agent.post(`/api/events/${eventId}/matches`).send({
      playerAId: extra.body.data.participantId, playerBId: players[2], phase: 'REQUEST',
    }).expect(409);

    const manual = await agent.post(`/api/events/${eventId}/matches`).send({
      playerAId: players[2], playerBId: players[3], phase: 'LEAGUE', courtId, force: true,
    }).expect(409);
    // The generated league fixture for this pair is reused instead of duplicated.
    const queued = (await agent.get(`/api/events/${eventId}/matches?status=WAITING`).expect(200)).body.data
      .find((row: any) => [row.playerAId, row.playerBId].sort().join() === [players[2], players[3]].sort().join());
    expect(queued).toBeTruthy();
    const started = await agent.post(`/api/events/${eventId}/matches/${queued.matchId}/action`).send({
      action: 'ASSIGN', courtId, rowVersion: queued.rowVersion, force: true,
    }).expect(200);
    const playing = await agent.post(`/api/events/${eventId}/matches/${queued.matchId}/action`).send({
      action: 'START', rowVersion: started.body.data.rowVersion, force: true,
    }).expect(200);
    const payload = { scoreA: 12, scoreB: 15, rowVersion: playing.body.data.rowVersion };
    const [first, second] = await Promise.all([
      agent.post(`/api/events/${eventId}/matches/${queued.matchId}/result`).send(payload),
      agent.post(`/api/events/${eventId}/matches/${queued.matchId}/result`).send(payload),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const resultCount = (db.prepare('SELECT COUNT(*) count FROM results WHERE match_id = ?').get(queued.matchId) as any).count;
    expect(Number(resultCount)).toBe(1);
    const matchRow = (db.prepare('SELECT status, winner_id FROM matches WHERE match_id = ?').get(queued.matchId) as any);
    expect(matchRow.status).toBe('COMPLETED');
    expect(matchRow.winner_id).toBe(queued.playerBId);
  });

  it('corrects a result and refuses to re-confirm what is already settled', async () => {
    const match = (db.prepare("SELECT match_id FROM matches WHERE event_id = ? AND status = 'COMPLETED' ORDER BY created_at LIMIT 1").get(eventId) as any);
    const detail = await agent.get(`/api/events/${eventId}/matches/${match.match_id}`).expect(200);
    const corrected = await agent.patch(`/api/events/${eventId}/matches/${match.match_id}/result`).send({
      scoreA: 8, scoreB: 15, rowVersion: detail.body.data.result.rowVersion,
    }).expect(200);
    expect(corrected.body.data.status).toBe('CORRECTED');
    expect(corrected.body.data.winnerId).toBe(detail.body.data.playerBId);
    // A correction is already an authoritative record, so the confirm switch declines.
    const confirmed = await agent.post(`/api/events/${eventId}/matches/${match.match_id}/result/confirm`).send({
      rowVersion: corrected.body.data.rowVersion,
    }).expect(409);
    expect(confirmed.body.error.code).toBe('ALREADY_CONFIRMED');

    const rankings = await agent.get(`/api/events/${eventId}/rankings?classId=${classId}`).expect(200);
    expect(rankings.body.data).toHaveLength(5);
    expect(rankings.body.data[0].wins).toBeGreaterThanOrEqual(rankings.body.data[1].wins);
    for (const row of rankings.body.data) {
      expect(row.pointDifference).toBe(row.pointsFor - row.pointsAgainst);
      expect(row.played).toBe(row.wins + row.losses);
    }
  });

  it('supports cancellation and no-show with valid state transitions', async () => {
    const waiting = (await agent.get(`/api/events/${eventId}/matches?status=WAITING`).expect(200)).body.data;
    const cancelled = await agent.post(`/api/events/${eventId}/matches/${waiting[0].matchId}/action`).send({
      action: 'CANCEL', rowVersion: waiting[0].rowVersion,
    }).expect(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');
    const noShow = await agent.post(`/api/events/${eventId}/matches/${waiting[1].matchId}/action`).send({
      action: 'NO_SHOW', rowVersion: waiting[1].rowVersion,
    }).expect(200);
    expect(noShow.body.data.status).toBe('NO_SHOW');
    await agent.post(`/api/events/${eventId}/matches/${waiting[1].matchId}/action`).send({
      action: 'START', rowVersion: noShow.body.data.rowVersion,
    }).expect(409);
  });
});
