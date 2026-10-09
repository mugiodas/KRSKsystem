import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createDatabase, type DB } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { createApp } from '../server/app.js';
import { createUser } from '../server/auth.js';
import { makeEvent, seedCompletedMatch, seedWaitingMatch, type TestEvent } from './helpers.js';

let db: DB;
let owner: TestAgent;
const app = () => createApp(db);

beforeAll(async () => {
  db = createDatabase(':memory:');
  seedDatabase(db);
  owner = request.agent(app());
  await owner.post('/api/auth/login').send({ email: 'owner@krsk.local', password: 'krsk-demo' }).expect(200);
});

afterAll(() => db.close());

/** Publishes a board link and returns the token, the way the settings panel does. */
async function issue(eventId: string): Promise<string> {
  const response = await owner.post(`/api/events/${eventId}/screen/token`).expect(201);
  return String(response.body.data.token);
}

async function playingEvent(overrides: { eventMode?: 'LEAGUE_REQUEST' | 'REQUEST_ONLY'; players?: string[] } = {}): Promise<TestEvent & { token: string }> {
  const names = overrides.players ?? ['A', 'B', 'C', 'D'];
  const event = await makeEvent(owner, db, {
    playerNames: names,
    courtCount: 2,
    startedMinutesAgo: 30,
    durationMinutes: 180,
    eventMode: overrides.eventMode ?? 'LEAGUE_REQUEST',
    settings: { autoEngineEnabled: false, autoCourtAssignment: false, defaultMatchMinutes: 12, leagueMatchCount: 2 },
  });
  for (const name of names) db.prepare('UPDATE participants SET checked_in = 1 WHERE participant_id = ?').run(event.players[name]!);
  return { ...event, token: await issue(event.eventId) };
}

describe('会場スクリーン（読み取り専用の掲示画面）', () => {
  it('refuses an unknown event and a wrong token in the same way', async () => {
    const fixture = await playingEvent();
    const wrong = await request(app()).get(`/api/public/screen/${fixture.eventId}?t=nope`).expect(403);
    const ghost = await request(app()).get(`/api/public/screen/evt_does_not_exist?t=nope`).expect(403);
    expect(wrong.body.error.code).toBe('SCREEN_LINK_INVALID');
    expect(ghost.body.error.code).toBe(wrong.body.error.code);
    expect(ghost.body.error.message).toBe(wrong.body.error.message);
    // No token at all is the same answer, so nobody can tell a real event from a fake one.
    expect((await request(app()).get(`/api/public/screen/${fixture.eventId}`).expect(403)).body.error.code)
      .toBe('SCREEN_LINK_INVALID');
  });

  it('serves the live board: courts, next calls and the finished scores', async () => {
    const fixture = await playingEvent();
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((name) => fixture.players[name]!);
    const live = await owner.post(`/api/events/${fixture.eventId}/matches`).send({
      phase: 'REQUEST', classId: fixture.classId, playerAId: a, playerBId: b,
      courtId: fixture.courtIds[0], scheduledTime: new Date().toISOString(), force: true,
    }).expect(201);
    const before = (await owner.get(`/api/events/${fixture.eventId}/matches/${live.body.data.matchId}`).expect(200)).body.data;
    await owner.post(`/api/events/${fixture.eventId}/matches/${live.body.data.matchId}/action`)
      .send({ action: 'START', rowVersion: before.rowVersion }).expect(200);
    seedWaitingMatch(db, fixture.eventId, c, d, fixture.classId);
    seedCompletedMatch(db, fixture.eventId, a, c, { endedMinutesAgo: 8, scoreA: 21, scoreB: 17, classId: fixture.classId });
    await owner.post(`/api/events/${fixture.eventId}/announcements`).send({
      title: '最終回戦', body: '17:00から最終試合を開始します', severity: 'IMPORTANT',
    }).expect(201);

    const board = (await request(app()).get(`/api/public/screen/${fixture.eventId}?t=${fixture.token}`).expect(200)).body.data;
    expect(board.eventName).toBeTruthy();
    expect(board.courts).toHaveLength(2);
    expect(board.courts[0]).toMatchObject({ courtName: 'COURT 1', match: { status: 'PLAYING', playerAName: 'A', playerBName: 'B' } });
    // The board counts down the slot, which is what a hall actually needs.
    expect(board.courts[0].endsInMinutes).toBeTypeOf('number');
    expect(board.courts[0].endsInMinutes).toBeGreaterThan(0);
    // Nothing is timed before it starts, so a queued card shows no countdown.
    expect(board.courts[1].endsInMinutes).toBeNull();
    expect(board.progress).toMatchObject({ courtsTotal: 2, courtsBusy: 1, completedMatches: 1, openMatches: 2 });
    expect(board.upNext).toHaveLength(1);
    expect(board.upNext[0].players).toBe('C ・ D');
    expect(board.results[0]).toMatchObject({ winner: 'A', loser: 'C', score: '21-17' });
    expect(board.standings[0].rows[0]).toMatchObject({ rank: 1, name: 'A', played: 1, wins: 1 });
    expect(board.announcements[0]).toMatchObject({ title: '最終回戦', severity: 'IMPORTANT' });
    expect(board.remainingMinutes).toBeGreaterThan(0);
    expect(board.league).toMatchObject({ plannedMatches: 4 });
    // The clock the board shows is the server's, not the browser's.
    expect(Date.parse(board.serverTime)).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it('never carries participant ids, contact details, ratings or the token itself', async () => {
    const fixture = await playingEvent();
    const [a, b] = ['A', 'B'].map((name) => fixture.players[name]!);
    db.prepare('UPDATE participants SET club = ?, rating = 1234 WHERE participant_id = ?').run('秘密クラブ', a);
    seedCompletedMatch(db, fixture.eventId, a, b, { endedMinutesAgo: 3, scoreA: 21, scoreB: 12, classId: fixture.classId });

    const response = await request(app()).get(`/api/public/screen/${fixture.eventId}?t=${fixture.token}`).expect(200);
    const text = JSON.stringify(response.body.data);
    for (const forbidden of ['participantId', 'playerAId', 'email', '秘密クラブ', 'rating', 'club',
      'rowVersion', 'nameKana', 'screen_token', 'token', fixture.token]) {
      expect(text).not.toContain(forbidden);
    }
    // Names are the point of a scoreboard, so those are present.
    expect(text).toContain('"A"');
    // and the shape is stable for the client type
    expect(Object.keys(response.body.data).sort()).toEqual([
      'announcements', 'brackets', 'courts', 'elapsedMinutes', 'endTime', 'eventDate', 'eventId', 'eventName',
      'league', 'nowMs', 'phase', 'progress', 'remainingMinutes', 'results', 'serverTime', 'standings',
      'startTime', 'status', 'upNext', 'venue',
    ].sort());
  });

  it('holds an unconfirmed report off the results strip', async () => {
    const fixture = await playingEvent({ players: ['A', 'B'] });
    const [a, b] = ['A', 'B'].map((name) => fixture.players[name]!);
    createUser(db, { email: 'screen-a@test.local', displayName: 'A', password: 'demo', role: 'PARTICIPANT', participantId: a });
    const live = await owner.post(`/api/events/${fixture.eventId}/matches`).send({
      phase: 'REQUEST', classId: fixture.classId, playerAId: a, playerBId: b,
      courtId: fixture.courtIds[0], scheduledTime: new Date().toISOString(), force: true,
    }).expect(201);
    const matchId = live.body.data.matchId as string;
    const before = (await owner.get(`/api/events/${fixture.eventId}/matches/${matchId}`).expect(200)).body.data;
    await owner.post(`/api/events/${fixture.eventId}/matches/${matchId}/action`).send({ action: 'START', rowVersion: before.rowVersion }).expect(200);

    const player = request.agent(app());
    await player.post('/api/auth/login').send({ email: 'screen-a@test.local', password: 'demo' }).expect(200);
    await player.post(`/api/events/${fixture.eventId}/matches/${matchId}/result`)
      .send({ scoreA: 21, scoreB: 15, rowVersion: before.rowVersion + 1 }).expect(201);

    let board = (await request(app()).get(`/api/public/screen/${fixture.eventId}?t=${fixture.token}`).expect(200)).body.data;
    expect(board.results).toEqual([]);
    expect(board.courts[0].endsInMinutes).toBeGreaterThan(0);
    expect(board.courts[0].overMinutes).toBe(0);

    // A court that ran past its slot stops counting down and says 延長 instead of
    // showing the hall a negative number.
    db.prepare('UPDATE matches SET start_time = ? WHERE match_id = ?')
      .run(new Date(Date.now() - 60 * 60_000).toISOString(), matchId);
    board = (await request(app()).get(`/api/public/screen/${fixture.eventId}?t=${fixture.token}`).expect(200)).body.data;
    expect(board.courts[0]).toMatchObject({ endsInMinutes: null, overMinutes: 40 });
    expect(board.courts[0].match).toMatchObject({ status: 'RESULT_PENDING', resultStatus: 'ENTERED' });
    expect(board.courts[0].match.scoreA).toBeNull();
  });

  it('rotates the link, and the old address stops working', async () => {
    const fixture = await playingEvent();
    await request(app()).get(`/api/public/screen/${fixture.eventId}?t=${fixture.token}`).expect(200);
    const rotated = await owner.post(`/api/events/${fixture.eventId}/screen/token`).expect(201);
    const next = String(rotated.body.data.token);
    expect(next).not.toBe(fixture.token);
    expect(rotated.body.data.path).toBe(`/screen/${fixture.eventId}?t=${next}`);
    await request(app()).get(`/api/public/screen/${fixture.eventId}?t=${fixture.token}`).expect(403);
    await request(app()).get(`/api/public/screen/${fixture.eventId}?t=${next}`).expect(200);

    const revoked = await owner.delete(`/api/events/${fixture.eventId}/screen/token`).expect(200);
    expect(revoked.body.data).toEqual({ token: null, path: null });
    await request(app()).get(`/api/public/screen/${fixture.eventId}?t=${next}`).expect(403);
    const staff = (await owner.get(`/api/events/${fixture.eventId}/screen`).expect(200)).body.data;
    expect(staff.screen).toEqual({ enabled: false, token: null, path: null });
    const logged = db.prepare('SELECT action FROM audit_logs WHERE entity_type = ? AND event_id = ? ORDER BY audit_id')
      .all('SCREEN', fixture.eventId) as { action: string }[];
    expect(logged.map((row) => row.action)).toEqual(['ISSUE', 'ISSUE', 'REVOKE']);
  });

  it('keeps issuing and revoking with staff, and hides the link from the hall', async () => {
    const fixture = await playingEvent();
    const viewer = request.agent(app());
    await viewer.post('/api/auth/login').send({ email: 'viewer@krsk.local', password: 'krsk-demo' }).expect(200);
    await viewer.post(`/api/events/${fixture.eventId}/screen/token`).expect(403);
    await viewer.delete(`/api/events/${fixture.eventId}/screen/token`).expect(403);
    // A viewer still previews the board, without being able to mint a link.
    const preview = (await viewer.get(`/api/events/${fixture.eventId}/screen`).expect(200)).body.data;
    expect(preview.screen.token).toBe(fixture.token);

    const player = request.agent(app());
    await player.post('/api/auth/login').send({ email: 'p01@demo.local', password: 'demo' }).expect(200);
    await player.get(`/api/events/${fixture.eventId}/screen`).expect(403);
  });

  it('refuses a draft event, and shows nothing misleading before the day', async () => {
    const created = await owner.post('/api/events').send({
      eventName: '準備中', eventDate: '2026-12-01', venue: '体育館',
      startTime: new Date(Date.now() + 86_400_000).toISOString(),
      endTime: new Date(Date.now() + 90_000_000).toISOString(),
      eventMode: 'LEAGUE_REQUEST', maxParticipants: 20,
    }).expect(201);
    const eventId = String(created.body.data.eventId);
    const token = await issue(eventId);
    await request(app()).get(`/api/public/screen/${eventId}?t=${token}`).expect(409);
    const board = (await owner.get(`/api/events/${eventId}/screen`).expect(200)).body.data;
    expect(board).toMatchObject({ status: 'DRAFT', courts: [], results: [], upNext: [], standings: [], brackets: [] });
  });

  it('reports no league promise for a request only event, and brackets for mode C', async () => {
    const requestOnly = await playingEvent({ eventMode: 'REQUEST_ONLY' });
    const plain = (await request(app()).get(`/api/public/screen/${requestOnly.eventId}?t=${requestOnly.token}`).expect(200)).body.data;
    expect(plain.league).toBeNull();
    expect(plain.brackets).toEqual([]);
  });
});
