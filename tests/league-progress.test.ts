import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createDatabase, type DB } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { createApp } from '../server/app.js';
import { createUser } from '../server/auth.js';
import { makeEvent, patchEvent, seedCompletedMatch, seedWaitingMatch, type TestEvent } from './helpers.js';
import { buildLeagueProgress, computeLeaguePlan, leagueTargets } from '../server/services/league.js';
import { runIntegrityChecks } from '../server/services/integrity.js';

let db: DB;
let agent: TestAgent;
const app = () => createApp(db);

beforeAll(async () => {
  db = createDatabase(':memory:');
  seedDatabase(db);
  agent = request.agent(app());
  await agent.post('/api/auth/login').send({ email: 'owner@krsk.local', password: 'krsk-demo' }).expect(200);
});

afterAll(() => db.close());

const checkIn = (...ids: string[]) => {
  for (const id of ids) db.prepare('UPDATE participants SET checked_in = 1 WHERE participant_id = ?').run(id,);
};
const progress = async (eventId: string) => (await agent.get(`/api/events/${eventId}/league/progress`).expect(200)).body.data;

/** A league event with 1 court and 20 minute slots, so time maths is predictable. */
async function leagueFixture(options: { players?: number; startedMinutesAgo?: number; durationMinutes?: number; settings?: Record<string, unknown> } = {}): Promise<TestEvent & { names: string[] }> {
  const names = Array.from({ length: options.players ?? 4 }, (_, index) => `P${index + 1}`);
  const event = await makeEvent(agent, db, {
    playerNames: names,
    courtCount: 1,
    startedMinutesAgo: options.startedMinutesAgo ?? 30,
    durationMinutes: options.durationMinutes ?? 240,
    eventMode: 'LEAGUE_REQUEST',
    settings: {
      autoEngineEnabled: false, autoCourtAssignment: false, minimumRestMinutes: 0,
      defaultMatchMinutes: 12, resultInputGraceMinutes: 3, safetyMarginMinutes: 5,
      leagueMatchCount: 1, leagueType: 'LIMITED_ROUND_ROBIN', ...options.settings,
    },
  });
  checkIn(...names.map((name) => event.players[name]!));
  return { ...event, names };
}

describe('リーグ消化の計画と不足警告', () => {
  it('promises each player exactly the cards the generator would schedule', async () => {
    const fixture = await leagueFixture({ players: 5, settings: { leagueMatchCount: 4 } });
    const plan = computeLeaguePlan(db, fixture.eventId)!;
    // 5 players => 5 rounds with one bye each, sliced to 4: 2 cards per round.
    expect(plan.classes[0]).toMatchObject({ size: 5, roundsPlanned: 4, pairsPlanned: 8 });
    expect(plan.plannedMatches).toBe(8);
    const targets = plan.players.map((player) => player.target);
    expect(targets.reduce((sum, value) => sum + value, 0)).toBe(16);
    // The byes of the first four rounds land on four different players: one is promised 4.
    expect(targets.filter((value) => value === 3)).toHaveLength(4);
    expect(targets.filter((value) => value === 4)).toHaveLength(1);
    expect(leagueTargets(plan).get(fixture.players.P1!)).toBe(targets[0]);

    const view = await progress(fixture.eventId);
    expect(view).toMatchObject({ applicable: true, plannedMatches: 8, playerCount: 5, classCount: 1 });
    expect(view.perPlayer).toMatchObject({ avg: 0, min: 0, max: 0, target: 4 });
  });

  it('treats a full round robin as unlimited rounds', async () => {
    const fixture = await leagueFixture({ players: 5, settings: { leagueMatchCount: 1, leagueType: 'FULL_ROUND_ROBIN' } });
    const view = await progress(fixture.eventId);
    expect(view).toMatchObject({ leagueType: 'FULL_ROUND_ROBIN', plannedMatches: 10, roundsOutstanding: 4 });
    expect(view.classes[0]).toMatchObject({ roundsPlanned: 5 });
  });

  it('warns while the plan is behind, and says so loudly when the clock runs out', async () => {
    const room = await leagueFixture({ players: 4 });
    const view = await progress(room.eventId);
    expect(view.status).toBe('BEHIND');
    expect(view).toMatchObject({ playersUnderTarget: 4, mostMissing: 1, completedMatches: 0 });
    // one outstanding round = 2 cards on 1 court = 2 slots of 20 minutes
    expect(view.minutesNeeded).toBe(40);
    expect(view.minutesRemaining).toBeGreaterThan(view.minutesNeeded);
    // Nothing is actually broken: the board is just behind its own plan.
    expect(runIntegrityChecks(db, room.eventId).violations).toEqual([]);

    // Same event, but five minutes from the whistle.
    const late = await leagueFixture({ players: 4, startedMinutesAgo: 235, durationMinutes: 240 });
    const urgent = await progress(late.eventId);
    expect(urgent.status).toBe('WONT_FIT');
    expect(urgent.minutesRemaining).toBeLessThan(urgent.minutesNeeded);
  });

  it('counts cards that exist but have not been played yet', async () => {
    const fixture = await leagueFixture({ players: 4 });
    const [a, b, c, d] = fixture.names.map((name) => fixture.players[name]!);
    seedWaitingMatch(db, fixture.eventId, a, b, fixture.classId);
    seedWaitingMatch(db, fixture.eventId, c, d, fixture.classId);
    const view = await progress(fixture.eventId);
    expect(view).toMatchObject({ status: 'ON_TRACK', playersUnderTarget: 0, completedMatches: 0, inFlightMatches: 2 });
    expect(view.completionRate).toBe(0);

    // Finishing one card moves the class to half done; nobody is over the plan because
    // the other pair is still on the board.
    const first = db.prepare(`SELECT match_id FROM matches WHERE event_id = ? AND player_a_id = ? AND player_b_id = ?`)
      .get(fixture.eventId, a, b) as { match_id: string };
    db.prepare(`UPDATE matches SET status = 'COMPLETED', score_a = 21, score_b = 19, winner_id = ?, end_time = ?
      WHERE match_id = ?`).run(a, new Date().toISOString(), first.match_id);
    const ownerId = String((db.prepare('SELECT user_id FROM users LIMIT 1').get() as { user_id: string }).user_id);
    db.prepare(`INSERT INTO results (result_id, match_id, score_a, score_b, winner_id, entered_by, status, entered_at, updated_at)
      VALUES ('res_league_probe', ?, 21, 19, ?, ?, 'CONFIRMED', ?, ?)`)
      .run(first.match_id, a, ownerId, new Date().toISOString(), new Date().toISOString());
    const after = await progress(fixture.eventId);
    expect(after).toMatchObject({ completedMatches: 1, inFlightMatches: 1, completionRate: 0.5, playersUnderTarget: 0 });
  });

  it('lets a walkover settle a promise but never a cancelled card', async () => {
    const fixture = await leagueFixture({ players: 2 });
    const [a, b] = fixture.names.map((name) => fixture.players[name]!);
    const matchId = seedWaitingMatch(db, fixture.eventId, a, b, fixture.classId);
    expect((await progress(fixture.eventId)).status).toBe('ON_TRACK');

    // NO_SHOW (a walkover) is a card both players got; CANCELLED erases it.
    db.prepare(`UPDATE matches SET status = 'NO_SHOW' WHERE match_id = ?`).run(matchId);
    const forfeit = await progress(fixture.eventId);
    expect(forfeit).toMatchObject({ status: 'ON_TRACK', completedMatches: 0, inFlightMatches: 0 });
    expect(forfeit.classes[0].cancelled).toBe(1);

    db.prepare(`UPDATE matches SET status = 'CANCELLED' WHERE match_id = ?`).run(matchId);
    const voided = await progress(fixture.eventId);
    expect(voided.status).toBe('BEHIND');
    expect(voided.playersUnderTarget).toBe(2);
  });

  it('names the players the operator has to fix, and only for staff', async () => {
    const fixture = await leagueFixture({ players: 4 });
    const [a, b] = fixture.names.map((name) => fixture.players[name]!);
    seedCompletedMatch(db, fixture.eventId, a, b, { endedMinutesAgo: 5, scoreA: 21, scoreB: 15, classId: fixture.classId });
    const staff = await progress(fixture.eventId);
    expect(staff.shortfalls).toHaveLength(2);
    expect(staff.shortfalls[0]).toMatchObject({ target: 1, played: 0, scheduled: 0, shortfall: 1 });
    expect(staff.shortfalls.map((row: { name: string }) => row.name).sort()).toEqual(['P3', 'P4']);

    // A player may see the aggregate, never somebody else's shortfall list.
    const participantId = fixture.players.P3!;
    createUser(db, { email: 'short@league.test', displayName: 'P3', password: 'demo', role: 'PARTICIPANT', participantId });
    const player = request.agent(app());
    await player.post('/api/auth/login').send({ email: 'short@league.test', password: 'demo' }).expect(200);
    const mine = (await player.get(`/api/events/${fixture.eventId}/league/progress`).expect(200)).body.data;
    expect(mine.shortfalls).toEqual([]);
    expect(mine).toMatchObject({ applicable: true, playersUnderTarget: 2 });
    expect(JSON.stringify(mine)).not.toContain('P4');
  });

  it('has nothing to promise for a request-only event', async () => {
    const fixture = await makeEvent(agent, db, { playerNames: ['A', 'B'], courtCount: 1 });
    const view = await progress(fixture.eventId);
    expect(view).toMatchObject({ applicable: false, status: 'NOT_APPLICABLE', plannedMatches: 0, shortfalls: [] });
    const roster = (await agent.get(`/api/events/${fixture.eventId}/participants`).expect(200)).body.data;
    expect(roster[0]).toMatchObject({ leagueTarget: 0, leaguePlayed: 0, leagueShortfall: 0 });
  });

  it('carries the promise next to the roster figures and into the report', async () => {
    const fixture = await leagueFixture({ players: 4 });
    const [a, b] = fixture.names.map((name) => fixture.players[name]!);
    seedCompletedMatch(db, fixture.eventId, a, b, { endedMinutesAgo: 5, scoreA: 21, scoreB: 15, classId: fixture.classId });
    const roster = (await agent.get(`/api/events/${fixture.eventId}/participants`).expect(200)).body.data;
    expect(roster.find((row: { participantId: string }) => row.participantId === a))
      .toMatchObject({ leagueTarget: 1, leaguePlayed: 1, leagueShortfall: 0 });
    expect(roster.find((row: { participantId: string }) => row.participantId === b)).toMatchObject({ leagueShortfall: 0 });
    expect(roster.find((row: { participantId: string }) => row.participantId === fixture.players.P3!))
      .toMatchObject({ leagueTarget: 1, leaguePlayed: 0, leagueShortfall: 1 });

    // The polled event detail and the report must agree with the endpoint.
    const detail = (await agent.get(`/api/events/${fixture.eventId}`).expect(200)).body.data;
    expect(detail.league).toMatchObject({ status: 'BEHIND', plannedMatches: 2, completedMatches: 1 });
    expect(detail.league.shortfalls).toEqual([]);   // the poll stays small
    const report = (await agent.get(`/api/events/${fixture.eventId}/report`).expect(200)).body.data;
    expect(report.league).toMatchObject({
      status: 'BEHIND', plannedMatches: 2, completedMatches: 1, completionRate: 0.5,
      // A round only counts as finished once every card it promised is off the board.
      roundsPlanned: 1, roundsFinished: 0, playersUnderTarget: 2, mostMissing: 1,
    });
    expect(report.league.shortfalls.map((row: { name: string }) => row.name).sort()).toEqual(['P3', 'P4']);
    const csv = (await agent.get(`/api/events/${fixture.eventId}/report.csv`).expect(200)).text;
    expect(csv).toContain('リーグ消化,1/2試合');
    expect(csv).toContain('リーグ未消化,2名');
    expect(csv).toContain('リーグ未消化,選手名,クラス,計画,消化,不足');

    // Filling in the last pair of the round closes the plan: no alert, no shortfall line.
    const [c, d] = ['P3', 'P4'].map((name) => fixture.players[name]!);
    seedCompletedMatch(db, fixture.eventId, c, d, { endedMinutesAgo: 2, scoreA: 21, scoreB: 17, classId: fixture.classId });
    expect((await agent.get(`/api/events/${fixture.eventId}/report`).expect(200)).body.data.league)
      .toMatchObject({ status: 'ON_TRACK', completionRate: 1, roundsFinished: 1, completedMatches: 2, playersUnderTarget: 0 });
    const done = (await agent.get(`/api/events/${fixture.eventId}/report.csv`).expect(200)).text;
    expect(done).toContain('リーグ消化,2/2試合');
    expect(done).not.toContain('リーグ未消化');
  });

  it('follows the plan when the settings change mid-event', async () => {
    const fixture = await leagueFixture({ players: 4 });
    expect((await progress(fixture.eventId)).plannedMatches).toBe(2);
    await patchEvent(agent, fixture.eventId, { leagueMatchCount: 2 });
    const after = await progress(fixture.eventId);
    expect(after).toMatchObject({ plannedMatches: 4, matchCountSetting: 2, roundsOutstanding: 2 });
    // 2 outstanding rounds of a 2 pair class on 1 court = 2 x (2 slots x 20 min / 2 rounds)
    expect(after.classes[0]).toMatchObject({ minutesPerRound: 40, minutesPlanned: 80 });
    expect(after.minutesNeeded).toBe(80);
  });
});
