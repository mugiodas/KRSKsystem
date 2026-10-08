import type { DB } from '../db.js';
import { asRow, asRows } from '../db.js';
import { ApiError } from '../http.js';
import { runIntegrityChecks } from './integrity.js';

interface MatchTimeRow {
  match_id: string; player_a_id: string; player_b_id: string; court_id: string | null;
  start_time: string | null; end_time: string | null;
  scheduled_time: string | null; created_at: string; status: string; source: string; phase: string;
}

export interface ParticipantReportRow {
  participantId: string;
  name: string;
  className: string | null;
  club: string;
  rating: number;
  checkedIn: boolean;
  played: number;
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDifference: number;
  winRate: number;
  totalWaitingMinutes: number;
  longestWaitingMinutes: number;
  requestCount: number;
  requestFulfilled: number;
  noShows: number;
}

export interface EventReport {
  eventId: string;
  eventName: string;
  eventDate: string;
  venue: string;
  status: string;
  eventMode: string;
  phase: string;
  generatedAt: string;
  window: { start: string; end: string; plannedMinutes: number; actualLastMatch: string | null; playedMinutes: number };
  participants: { registered: number; active: number; checkedIn: number; classes: number };
  matches: {
    total: number; completed: number; cancelled: number; noShow: number; pendingResult: number;
    bySource: Record<string, number>; byPhase: Record<string, number>;
  };
  matchCount: { total: number; avg: number; min: number; max: number; spread: number; zeroMatchPlayers: number; histogram: Array<{ matches: number; players: number }> };
  waiting: {
    avgMinutes: number; maxMinutes: number; over30Players: number; p90Minutes: number; samples: number;
    /** How long idle players have been waiting at report time, i.e. the live alert measure. */
    longestIdleMinutes: number; idleOver30Players: number; idlePlayers: number;
  };
  courts: { count: number; utilization: number; busyMinutes: number; availableMinutes: number; perCourt: Array<{ courtId: string; courtName: string; matches: number; busyMinutes: number; utilization: number }> };
  requests: { total: number; active: number; matched: number; cancelled: number; expired: number; fulfillmentRate: number };
  fairness: { playedStdDev: number; balanceScore: number; mostPlayed: string | null; leastPlayed: string | null };
  automation: { autoEngine: boolean; autoCourt: boolean; createdAuto: number; createdManual: number; autoShare: number };
  noShows: { count: number; affectedPlayers: number; rate: number };
  integrity: ReturnType<typeof runIntegrityChecks>;
  standings: Array<{ className: string | null; rows: Array<{ rank: number; name: string; played: number; wins: number; pointDifference: number }> }>;
  rows: ParticipantReportRow[];
}

function stats(values: number[]) {
  if (values.length === 0) return { avg: 0, min: 0, max: 0, stdDev: 0 };
  const sum = values.reduce((total, value) => total + value, 0);
  const avg = sum / values.length;
  const variance = values.reduce((total, value) => total + (value - avg) ** 2, 0) / values.length;
  return { avg, min: Math.min(...values), max: Math.max(...values), stdDev: Math.sqrt(variance) };
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index];
}

const toMinutes = (ms: number) => ms / 60_000;

/**
 * Event report. Every figure is derived from persisted matches and results, so
 * the report can be regenerated mid-event or days later and stays consistent
 * with what the board showed. Waiting time is measured from the record itself:
 * the gap between one match ending and the next starting.
 */
export function buildEventReport(db: DB, eventId: string): EventReport {
  const event = asRow<Record<string, any>>(db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId));
  if (!event) throw new ApiError(404, 'EVENT_NOT_FOUND', '大会が見つかりません。');

  const startMs = new Date(String(event.start_time)).getTime();
  const endMs = new Date(String(event.end_time)).getTime();
  const defaultMinutes = Number(event.default_match_minutes);

  const participantRows = asRows<Record<string, any>>(db.prepare(`
    SELECT p.participant_id, p.name, p.club, p.rating, p.active, p.checked_in, c.class_name
    FROM participants p LEFT JOIN classes c ON c.class_id = p.class_id
    WHERE p.event_id = ? ORDER BY c.display_order, p.name_kana, p.name`).all(eventId));

  const matchRows = asRows<MatchTimeRow>(db.prepare(`
    SELECT match_id, player_a_id, player_b_id, court_id, start_time, end_time, scheduled_time, created_at, status, source, phase
    FROM matches WHERE event_id = ?`).all(eventId));

  const perPlayerMatches = new Map<string, MatchTimeRow[]>();
  for (const row of matchRows) {
    for (const playerId of [row.player_a_id, row.player_b_id]) {
      perPlayerMatches.set(playerId, [...(perPlayerMatches.get(playerId) ?? []), row]);
    }
  }

  const scoreRows = asRows<{ match_id: string; score_a: number | null; score_b: number | null; winner_id: string | null }>(
    db.prepare(`SELECT match_id, score_a, score_b, winner_id FROM matches WHERE event_id = ? AND status = 'COMPLETED'`).all(eventId));
  const scores = new Map(scoreRows.map((row) => [row.match_id, row]));

  const requestStats = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'MATCHED' THEN 1 ELSE 0 END) AS matched,
      SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN status = 'EXPIRED' THEN 1 ELSE 0 END) AS expired
    FROM match_requests WHERE event_id = ?`).get(eventId) as Record<string, number>;

  const requestPerPlayer = asRows<{ player: string; total: number; matched: number }>(db.prepare(`
    SELECT player, COUNT(*) AS total, SUM(CASE WHEN status = 'MATCHED' THEN 1 ELSE 0 END) AS matched FROM (
      SELECT requester_id AS player, status FROM match_requests WHERE event_id = ?
      UNION ALL SELECT target_player_id, status FROM match_requests WHERE event_id = ?
    ) GROUP BY player`).all(eventId, eventId));
  const requestMap = new Map(requestPerPlayer.map((row) => [row.player, row]));

  const gapValues: number[] = [];
  /** When each player stopped being busy, used for the "waiting right now" figure. */
  const lastFreeMs = new Map<string, number>();
  const rows: ParticipantReportRow[] = participantRows.map((player) => {
    const own = (perPlayerMatches.get(String(player.participant_id)) ?? [])
      .slice()
      .sort((left, right) => {
        const leftMs = new Date(String(left.start_time ?? left.scheduled_time ?? left.created_at)).getTime();
        const rightMs = new Date(String(right.start_time ?? right.scheduled_time ?? right.created_at)).getTime();
        return leftMs - rightMs;
      });
    let played = 0;
    let wins = 0;
    let pointsFor = 0;
    let pointsAgainst = 0;
    let noShows = 0;
    let totalWaiting = 0;
    let longestWaiting = 0;

    // Only realised waiting counts: the gap between the moment a player was free and
    // the moment their next match actually started. Time until a match that is still
    // scheduled belongs to the live board, not to the post-event report.
    let cursorMs: number | null = null;
    for (const match of own) {
      if (match.status === 'NO_SHOW') noShows += 1;
      const startMsValue = match.start_time ? new Date(match.start_time).getTime() : null;
      if (startMsValue !== null && cursorMs !== null) {
        const gap = toMinutes(startMsValue - cursorMs);
        if (gap > 0) {
          totalWaiting += gap;
          longestWaiting = Math.max(longestWaiting, gap);
          gapValues.push(gap);
        }
      }
      if (match.status === 'COMPLETED') {
        played += 1;
        const score = scores.get(match.match_id);
        if (score) {
          const mineIsA = match.player_a_id === player.participant_id;
          pointsFor += Number(mineIsA ? score.score_a : score.score_b);
          pointsAgainst += Number(mineIsA ? score.score_b : score.score_a);
          if (score.winner_id === player.participant_id) wins += 1;
        }
        cursorMs = match.end_time ? new Date(match.end_time).getTime() : startMsValue;
        if (cursorMs !== null) lastFreeMs.set(String(player.participant_id), cursorMs);
      } else {
        // Cancelled or queued cards must not reset the clock: the player is still waiting.
        cursorMs = match.status === 'CANCELLED' ? cursorMs : (match.start_time ? startMsValue : cursorMs);
      }
    }
    const requests = requestMap.get(String(player.participant_id));
    return {
      participantId: String(player.participant_id),
      name: String(player.name),
      className: player.class_name ?? null,
      club: String(player.club ?? ''),
      rating: Number(player.rating),
      checkedIn: Number(player.checked_in) === 1,
      played,
      wins,
      losses: played - wins,
      pointsFor,
      pointsAgainst,
      pointDifference: pointsFor - pointsAgainst,
      winRate: played === 0 ? 0 : Number((wins / played).toFixed(3)),
      totalWaitingMinutes: Number(totalWaiting.toFixed(1)),
      longestWaitingMinutes: Number(longestWaiting.toFixed(1)),
      requestCount: Number(requests?.total ?? 0),
      requestFulfilled: Number(requests?.matched ?? 0),
      noShows,
    };
  });

  const playedValues = rows.map((row) => row.played);
  const waitingValues = rows.filter((row) => row.checkedIn).map((row) => row.longestWaitingMinutes).sort((left, right) => left - right);
  const sortedGaps = gapValues.slice().sort((left, right) => left - right);
  const busyPlayers = new Set<string>();
  for (const match of matchRows) {
    // Queued and called players count as waiting: on court is the only busy state here.
    if (['COURT_ASSIGNED', 'PLAYING', 'RESULT_PENDING'].includes(String(match.status))) {
      busyPlayers.add(String(match.player_a_id));
      busyPlayers.add(String(match.player_b_id));
    }
  }
  // A finished event stops counting idle time at its end whistle; a running one at now.
  const eventEndMs = event.end_time ? new Date(String(event.end_time)).getTime() : null;
  const idleHorizonMs = eventEndMs === null ? Date.now() : Math.min(Date.now(), eventEndMs);
  const idleValues = rows
    .filter((row) => row.checkedIn && !busyPlayers.has(row.participantId) && lastFreeMs.has(row.participantId))
    .map((row) => Math.max(0, toMinutes(idleHorizonMs - (lastFreeMs.get(row.participantId) as number))))
    .sort((left, right) => left - right);
  const totalWaitingValues = rows.filter((row) => row.checkedIn).map((row) => row.totalWaitingMinutes).sort((left, right) => left - right);
  const matchStats = stats(playedValues);

  const histogram = new Map<number, number>();
  playedValues.forEach((value) => histogram.set(value, (histogram.get(value) ?? 0) + 1));

  const courtRows = asRows<{ court_id: string; court_name: string; available_from: string; available_to: string }>(
    db.prepare(`SELECT court_id, court_name, available_from, available_to FROM courts WHERE event_id = ? AND enabled = 1 ORDER BY priority, court_number`).all(eventId));
  const perCourt = courtRows.map((court) => {
    const matches = matchRows.filter((match) => match.court_id === court.court_id && ['COURT_ASSIGNED', 'PLAYING', 'RESULT_PENDING', 'COMPLETED'].includes(match.status));
    let busyMinutes = 0;
    for (const match of matches) {
      const from = match.start_time ? new Date(match.start_time).getTime()
        : match.scheduled_time ? new Date(match.scheduled_time).getTime() : null;
      const to = match.end_time ? new Date(match.end_time).getTime() : null;
      busyMinutes += from && to ? toMinutes(to - from) : defaultMinutes;
    }
    const window = toMinutes(new Date(court.available_to).getTime() - new Date(court.available_from).getTime());
    return {
      courtId: court.court_id,
      courtName: court.court_name,
      matches: matches.length,
      busyMinutes: Number(busyMinutes.toFixed(1)),
      utilization: window <= 0 ? 0 : Number((busyMinutes / window).toFixed(3)),
    };
  });
  const busyMinutesTotal = perCourt.reduce((sum, court) => sum + court.busyMinutes, 0);
  const availableMinutesTotal = courtRows.reduce((sum, court) => sum + Math.max(0, toMinutes(new Date(court.available_to).getTime() - new Date(court.available_from).getTime())), 0);

  const statusCounts = asRows<{ status: string; total: number }>(db.prepare(`
    SELECT status, COUNT(*) AS total FROM matches WHERE event_id = ? GROUP BY status`).all(eventId));
  const countOf = (status: string) => Number(statusCounts.find((row) => row.status === status)?.total ?? 0);
  const sourceCounts = asRows<{ source: string; total: number }>(db.prepare(`
    SELECT source, COUNT(*) AS total FROM matches WHERE event_id = ? GROUP BY source`).all(eventId));
  const phaseCounts = asRows<{ phase: string; total: number }>(db.prepare(`
    SELECT phase, COUNT(*) AS total FROM matches WHERE event_id = ? GROUP BY phase`).all(eventId));
  const bySource = Object.fromEntries(sourceCounts.map((row) => [row.source, Number(row.total)]));

  const classRows = asRows<{ class_id: string | null; class_name: string | null }>(db.prepare(`
    SELECT class_id, class_name FROM classes WHERE event_id = ? AND enabled = 1 ORDER BY display_order`).all(eventId));

  const standings = classRows.map((clazz) => {
    const group = rows.filter((row) => row.className === clazz.class_name).sort((left, right) => right.wins - left.wins || right.pointDifference - left.pointDifference);
    let rank = 0;
    let prior: ParticipantReportRow | undefined;
    return {
      className: clazz.class_name,
      rows: group.slice(0, 10).map((row, index) => {
        if (!prior || row.wins !== prior.wins || row.pointDifference !== prior.pointDifference) rank = index + 1;
        prior = row;
        return { rank, name: row.name, played: row.played, wins: row.wins, pointDifference: row.pointDifference };
      }),
    };
  });

  const totalRequests = Number(requestStats.total ?? 0);
  const matchedRequests = Number(requestStats.matched ?? 0);
  const noShowMatches = countOf('NO_SHOW');
  const affectedNoShow = rows.filter((row) => row.noShows > 0).length;
  const activePlayers = rows.filter((row) => row.checkedIn);
  const most = [...rows].sort((left, right) => right.played - left.played)[0];
  const least = [...rows].sort((left, right) => left.played - right.played)[0];

  const lastCompleted = matchRows
    .filter((match) => match.status === 'COMPLETED' && match.end_time)
    .map((match) => String(match.end_time))
    .sort()
    .at(-1) ?? null;

  return {
    eventId,
    eventName: String(event.event_name),
    eventDate: String(event.event_date),
    venue: String(event.venue ?? ''),
    status: String(event.status),
    eventMode: String(event.event_mode),
    phase: String(event.current_phase),
    generatedAt: new Date().toISOString(),
    window: {
      start: String(event.start_time),
      end: String(event.end_time),
      plannedMinutes: Number(toMinutes(endMs - startMs).toFixed(1)),
      actualLastMatch: lastCompleted,
      playedMinutes: Number(matchRows.filter((match) => match.status === 'COMPLETED')
        .reduce((sum, match) => sum + (match.start_time && match.end_time
          ? toMinutes(new Date(match.end_time).getTime() - new Date(match.start_time).getTime())
          : defaultMinutes), 0).toFixed(1)),
    },
    participants: {
      registered: rows.length,
      active: rows.filter((row) => row.checkedIn).length,
      checkedIn: rows.filter((row) => row.checkedIn).length,
      classes: classRows.length,
    },
    matches: {
      total: matchRows.length,
      completed: countOf('COMPLETED'),
      cancelled: countOf('CANCELLED'),
      noShow: noShowMatches,
      pendingResult: countOf('RESULT_PENDING'),
      bySource,
      byPhase: Object.fromEntries(phaseCounts.map((row) => [row.phase, Number(row.total)])),
    },
    matchCount: {
      total: playedValues.reduce((sum, value) => sum + value, 0),
      avg: Number(matchStats.avg.toFixed(2)),
      min: matchStats.min,
      max: matchStats.max,
      spread: matchStats.max - matchStats.min,
      zeroMatchPlayers: playedValues.filter((value) => value === 0).length,
      histogram: [...histogram.entries()].sort((left, right) => left[0] - right[0]).map(([matches, players]) => ({ matches, players })),
    },
    waiting: {
      avgMinutes: Number(stats(totalWaitingValues).avg.toFixed(1)),
      maxMinutes: Number((waitingValues.at(-1) ?? 0).toFixed(1)),
      over30Players: waitingValues.filter((value) => value >= 30).length,
      p90Minutes: Number(percentile(sortedGaps, 0.9).toFixed(1)),
      samples: gapValues.length,
      longestIdleMinutes: Number((idleValues.at(-1) ?? 0).toFixed(1)),
      idleOver30Players: idleValues.filter((value) => value >= 30).length,
      idlePlayers: idleValues.length,
    },
    courts: {
      count: courtRows.length,
      utilization: availableMinutesTotal <= 0 ? 0 : Number((busyMinutesTotal / availableMinutesTotal).toFixed(3)),
      busyMinutes: Number(busyMinutesTotal.toFixed(1)),
      availableMinutes: Number(availableMinutesTotal.toFixed(1)),
      perCourt,
    },
    requests: {
      total: totalRequests,
      active: Number(requestStats.active ?? 0),
      matched: matchedRequests,
      cancelled: Number(requestStats.cancelled ?? 0),
      expired: Number(requestStats.expired ?? 0),
      fulfillmentRate: totalRequests === 0 ? 1 : Number((matchedRequests / totalRequests).toFixed(3)),
    },
    fairness: {
      playedStdDev: Number(matchStats.stdDev.toFixed(2)),
      // 1.0 means everybody played the same number of matches; a spread wider than
      // twice the average bottoms the score out at 0 rather than going negative.
      balanceScore: rows.length === 0 ? 1 : Number(Math.min(1, Math.max(0,
        1 - (matchStats.max - matchStats.min) / Math.max(1, matchStats.avg * 2))).toFixed(3)),
      mostPlayed: most ? `${most.name}（${most.played}試合）` : null,
      leastPlayed: least ? `${least.name}（${least.played}試合）` : null,
    },
    automation: {
      autoEngine: Number(event.auto_engine_enabled) === 1,
      autoCourt: Number(event.auto_court_assignment) === 1,
      createdAuto: Number(bySource.AUTO ?? 0),
      createdManual: Number(bySource.MANUAL ?? 0) + Number(bySource.ADMIN ?? 0),
      autoShare: matchRows.length === 0 ? 0 : Number(((Number(bySource.AUTO ?? 0) / matchRows.length)).toFixed(3)),
    },
    noShows: {
      count: noShowMatches,
      affectedPlayers: affectedNoShow,
      rate: matchRows.length === 0 ? 0 : Number((noShowMatches / matchRows.length).toFixed(3)),
    },
    integrity: runIntegrityChecks(db, eventId),
    standings,
    rows,
  };
}

/** Excel friendly CSV for Japanese spreadsheets: BOM plus CRLF. */
export function reportToCsv(report: EventReport): string {
  const esc = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines: string[] = [];
  lines.push(['#', report.eventName, esc(`${report.eventDate} ${report.venue}`), `生成 ${report.generatedAt}`].join(','));
  lines.push('集計,値');
  lines.push(`参加者数,${esc(report.participants.registered)}`);
  lines.push(`チェックイン数,${esc(report.participants.checkedIn)}`);
  lines.push(`総試合数,${esc(report.matches.total)}`);
  lines.push(`完了試合数,${esc(report.matches.completed)}`);
  lines.push(`1人平均試合数,${esc(report.matchCount.avg)}`);
  lines.push(`最少試合数,${esc(report.matchCount.min)}`);
  lines.push(`最多試合数,${esc(report.matchCount.max)}`);
  lines.push(`平均待機時間(分),${esc(report.waiting.avgMinutes)}`);
  lines.push(`最大待機時間(分),${esc(report.waiting.maxMinutes)}`);
  lines.push(`レポート時点の待機(分),${esc(report.waiting.longestIdleMinutes)}`);
  lines.push(`30分以上待機中の選手,${esc(report.waiting.idleOver30Players)}`);
  lines.push(`コート稼働率,${esc(report.courts.utilization)}`);
  lines.push(`希望成立率,${esc(report.requests.fulfillmentRate)}`);
  lines.push(`ノーショー,${esc(report.noShows.count)}`);
  lines.push(`取消,${esc(report.matches.cancelled)}`);
  lines.push('');
  lines.push('選手名,クラス,所属,試合数,勝利,敗北,勝率,得点,失点,得失差,合計待機(分),最大待機(分),希望数,希望成立数,ノーショー');
  for (const row of report.rows) {
    lines.push([esc(row.name), esc(row.className), esc(row.club), row.played, row.wins, row.losses, row.winRate,
      row.pointsFor, row.pointsAgainst, row.pointDifference, row.totalWaitingMinutes, row.longestWaitingMinutes,
      row.requestCount, row.requestFulfilled, row.noShows].join(','));
  }
  lines.push('');
  lines.push('コート,試合数,稼働分,稼働率');
  for (const court of report.courts.perCourt) {
    lines.push([esc(court.courtName), court.matches, court.busyMinutes, court.utilization].join(','));
  }
  return `\ufeff${lines.join('\r\n')}\r\n`;
}
