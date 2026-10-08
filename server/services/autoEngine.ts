import type { DB } from '../db.js';
import { asRow } from '../db.js';
import { runEngine, type EngineRunResult } from './matching.js';

/**
 * Runs the matching engine after a state change, but only when the event opts in.
 * Failures are logged and never break the operator action that triggered them.
 */
export function maybeRunEngine(db: DB, eventId: string, actorId?: string | null): EngineRunResult | null {
  try {
    const event = asRow<{ status: string; auto_engine_enabled: number; auto_court_assignment: number }>(
      db.prepare('SELECT status, auto_engine_enabled, auto_court_assignment FROM events WHERE event_id = ?').get(eventId),
    );
    if (!event || event.status !== 'RUNNING') return null;
    if (!event.auto_engine_enabled || !event.auto_court_assignment) return null;
    return runEngine(db, eventId, { actorId: actorId ?? null, maxPairs: 40 });
  } catch (error) {
    console.error('[KRSK] auto engine failed', eventId, error);
    return null;
  }
}
