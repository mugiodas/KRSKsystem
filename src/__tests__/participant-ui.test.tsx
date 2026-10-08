// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MyMatchView } from '../api/types';
import { NextMatchCard } from '../components/participant/NextMatchCard';
import { HistoryTab } from '../components/participant/HistoryTab';
import { InfoTab } from '../components/participant/InfoTab';
import { RequestsTab } from '../components/participant/RequestsTab';

const NOW = Date.parse('2026-04-11T09:00:00.000Z');

const baseView = (over: Partial<MyMatchView> = {}): MyMatchView => ({
  participant: { participantId: 'p1', name: '古谷 莉歩', className: 'Aクラス', club: '唐崎ジュニア', rating: 1320, active: true, checkedIn: true },
  event: { eventName: 'KRSK DEMO', status: 'RUNNING', phase: 'REQUEST', startTime: new Date(NOW - 60 * 60_000).toISOString(),
    endTime: new Date(NOW + 120 * 60_000).toISOString(), allowRequest: true, defaultMatchMinutes: 15 },
  today: { played: 3, wins: 2, losses: 1, pointsFor: 96, courtsUsed: 2 },
  rank: { rank: 2, of: 10, winRate: 0.67, pointDifference: 12 },
  nextMatch: null,
  waiting: { minutes: 34, estimateMinutes: 23, position: 3, waitingCount: 11, restBlocked: false, restReadyInMinutes: 0, slotMinutes: 23, freeCourts: 1 },
  history: [{ matchId: 'm9', opponentName: '森 悠人', won: true, scoreMine: 21, scoreOpponent: 18, courtName: 'COURT 2', endTime: new Date(NOW - 30 * 60_000).toISOString(), phase: 'LEAGUE' }],
  otherMatches: [],
  requests: [{ requestId: 'r1', targetName: '橋本 蒼', requesterName: '古谷 莉歩', mine: true, priority: 1, status: 'ACTIVE',
    createdAt: new Date(NOW - 10 * 60_000).toISOString(), rowVersion: 1, matchedStatus: null, matchedCourtName: null, matchedScheduledTime: null }],
  announcements: [{ title: '間もなく最終ラウンド', body: '17:30以降は新規試合を作りません。', severity: 'URGENT', createdAt: new Date(NOW - 5 * 60_000).toISOString(), actorName: '大会運営' }],
  ...over,
});

const noop = () => undefined;

describe('Phase 5: participant phone surface', () => {
  it('answers when and where while waiting, without operator clutter', () => {
    const html = renderToStaticMarkup(createElement(NextMatchCard, { view: baseView(), nowMs: NOW, onEnterResult: noop }));
    expect(html).toContain('待機中');
    expect(html).toContain('34');                       // own waiting minutes
    expect(html).toContain('3 / 11');                   // queue position, explained
    expect(html).toContain('約 1 枠');                   // estimate expressed in slots, not raw maths
    // A player screen must not expose the operator's machinery.
    for (const forbidden of ['COURT LIVE', 'PARTICIPANT STATUS', 'blockedCounts', 'hardConstraint', 'エンジンの重み']) {
      expect(html).not.toContain(forbidden);
    }
  });

  it('explains a mandatory break instead of showing a fake queue place', () => {
    const view = baseView({ waiting: { minutes: 4, estimateMinutes: 6, position: null, waitingCount: 9, restBlocked: true,
      restReadyInMinutes: 5.6, slotMinutes: 23, freeCourts: 0 } });
    const html = renderToStaticMarkup(createElement(NextMatchCard, { view, nowMs: NOW, onEnterResult: noop }));
    expect(html).toContain('休憩中です');
    expect(html).toContain('6');
    // No fake queue estimate while the player is blocked by the rest rule:
    // the "約 N 枠" branch must not render, the break notice must.
    expect(html).not.toContain('あとお時間で出番が来ます');
    expect(html).not.toContain('分後に出場予定');
  });

  it('turns into a call card with the court number as the hero when assigned', () => {
    const view = baseView({
      nextMatch: { matchId: 'm1', status: 'CALLED', courtName: 'COURT 3', courtNumber: 3, opponentName: '井上 湊', opponentClub: '大津シャトル',
        scheduledTime: new Date(NOW + 4 * 60_000).toISOString(), startTime: null, phase: 'REQUEST', scoreA: null, scoreB: null, isMineSideA: true },
    });
    const html = renderToStaticMarkup(createElement(NextMatchCard, { view, nowMs: NOW, onEnterResult: noop }));
    expect(html).toContain('コートへ向かってください');
    expect(html).toContain('m-hero-court');
    expect(html.match(/<b[^>]*>3<\/b>/)).toBeTruthy();   // court number is the largest element
    expect(html).toContain('井上 湊');
    expect(html).toContain('>4</b>');
    expect(html).toContain('分後スタート');
    expect(html).toContain('集合音を出す');
  });

  it('offers result entry while playing', () => {
    const view = baseView({
      nextMatch: { matchId: 'm1', status: 'PLAYING', courtName: 'COURT 1', courtNumber: 1, opponentName: '井上 湊', opponentClub: '大津シャトル',
        scheduledTime: null, startTime: new Date(NOW - 6 * 60_000).toISOString(), phase: 'LEAGUE', scoreA: 11, scoreB: 9, isMineSideA: true },
    });
    const html = renderToStaticMarkup(createElement(NextMatchCard, { view, nowMs: NOW, onEnterResult: noop }));
    expect(html).toContain('試合中');
    expect(html).toContain('結果を入力');
    expect(html).toContain('11 - 9');
  });

  it('shows today record and per match scores', () => {
    const html = renderToStaticMarkup(createElement(HistoryTab, { view: baseView() }));
    expect(html).toContain('本日対戦した相手（1試合）');
    expect(html).toContain('勝ち vs 森 悠人');
    expect(html).toContain('21-18');
    expect(html).toContain('2位');
    expect(html).toContain('67%');
  });

  it('renders announcements with severity and the event facts', () => {
    const html = renderToStaticMarkup(createElement(InfoTab, { view: baseView() }));
    expect(html).toContain('m-notice URGENT');
    expect(html).toContain('間もなく最終ラウンド');
    expect(html).toContain('チェックイン済');
    expect(html).toContain('23分/枠');
  });

  it('lists own requests and lets the player withdraw one', () => {
    const html = renderToStaticMarkup(createElement(RequestsTab, { eventId: 'e1', view: baseView(), onChanged: noop, canSubmit: true }));
    expect(html).toContain('対戦したい相手を選ぶ');
    expect(html).toContain('橋本 蒼 と');
    expect(html).toContain('取下げ');
    expect(html).toContain('あなたの希望（1件）');
  });

  it('hides the request composer when the event stopped accepting requests', () => {
    const view = baseView({ event: { ...baseView().event, allowRequest: false } });
    const html = renderToStaticMarkup(createElement(RequestsTab, { eventId: 'e1', view, onChanged: noop, canSubmit: true }));
    expect(html).toContain('対戦希望の受付を終了');
    expect(html).not.toContain('対戦したい相手を選ぶ');
  });
});
