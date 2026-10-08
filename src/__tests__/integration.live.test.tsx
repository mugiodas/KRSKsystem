// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Server } from 'node:http';
import { createDatabase, transaction } from '../../server/db.js';
import { seedDatabase } from '../../server/seed.js';
import { createApp } from '../../server/app.js';
import { CourtLive } from '../components/dashboard/CourtLive';
import { MatchQueue } from '../components/dashboard/MatchQueue';
import { ParticipantStatus } from '../components/dashboard/ParticipantStatus';
import { buildAlerts } from '../lib/alerts';

/**
 * Renders the operator board against the real HTTP API (express + SQLite in
 * memory) so a broken response shape fails the suite instead of the venue.
 */
describe('Phase 4: dashboard against the live API', () => {
  let server: Server;
  let base = '';
  let cookie = '';

  beforeAll(async () => {
    const db = createDatabase(':memory:');
    seedDatabase(db);
    transaction(db, () => {
      db.prepare(`UPDATE events SET start_time = datetime('now','-70 minutes'), end_time = datetime('now','+170 minutes') WHERE event_id = 'evt_demo_krsk'`).run();
    });
    server = createApp(db).listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@krsk.local', password: 'krsk-demo' }),
    });
    cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
  });

  afterAll(() => { server.close(); });

  async function get<T>(path: string): Promise<T> {
    const res = await fetch(`${base}${path}`, { headers: { cookie } });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return (await res.json() as { data: T }).data;
  }

  it('renders courts, queue and participant status from persisted data', async () => {
    const eventId = 'evt_demo_krsk';
    const [event, courts, matches, participants, requests, engine] = await Promise.all([
      get<Record<string, any>>(`/api/events/${eventId}`),
      get<Array<Record<string, any>>>(`/api/events/${eventId}/courts`),
      get<Array<Record<string, any>>>(`/api/events/${eventId}/matches?limit=500`),
      get<Array<Record<string, any>>>(`/api/events/${eventId}/participants`),
      get<Array<Record<string, any>>>(`/api/events/${eventId}/requests`),
      get<Record<string, any>>(`/api/events/${eventId}/engine/state`),
    ]);
    const nowMs = Date.now();
    const live = matches.filter((match) => ['WAITING', 'CALLED', 'COURT_ASSIGNED', 'PLAYING', 'RESULT_PENDING'].includes(String(match.status)));
    const alerts = buildAlerts({ event: event as never, courts: courts as never, matches: live as never, participants: participants as never, requests: requests as never, engine: engine as never, nowMs });

    const courtsHtml = renderToStaticMarkup(createElement(CourtLive, {
      courts: courts as never, matches: live as never, nowMs, canOperate: true, matchMinutes: 19,
      onStart: () => undefined, onFinish: () => undefined, onResult: () => undefined, onCall: () => undefined, onManualAssign: () => undefined,
    }));
    const queueHtml = renderToStaticMarkup(createElement(MatchQueue, {
      matches: live as never, requests: requests as never, nowMs, canOperate: true,
      timeProtected: Boolean(engine.timeProtected),
      freeCourts: courts.filter((court) => court.status === 'AVAILABLE').map((court) => ({ courtId: court.courtId, courtName: court.courtName })),
      onCall: () => undefined, onAssign: () => undefined, onCancel: () => undefined, onNoShow: () => undefined,
    }));
    const statusHtml = renderToStaticMarkup(createElement(ParticipantStatus, {
      participants: participants as never, engine: engine as never, matches: live as never, requests: requests as never, selectedIds: [], onToggleSelect: () => undefined,
    }));
    const html = `${courtsHtml}${queueHtml}${statusHtml}`;

    // The demo event ships with 4 courts and 20 participants: every one of them
    // must reach the DOM, which proves the API shapes match the UI contract.
    expect(courts).toHaveLength(4);
    expect(courts.filter((court) => courtsHtml.includes(String(court.courtName)))).toHaveLength(4);
    expect(participants.filter((player) => html.includes(String(player.name)))).toHaveLength(participants.length);
    expect(statusHtml).toContain('PARTICIPANT STATUS');
    expect(queueHtml).toContain('MATCH QUEUE');
    expect(html).toContain('待ち時間');
    expect(engine.evaluatedPairs).toBeGreaterThan(0);
    expect(Array.isArray(alerts)).toBe(true);
  }, 25_000);
});
