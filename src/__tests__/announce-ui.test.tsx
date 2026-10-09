// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnouncementsPanel, type PendingCard } from '../components/dashboard/AnnouncementsPanel';
import { ToastProvider } from '../components/ui';

const NOW = Date.parse('2026-04-11T09:00:00.000Z');

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card = (over: Partial<PendingCard> = {}): PendingCard => ({ courtName: 'COURT 1', label: '古谷 莉歩 × 森 悠人', ...over });

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

describe('ワンクリック配信', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();
  const posts: Array<{ title: string; body: string; severity: string }> = [];

  /** Mounts the panel; `over` controls which live facts the board reports. */
  async function render(over: Record<string, unknown> = {}) {
    const props = {
      eventId: 'evt_1',
      canOperate: true,
      endTime: new Date(NOW + 22 * 60_000).toISOString(),
      nowMs: NOW,
      ...over,
    };
    await act(async () => {
      root.render(createElement(ToastProvider, null, createElement(AnnouncementsPanel, props)));
    });
    return props;
  }

  const rows = () => Array.from(container.querySelectorAll<HTMLElement>('.quick-cast-row'));
  const body = (key: string) => rows().find((row) => row.dataset.quick === key)?.querySelector('.quick-cast-body')?.textContent ?? '';
  const button = (key: string) => rows().find((row) => row.dataset.quick === key)?.querySelector('button');

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    posts.length = 0;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return jsonResponse({ data: { announcementId: 'an_1' } }, 201);
      }
      return jsonResponse({ data: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    // jsdom has no layout engine; the panel scrolls the composer into view.
    Element.prototype.scrollIntoView = vi.fn();
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('states the real remaining minutes and sends on one click', async () => {
    await render();
    expect(rows().map((row) => row.dataset.quick)).toEqual(['CLOSING']);
    expect(body('CLOSING')).toContain('残り約22分');

    await act(async () => { button('CLOSING')?.click(); });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      title: '終了時刻が迫っています',
      severity: 'IMPORTANT',
      body: expect.stringContaining('これ以上新しい試合は作成しません'),
    });
    expect(posts[0].body).toContain('残り約22分');
    expect(container.textContent).toContain('お知らせを配信しました');
  });

  it('names the blocked courts, and only the ones that fit the notice', async () => {
    const resultPending = [card({}), card({ courtName: 'COURT 2' }), card({ courtName: 'COURT 3' }), card({ courtName: 'COURT 4' })];
    await render({
      resultPending,
      unconfirmed: [card({ courtName: 'COURT 5' })],
      endTime: new Date(NOW + 120 * 60_000).toISOString(),
    });
    expect(rows().map((row) => row.dataset.quick)).toEqual(['RESULTS', 'UNCONFIRMED']);
    expect(body('RESULTS')).toContain('4件あります（COURT 1・COURT 2・COURT 3 他1面）');
    expect(body('UNCONFIRMED')).toContain('1件あります（COURT 5）');

    await act(async () => { button('RESULTS')?.click(); });
    expect(posts[0].title).toBe('結果の入力をお願いします');
  });

  it('stays out of the way when there is nothing to announce', async () => {
    // Two hours left and no court held up: the block would be pure noise.
    await render({ endTime: new Date(NOW + 120 * 60_000).toISOString() });
    expect(container.querySelector('.quick-cast')).toBeNull();
    expect(container.textContent).toContain('ANNOUNCEMENTS');
  });

  it('only pre-fills the composer when an alert sent the operator here', async () => {
    await render({ resultPending: [card({})], preselect: 'RESULTS', onPreselect: undefined });
    const title = container.querySelector('input') as HTMLInputElement;
    const text = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(title.value).toBe('結果の入力をお願いします');
    expect(text.value).toContain('結果が未入力の試合が1件あります');
    // A broadcast is not fired by an accidental click on an alert.
    expect(posts).toHaveLength(0);
  });

  it('offers no sending affordance to a viewer', async () => {
    await render({ canOperate: false });
    expect(container.querySelector('.quick-cast')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
  });
});
