import type { DB } from '../db.js';
import { asRows } from '../db.js';
import { ApiError } from '../http.js';

interface LeagueEvent {
  event_id: string;
  start_time: string;
  end_time: string;
  status: string;
  default_match_minutes: number;
  result_input_grace_minutes: number;
  safety_margin_minutes: number;
  league_match_count: number;
  league_type: 'FULL_ROUND_ROBIN' | 'LIMITED_ROUND_ROBIN';
}

interface LeagueParticipant {
  participant_id: string;
  name: string;
  class_id: string;
  class_name: string;
  rating: number;
}

export interface LeaguePair {
  classId: string;
  className: string;
  round: number;
  playerAId: string;
  playerAName: string;
  playerBId: string;
  playerBName: string;
  scheduledTime: string;
  estimatedEndTime: string;
  existing: boolean;
  fitsBeforeEnd: boolean;
}

function roundRobin<T>(items: T[]): Array<Array<[T, T]>> {
  const players: Array<T | null> = [...items];
  if (players.length % 2 === 1) players.push(null);
  const rounds: Array<Array<[T, T]>> = [];
  const count = players.length;
  for (let round = 0; round < count - 1; round += 1) {
    const pairs: Array<[T, T]> = [];
    for (let index = 0; index < count / 2; index += 1) {
      const left = players[index];
      const right = players[count - 1 - index];
      if (left !== null && right !== null) pairs.push(round % 2 === 0 ? [left, right] : [right, left]);
    }
    rounds.push(pairs);
    const fixed = players[0];
    const rest = players.slice(1);
    rest.unshift(rest.pop() ?? null);
    players.splice(0, players.length, fixed, ...rest);
  }
  return rounds;
}

export function buildLeaguePreview(db: DB, eventId: string, selectedClassIds?: string[]): {
  pairs: LeaguePair[];
  summary: { participantCount: number; matchCount: number; classCount: number; excludedByEndTime: number; duplicateCount: number };
} {
  const event = db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId) as unknown as LeagueEvent | undefined;
  if (!event) throw new ApiError(404, 'EVENT_NOT_FOUND', 'イベントが見つかりません。');

  const classes = asRows<{ class_id: string; class_name: string }>(db.prepare(`SELECT class_id, class_name FROM classes
    WHERE event_id = ? AND enabled = 1 ORDER BY display_order, class_name`).all(eventId));
  const classFilter = selectedClassIds?.length ? new Set(selectedClassIds) : null;
  const enabledClasses = classes.filter((item) => !classFilter || classFilter.has(item.class_id));
  if (!enabledClasses.length) throw new ApiError(400, 'NO_CLASSES', '対象クラスがありません。');

  const courtCount = Math.max(1, Number((db.prepare(`SELECT COUNT(*) AS count FROM courts
    WHERE event_id = ? AND enabled = 1 AND status NOT IN ('BLOCKED','MAINTENANCE')`).get(eventId) as { count: number }).count));
  const existingPairs = new Set(asRows<{ key: string }>(db.prepare(`SELECT
    CASE WHEN player_a_id < player_b_id THEN player_a_id || ':' || player_b_id ELSE player_b_id || ':' || player_a_id END AS key
    FROM matches WHERE event_id = ? AND phase = 'LEAGUE' AND status NOT IN ('CANCELLED','NO_SHOW')`).all(eventId)).map((row) => row.key));

  const preview: LeaguePair[] = [];
  const baseTime = event.status === 'RUNNING'
    ? Math.max(Date.now(), new Date(event.start_time).getTime())
    : new Date(event.start_time).getTime();
  const durationMs = event.default_match_minutes * 60_000;
  const completionBufferMs = (event.result_input_grace_minutes + event.safety_margin_minutes) * 60_000;
  let globalRoundOffsetMs = 0;
  let participantCount = 0;

  for (const leagueClass of enabledClasses) {
    const participants = asRows<LeagueParticipant>(db.prepare(`SELECT p.participant_id, p.name, p.class_id, c.class_name, p.rating
      FROM participants p JOIN classes c ON c.class_id = p.class_id
      WHERE p.event_id = ? AND p.class_id = ? AND p.active = 1 AND p.checked_in = 1
      ORDER BY p.rating DESC, p.name_kana, p.name`).all(eventId, leagueClass.class_id));
    participantCount += participants.length;
    if (participants.length < 2) continue;
    const allRounds = roundRobin(participants);
    const rounds = event.league_type === 'FULL_ROUND_ROBIN'
      ? allRounds
      : allRounds.slice(0, Math.min(event.league_match_count, allRounds.length));

    rounds.forEach((roundPairs, roundIndex) => {
      const slotsInRound = Math.ceil(roundPairs.length / courtCount);
      roundPairs.forEach(([a, b], pairIndex) => {
        const slot = Math.floor(pairIndex / courtCount);
        const scheduledMs = baseTime + globalRoundOffsetMs + slot * durationMs;
        const estimatedEndMs = scheduledMs + durationMs + completionBufferMs;
        const key = a.participant_id < b.participant_id
          ? `${a.participant_id}:${b.participant_id}` : `${b.participant_id}:${a.participant_id}`;
        preview.push({
          classId: leagueClass.class_id,
          className: leagueClass.class_name,
          round: roundIndex + 1,
          playerAId: a.participant_id,
          playerAName: a.name,
          playerBId: b.participant_id,
          playerBName: b.name,
          scheduledTime: new Date(scheduledMs).toISOString(),
          estimatedEndTime: new Date(estimatedEndMs).toISOString(),
          existing: existingPairs.has(key),
          fitsBeforeEnd: estimatedEndMs <= new Date(event.end_time).getTime(),
        });
      });
      globalRoundOffsetMs += Math.max(1, slotsInRound) * durationMs;
    });
  }

  return {
    pairs: preview,
    summary: {
      participantCount,
      matchCount: preview.filter((pair) => !pair.existing && pair.fitsBeforeEnd).length,
      classCount: enabledClasses.length,
      excludedByEndTime: preview.filter((pair) => !pair.fitsBeforeEnd).length,
      duplicateCount: preview.filter((pair) => pair.existing).length,
    },
  };
}
