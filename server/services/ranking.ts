import type { DB } from '../db.js';
import { asRows } from '../db.js';
import { ApiError } from '../http.js';

interface ParticipantRow {
  participant_id: string;
  name: string;
  club: string;
  class_id: string | null;
  class_name: string | null;
}

interface CompletedMatch {
  player_a_id: string;
  player_b_id: string;
  score_a: number;
  score_b: number;
  winner_id: string;
}

export interface RankingRow {
  eventId: string;
  classId: string | null;
  className: string | null;
  rank: number;
  participantId: string;
  participantName: string;
  club: string;
  played: number;
  wins: number;
  losses: number;
  gamesWon: number;
  gamesLost: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDifference: number;
  winRate: number;
  rankingValue: number;
}

export function calculateRankings(db: DB, eventId: string, classId?: string): RankingRow[] {
  const event = db.prepare('SELECT 1 FROM events WHERE event_id = ?').get(eventId);
  if (!event) throw new ApiError(404, 'EVENT_NOT_FOUND', 'イベントが見つかりません。');
  const participants = asRows<ParticipantRow>(db.prepare(`SELECT p.participant_id, p.name, p.club, p.class_id, c.class_name
    FROM participants p LEFT JOIN classes c ON c.class_id = p.class_id
    WHERE p.event_id = ? AND p.active = 1 AND (? IS NULL OR p.class_id = ?)
    ORDER BY c.display_order, p.name_kana, p.name`).all(eventId, classId ?? null, classId ?? null));
  const matches = asRows<CompletedMatch>(db.prepare(`SELECT player_a_id, player_b_id, score_a, score_b, winner_id
    FROM matches WHERE event_id = ? AND status = 'COMPLETED' AND score_a IS NOT NULL AND score_b IS NOT NULL`).all(eventId));
  const matchByParticipant = new Map<string, CompletedMatch[]>();
  for (const match of matches) {
    matchByParticipant.set(match.player_a_id, [...(matchByParticipant.get(match.player_a_id) ?? []), match]);
    matchByParticipant.set(match.player_b_id, [...(matchByParticipant.get(match.player_b_id) ?? []), match]);
  }
  const rows = participants.map((participant): Omit<RankingRow, 'rank'> => {
    const playedMatches = matchByParticipant.get(participant.participant_id) ?? [];
    let wins = 0;
    let pointsFor = 0;
    let pointsAgainst = 0;
    let gamesWon = 0;
    let gamesLost = 0;
    for (const match of playedMatches) {
      const isA = match.player_a_id === participant.participant_id;
      const own = isA ? Number(match.score_a) : Number(match.score_b);
      const opponent = isA ? Number(match.score_b) : Number(match.score_a);
      pointsFor += own;
      pointsAgainst += opponent;
      if (match.winner_id === participant.participant_id) {
        wins += 1;
        gamesWon += 1;
      } else gamesLost += 1;
    }
    const played = playedMatches.length;
    const winRate = played ? wins / played : 0;
    const difference = pointsFor - pointsAgainst;
    return {
      eventId, classId: participant.class_id, className: participant.class_name,
      participantId: participant.participant_id, participantName: participant.name, club: participant.club,
      played, wins, losses: played - wins, gamesWon, gamesLost, pointsFor, pointsAgainst,
      pointDifference: difference, winRate,
      rankingValue: wins * 1_000_000 + Math.round(winRate * 100_000) + (difference + 10_000) * 100 + pointsFor,
    };
  });

  const grouped = new Map<string, Array<Omit<RankingRow, 'rank'>>>();
  for (const row of rows) {
    const key = row.classId ?? 'unclassified';
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  const ranked: RankingRow[] = [];
  for (const group of grouped.values()) {
    group.sort((a, b) => b.wins - a.wins || b.winRate - a.winRate || b.pointDifference - a.pointDifference || b.pointsFor - a.pointsFor || a.participantName.localeCompare(b.participantName, 'ja'));
    let rank = 0;
    let prior: Omit<RankingRow, 'rank'> | undefined;
    group.forEach((row, index) => {
      if (!prior || row.wins !== prior.wins || row.winRate !== prior.winRate || row.pointDifference !== prior.pointDifference || row.pointsFor !== prior.pointsFor) rank = index + 1;
      ranked.push({ ...row, rank });
      prior = row;
    });
  }
  return ranked;
}
