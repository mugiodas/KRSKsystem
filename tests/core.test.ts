import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createDatabase, type DB } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { createApp } from '../server/app.js';

let db: DB;
let agent: TestAgent;
let eventId: string;

beforeAll(async () => {
  db = createDatabase(':memory:');
  seedDatabase(db);
  agent = request.agent(createApp(db));
  await agent.post('/api/auth/login').send({ email: 'owner@krsk.local', password: 'krsk-demo' }).expect(200);
});

afterAll(() => db.close());

describe('Phase 1: event, participant and court core', () => {
  it('requires authentication and separates roles', async () => {
    await request(createApp(db)).get('/api/events').expect(401);
    const participantAgent = request.agent(createApp(db));
    await participantAgent.post('/api/auth/login').send({ email: 'p01@demo.local', password: 'demo' }).expect(200);
    const events = await participantAgent.get('/api/events').expect(200);
    expect(events.body.data).toHaveLength(1);
    await participantAgent.post('/api/events').send({}).expect(403);
  });

  it('creates, edits, starts and completes an event with optimistic locking', async () => {
    const start = new Date(Date.now() + 3_600_000);
    const end = new Date(start.getTime() + 4 * 3_600_000);
    const created = await agent.post('/api/events').send({
      eventName: '統合テスト交流戦', eventDate: start.toISOString().slice(0, 10), venue: 'テスト体育館',
      startTime: start.toISOString(), endTime: end.toISOString(), eventMode: 'REQUEST_ONLY', maxParticipants: 40,
    }).expect(201);
    eventId = created.body.data.eventId;
    expect(created.body.data.currentPhase).toBe('REQUEST');

    const edited = await agent.patch(`/api/events/${eventId}`).send({
      venue: '更新済み体育館', rowVersion: created.body.data.rowVersion,
    }).expect(200);
    expect(edited.body.data.venue).toBe('更新済み体育館');
    await agent.patch(`/api/events/${eventId}`).send({ venue: '競合', rowVersion: created.body.data.rowVersion }).expect(409);

    const started = await agent.post(`/api/events/${eventId}/status`).send({
      status: 'RUNNING', rowVersion: edited.body.data.rowVersion,
    }).expect(200);
    expect(started.body.data.status).toBe('RUNNING');
    const completed = await agent.post(`/api/events/${eventId}/status`).send({
      status: 'COMPLETED', rowVersion: started.body.data.rowVersion,
    }).expect(200);
    expect(completed.body.data.status).toBe('COMPLETED');
    await agent.post(`/api/events/${eventId}/status`).send({ status: 'RUNNING', rowVersion: completed.body.data.rowVersion }).expect(409);
  });

  it('registers participants, prevents normalized duplicates, and safely disables them', async () => {
    const event = await agent.get(`/api/events/${eventId}`).expect(200);
    const classCreated = await agent.post(`/api/events/${eventId}/classes`).send({ className: '初級', displayOrder: 1 }).expect(201);
    const first = await agent.post(`/api/events/${eventId}/participants`).send({
      name: 'テスト 選手', nameKana: 'てすと せんしゅ', classId: classCreated.body.data.classId, rating: 900,
    }).expect(201);
    expect(first.body.data.active).toBe(1);
    await agent.post(`/api/events/${eventId}/participants`).send({ name: 'テスト　選手' }).expect(409);
    const disabled = await agent.patch(`/api/events/${eventId}/participants/${first.body.data.participantId}`).send({
      active: false, rowVersion: first.body.data.rowVersion,
    }).expect(200);
    expect(disabled.body.data.active).toBe(0);
    expect(event.body.data.summary.participantCount).toBe(0);
  });

  it('adds and updates a court while validating its availability window', async () => {
    const event = (await agent.get(`/api/events/${eventId}`).expect(200)).body.data;
    const court = await agent.post(`/api/events/${eventId}/courts`).send({
      courtNumber: 1, courtName: 'メインコート', availableFrom: event.startTime,
      availableTo: event.endTime, priority: 1,
    }).expect(201);
    const blocked = await agent.patch(`/api/events/${eventId}/courts/${court.body.data.courtId}`).send({
      status: 'MAINTENANCE', rowVersion: court.body.data.rowVersion,
    }).expect(200);
    expect(blocked.body.data.status).toBe('MAINTENANCE');
    await agent.post(`/api/events/${eventId}/courts`).send({
      courtNumber: 2, courtName: '不正コート', availableFrom: event.endTime, availableTo: event.startTime,
    }).expect(400);
  });
});
