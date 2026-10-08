// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BracketPanel } from '../components/dashboard/BracketPanel';
import { TournamentModal } from '../components/dashboard/TournamentModal';
import type { TournamentBracket, TournamentPreview } from '../api/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const iso = (minutesFromNow: number) => new Date(Date.parse('2026-04-11T09:00:00.000Z') + minutesFromNow * 60_000).toISOString();

const bracket = {
  bracketId: 'b1', eventId: 'evt_1', classId: 'c1', className: 'Aクラス', format: 'SINGLE_ELIM',
  size: 4, rounds: 2, status: 'OPEN', winnerId: null, winnerName: null, byes: 1,
  entrants: [
    { slot: 0, participantId: 'p1', name: '古谷 莉歩', seed: 1 },
    { slot: 1, participantId: 'p2', name: '井上 湊', seed: 4 },
    { slot: 2, participantId: 'p3', name: '橋本 蒼', seed: 2 },
  ],
  pairings: [
    {
      round: 1, slot: 0, roundLabel: '1回戦', matchId: null, status: null, courtName: null, scheduledTime: null,
      playerAId: 'p1', playerAName: '古谷 莉歩', playerBId: null, playerBName: null, scoreA: null, scoreB: null, winnerId: 'p1', bye: true,
    },
    {
      round: 1, slot: 1, roundLabel: '1回戦', matchId: 'm1', status: 'COMPLETED', courtName: 'COURT 1', scheduledTime: iso(-18),
      playerAId: 'p2', playerAName: '井上 湊', playerBId: 'p3', playerBName: '橋本 蒼', scoreA: 18, scoreB: 21, winnerId: 'p3', bye: false,
    },
    {
      round: 2, slot: 0, roundLabel: '決勝', matchId: 'm2', status: 'COURT_ASSIGNED', courtName: 'COURT 2', scheduledTime: iso(2),
      playerAId: 'p1', playerAName: '古谷 莉歩', playerBId: 'p3', playerBName: '橋本 蒼', scoreA: null, scoreB: null, winnerId: null, bye: false,
    },
  ],
  decidedMatches: 1, requiredMatches: 2,
} as unknown as TournamentBracket;

const preview: TournamentPreview = {
  summary: { classCount: 1, entrants: 5, matchCount: 4, blockedClasses: 1, fitsBeforeEnd: false, perRoundMinutes: 20 },
  classes: [{
    classId: 'c1', className: 'Aクラス', size: 8, rounds: 3, requiredMatches: 4, byes: 3, roundOneCards: 1,
    estimatedMinutes: 60, fitsBeforeEnd: false, reason: '終了時刻までに全3ラウンド（約60分）が終わりません',
    entrants: Array.from({ length: 5 }, (_unused, index) => ({ participantId: `p${index + 1}`, name: `選手${index + 1}`, seed: index + 1, rating: 1200 })),
  }],
};

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
}

describe('トーナメント表パネル', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ data: [bracket] })));
    vi.stubGlobal('fetch', fetchMock);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('shows the draw as it stands, with the walkover and the live final', async () => {
    const onResult = vi.fn();
    await act(async () => {
      root.render(createElement(BracketPanel, {
        eventId: 'evt_1', canOperate: true, refreshKey: 'tick-1', onGenerate: () => undefined, onResult,
      }));
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Aクラス');
    expect(text).toContain('4ドロー・2回戦');
    expect(text).toContain('1/2枚 完了');
    expect(text).toContain('不戦勝 1名');
    expect(text).toContain('決勝');
    expect(text).toContain('橋本 蒼');
    // The decided card is corrected, the live card is entered; a walkover has no button.
    expect(text).toContain('修正');
    expect(text).toContain('結果');
    expect(container.querySelectorAll('.bkt-card')).toHaveLength(3);
    expect(container.querySelector('.bkt-card.bye')).toBeTruthy();
    expect(container.querySelector('.bkt-card.live')).toBeTruthy();

    const live = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('結果'));
    await act(async () => { live?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onResult).toHaveBeenCalledWith('m2', 'enter');
  });

  it('repairs the draw through the rebalance switch', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/rebalance')) return Promise.resolve(jsonResponse({ data: { created: 1, opened: 0, bracket } }));
      return Promise.resolve(jsonResponse({ data: [bracket] }));
    });
    await act(async () => {
      root.render(createElement(BracketPanel, {
        eventId: 'evt_1', canOperate: true, refreshKey: 'tick-1', onGenerate: () => undefined, onResult: () => undefined,
      }));
    });
    const repair = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('進行を直す'));
    await act(async () => { repair?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/tournament/b1/rebalance')
      && (init as RequestInit).method === 'POST')).toBe(true);
  });

  it('explains that nothing exists yet and offers the generator', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
    const onGenerate = vi.fn();
    await act(async () => {
      root.render(createElement(BracketPanel, {
        eventId: 'evt_1', canOperate: true, refreshKey: 'tick-1', onGenerate, onResult: () => undefined,
      }));
    });
    expect(container.textContent).toContain('まだトーナメント表はありません');
    const button = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.includes('自動生成'));
    await act(async () => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onGenerate).toHaveBeenCalled();
  });

  it('refuses the actions for a viewer', async () => {
    await act(async () => {
      root.render(createElement(BracketPanel, {
        eventId: 'evt_1', canOperate: false, refreshKey: 'tick-1', onGenerate: () => undefined, onResult: () => undefined,
      }));
    });
    expect(container.textContent).not.toContain('自動生成');
    expect(container.textContent).not.toContain('進行を直す');
    expect(container.textContent).not.toContain('結果');
  });
});

describe('トーナメント表 生成プレビュー', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ data: preview })));
    vi.stubGlobal('fetch', fetchMock);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('lists the draw before anything is created and blocks a draw that will not finish', async () => {
    const onGenerated = vi.fn();
    await act(async () => {
      root.render(createElement(TournamentModal, {
        eventId: 'evt_1', canOperate: true, endTime: iso(90), onClose: () => undefined, onGenerated,
      }));
    });
    const text = container.textContent ?? '';
    expect(text).toContain('作れません');
    expect(text).toContain('作れないクラス');
    expect(text).toContain('Aクラス');
    expect(text).toContain('8ドロー・3回戦・優勝まで 4枚');
    expect(text).toContain('約 60分');
    expect(text).toContain('終了時刻までに全3ラウンド');
    expect(text).toContain('1回戦 不戦勝');
    expect(text).toContain('初回で作られるカードは 1枚');
    // No generate is offered while the projected draw cannot finish in time.
    expect(text).toContain('0クラス');
    const generate = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Generate Bracket'));
    expect(generate?.hasAttribute('disabled')).toBe(true);
    expect(onGenerated).not.toHaveBeenCalled();
  });

  it('generates only after the operator confirms the preview', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/generate')) {
        return Promise.resolve(jsonResponse({ data: {
          bracket,
          created: [{ matchId: 'm1', round: 1, roundLabel: '1回戦', playerAName: '古谷 莉歩', playerBName: '井上 湊' }, { matchId: 'm2', round: 1, roundLabel: '1回戦', playerAName: '橋本 蒼', playerBName: '森 悠人' }],
          walkovers: [{ participantName: '古谷 莉歩', intoRound: 2, roundLabel: '決勝' }],
        } }));
      }
      return Promise.resolve(jsonResponse({ data: {
        ...preview,
        summary: { ...preview.summary, blockedClasses: 0, fitsBeforeEnd: true },
        classes: [{ ...preview.classes[0]!, fitsBeforeEnd: true, reason: null }],
      } }));
    });
    const onGenerated = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root.render(createElement(TournamentModal, {
        eventId: 'evt_1', canOperate: true, endTime: iso(150), onClose, onGenerated,
      }));
    });
    const text = container.textContent ?? '';
    expect(text).toContain('終了時刻に内');
    expect(text).not.toContain('作れません');
    const generate = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Generate Bracket'));
    expect(generate?.hasAttribute('disabled')).toBe(false);
    await act(async () => { generate?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/tournament/generate')
      && (init as RequestInit).method === 'POST')).toBe(true);
    expect(onGenerated).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('tells a viewer that they cannot generate', async () => {
    await act(async () => {
      root.render(createElement(TournamentModal, {
        eventId: 'evt_1', canOperate: false, endTime: iso(90), onClose: () => undefined, onGenerated: () => undefined,
      }));
    });
    expect(container.textContent).toContain('生成権限がありません');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('Generate Bracket'))).toBe(false);
  });
});
