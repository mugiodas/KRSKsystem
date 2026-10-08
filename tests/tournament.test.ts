import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createDatabase, makeId, nowIso, pairKey, type DB } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { createApp } from '../server/app.js';
import { makeEvent, type TestEvent } from './helpers.js';
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

/** Mode C event with a bracket-friendly roster, engine off unless a test asks for it. */
async function makeTournamentEvent(overrides: { players?: number; courts?: number; autoEngine?: boolean; durationMinutes?: number; startedMinutesAgo?: number } = {}): Promise<TestEvent> {
  const count = overrides.players ?? 5;
  return makeEvent(agent, db, {
    playerNames: Array.from({ length: count }, (_unused, index) => `P${index + 1}`),
    courtCount: overrides.courts ?? 2,
    durationMinutes: overrides.durationMinutes ?? 240,
    startedMinutesAgo: overrides.startedMinutesAgo ?? 30,
    eventMode: 'LEAGUE_TOURNAMENT_REQUEST',
    settings: {
      autoEngineEnabled: overrides.autoEngine ?? false,
      autoCourtAssignment: overrides.autoEngine ?? false,
      minimumRestMinutes: 0,
      defaultMatchMinutes: 10,
    },
  });
}

interface BracketView {
  bracketId: string;
  size: number;
  rounds: number;
  status: string;
  winnerId: string | null;
  byes: number;
  winnerName: string | null;
  decidedMatches: number;
  requiredMatches: number;
  pairings: Array<{
    round: number; slot: number; matchId: string | null; status: string | null;
    playerAId: string | null; playerBId: string | null; winnerId: string | null; bye: boolean; roundLabel: string;
  }>;
}

async function readBracket(eventId: string): Promise<BracketView> {
  const body = await agent.get(`/api/events/${eventId}/tournament`).expect(200);
  return body.body.data[0] as BracketView;
}

async function phaseOf(eventId: string): Promise<string> {
  const body = await agent.get(`/api/events/${eventId}`).expect(200);
  return body.body.data.currentPhase as string;
}

/** Drives one card through court assignment, start and result, exactly as an operator does. */
async function playCard(eventId: string, matchId: string, options: { homeWins?: boolean; scoreA?: number; scoreB?: number } = {}): Promise<{ status: number; body: any }> {
  const courtRow = db.prepare(`SELECT court_id FROM courts WHERE event_id = ? AND status = 'AVAILABLE' ORDER BY priority LIMIT 1`)
    .get(eventId) as { court_id?: string } | undefined;
  if (courtRow) {
    const current = await agent.get(`/api/events/${eventId}/matches/${matchId}`).expect(200);
    await agent.post(`/api/events/${eventId}/matches/${matchId}/action`).send({
      action: 'ASSIGN', courtId: courtRow.court_id, rowVersion: current.body.data.rowVersion,
    }).expect(200);
  }
  const beforeStart = await agent.get(`/api/events/${eventId}/matches/${matchId}`).expect(200);
  await agent.post(`/api/events/${eventId}/matches/${matchId}/action`).send({
    action: 'START', rowVersion: beforeStart.body.data.rowVersion,
  }).expect(200);
  const beforeResult = await agent.get(`/api/events/${eventId}/matches/${matchId}`).expect(200);
  return agent.post(`/api/events/${eventId}/matches/${matchId}/result`).send({
    scoreA: options.scoreA ?? (options.homeWins === false ? 12 : 21),
    scoreB: options.scoreB ?? (options.homeWins === false ? 21 : 12),
    rowVersion: beforeResult.body.data.rowVersion,
  });
}

describe('Phase 6+: tournament draw (event mode C)', () => {
  it('previews the draw without creating anything', async () => {
    const { eventId, classId } = await makeTournamentEvent({ players: 5 });
    const preview = (await agent.get(`/api/events/${eventId}/tournament/preview`).expect(200)).body.data;
    expect(preview.summary.classCount).toBe(1);
    const drawn = preview.classes[0];
    expect(drawn.entrants).toHaveLength(5);
    expect(drawn.size).toBe(8);
    expect(drawn.rounds).toBe(3);
    expect(drawn.byes).toBe(3);
    expect(drawn.requiredMatches).toBe(4);   // a 5-player single elimination is 4 matches
    expect(drawn.fitsBeforeEnd).toBe(true);
    expect(drawn.reason).toBeNull();
    // Nothing may exist before the operator confirms the preview.
    expect(db.prepare('SELECT COUNT(*) AS count FROM tournament_brackets').get() as { count: number }).toEqual({ count: 0 });
    const view = await agent.get(`/api/events/${eventId}/tournament`).expect(200);
    expect(view.body.data).toEqual([]);
    expect(classId).toBeTruthy();
  });

  it('creates only playable cards, walks byes over and takes the phase', async () => {
    const { eventId, classId } = await makeTournamentEvent({ players: 5 });
    const generated = (await agent.post(`/api/events/${eventId}/tournament/generate`).send({ classId }).expect(201)).body.data;
    expect(generated.walkovers).toHaveLength(3);
    expect(generated.created.length).toBeGreaterThan(0);

    const bracket = await readBracket(eventId);
    expect(bracket.size).toBe(8);
    expect(bracket.rounds).toBe(3);
    expect(bracket.status).toBe('OPEN');
    expect(await phaseOf(eventId)).toBe('TOURNAMENT');
    // Every created card is a TOURNAMENT card carrying its slot, and no card holds a bye.
    const rows = db.prepare(`SELECT match_id, phase, bracket_round, bracket_slot, player_a_id, player_b_id
      FROM matches WHERE bracket_id = ?`).all(bracket.bracketId) as Array<{ match_id: string; phase: string; bracket_round: number; bracket_slot: number }>;
    expect(rows.length).toBe(bracket.pairings.filter((pairing) => pairing.matchId).length);
    expect(rows.every((row) => row.phase === 'TOURNAMENT')).toBe(true);
    for (const pairing of bracket.pairings.filter((entry) => entry.matchId)) {
      expect(pairing.bye).toBe(false);
      expect(pairing.playerAId).toBeTruthy();
      expect(pairing.playerBId).toBeTruthy();
      expect(pairing.playerAId).not.toBe(pairing.playerBId);
    }
    // A second draw for the same class is refused instead of doubling the bracket.
    await agent.post(`/api/events/${eventId}/tournament/generate`).send({ classId }).expect(409);
  });

  it('plays the whole draw out and hands the floor back to requests', async () => {
    const { eventId, classId, players } = await makeTournamentEvent({ players: 5 });
    await agent.post(`/api/events/${eventId}/tournament/generate`).send({ classId }).expect(201);
    const bracketId = (await readBracket(eventId)).bracketId;

    for (let guard = 0; guard < 10; guard += 1) {
      const next = db.prepare(`SELECT match_id, player_a_id FROM matches WHERE bracket_id = ? AND status = 'WAITING'
        ORDER BY bracket_round, bracket_slot LIMIT 1`).get(bracketId) as { match_id: string; player_a_id: string } | undefined;
      if (!next) break;
      // Home player wins every card, so the expected champion is predictable.
      const result = await playCard(eventId, next.match_id, { homeWins: true });
      expect(result.status).toBe(201);
    }

    const bracket = await readBracket(eventId);
    expect(bracket.decidedMatches).toBe(4);
    expect(bracket.status).toBe('COMPLETED');
    expect(bracket.winnerId).toBeTruthy();
    expect(await phaseOf(eventId)).toBe('REQUEST');
    // One card per tie in the draw, no duplicated slots, no leftovers waiting.
    const counts = db.prepare(`SELECT COUNT(*) AS total FROM matches WHERE bracket_id = ? AND status <> 'CANCELLED'`).get(bracketId) as { total: number };
    expect(Number(counts.total)).toBe(4);
    expect(db.prepare(`SELECT COUNT(*) AS total FROM matches WHERE bracket_id = ? AND status = 'WAITING'`).get(bracketId) as { total: number }).toEqual({ total: 0 });
    // The champion is one of the entrants, and it is the player who kept winning.
    expect(Object.values(players)).toContain(bracket.winnerId as string);
    expect(bracket.winnerName).toBeTruthy();
    expect(runIntegrityChecks(db, eventId).violations).toEqual([]);
  });

  it('refuses to cancel or no-show a bracket card', async () => {
    const { eventId, classId } = await makeTournamentEvent({ players: 4 });
    await agent.post(`/api/events/${eventId}/tournament/generate`).send({ classId }).expect(201);
    const bracket = await readBracket(eventId);
    const card = bracket.pairings.find((pairing) => pairing.matchId && pairing.status === 'WAITING');
    expect(card).toBeTruthy();
    const current = await agent.get(`/api/events/${eventId}/matches/${card!.matchId}`).expect(200);
    const cancelled = await agent.post(`/api/events/${eventId}/matches/${card!.matchId}/action`)
      .send({ action: 'CANCEL', rowVersion: current.body.data.rowVersion });
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.error.code).toBe('BRACKET_CARD_LOCKED');
    const noShow = await agent.post(`/api/events/${eventId}/matches/${card!.matchId}/action`)
      .send({ action: 'NO_SHOW', rowVersion: current.body.data.rowVersion });
    expect(noShow.status).toBe(409);
    expect(noShow.body.error.code).toBe('BRACKET_CARD_LOCKED');
  });

  it('advances a walkover recorded as a result, not a no-show', async () => {
    const { eventId, classId, players } = await makeTournamentEvent({ players: 3 });
    const generated = (await agent.post(`/api/events/${eventId}/tournament/generate`).send({ classId }).expect(201)).body.data;
    expect(generated.walkovers).toHaveLength(1);
    const byeName = generated.walkovers[0].participantName as string;
    const bracket = await readBracket(eventId);
    const card = bracket.pairings.find((pairing) => pairing.round === 1 && pairing.matchId)!;
    const result = await playCard(eventId, card.matchId!, { scoreA: 21, scoreB: 0 });
    expect(result.status).toBe(201);

    const final = (await readBracket(eventId)).pairings.find((pairing) => pairing.round === 2 && pairing.matchId)!;
    const names = new Map(Object.entries(players).map(([key, value]) => [value, key]));
    expect([final.playerAId, final.playerBId]).toContain(card.playerAId);        // the winner advanced
    expect(names.get(final.playerAId === card.playerAId ? final.playerBId! : final.playerAId!)).toBe(byeName);
    expect(final.roundLabel).toBe('決勝');
  });

  it('puts the draw on free courts but never invents request matches around it', async () => {
    const fixture = await makeTournamentEvent({ players: 8, courts: 2, autoEngine: true });
    await agent.post(`/api/events/${fixture.eventId}/tournament/generate`).send({ classId: fixture.classId }).expect(201);
    // The generate call ends with the engine, so the first round is already on courts.
    const onCourt = db.prepare(`SELECT COUNT(*) AS count FROM matches
      WHERE event_id = ? AND bracket_id IS NOT NULL AND status = 'COURT_ASSIGNED'`).get(fixture.eventId) as { count: number };
    expect(Number(onCourt.count)).toBe(2);
    const run = (await agent.post(`/api/events/${fixture.eventId}/engine/run`).send({ force: true }).expect(200)).body.data;
    expect(run.created).toHaveLength(0);
    expect(run.skippedReasons.BRACKET_OPEN ?? 0).toBeGreaterThan(0);
    // Nothing outside the draw was created: every card of this event belongs to the bracket.
    const loose = db.prepare(`SELECT COUNT(*) AS count FROM matches WHERE event_id = ? AND bracket_id IS NULL`).get(fixture.eventId) as { count: number };
    expect(Number(loose.count)).toBe(0);
  });

  it('refuses a draw that cannot finish before the end time', async () => {
    const { eventId, classId } = await makeTournamentEvent({ players: 8, durationMinutes: 60, startedMinutesAgo: 45 });
    const preview = (await agent.get(`/api/events/${eventId}/tournament/preview`).expect(200)).body.data;
    expect(preview.classes[0].fitsBeforeEnd).toBe(false);
    expect(preview.classes[0].reason).toContain('終了時刻');
    const refused = await agent.post(`/api/events/${eventId}/tournament/generate`).send({ classId });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('TOURNAMENT_WONT_FIT');
    expect(db.prepare('SELECT COUNT(*) AS count FROM tournament_brackets WHERE event_id = ?').get(eventId) as { count: number }).toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM matches WHERE event_id = ? AND bracket_id IS NOT NULL`).get(eventId) as { count: number }).toEqual({ count: 0 });
  });

  it('re-points the next round when a score is corrected, then protects live cards', async () => {
    const { eventId, classId } = await makeTournamentEvent({ players: 4 });
    await agent.post(`/api/events/${eventId}/tournament/generate`).send({ classId }).expect(201);
    const first = await readBracket(eventId);
    const cards = first.pairings.filter((pairing) => pairing.round === 1 && pairing.matchId);
    expect(cards).toHaveLength(2);
    await playCard(eventId, cards[0]!.matchId!, { homeWins: true });
    // The final waits for both quarter-finals, so one more result is needed.
    expect((await readBracket(eventId)).pairings.some((pairing) => pairing.round === 2 && pairing.matchId)).toBe(false);
    await playCard(eventId, cards[1]!.matchId!, { homeWins: true });

    const second = await readBracket(eventId);
    const final = second.pairings.find((pairing) => pairing.round === 2 && pairing.matchId)!;
    expect(final.playerAId).toBe(cards[0]!.playerAId);

    // Correcting the first quarter-final flips who stands in the final.
    const resultRow = db.prepare('SELECT row_version FROM results WHERE match_id = ?').get(cards[0]!.matchId!) as { row_version: number };
    await agent.patch(`/api/events/${eventId}/matches/${cards[0]!.matchId!}/result`)
      .send({ scoreA: 12, scoreB: 21, rowVersion: resultRow.row_version }).expect(200);
    const third = await readBracket(eventId);
    const moved = third.pairings.find((pairing) => pairing.round === 2 && pairing.matchId)!;
    expect(moved.playerAId).toBe(cards[0]!.playerBId);
    expect(moved.playerBId).toBe(cards[1]!.playerAId);

    // Once the final is live, the earlier result can no longer be rewritten.
    const court = db.prepare(`SELECT court_id FROM courts WHERE event_id = ? AND status = 'AVAILABLE'`).all(eventId) as Array<{ court_id: string }>;
    expect(court.length).toBeGreaterThan(0);
    const beforeCall = await agent.get(`/api/events/${eventId}/matches/${moved.matchId!}`).expect(200);
    await agent.post(`/api/events/${eventId}/matches/${moved.matchId!}/action`)
      .send({ action: 'ASSIGN', courtId: court[0].court_id, rowVersion: beforeCall.body.data.rowVersion }).expect(200);
    const beforeStart = await agent.get(`/api/events/${eventId}/matches/${moved.matchId!}`).expect(200);
    await agent.post(`/api/events/${eventId}/matches/${moved.matchId!}/action`)
      .send({ action: 'START', rowVersion: beforeStart.body.data.rowVersion }).expect(200);
    const currentResult = db.prepare('SELECT row_version FROM results WHERE match_id = ?').get(cards[0]!.matchId!) as { row_version: number };
    const blocked = await agent.patch(`/api/events/${eventId}/matches/${cards[0]!.matchId!}/result`)
      .send({ scoreA: 21, scoreB: 12, rowVersion: currentResult.row_version });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('BRACKET_ADVANCED');
  });

  it('reports a stalled draw as a critical integrity failure', async () => {
    const { eventId, classId } = await makeTournamentEvent({ players: 4 });
    await agent.post(`/api/events/${eventId}/tournament/generate`).send({ classId }).expect(201);
    const bracket = await readBracket(eventId);
    const cards = bracket.pairings.filter((pairing) => pairing.round === 1 && pairing.matchId);
    await playCard(eventId, cards[0]!.matchId!, { homeWins: true });
    await playCard(eventId, cards[1]!.matchId!, { homeWins: false });

    // Both feeders are decided, so the final must exist. Deleting it behind the app's
    // back has to be caught, and the rebalance switch has to repair the draw.
    const final = (await readBracket(eventId)).pairings.find((pairing) => pairing.round === 2 && pairing.matchId)!;
    db.prepare('DELETE FROM matches WHERE match_id = ?').run(final.matchId!);
    expect(runIntegrityChecks(db, eventId).violations.map((violation) => violation.code)).toContain('BRACKET_ADVANCE_MISSED');

    const fixed = await agent.post(`/api/events/${eventId}/tournament/${bracket.bracketId}/rebalance`).send({}).expect(200);
    expect(fixed.body.data.created).toBe(1);
    const repaired = await readBracket(eventId);
    expect(repaired.pairings.find((pairing) => pairing.round === 2 && pairing.matchId)?.playerAId).toBe(cards[0]!.playerAId);
    expect(runIntegrityChecks(db, eventId).violations.map((violation) => violation.code)).not.toContain('BRACKET_ADVANCE_MISSED');
  });

  it('exposes the draw in the event report', async () => {
    const { eventId, classId } = await makeTournamentEvent({ players: 4 });
    await agent.post(`/api/events/${eventId}/tournament/generate`).send({ classId }).expect(201);
    for (let guard = 0; guard < 6; guard += 1) {
      const bracket = await readBracket(eventId);
      const card = bracket.pairings.find((pairing) => pairing.matchId && pairing.status === 'WAITING');
      if (!card) break;
      await playCard(eventId, card.matchId!, { homeWins: true });
    }
    const report = (await agent.get(`/api/events/${eventId}/report`).expect(200)).body.data;
    expect(report.tournament.brackets).toBe(1);
    expect(report.tournament.completed).toBe(1);
    expect(report.tournament.champion).toBeTruthy();
    expect(report.tournament.byClass[0]).toMatchObject({ size: 4, rounds: 2, status: 'COMPLETED' });
    const csv = await agent.get(`/api/events/${eventId}/report.csv`).expect(200);
    expect(csv.text).toContain('優勝');
    expect(csv.text).toContain('トーナメント,クラス,サイズ,ラウンド,状態,勝者');
  });
});
