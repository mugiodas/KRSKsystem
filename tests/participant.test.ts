import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createDatabase, type DB } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { createApp } from '../server/app.js';

const DEMO = 'evt_demo_krsk';

/**
 * Phase 5 covers the participant phone surface: one aggregate endpoint that
 * has to stay fast, honest about waiting, and strict about privacy.
 */
describe('Phase 5: participant aggregate and announcements', () => {
  let db: DB;
  let app: ReturnType<typeof createApp>;
  let owner: any;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    seedDatabase(db);
    app = createApp(db);
    owner = request.agent(app);
    await owner.post('/api/auth/login').send({ email: 'owner@krsk.local', password: 'krsk-demo' });
  });

  afterEach(() => db.close());

  async function participantView(email: string, query = '') {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email, password: 'demo' });
    const response = await agent.get(`/api/events/${DEMO}/me${query}`);
    return response;
  }

  it('returns the participant identity, today record and announcements', async () => {
    const response = await participantView('p01@demo.local');
    expect(response.status).toBe(200);
    const body = response.body.data;
    expect(body.participant.name).toBe('古谷 莉歩');
    expect(body.participant.checkedIn).toBe(true);
    expect(body.today.played).toBeGreaterThanOrEqual(1);
    expect(body.history).toHaveLength(body.today.played);
    expect(body.announcements.length).toBeGreaterThan(0);
    expect(body.event.eventName).toBeTruthy();
    expect(body.waiting.slotMinutes).toBeGreaterThan(10);

    // No internal bookkeeping or identity fields leak into the phone payload.
    const raw = JSON.stringify(body);
    for (const forbidden of ['nameKana', 'name_kana', 'password', 'passwordHash', 'email']) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it('ignores a forged participantId for participants but honours it for staff preview', async () => {
    const forged = await participantView('p01@demo.local', '?participantId=demo_p02');
    expect(forged.status).toBe(200);
    expect(forged.body.data.participant.participantId).toBe('demo_p01');

    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: 'owner@krsk.local', password: 'krsk-demo' });
    const preview = await agent.get(`/api/events/${DEMO}/me?participantId=demo_p02`).expect(200);
    expect(preview.body.data.participant.participantId).toBe('demo_p02');
  });

  it('estimates the wait from live queue position, courts and slot length', async () => {
    const view = await participantView('p01@demo.local');
    const { waiting, nextMatch } = view.body.data;
    if (nextMatch && nextMatch.status !== 'WAITING') {
      expect(waiting.estimateMinutes).toBe(0);
    } else if (waiting.position !== null && !waiting.restBlocked) {
      const rounds = Math.floor((waiting.position - 1) / Math.max(1, waiting.freeCourts * 2)) + 1;
      expect(waiting.estimateMinutes).toBeGreaterThan(0);
      expect(waiting.estimateMinutes).toBeLessThanOrEqual(rounds * waiting.slotMinutes + waiting.slotMinutes);
    } else {
      expect(waiting.estimateMinutes).toBeGreaterThan(0);
    }
    expect(waiting.waitingCount).toBeGreaterThanOrEqual(0);
  });

  it('lets staff broadcast an announcement that the phone reads back', async () => {
    const created = await owner.post(`/api/events/${DEMO}/announcements`)
      .send({ title: '終盤戦の注意事項', body: '17:30以降は新しい試合を作成しません。結果入力にご協力ください。', severity: 'URGENT' })
      .expect(201);
    expect(created.body.data.active).toBe(1);

    const view = await participantView('p03@demo.local');
    expect(view.body.data.announcements[0].title).toBe('終盤戦の注意事項');
    expect(view.body.data.announcements[0].severity).toBe('URGENT');

    const viewer = request.agent(app);
    await viewer.post('/api/auth/login').send({ email: 'viewer@krsk.local', password: 'krsk-demo' });
    await viewer.post(`/api/events/${DEMO}/announcements`).send({ title: 'x', body: 'y' }).expect(403);
  });

  it('drops a deactivated announcement from the phone but keeps it in history', async () => {
    const list = await owner.get(`/api/events/${DEMO}/announcements?all=true`).expect(200);
    const target = list.body.data[0];
    await owner.patch(`/api/events/${DEMO}/announcements/${target.announcementId}`).send({ active: false }).expect(200);

    const active = await owner.get(`/api/events/${DEMO}/announcements`).expect(200);
    expect(active.body.data.map((row: { announcementId: string }) => row.announcementId)).not.toContain(target.announcementId);
    const view = await participantView('p02@demo.local');
    expect(view.body.data.announcements.map((row: { title: string }) => row.title)).not.toContain(target.title);
  });

  it('lets a participant send a request and see it in their own aggregate', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: 'p04@demo.local', password: 'demo' });
    const suggestions = await agent.get(`/api/events/${DEMO}/requests/suggestions`).expect(200);
    const target = suggestions.body.data.find((row: { headToHead: number }) => row.headToHead === 0)
      ?? suggestions.body.data[0];

    const created = await agent.post(`/api/events/${DEMO}/requests`)
      .send({ targetPlayerId: target.participantId, priority: 1 }).expect(201);
    expect(created.body.data.status).toBe('ACTIVE');
    expect(created.body.data.own).toBe(true);

    const view = await agent.get(`/api/events/${DEMO}/me`).expect(200);
    const mine = view.body.data.requests.find((row: { requestId: string }) => row.requestId === created.body.data.requestId);
    expect(mine).toBeTruthy();
    expect(mine.mine).toBe(true);
    expect(mine.targetName).toBe(target.name);
  });

  it('refuses the aggregate endpoint for staff accounts with no participant link', async () => {
    const viewer = request.agent(app);
    await viewer.post('/api/auth/login').send({ email: 'viewer@krsk.local', password: 'krsk-demo' });
    const response = await viewer.get(`/api/events/${DEMO}/me`);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('PARTICIPANT_REQUIRED');
  });
});
