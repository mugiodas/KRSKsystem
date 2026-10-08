// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { ReportPanel } from '../components/dashboard/ReportPanel';
import type { EventReport } from '../api/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const report = {
  eventId: 'evt_1',
  eventName: '唐崎ジュニア 練習会',
  eventDate: '2026-04-11',
  venue: '唐崎小学校 体育館',
  status: 'RUNNING',
  eventMode: 'LEAGUE_REQUEST',
  phase: 'LEAGUE',
  generatedAt: '2026-04-11T09:00:00.000Z',
  window: { start: '2026-04-11T08:00:00.000Z', end: '2026-04-11T11:00:00.000Z', plannedMinutes: 180, actualLastMatch: null, playedMinutes: 42 },
  participants: { registered: 3, active: 3, checkedIn: 2, classes: 2 },
  matches: { total: 9, completed: 7, cancelled: 1, noShow: 1, pendingResult: 0, bySource: { AUTO: 6, MANUAL: 1 }, byPhase: { LEAGUE: 7 } },
  matchCount: { total: 14, avg: 4.67, min: 2, max: 7, spread: 5, zeroMatchPlayers: 0, histogram: [{ matches: 2, players: 1 }, { matches: 7, players: 2 }] },
  waiting: { avgMinutes: 12.5, maxMinutes: 38, over30Players: 1, p90Minutes: 30, samples: 14, longestIdleMinutes: 44, idleOver30Players: 2, idlePlayers: 3 },
  courts: {
    count: 2, utilization: 0.62, busyMinutes: 84, availableMinutes: 136,
    perCourt: [
      { courtId: 'ct1', courtName: 'COURT 1', matches: 5, busyMinutes: 60, utilization: 0.88 },
      { courtId: 'ct2', courtName: 'COURT 2', matches: 2, busyMinutes: 24, utilization: 0.35 },
    ],
  },
  requests: { total: 8, active: 2, matched: 6, cancelled: 1, expired: 1, fulfillmentRate: 0.75 },
  fairness: { playedStdDev: 1.4, balanceScore: 0.46, mostPlayed: '古谷 莉歩（7試合）', leastPlayed: '森 悠人（2試合）' },
  automation: { autoEngine: true, autoCourt: true, createdAuto: 8, createdManual: 1, autoShare: 0.89 },
  noShows: { count: 1, affectedPlayers: 2, rate: 0.11 },
  integrity: { eventId: 'evt_1', checkedAt: '2026-04-11T09:00:00.000Z', checks: 14, violations: [], clean: true },
  standings: [{ className: 'Aクラス', rows: [{ rank: 1, name: '古谷 莉歩', played: 7, wins: 5, pointDifference: 42 }] }],
  rows: [
    {
      participantId: 'p1', name: '古谷 莉歩', className: 'Aクラス', club: '唐崎', rating: 1200, checkedIn: true,
      played: 7, wins: 5, losses: 2, pointsFor: 15, pointsAgainst: 9, pointDifference: 6, winRate: 0.714,
      totalWaitingMinutes: 18, longestWaitingMinutes: 12, requestCount: 3, requestFulfilled: 2, noShows: 0,
    },
    {
      participantId: 'p2', name: '森 悠人', className: 'Bクラス', club: '守山', rating: 980, checkedIn: false,
      played: 2, wins: 0, losses: 2, pointsFor: 8, pointsAgainst: 14, pointDifference: -6, winRate: 0,
      totalWaitingMinutes: 38, longestWaitingMinutes: 38, requestCount: 1, requestFulfilled: 0, noShows: 1,
    },
  ],
} as unknown as EventReport;

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
}

describe('大会レポート画面', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    fetchMock.mockReset();
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/integrity')) {
        return Promise.resolve(jsonResponse({
          data: { eventId: 'evt_1', checkedAt: '2026-04-11T09:05:00.000Z', checks: 14, clean: false, violations: [{ code: 'COURT_DOUBLE_BOOKED', severity: 'CRITICAL', count: 2, sample: 'ct1' }] },
        }));
      }
      return Promise.resolve(jsonResponse({ data: report }));
    });
    vi.stubGlobal('fetch', fetchMock);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('renders the stored figures without re-deriving them', async () => {
    await act(async () => { root.render(createElement(ReportPanel, { eventId: 'evt_1' })); });
    const text = container.textContent ?? '';
    expect(text).toContain('唐崎ジュニア 練習会');
    expect(text).toContain('実施試合数');
    expect(text).toContain('7');
    // 12.5分 average waiting and the 38分 maximum, formatted for a Japanese gym sheet.
    expect(text).toContain('13分'); // 12.5分 rounds to a whole minute on the sheet
    expect(text).toContain('38分');
    expect(text).toContain('62%');
    expect(text).toContain('75%');
    expect(text).toContain('COURT 1');
    expect(text).toContain('古谷 莉歩');
    expect(text).toContain('Aクラス');
    // The idle column is the live "still waiting" figure, not a realised gap.
    expect(text).toContain('いま待っている時間');
    expect(text).toContain('44分・3名');
    // The report already carries the integrity verdict from generation time.
    expect(text).toContain('14項目すべて合格');
  });

  it('highlights the players the operators should act on', async () => {
    await act(async () => { root.render(createElement(ReportPanel, { eventId: 'evt_1' })); });
    const cold = container.querySelector('.report-row-cold');
    // 38 minutes waiting crosses the 30 minute alert line, so that cell is flagged.
    const flagged = [...container.querySelectorAll('.report-table .danger')].map((node) => node.textContent);
    expect(flagged.some((value) => value?.includes('38分'))).toBe(true);
    expect(cold).toBeNull();
    expect(container.textContent).toContain('1名');
    expect(container.innerHTML).toContain('未IF');
  });

  it('runs the integrity check on demand and shows what it found', async () => {
    await act(async () => { root.render(createElement(ReportPanel, { eventId: 'evt_1' })); });
    const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('再検査'));
    expect(button).toBeTruthy();
    await act(async () => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith('/integrity'))).toBe(true);
    expect(container.textContent).toContain('コートの二重予約');
    expect(container.textContent).toContain('2件');
    expect(container.textContent).toContain('CRITICAL');
  });

  it('exposes the CSV download and the print affordance', async () => {
    await act(async () => { root.render(createElement(ReportPanel, { eventId: 'evt_1' })); });
    const link = container.querySelector('a[href="/api/events/evt_1/report.csv"]');
    expect(link).toBeTruthy();
    const print = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('印刷'));
    expect(print).toBeTruthy();
  });
});
