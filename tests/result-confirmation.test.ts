import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createDatabase, type DB } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { createApp } from '../server/app.js';
import { createUser } from '../server/auth.js';
import { makeEvent, type TestEvent } from './helpers.js';
import { runIntegrityChecks } from '../server/services/integrity.js';
import { confirmStaleResults } from '../server/services/results.js';

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

interface Fixture extends TestEvent {
  playerAgent: (name: string) => Promise<TestAgent>;
}

/** A running event whose players each have a login, so the two-step can be driven for real. */
async function makeFixture(overrides: { players?: string[]; courts?: number; settings?: Record<string, unknown>; eventMode?: 'LEAGUE_REQUEST' | 'REQUEST_ONLY' | 'LEAGUE_TOURNAMENT_REQUEST' } = {}): Promise<Fixture> {
  const names = overrides.players ?? ['A', 'B', 'C'];
  const event = await makeEvent(owner, db, {
    playerNames: names,
    courtCount: overrides.courts ?? 1,
    durationMinutes: 240,
    startedMinutesAgo: 30,
    eventMode: overrides.eventMode ?? 'REQUEST_ONLY',
    settings: { autoEngineEnabled: false, autoCourtAssignment: false, minimumRestMinutes: 0, defaultMatchMinutes: 10, ...overrides.settings },
  });
  const emails: Record<string, string> = {};
  for (const [name, participantId] of Object.entries(event.players)) {
    const email = `${name.toLowerCase()}-${participantId.slice(-6)}@test.local`;
    createUser(db, { email, displayName: name, password: 'demo', role: 'PARTICIPANT', participantId });
    emails[name] = email;
  }
  return {
    ...event,
    playerAgent: async (name: string) => {
      const agent = request.agent(app());
      await agent.post('/api/auth/login').send({ email: emails[name], password: 'demo' }).expect(200);
      return agent;
    },
  };
}

/** Manual card on a court, started by staff, so the match is in PLAYING. */
async function startCard(fixture: Fixture, aName: string, bName: string): Promise<{ matchId: string; courtId: string }> {
  const created = await owner.post(`/api/events/${fixture.eventId}/matches`).send({
    classId: fixture.classId, playerAId: fixture.players[aName], playerBId: fixture.players[bName],
    courtId: fixture.courtIds[0], scheduledTime: new Date().toISOString(),
  }).expect(201);
  const matchId = created.body.data.matchId as string;
  const before = await owner.get(`/api/events/${fixture.eventId}/matches/${matchId}`).expect(200);
  await owner.post(`/api/events/${fixture.eventId}/matches/${matchId}/action`)
    .send({ action: 'START', rowVersion: before.body.data.rowVersion }).expect(200);
  return { matchId, courtId: fixture.courtIds[0]! };
}

const versionOf = (matchId: string) => Number((db.prepare('SELECT row_version FROM matches WHERE match_id = ?').get(matchId) as { row_version: number }).row_version);
const resultRow = (matchId: string) => db.prepare('SELECT * FROM results WHERE match_id = ?').get(matchId) as Record<string, any>;
const matchRow = (matchId: string) => db.prepare('SELECT * FROM matches WHERE match_id = ?').get(matchId) as Record<string, any>;

describe('Phase 6+: two-step result confirmation (ENTERED → CONFIRMED)', () => {
  it('holds a player report as unconfirmed without touching the standings', async () => {
    const fixture = await makeFixture();
    const { matchId, courtId } = await startCard(fixture, 'A', 'B');
    const alice = await fixture.playerAgent('A');

    const submitted = await alice.post(`/api/events/${fixture.eventId}/matches/${matchId}/result`)
      .send({ scoreA: 21, scoreB: 15, rowVersion: versionOf(matchId) }).expect(201);
    expect(submitted.body.data.resultStatus).toBe('ENTERED');
    expect(submitted.body.data.confirmed).toBe(false);
    expect(submitted.body.data.status).toBe('RESULT_PENDING');
    // The provisional score lives on the result row only.
    expect(matchRow(matchId).score_a).toBeNull();
    expect(matchRow(matchId).winner_id).toBeNull();
    expect(resultRow(matchId).status).toBe('ENTERED');
    expect(resultRow(matchId).entered_by_participant).toBe(fixture.players.A);
    expect(resultRow(matchId).score_a).toBe(21);
    // Nothing is counted yet: no ranking row, and the court stays occupied.
    const rankings = (await owner.get(`/api/events/${fixture.eventId}/rankings?classId=${fixture.classId}`).expect(200)).body.data;
    expect(rankings.find((row: { participantId: string }) => row.participantId === fixture.players.A).played).toBe(0);
    expect((db.prepare('SELECT status FROM courts WHERE court_id = ?').get(courtId) as { status: string }).status).not.toBe('AVAILABLE');
    // The QA switch must not treat a legitimately pending report as an orphan.
    const report = runIntegrityChecks(db, fixture.eventId);
    expect(report.violations.map((violation) => violation.code)).not.toContain('ORPHAN_RESULT');
    expect(report.checks).toBe(20);
  });

  it('confirms itself when both players report the same score, and frees the court', async () => {
    const fixture = await makeFixture();
    const { matchId, courtId } = await startCard(fixture, 'A', 'B');
    const alice = await fixture.playerAgent('A');
    const bob = await fixture.playerAgent('B');
    await alice.post(`/api/events/${fixture.eventId}/matches/${matchId}/result`)
      .send({ scoreA: 21, scoreB: 15, rowVersion: versionOf(matchId) }).expect(201);

    const agreed = await bob.post(`/api/events/${fixture.eventId}/matches/${matchId}/result`)
      .send({ scoreA: 21, scoreB: 15, rowVersion: versionOf(matchId) }).expect(201);
    expect(agreed.body.data.resultStatus).toBe('CONFIRMED');
    expect(agreed.body.data.status).toBe('COMPLETED');
    expect(agreed.body.data.scoreA).toBe(21);
    expect(agreed.body.data.winnerId).toBe(fixture.players.A);
    expect(resultRow(matchId).status).toBe('CONFIRMED');
    expect((db.prepare('SELECT status FROM courts WHERE court_id = ?').get(courtId) as { status: string }).status).toBe('AVAILABLE');
    const rankings = (await owner.get(`/api/events/${fixture.eventId}/rankings?classId=${fixture.classId}`).expect(200)).body.data;
    expect(rankings.find((row: { participantId: string }) => row.participantId === fixture.players.A)).toMatchObject({ played: 1, wins: 1 });
    expect(runIntegrityChecks(db, fixture.eventId).violations).toEqual([]);
  });

  it('opens a dispute when the two reports differ and lets staff decide', async () => {
    const fixture = await makeFixture();
    const { matchId } = await startCard(fixture, 'A', 'B');
    const alice = await fixture.playerAgent('A');
    const bob = await fixture.playerAgent('B');
    await alice.post(`/api/events/${fixture.eventId}/matches/${matchId}/result`)
      .send({ scoreA: 21, scoreB: 15, rowVersion: versionOf(matchId) }).expect(201);

    const clash = await bob.post(`/api/events/${fixture.eventId}/matches/${matchId}/result`)
      .send({ scoreA: 15, scoreB: 21, rowVersion: versionOf(matchId) }).expect(201);
    expect(clash.body.data.resultStatus).toBe('DISPUTED');
    expect(matchRow(matchId).status).toBe('RESULT_PENDING');
    expect(resultRow(matchId).dispute).toContain('15');
    const flagged = runIntegrityChecks(db, fixture.eventId).violations;
    expect(flagged.map((violation) => violation.code)).toContain('RESULT_DISPUTED');
    expect(flagged.every((violation) => violation.severity !== 'CRITICAL')).toBe(true);

    // The phone shows both claims to the operator.
    const view = (await owner.get(`/api/events/${fixture.eventId}/matches/${matchId}`).expect(200)).body.data;
    expect(view.resultStatus).toBe('DISPUTED');
    expect(view.reportedScoreA).toBe(21);
    expect(view.resultDispute).toMatchObject({ scoreA: 15, scoreB: 21 });

    // Neither side can settle a dispute by themselves - the phone hides both
    // buttons for exactly this reason, so the API has to refuse as well.
    for (const player of [alice, bob]) {
      const attempt = await player.post(`/api/events/${fixture.eventId}/matches/${matchId}/result/confirm`).expect(409);
      expect(attempt.body.error.code).toBe('DISPUTE_REQUIRES_STAFF');
    }
    // A stale dispute is not swept while the event is still running either.
    expect((await owner.post(`/api/events/${fixture.eventId}/results/sweep`).expect(200)).body.data)
      .toMatchObject({ confirmed: 0, disputed: 0 });

    // Staff decides: the write-over both claims and confirms.
    await owner.patch(`/api/events/${fixture.eventId}/matches/${matchId}/result`)
      .send({ scoreA: 21, scoreB: 18, rowVersion: versionOf(matchId) }).expect(200);
    expect(matchRow(matchId).status).toBe('COMPLETED');
    expect(matchRow(matchId).score_a).toBe(21);
    expect(resultRow(matchId).status).toBe('CORRECTED');
    expect(resultRow(matchId).dispute).toBeNull();
    expect(runIntegrityChecks(db, fixture.eventId).violations).toEqual([]);
  });

  it('lets the operator settle a dispute with the reported score as it stands', async () => {
    const fixture = await makeFixture();
    const { matchId, courtId } = await startCard(fixture, 'A', 'B');
    const alice = await fixture.playerAgent('A');
    const bob = await fixture.playerAgent('B');
    await alice.post(`/api/events/${fixture.eventId}/matches/${matchId}/result`)
      .send({ scoreA: 21, scoreB: 15, rowVersion: versionOf(matchId) }).expect(201);
    await bob.post(`/api/events/${fixture.eventId}/matches/${matchId}/result`)
      .send({ scoreA: 15, scoreB: 21, rowVersion: versionOf(matchId) }).expect(201);

    // 「確定」 without rewriting keeps the first report and records who settled it.
    const settled = await owner.post(`/api/events/${fixture.eventId}/matches/${matchId}/result/confirm`).expect(200);
    expect(settled.body.data.resultStatus).toBe('CONFIRMED');
    expect(matchRow(matchId)).toMatchObject({ status: 'COMPLETED', score_a: 21, score_b: 15 });
    const ownerId = String((db.prepare(`SELECT user_id FROM users WHERE email = 'owner@krsk.local'`).get() as { user_id: string }).user_id);
    expect(resultRow(matchId)).toMatchObject({ status: 'CONFIRMED', dispute: null, confirmed_by: ownerId });
    expect(runIntegrityChecks(db, fixture.eventId).violations).toEqual([]);
    expect(db.prepare(`SELECT status FROM courts WHERE court_id = ?`).get(courtId)).toMatchObject({ status: 'AVAILABLE' });
  });

  it('refuses a self-confirmation and accepts the opponent instead', async () => {
    const fixture = await makeFixture();
    const { matchId } = await startCard(fixture, 'A', 'B');
    const alice = await fixture.playerAgent('A');
    const bob = await fixture.playerAgent('B');
    await alice.post(`/api/events/${fixture.eventId}/matches/${matchId}/result`)
      .send({ scoreA: 21, scoreB: 15, rowVersion: versionOf(matchId) }).expect(201);

    const selfish = await alice.post(`/api/events/${fixture.eventId}/matches/${matchId}/result/confirm`).send({});
    expect(selfish.status).toBe(409);
    expect(selfish.body.error.code).toBe('SELF_CONFIRM');

    const rejected = await bob.post(`/api/events/${fixture.eventId}/matches/${matchId}/result/reject`)
      .send({ note: 'こちら側が21-15で取っています' }).expect(200);
    expect(rejected.body.data.resultStatus).toBe('DISPUTED');
    expect(rejected.body.data.claim.note).toContain('21-15');

    // Staff may confirm the report as it stands, without rewriting anything.
    await owner.post(`/api/events/${fixture.eventId}/matches/${matchId}/result/confirm`).send({}).expect(200);
    expect(matchRow(matchId).status).toBe('COMPLETED');
    expect(matchRow(matchId).score_a).toBe(21);
    expect(matchRow(matchId).score_b).toBe(15);
  });

  it('keeps a staff entry one-step, exactly as before', async () => {
    const fixture = await makeFixture();
    const { matchId } = await startCard(fixture, 'A', 'B');
    const entered = await owner.post(`/api/events/${fixture.eventId}/matches/${matchId}/result`)
      .send({ scoreA: 21, scoreB: 19, rowVersion: versionOf(matchId) }).expect(201);
    expect(entered.body.data.status).toBe('COMPLETED');
    expect(entered.body.data.resultStatus).toBe('CONFIRMED');
    expect(resultRow(matchId).status).toBe('CONFIRMED');
    expect(resultRow(matchId).confirmed_by).toBeTruthy();
    const detail = (await owner.get(`/api/events/${fixture.eventId}/matches/${matchId}`).expect(200)).body.data;
    expect(detail.result.status).toBe('CONFIRMED');
    expect(detail.result.enteredByParticipant).toBeNull();
  });

  it('rejects a second report on an already confirmed result', async () => {
    const fixture = await makeFixture();
    const { matchId } = await startCard(fixture, 'A', 'B');
    const alice = await fixture.playerAgent('A');
    const bob = await fixture.playerAgent('B');
    await alice.post(`/api/events/${fixture.eventId}/matches/${matchId}/result`)
      .send({ scoreA: 21, scoreB: 15, rowVersion: versionOf(matchId) }).expect(201);
    await bob.post(`/api/events/${fixture.eventId}/matches/${matchId}/result`)
      .send({ scoreA: 21, scoreB: 15, rowVersion: versionOf(matchId) }).expect(201);

    const late = await bob.post(`/api/events/${fixture.eventId}/matches/${matchId}/result`)
      .send({ scoreA: 21, scoreB: 9, rowVersion: versionOf(matchId) });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('RESULT_ALREADY_CONFIRMED');
  });

  it('auto-confirms a report nobody settles, and sweeps a stale dispute at the end', async () => {
    const fixture = await makeFixture();
    const { matchId, courtId } = await startCard(fixture, 'A', 'B');
    const alice = await fixture.playerAgent('A');
    await alice.post(`/api/events/${fixture.eventId}/matches/${matchId}/result`)
      .send({ scoreA: 21, scoreB: 11, rowVersion: versionOf(matchId) }).expect(201);

    // Nothing is due yet, so a sweep leaves the card waiting for the opponent.
    expect(confirmStaleResults(db, fixture.eventId).confirmed).toBe(0);
    expect(matchRow(matchId).status).toBe('RESULT_PENDING');

    // Age the report past the event's confirm timeout and sweep again.
    db.prepare(`UPDATE results SET entered_at = datetime('now', '-30 minutes') WHERE match_id = ?`).run(matchId);
    expect(runIntegrityChecks(db, fixture.eventId).violations.map((violation) => violation.code)).toContain('RESULT_UNCONFIRMED');
    const swept = confirmStaleResults(db, fixture.eventId);
    expect(swept.confirmed).toBe(1);
    expect(matchRow(matchId).status).toBe('COMPLETED');
    expect(Number(resultRow(matchId).auto_confirmed)).toBe(1);
    expect(resultRow(matchId).confirmed_by).toBeNull();
    expect((db.prepare('SELECT status FROM courts WHERE court_id = ?').get(courtId) as { status: string }).status).toBe('AVAILABLE');
    expect(runIntegrityChecks(db, fixture.eventId).violations).toEqual([]);
  });

  it('lets a timeout of zero confirm a player report immediately', async () => {
    const fixture = await makeFixture({ settings: { resultConfirmTimeoutMinutes: 0 } });
    const { matchId } = await startCard(fixture, 'A', 'B');
    const alice = await fixture.playerAgent('A');
    const submitted = await alice.post(`/api/events/${fixture.eventId}/matches/${matchId}/result`)
      .send({ scoreA: 21, scoreB: 13, rowVersion: versionOf(matchId) }).expect(201);
    expect(submitted.body.data.status).toBe('COMPLETED');
    expect(submitted.body.data.resultStatus).toBe('CONFIRMED');
    expect(Number(resultRow(matchId).auto_confirmed)).toBe(1);
  });

  it('does not advance a tournament card until the report is confirmed', async () => {
    const fixture = await makeFixture({ players: ['A', 'B', 'C', 'D'], courts: 2, eventMode: 'LEAGUE_TOURNAMENT_REQUEST' });
    await owner.post(`/api/events/${fixture.eventId}/tournament/generate`).send({ classId: fixture.classId }).expect(201);
    const bracketId = (await owner.get(`/api/events/${fixture.eventId}/tournament`).expect(200)).body.data[0].bracketId;
    const card = (await owner.get(`/api/events/${fixture.eventId}/tournament`).expect(200)).body.data[0].pairings
      .find((pairing: { matchId: string | null; status: string }) => pairing.matchId && pairing.status === 'WAITING');

    const nameOf = (participantId: string) => Object.entries(fixture.players)
      .find(([, id]) => id === participantId)![0];
    const row = matchRow(card.matchId);
    const reporter = await fixture.playerAgent(nameOf(String(row.player_a_id)));
    const confirmer = await fixture.playerAgent(nameOf(String(row.player_b_id)));
    const freeCourt = (db.prepare(`SELECT court_id FROM courts WHERE event_id = ? AND status = 'AVAILABLE'
      ORDER BY priority LIMIT 1`).get(fixture.eventId) as { court_id: string }).court_id;
    const queued = await owner.get(`/api/events/${fixture.eventId}/matches/${card.matchId}`).expect(200);
    await owner.post(`/api/events/${fixture.eventId}/matches/${card.matchId}/action`)
      .send({ action: 'ASSIGN', courtId: freeCourt, rowVersion: queued.body.data.rowVersion }).expect(200);
    const started = await owner.get(`/api/events/${fixture.eventId}/matches/${card.matchId}`).expect(200);
    await owner.post(`/api/events/${fixture.eventId}/matches/${card.matchId}/action`)
      .send({ action: 'START', rowVersion: started.body.data.rowVersion }).expect(200);
    // The two players settle the card themselves, without staff touching the result.
    const ready = await owner.get(`/api/events/${fixture.eventId}/matches/${card.matchId}`).expect(200);
    const reported = await reporter.post(`/api/events/${fixture.eventId}/matches/${card.matchId}/result`)
      .send({ scoreA: 21, scoreB: 14, rowVersion: ready.body.data.rowVersion }).expect(201);
    expect(reported.body.data.resultStatus).toBe('ENTERED');

    const waiting = (await owner.get(`/api/events/${fixture.eventId}/tournament`).expect(200)).body.data[0];
    expect(waiting.decidedMatches).toBe(0);
    expect(waiting.pairings.some((pairing: { round: number; matchId: string | null }) => pairing.round === 2 && pairing.matchId)).toBe(false);

    const confirmed = await confirmer.post(`/api/events/${fixture.eventId}/matches/${card.matchId}/result/confirm`)
      .send({}).expect(200);
    expect(confirmed.body.data.status).toBe('COMPLETED');
    const advanced = (await owner.get(`/api/events/${fixture.eventId}/tournament`).expect(200)).body.data[0];
    expect(advanced.decidedMatches).toBe(1);
    expect(advanced.bracketId).toBe(bracketId);
    expect(runIntegrityChecks(db, fixture.eventId).violations).toEqual([]);
  });

  it('exposes the confirmation state to the player phone and the report', async () => {
    const fixture = await makeFixture();
    const { matchId } = await startCard(fixture, 'A', 'B');
    const alice = await fixture.playerAgent('A');
    await alice.post(`/api/events/${fixture.eventId}/matches/${matchId}/result`)
      .send({ scoreA: 21, scoreB: 15, rowVersion: versionOf(matchId) }).expect(201);

    const mine = (await alice.get(`/api/events/${fixture.eventId}/me`).expect(200)).body.data;
    expect(mine.nextMatch.result).toMatchObject({ status: 'ENTERED', enteredByMe: true, canConfirm: false, scoreMine: 21, scoreOpponent: 15 });
    const theirs = (await (await fixture.playerAgent('B')).get(`/api/events/${fixture.eventId}/me`).expect(200)).body.data;
    expect(theirs.nextMatch.result).toMatchObject({ status: 'ENTERED', enteredByMe: false, canConfirm: true, scoreMine: 15, scoreOpponent: 21 });

    const report = (await owner.get(`/api/events/${fixture.eventId}/report`).expect(200)).body.data;
    expect(report.confirmations).toMatchObject({ total: 1, entered: 1, confirmed: 0, pendingMatches: 1, byPlayers: 1, autoConfirmed: 0 });
    expect(report.matches.pendingResult).toBe(1);
    expect(report.confirmations.confirmRate).toBe(0);

    await owner.post(`/api/events/${fixture.eventId}/matches/${matchId}/result/confirm`).send({}).expect(200);
    const after = (await owner.get(`/api/events/${fixture.eventId}/report`).expect(200)).body.data;
    expect(after.confirmations).toMatchObject({ confirmed: 1, entered: 0, pendingMatches: 0, avgConfirmMinutes: 0 });
    const csv = await owner.get(`/api/events/${fixture.eventId}/report.csv`).expect(200);
    expect(csv.text).toContain('結果の確定');
  });
});
