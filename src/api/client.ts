import type {
  AnnouncementRow, CourtRow, EngineRunResult, EngineState, EventDetail, EventSummary, LeaguePreview, MatchRow,
  EventReport, EventSnapshot, IntegrityReport, MyMatchView, TournamentBracket, TournamentGenerated, TournamentPreview, ParticipantRow, RankingRow, RequestRow, ResultRow, ScoreBreakdown, Session,
} from './types';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

const BASE = '/api';

async function call<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let payload: any = {};
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { error: { code: 'BAD_JSON', message: '応答を解析できませんでした。' } }; }
  }
  if (!response.ok) {
    throw new ApiError(response.status, payload?.error?.code ?? 'ERROR', payload?.error?.message ?? 'リクエストに失敗しました。', payload?.error?.details);
  }
  return payload?.data as T;
}

export interface ManualMatchInput {
  playerAId: string;
  playerBId: string;
  courtId?: string | null;
  classId?: string | null;
  phase?: 'LEAGUE' | 'REQUEST' | 'TOURNAMENT';
  scheduledTime?: string | null;
  priorityScore?: number;
  force?: boolean;
}

export type MatchAction = 'CALL' | 'ASSIGN' | 'START' | 'FINISH' | 'CANCEL' | 'NO_SHOW';

export interface SuggestionRow {
  participantId: string;
  name: string;
  className: string | null;
  rating?: number;
  played: number;
  headToHead: number;
  requestedPriority: number | null;
}

export interface ExplainResponse {
  matchId?: string;
  playerA?: { name: string; played: number; waitingMinutes: number; rating: number } | null;
  playerB?: { name: string; played: number; waitingMinutes: number; rating: number } | null;
  breakdown?: ScoreBreakdown | null;
  rank?: number | null;
  candidateCount?: number;
  candidates?: EngineState['candidates'];
}

export const api = {
  me: () => call<Session>('GET', '/auth/me'),
  login: (email: string, password: string) => call<Session>('POST', '/auth/login', { email, password }),
  logout: () => call<void>('POST', '/auth/logout', {}),
  demoAccounts: () => call<Array<{ role: string; email: string; password: string; label: string }>>('GET', '/demo/accounts'),

  events: () => call<EventSummary[]>('GET', '/events'),
  event: (eventId: string) => call<EventDetail>('GET', `/events/${eventId}`),
  patchEvent: (eventId: string, patch: Record<string, unknown> & { rowVersion: number }) =>
    call<EventDetail>('PATCH', `/events/${eventId}`, patch),
  setStatus: (eventId: string, status: string, rowVersion: number) =>
    call<EventDetail>('POST', `/events/${eventId}/status`, { status, rowVersion }),

  participants: (eventId: string, query = '') => call<ParticipantRow[]>('GET', `/events/${eventId}/participants${query}`),
  patchParticipant: (eventId: string, participantId: string, patch: Record<string, unknown> & { rowVersion: number }) =>
    call<ParticipantRow>('PATCH', `/events/${eventId}/participants/${participantId}`, patch),

  courts: (eventId: string) => call<CourtRow[]>('GET', `/events/${eventId}/courts`),
  patchCourt: (eventId: string, courtId: string, patch: Record<string, unknown> & { rowVersion: number }) =>
    call<CourtRow>('PATCH', `/events/${eventId}/courts/${courtId}`, patch),

  matches: (eventId: string, query = '') => call<MatchRow[]>('GET', `/events/${eventId}/matches${query}`),
  match: (eventId: string, matchId: string) => call<MatchRow>('GET', `/events/${eventId}/matches/${matchId}`),
  createMatch: (eventId: string, input: ManualMatchInput) => call<MatchRow>('POST', `/events/${eventId}/matches`, input),
  patchMatch: (eventId: string, matchId: string, patch: Record<string, unknown> & { rowVersion: number }) =>
    call<MatchRow>('PATCH', `/events/${eventId}/matches/${matchId}`, patch),
  matchAction: (eventId: string, matchId: string, action: MatchAction, rowVersion: number, extra?: Record<string, unknown>) =>
    call<MatchRow>('POST', `/events/${eventId}/matches/${matchId}/action`, { action, rowVersion, ...extra }),
  enterResult: (eventId: string, matchId: string, scoreA: number, scoreB: number, rowVersion: number, note?: string) =>
    call<MatchRow & { resultStatus?: string; confirmed?: boolean }>('POST', `/events/${eventId}/matches/${matchId}/result`, {
      scoreA, scoreB, rowVersion, ...(note ? { note } : {}),
    }),
  correctResult: (eventId: string, matchId: string, scoreA: number, scoreB: number, rowVersion: number) =>
    call<ResultRow>('PATCH', `/events/${eventId}/matches/${matchId}/result`, { scoreA, scoreB, rowVersion }),
  confirmResult: (eventId: string, matchId: string, rowVersion?: number) =>
    call<MatchRow>('POST', `/events/${eventId}/matches/${matchId}/result/confirm`, rowVersion === undefined ? {} : { rowVersion }),
  rejectResult: (eventId: string, matchId: string, note?: string | null) =>
    call<MatchRow>('POST', `/events/${eventId}/matches/${matchId}/result/reject`, { note: note ?? null }),
  sweepResults: (eventId: string) => call<{ confirmed: number; disputed: number; matchIds: string[] }>('POST', `/events/${eventId}/results/sweep`, {}),

  engineState: (eventId: string) => call<EngineState>('GET', `/events/${eventId}/engine/state`),
  enginePreview: (eventId: string, body: Record<string, unknown> = {}) => call<EngineRunResult>('POST', `/events/${eventId}/engine/preview`, body),
  engineRun: (eventId: string, body: Record<string, unknown> = {}) => call<EngineRunResult>('POST', `/events/${eventId}/engine/run`, body),
  engineExplain: (eventId: string, matchId?: string) =>
    call<ExplainResponse>('GET', `/events/${eventId}/engine/explain${matchId ? `?matchId=${matchId}` : ''}`),

  leaguePreview: (eventId: string, classIds?: string[]) => call<LeaguePreview>('POST', `/events/${eventId}/league/preview`, { classIds }),
  leagueGenerate: (eventId: string, classIds?: string[]) =>
    call<{ createdCount: number; skippedDuplicate: number; skippedEndTime: number }>('POST', `/events/${eventId}/league/generate`, { classIds }),

  tournamentPreview: (eventId: string) => call<TournamentPreview>('GET', `/events/${eventId}/tournament/preview`),
  tournamentBrackets: (eventId: string) => call<TournamentBracket[]>('GET', `/events/${eventId}/tournament`),
  tournamentGenerate: (eventId: string, classId: string) =>
    call<TournamentGenerated>('POST', `/events/${eventId}/tournament/generate`, { classId }),
  tournamentRebalance: (eventId: string, bracketId: string) =>
    call<{ created: number; bracket: TournamentBracket }>('POST', `/events/${eventId}/tournament/${bracketId}/rebalance`, {}),
  tournamentDelete: (eventId: string, bracketId: string) =>
    call<{ cancelledMatches: number }>('DELETE', `/events/${eventId}/tournament/${bracketId}`),

  requests: (eventId: string, query = '') => call<RequestRow[]>('GET', `/events/${eventId}/requests${query}`),
  createRequest: (eventId: string, targetPlayerId: string, priority: 1 | 2 | 3, requesterId?: string) =>
    call<RequestRow>('POST', `/events/${eventId}/requests`, { targetPlayerId, priority, requesterId }),
  cancelRequest: (eventId: string, requestId: string, rowVersion: number) =>
    call<RequestRow>('PATCH', `/events/${eventId}/requests/${requestId}`, { status: 'CANCELLED', rowVersion }),
  deleteRequest: (eventId: string, requestId: string) => call<void>('DELETE', `/events/${eventId}/requests/${requestId}`),
  suggestions: (eventId: string, participantId?: string) =>
    call<SuggestionRow[]>('GET', `/events/${eventId}/requests/suggestions${participantId ? `?participantId=${participantId}` : ''}`),

  /** The participant phone's single aggregate call. */
  myView: (eventId: string, participantId?: string | null) =>
    call<MyMatchView>('GET', `/events/${eventId}/me${participantId ? `?participantId=${participantId}` : ''}`),
  announcements: (eventId: string, all = false) => call<AnnouncementRow[]>('GET', `/events/${eventId}/announcements${all ? '?all=true' : ''}`),
  createAnnouncement: (eventId: string, title: string, body: string, severity: 'INFO' | 'IMPORTANT' | 'URGENT') =>
    call<AnnouncementRow>('POST', `/events/${eventId}/announcements`, { title, body, severity }),
  patchAnnouncement: (eventId: string, announcementId: string, patch: Record<string, unknown>) =>
    call<AnnouncementRow>('PATCH', `/events/${eventId}/announcements/${announcementId}`, patch),

  /** One polled round trip for the whole operator board. */
  snapshot: (eventId: string) => call<EventSnapshot>('GET', `/events/${eventId}/snapshot`),

  /** Phase 6: printable report + integrity self-check, both computed server side. */
  report: (eventId: string) => call<EventReport>('GET', `/events/${eventId}/report`),
  integrity: (eventId: string) => call<IntegrityReport>('GET', `/events/${eventId}/integrity`),
  /** Plain CSV endpoint, so the browser download manager handles the file. */
  reportCsvUrl: (eventId: string) => `${BASE}/events/${eventId}/report.csv`,

  rankings: (eventId: string, classId?: string) => call<RankingRow[]>('GET', `/events/${eventId}/rankings${classId ? `?classId=${classId}` : ''}`),
  audit: (eventId: string, limit = 40) => call<Array<Record<string, unknown>>>('GET', `/events/${eventId}/audit?limit=${limit}`),
};

export function isConflict(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'VERSION_CONFLICT' || error.status === 409);
}
