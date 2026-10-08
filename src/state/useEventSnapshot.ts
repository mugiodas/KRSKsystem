import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { CourtRow, EngineState, EventDetail, MatchRow, ParticipantRow, RequestRow } from '../api/types';

export interface Snapshot {
  event: EventDetail;
  courts: CourtRow[];
  /** Live matches plus everything touched in the last 30 minutes. */
  matches: MatchRow[];
  /** Unfiltered matches of the event, used for history and reports. */
  allMatches: MatchRow[];
  participants: ParticipantRow[];
  requests: RequestRow[];
  engine: EngineState | null;
  fetchedAt: number;
}

const ACTIVE_STATUSES = ['WAITING', 'CALLED', 'COURT_ASSIGNED', 'PLAYING', 'RESULT_PENDING'];

/**
 * One polling loop per screen, one request per poll. The dashboard never guesses
 * state locally: every panel renders what the API returned, so two operators on two
 * laptops see the same board and a stale tab simply shows a "data age" warning.
 */
export function useEventSnapshot(eventId: string | null, intervalMs = 4000) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const inFlight = useRef(false);

  const refresh = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!eventId || inFlight.current) return;
    inFlight.current = true;
    if (!options.silent) setBusy(true);
    try {
      // A single request carries the whole board: six parallel calls per poll
      // were the busiest thing on the venue Wi-Fi.
      const data = await api.snapshot(eventId);
      if (!alive.current) return;
      setSnapshot({
        event: data.event, courts: data.courts, matches: data.matches, allMatches: data.allMatches,
        participants: data.participants, requests: data.requests, engine: data.engine, fetchedAt: Date.now(),
      });
      setError(null);
    } catch (caught) {
      if (alive.current) setError(caught instanceof ApiError ? caught.message : '大会データの取得に失敗しました。');
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }, [eventId]);

  useEffect(() => {
    alive.current = true;
    void refresh({ silent: true });
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh({ silent: true });
    }, intervalMs);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh({ silent: true }); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, intervalMs]);

  const activeMatches = useMemo(() => (snapshot ? snapshot.matches.filter((match) => ACTIVE_STATUSES.includes(match.status)) : []), [snapshot]);
  return { snapshot, error, busy, refresh, activeMatches, setSnapshot };
}

/** Keeps a live wall clock without re-fetching the whole board. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
