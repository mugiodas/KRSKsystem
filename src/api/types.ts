export type Role = 'OWNER' | 'ADMIN' | 'VIEWER' | 'PARTICIPANT';

export interface Session {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  participantId: string | null;
}

export interface EventSummary {
  eventId: string;
  eventName: string;
  eventDate: string;
  venue: string;
  startTime: string;
  endTime: string;
  status: 'DRAFT' | 'READY' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
  eventMode: 'LEAGUE_REQUEST' | 'REQUEST_ONLY' | 'LEAGUE_TOURNAMENT_REQUEST';
  currentPhase: 'LEAGUE' | 'TOURNAMENT' | 'REQUEST';
  maxParticipants: number;
  participantCount: number;
  courtCount: number;
  matchCount: number;
  completedMatchCount: number;
}

export interface EventClass {
  classId: string;
  eventId: string;
  className: string;
  displayOrder: number;
  description: string;
  enabled: number;
  rowVersion: number;
}

export interface EventDetail extends Omit<EventSummary, 'participantCount' | 'courtCount' | 'matchCount' | 'completedMatchCount'> {
  defaultMatchMinutes: number;
  minimumRestMinutes: number;
  maximumRestMinutes: number;
  resultInputGraceMinutes: number;
  lateMatchCutoffMinutes: number;
  safetyMarginMinutes: number;
  leagueMatchCount: number;
  leagueType: 'FULL_ROUND_ROBIN' | 'LIMITED_ROUND_ROBIN';
  entryFee: number;
  description: string;
  allowRequest: number;
  allowRematch: number;
  allowSameDayRepeat: number;
  autoCourtAssignment: number;
  autoRematch: number;
  noShowEnabled: number;
  notificationEnabled: number;
  autoEngineEnabled: number;
  weightRequestPriority: number;
  weightWaiting: number;
  weightMatchBalance: number;
  weightUnplayed: number;
  weightRating: number;
  weightTimeFit: number;
  penaltyRecent: number;
  penaltyRepeat: number;
  rowVersion: number;
  classes: EventClass[];
  summary: {
    participantCount: number; checkedInCount: number; courtCount: number;
    matchCount: number; completedMatchCount: number;
  };
}

export interface ParticipantRow {
  participantId: string;
  eventId: string;
  name: string;
  nameKana: string;
  club: string;
  grade: string;
  gender: string;
  category: string;
  classId: string | null;
  className: string | null;
  rating: number;
  active: number;
  checkedIn: number;
  played: number;
  wins: number;
  rowVersion: number;
  updatedAt: string;
}

export interface CourtRow {
  courtId: string;
  eventId: string;
  courtNumber: number;
  courtName: string;
  status: 'AVAILABLE' | 'RESERVED' | 'CALLING' | 'PLAYING' | 'RESULT_PENDING' | 'BLOCKED' | 'MAINTENANCE';
  availableFrom: string;
  availableTo: string;
  priority: number;
  enabled: number;
  currentMatchId: string | null;
  rowVersion: number;
}

export type MatchStatus = 'WAITING' | 'CALLED' | 'COURT_ASSIGNED' | 'PLAYING' | 'RESULT_PENDING'
  | 'COMPLETED' | 'CANCELLED' | 'DISPUTED' | 'NO_SHOW';

export interface MatchRow {
  matchId: string;
  eventId: string;
  phase: 'LEAGUE' | 'REQUEST' | 'TOURNAMENT';
  classId: string | null;
  className: string | null;
  playerAId: string;
  playerBId: string;
  playerAName: string;
  playerBName: string;
  playerAClub: string;
  playerBClub: string;
  courtId: string | null;
  courtName: string | null;
  courtNumber: number | null;
  scheduledTime: string | null;
  calledTime: string | null;
  startTime: string | null;
  endTime: string | null;
  status: MatchStatus;
  source: 'AUTO' | 'MANUAL' | 'REQUEST' | 'ADMIN';
  priorityScore: number;
  scoreA: number | null;
  scoreB: number | null;
  winnerId: string | null;
  rowVersion: number;
  updatedAt: string;
  result?: ResultRow | null;
}

export interface ResultRow {
  resultId: string;
  matchId: string;
  scoreA: number;
  scoreB: number;
  winnerId: string;
  status: 'ENTERED' | 'CONFIRMED' | 'DISPUTED' | 'CORRECTED';
  enteredAt: string;
  rowVersion: number;
}

export interface WaitingPlayer {
  participantId: string;
  name: string;
  className: string | null;
  rating: number;
  played: number;
  wins: number;
  waitingMinutes: number;
  lastEndTime: string | null;
  restReady: boolean;
  restReadyInMinutes: number;
  activeRequests: number;
}

export interface ScoreBreakdown {
  requestPriority: number;
  waitingScore: number;
  matchCountBalance: number;
  unplayedBonus: number;
  ratingCompatibility: number;
  remainingTimeFit: number;
  recentMatchPenalty: number;
  repeatPenalty: number;
  total: number;
  notes: string[];
}

export interface EngineCandidate {
  playerAId: string;
  playerAName: string;
  playerBId: string;
  playerBName: string;
  classId: string | null;
  className: string | null;
  mutual: boolean;
  requestPriority: 1 | 2 | 3 | null;
  repeats: number;
  ratingDiff: number;
  pairWaitingMinutes: number;
  restGapMinutes: number;
  breakdown: ScoreBreakdown;
  score: number;
}

export interface BlockedCandidate extends Omit<EngineCandidate, 'breakdown' | 'score'> {
  reason: string;
  reasonLabel: string;
}

export interface EngineState {
  ranAt: string;
  eventId: string;
  eventName: string;
  phase: string;
  eventMode: string;
  eventStatus: string;
  engineEnabled: boolean;
  autoCourtAssignment: boolean;
  allowRequest: boolean;
  remainingMinutes: number;
  matchSlotMinutes: number;
  timeProtected: boolean;
  eligibleCount: number;
  busyPlayerCount: number;
  courts: Array<{ courtId: string; courtNumber: number; courtName: string; status: string; busy: boolean; free: boolean }>;
  freeCourtCount: number;
  queue: Array<{ matchId: string; phase: string; playerAName: string; playerBName: string; scheduledTime: string | null }>;
  waitingPlayers: WaitingPlayer[];
  evaluatedPairs: number;
  candidates: EngineCandidate[];
  blocked: BlockedCandidate[];
  blockedCounts: Record<string, number>;
  weights: Record<string, number>;
}

export interface EngineRunResult {
  ranAt: string;
  engineEnabled: boolean;
  phase: string;
  freeCourts: number;
  assignedQueue: Array<{ matchId: string; courtId: string; courtName: string; playerAName: string; playerBName: string }>;
  created: Array<{ matchId: string; courtId: string; courtName: string; playerAName: string; playerBName: string; score: number }>;
  candidates: EngineCandidate[];
  evaluatedPairs: number;
  blocked: BlockedCandidate[];
  blockedCounts: Record<string, number>;
  skippedReasons: Record<string, number>;
  endedByTimeProtection: boolean;
}

export interface RequestRow {
  requestId: string;
  requesterId: string;
  requesterName: string;
  targetPlayerId: string;
  targetName: string;
  targetClassName: string | null;
  priority: 1 | 2 | 3;
  status: 'ACTIVE' | 'MATCHED' | 'CANCELLED' | 'EXPIRED';
  matchedMatchId?: string | null;
  matchedMatchStatus?: string | null;
  matchedCourtName?: string | null;
  createdAt: string;
  rowVersion: number;
  own?: boolean;
}

export interface RankingRow {
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

export interface LeaguePreview {
  pairs: LeaguePair[];
  summary: {
    participantCount: number;
    matchCount: number;
    classCount: number;
    excludedByEndTime: number;
    duplicateCount: number;
  };
}

export interface ApiFailure { code: string; message: string }
