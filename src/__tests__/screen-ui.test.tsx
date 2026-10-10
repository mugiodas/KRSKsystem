// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScreenPage } from '../pages/ScreenPage';
import type { ScreenBoard } from '../api/types';

const NOW = Date.parse('2026-04-11T09:00:00.000Z');
const TOKEN = 'tok-abcdef123456';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const board = (over: Partial<ScreenBoard> = {}): ScreenBoard => ({
  eventId: 'evt_1', eventName: '唐崎ジュニア 練習会', eventDate: '2026-04-11', venue: '唐崎市民体育館',
  status: 'RUNNING', phase: 'LEAGUE', startTime: new Date(NOW - 60 * 60_000).toISOString(),
  endTime: new Date(NOW + 120 * 60_000).toISOString(), serverTime: new Date(NOW).toISOString(), nowMs: NOW,
  elapsedMinutes: 60, remainingMinutes: 120,
  progress: { completedMatches: 12, openMatches: 3, courtsBusy: 2, courtsTotal: 4 },
  league: { status: 'BEHIND', completedMatches: 12, plannedMatches: 20, completionRate: 0.6 },
  courts: [
    { courtNumber: 1, courtName: 'COURT 1', status: 'PLAYING', available: true, endsInMinutes: 8, overMinutes: 0,
      match: { status: 'PLAYING', phase: 'LEAGUE', roundName: 'リーグ', playerAName: '古谷 莉歩', playerBName: '森 悠人',
        scoreA: null, scoreB: null, scheduledTime: null, startTime: new Date(NOW - 7 * 60_000).toISOString(), endTime: null, resultStatus: null } },
    { courtNumber: 2, courtName: 'COURT 2', status: 'RESULT_PENDING', available: true, endsInMinutes: null, overMinutes: 12,
      match: { status: 'RESULT_PENDING', phase: 'LEAGUE', roundName: 'リーグ', playerAName: '池田 紬', playerBName: '橋本 蒼',
        scoreA: null, scoreB: null, scheduledTime: null, startTime: new Date(NOW - 20 * 60_000).toISOString(),
        endTime: new Date(NOW - 4 * 60_000).toISOString(), resultStatus: 'ENTERED' } },
    { courtNumber: 3, courtName: 'COURT 3', status: 'CALLING', available: true, endsInMinutes: null, overMinutes: 0,
      match: { status: 'COURT_ASSIGNED', phase: 'TOURNAMENT', roundName: '準決勝', playerAName: '田中 美羽', playerBName: '中村 颯太',
        scoreA: null, scoreB: null, scheduledTime: new Date(NOW + 3 * 60_000).toISOString(), startTime: null, endTime: null, resultStatus: null } },
    { courtNumber: 4, courtName: 'COURT 4', status: 'AVAILABLE', available: true, endsInMinutes: null, overMinutes: 0, match: null },
  ],
  upNext: [{ players: '伊藤 心春 ・ 加藤 蓮', courtName: 'COURT 4', etaMinutes: 5 }],
  results: [{ winner: '古谷 莉歩', loser: '山本 悠真', score: '21-15', at: new Date(NOW - 12 * 60_000).toISOString() }],
  standings: [
    { className: 'Aクラス', rows: [{ rank: 1, name: '古谷 莉歩', played: 5, wins: 4, pointDifference: 33 }] },
    { className: 'Bクラス', rows: [{ rank: 1, name: '清水 凛', played: 4, wins: 3, pointDifference: 12 }] },
  ],
  brackets: [{ className: 'Aクラス', size: 8, status: 'OPEN', roundName: '準決勝', decided: 5, total: 7, champion: null }],
  announcements: [{ title: '最終ラウンド', body: '17:00以降は新しい試合を作りません。', severity: 'URGENT', at: new Date(NOW - 60_000).toISOString() }],
  ...over,
});

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
}

describe('会場スクリーン', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ data: board() }));
    vi.stubGlobal('fetch', fetchMock);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = async () => {
    await act(async () => {
      root.render(createElement(MemoryRouter, { initialEntries: [`/screen/evt_1?t=${TOKEN}`] },
        createElement(Routes, null, createElement(Route, { path: '/screen/:eventId', element: createElement(ScreenPage) }))));
    });
  };

  it('shows every court as the hall reads it, without operator machinery', async () => {
    await render();
    const text = container.textContent ?? '';
    expect(text).toContain('唐崎ジュニア 練習会');
    expect(text).toContain('唐崎市民体育館');
    expect(text).toContain('終了まで');
    expect(text).toContain('2/4 コート稼働');
    expect(text).toContain('COURT 1');
    expect(text).toContain('古谷 莉歩');
    expect(text).toContain('試合中');
    expect(text).toContain('経過');           // a running card is timed, not just labelled
    expect(text).toContain('結果確認中');      // the settled-not-confirmed card
    expect(text).toContain('選手の申告を相手に確認してもらっています');
    expect(text).toContain('まもなく開始');
    expect(text).toContain('準決勝');
    expect(text).toContain('空きコート');
    expect(text).toContain('伊藤 心春 ・ 加藤 蓮');
    expect(text).toContain('5分後');
    expect(text).toContain('21-15');
    expect(text).toContain('Aクラス');
    expect(text).toContain('12/20試合');
    expect(text).toContain('計画より遅れ');
    expect(text).toContain('17:00以降は新しい試合を作りません。');
    expect(text).toContain('F キーで全画面');
    // Nothing from the operator side leaks onto a board the hall can photograph.
    for (const forbidden of ['blockedCounts', 'hardConstraint', 'rowVersion', '整合性', 'エンジン', TOKEN]) {
      expect(text).not.toContain(forbidden);
    }
    // An unconfirmed score is not displayed as a result.
    expect(text).not.toContain('21 - 15');
    expect(container.querySelector('.sc-score.is-pending')).not.toBeNull();
    // and the board asked for the public path, not the staff snapshot
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/public/screen/evt_1?t=');
  });

  it('keeps the last board on screen when the network drops', async () => {
    await render();
    expect(container.textContent).toContain('COURT 1');
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    // The poll is on a timer, so re-render after the failing attempt resolves.
    fetchMock.mockResolvedValue(jsonResponse({ data: board() }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3_100)); });
    expect(container.textContent).toContain('COURT 1');
  });

  it('explains a dead link instead of a spinner', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      error: { code: 'SCREEN_LINK_INVALID', message: '表示用リンクが無効です。運営に確認してください。' },
    }), { status: 403, headers: { 'content-type': 'application/json' } })));
    await render();
    const text = container.textContent ?? '';
    expect(text).toContain('会場スクリーンを表示できません');
    expect(text).toContain('表示用リンクが無効です');
    expect(text).toContain('設定 → 会場スクリーン');
    expect(container.querySelector('.sc-court')).toBeNull();
  });

  it('asks for the link when the token is missing entirely', async () => {
    await act(async () => {
      root.render(createElement(MemoryRouter, { initialEntries: ['/screen/evt_1'] },
        createElement(Routes, null, createElement(Route, { path: '/screen/:eventId', element: createElement(ScreenPage) }))));
    });
    expect(container.textContent).toContain('表示用リンク（?t=…）がありません');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
