// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { buildAlerts } from '../lib/alerts';
import type { CourtRow, EngineState, EventDetail, MatchRow, ParticipantRow } from '../api/types';
import { CourtLive } from '../components/dashboard/CourtLive';
import { MatchQueue } from '../components/dashboard/MatchQueue';
import { ParticipantStatus } from '../components/dashboard/ParticipantStatus';
import { AlertRail } from '../components/dashboard/AlertRail';

const NOW = Date.parse('2026-04-11T09:00:00.000Z');

const event = {
  eventId: 'evt_1', eventName: 'DEMO', eventDate: '2026-04-11', venue: 'v',
  startTime: new Date(NOW - 90 * 60_000).toISOString(), endTime: new Date(NOW + 90 * 60_000).toISOString(),
  status: 'RUNNING', eventMode: 'LEAGUE_REQUEST', currentPhase: 'LEAGUE', maxParticipants: 20,
  defaultMatchMinutes: 15, resultInputGraceMinutes: 3, safetyMarginMinutes: 5, minimumRestMinutes: 8,
} as unknown as EventDetail;

const match = (over: Partial<MatchRow>): MatchRow => ({
  matchId: 'm1', eventId: 'evt_1', phase: 'LEAGUE', classId: 'c1', className: 'A',
  playerAId: 'p1', playerBId: 'p2', playerAName: '古谷 莉歩', playerBName: '森 悠人',
  playerAClub: '唐崎', playerBClub: '守山', courtId: 'ct1', courtName: 'COURT 1', courtNumber: 1,
  scheduledTime: new Date(NOW - 20 * 60_000).toISOString(), calledTime: null, startTime: null, endTime: null,
  status: 'WAITING', source: 'AUTO', priorityScore: 40, scoreA: null, scoreB: null, winnerId: null,
  rowVersion: 1, updatedAt: new Date(NOW - 60_000).toISOString(), ...over,
});

const court = (over: Partial<CourtRow>): CourtRow => ({
  courtId: 'ct1', eventId: 'evt_1', courtNumber: 1, courtName: 'COURT 1', status: 'AVAILABLE',
  availableFrom: '', availableTo: '', priority: 1, enabled: 1, currentMatchId: null, rowVersion: 1, ...over,
});

const player = (over: Partial<ParticipantRow>): ParticipantRow => ({
  participantId: 'p1', eventId: 'evt_1', name: '古谷 莉歩', nameKana: 'ふるや', club: '唐崎', grade: '6年',
  gender: 'FEMALE', category: 'SINGLES', classId: 'c1', className: 'Aクラス', rating: 1100,
  active: 1, checkedIn: 1, played: 3, wins: 2, rowVersion: 1, updatedAt: '', ...over,
});

const engineWith = (waiting: EngineState['waitingPlayers'], over: Partial<EngineState> = {}): EngineState => ({
  ranAt: new Date(NOW).toISOString(), eventId: 'evt_1', eventName: 'DEMO', phase: 'LEAGUE', eventMode: 'LEAGUE_REQUEST',
  eventStatus: 'RUNNING', engineEnabled: true, autoCourtAssignment: true, allowRequest: true,
  remainingMinutes: 90, matchSlotMinutes: 23, timeProtected: false, eligibleCount: waiting.length, busyPlayerCount: 2,
  courts: [], freeCourtCount: 1, queue: [], waitingPlayers: waiting, evaluatedPairs: 24, candidates: [],
  blocked: [], blockedCounts: {}, weights: {}, ...over,
});

describe('Phase 4: dashboard alert rules', () => {
  it('raises a missing result alert only after the grace period', () => {
    const pending = match({ status: 'RESULT_PENDING', startTime: new Date(NOW - 25 * 60_000).toISOString(), endTime: new Date(NOW - 4 * 60_000).toISOString() });
    const alerts = buildAlerts({ event, courts: [court({})], matches: [pending], participants: [], requests: [], engine: null, nowMs: NOW });
    expect(alerts.map((alert) => alert.kind)).toContain('MISSING_RESULT');
    expect(alerts.find((alert) => alert.kind === 'MISSING_RESULT')?.matchId).toBe('m1');

    const fresh = buildAlerts({ event, courts: [court({})],
      matches: [match({ status: 'RESULT_PENDING', endTime: new Date(NOW - 60_000).toISOString() })],
      participants: [], requests: [], engine: null, nowMs: NOW });
    expect(fresh.map((alert) => alert.kind)).not.toContain('MISSING_RESULT');
  });

  it('flags 30+ minute waits and idle courts, but never a busy board', () => {
    const engine = engineWith([
      { participantId: 'p9', name: '池田 紬', className: 'B', rating: 960, played: 0, wins: 0, waitingMinutes: 38, lastEndTime: null, restReady: true, restReadyInMinutes: 0, activeRequests: 0 },
      { participantId: 'p10', name: '橋本 蒼', className: 'B', rating: 990, played: 1, wins: 0, waitingMinutes: 31, lastEndTime: null, restReady: true, restReadyInMinutes: 0, activeRequests: 0 },
    ]);
    const alerts = buildAlerts({ event, courts: [court({})], matches: [], participants: [player({ played: 0 })], requests: [], engine, nowMs: NOW });
    const kinds = alerts.map((alert) => alert.kind);
    expect(kinds).toContain('LONG_WAIT');
    expect(kinds).toContain('IDLE_COURT');
    expect(kinds).toContain('UNDER_MATCHED');
    expect(alerts[0].severity).not.toBe('INFO');

    const busyCourt = buildAlerts({ event,
      courts: [court({ status: 'PLAYING', currentMatchId: 'm1' })],
      matches: [match({ status: 'PLAYING', startTime: new Date(NOW - 5 * 60_000).toISOString() })],
      participants: [player({})], requests: [], engine: engineWith([], { freeCourtCount: 0 }), nowMs: NOW });
    expect(busyCourt.map((alert) => alert.kind)).not.toContain('IDLE_COURT');
  });

  it('reports a called match that has not started, and honours end time protection', () => {
    const late = match({ status: 'CALLED', scheduledTime: new Date(NOW - 12 * 60_000).toISOString(), calledTime: new Date(NOW - 12 * 60_000).toISOString() });
    const alerts = buildAlerts({ event, courts: [court({})], matches: [late], participants: [], requests: [],
      engine: engineWith([], { timeProtected: true, remainingMinutes: 12 }), nowMs: NOW });
    expect(alerts.map((alert) => alert.kind)).toEqual(expect.arrayContaining(['DELAY', 'TIME_PROTECTED']));
    // Operational problems lead; pure information sinks to the bottom.
    expect(alerts[0].kind).toBe('DELAY');
    expect(alerts.at(-1)?.kind).toBe('TIME_PROTECTED');

    const veryLate = buildAlerts({ event, courts: [court({})],
      matches: [match({ status: 'CALLED', scheduledTime: new Date(NOW - 26 * 60_000).toISOString() })],
      participants: [], requests: [], engine: null, nowMs: NOW });
    expect(veryLate[0].severity).toBe('URGENT');
  });
});

describe('Phase 4: dashboard rendering', () => {
  it('renders courts with players, clock and the result action', () => {
    const playing = match({ status: 'PLAYING', scoreA: 11, scoreB: 9, startTime: new Date(NOW - 8 * 60_000).toISOString(), courtId: 'ct1' });
    const html = renderToStaticMarkup(createElement(CourtLive, {
      courts: [court({}), court({ courtId: 'ct2', courtNumber: 2, courtName: 'COURT 2', status: 'AVAILABLE' })],
      matches: [playing], nowMs: NOW, canOperate: true, matchMinutes: 16,
      onStart: () => undefined, onFinish: () => undefined, onResult: () => undefined, onCall: () => undefined, onManualAssign: () => undefined, onConfirm: () => undefined,
    }));
    expect(html).toContain('COURT LIVE');
    expect(html).toContain('古谷 莉歩');
    expect(html).toContain('結果入力');
    expect(html).toContain('8:00');            // live stopwatch, not a placeholder
    expect(html).toContain('空き');            // the idle court is visible as an action slot
    expect(html).toMatch(/1 \/ 2/);
  });

  it('renders the queue ordered by engine priority with per row actions', () => {
    const html = renderToStaticMarkup(createElement(MatchQueue, {
      matches: [match({ matchId: 'm1', priorityScore: 20, status: 'WAITING' }), match({ matchId: 'm2', priorityScore: 95, status: 'WAITING', playerAName: '橋本 蒼' })],
      requests: [], nowMs: NOW, canOperate: true, timeProtected: false, freeCourts: [{ courtId: 'ct1', courtName: 'COURT 1' }],
      onCall: () => undefined, onAssign: () => undefined, onCancel: () => undefined, onNoShow: () => undefined,
    }));
    expect(html).toContain('MATCH QUEUE');
    expect(html.indexOf('橋本 蒼')).toBeLessThan(html.indexOf('古谷 莉歩')); // higher priority first
    expect(html).toContain('呼出');
    expect(html).toContain('95');
  });

  it('shows waiting minutes as a ranked bar for the operator', () => {
    const engine = engineWith([
      { participantId: 'p1', name: '古谷 莉歩', className: 'A', rating: 1100, played: 3, wins: 2, waitingMinutes: 41, lastEndTime: null, restReady: true, restReadyInMinutes: 0, activeRequests: 1 },
      { participantId: 'p2', name: '森 悠人', className: 'A', rating: 1000, played: 5, wins: 1, waitingMinutes: 4, lastEndTime: null, restReady: true, restReadyInMinutes: 0, activeRequests: 0 },
    ]);
    const html = renderToStaticMarkup(createElement(ParticipantStatus, {
      participants: [player({}), player({ participantId: 'p2', name: '森 悠人', played: 5, wins: 1 })],
      engine, matches: [], requests: [], selectedIds: [], onToggleSelect: () => undefined,
    }));
    expect(html).toContain('PARTICIPANT STATUS');
    expect(html).toContain('41');
    expect(html).toContain('希望');
    expect(html).toContain('width:100%'); // the longest wait fills the bar
  });

  it('renders an all-clear state instead of fake alerts', () => {
    const empty = renderToStaticMarkup(createElement(AlertRail, { alerts: [], onJump: () => undefined, loading: false }));
    expect(empty).toContain('対応が必要な問題はありません');
    const filled = renderToStaticMarkup(createElement(AlertRail, {
      alerts: [{ id: 'x', severity: 'URGENT', kind: 'MISSING_RESULT', title: '結果が未入力です', detail: 'COURT 1', matchId: 'm1' }],
      onJump: () => undefined, loading: false,
    }));
    expect(filled).toContain('要即時対応');
  });
});
