import type { DB } from '../db.js';
import { asRows } from '../db.js';

export type ViolationCode =
  | 'PARTICIPANT_DOUBLE_BOOKED' | 'COURT_DOUBLE_BOOKED' | 'DUPLICATE_OPEN_PAIR' | 'ORPHAN_REFERENCE'
  | 'INVALID_COMPLETED_SCORE' | 'RESULT_MISMATCH' | 'ORPHAN_RESULT' | 'COMPLETED_WITHOUT_RESULT'
  | 'END_BEFORE_START' | 'INVALID_REQUEST' | 'REQUEST_MATCHED_TO_NON_MATCH' | 'COURT_STATE_STALE' | 'WINNER_NOT_IN_MATCH' | 'SCORE_ON_OPEN_MATCH'
  | 'BRACKET_SLOT_DUPLICATE' | 'BRACKET_ADVANCE_MISSED' | 'BRACKET_FINAL_UNCLOSED' | 'BRACKET_SEED_UNKNOWN'
  | 'RESULT_UNCONFIRMED' | 'RESULT_DISPUTED';

/** Japanese labels shared by the QA endpoint, the CLI and the report sheet. */
export const VIOLATION_LABELS: Record<ViolationCode, string> = {
  PARTICIPANT_DOUBLE_BOOKED: '選手の二重予約',
  COURT_DOUBLE_BOOKED: 'コートの二重予約',
  DUPLICATE_OPEN_PAIR: '同一カードの重複',
  ORPHAN_REFERENCE: '存在しないレコードへの参照',
  INVALID_COMPLETED_SCORE: 'スコアが不正な完了試合',
  RESULT_MISMATCH: '勝者とスコアの不一致',
  ORPHAN_RESULT: '試合のない結果記録',
  COMPLETED_WITHOUT_RESULT: '結果がないまま完了',
  END_BEFORE_START: '終了が開始より古い',
  INVALID_REQUEST: '不正な対戦希望',
  REQUEST_MATCHED_TO_NON_MATCH: '希望が別カードと接続',
  COURT_STATE_STALE: 'コート状態の食い違い',
  WINNER_NOT_IN_MATCH: '勝者がカードに不在',
  SCORE_ON_OPEN_MATCH: '未終了カードにスコア',
  BRACKET_SLOT_DUPLICATE: 'トーナメント枠の重複カード',
  BRACKET_ADVANCE_MISSED: 'トーナメントの次ラウンド未作成',
  BRACKET_FINAL_UNCLOSED: '決勝済みなのに未閉じのトーナメント',
  BRACKET_SEED_UNKNOWN: 'シード外の選手が組まれたトーナメント対戦',
  RESULT_UNCONFIRMED: '結果が確定されないまま経過',
  RESULT_DISPUTED: '選手の申告不一致',
};

export interface IntegrityViolation {
  code: ViolationCode;
  severity: 'CRITICAL' | 'WARNING';
  count: number;
  sample: string | null;
}

export interface IntegrityReport {
  eventId: string;
  checkedAt: string;
  checks: number;
  violations: IntegrityViolation[];
  clean: boolean;
}

const OPEN = `status IN ('WAITING','CALLED','COURT_ASSIGNED','PLAYING','RESULT_PENDING')`;
const BLOCKING = `status IN ('CALLED','COURT_ASSIGNED','PLAYING','RESULT_PENDING')`;

interface CounterRow { count: number; sample?: string | null }

function first(rows: Array<Record<string, any>>): string | null {
  if (rows.length === 0) return null;
  const row = rows[0];
  const key = Object.keys(row)[0]!;
  return String(row[key]);
}

/**
 * The integrity suite the spec demands, expressed as one query set so the same
 * rules guard the stress simulation, the QA endpoint and the event report.
 * Anything listed here as CRITICAL means the running board cannot be trusted.
 */
export function runIntegrityChecks(db: DB, eventId: string): IntegrityReport {
  const violations: IntegrityViolation[] = [];
  const push = (code: ViolationCode, severity: IntegrityViolation['severity'], rows: CounterRow[]) => {
    for (const row of rows) {
      if (Number(row.count) > 0) {
        violations.push({ code, severity, count: Number(row.count), sample: row.sample === undefined ? null : String(row.sample ?? null) });
        return;
      }
    }
  };

  /** One SQL rule -> one violation entry. Keeps the rule set auditable. */
  const check = (code: IntegrityViolation['code'], severity: IntegrityViolation['severity'], sql: string, ...params: unknown[]) => {
    push(code, severity, asRows<CounterRow>(db.prepare(sql).all(...(params as never[]))));
  };

  // 1) No participant may sit in two live matches at once.
  check('PARTICIPANT_DOUBLE_BOOKED', 'CRITICAL', `
    SELECT COUNT(*) AS count, player AS sample FROM (
      SELECT player, COUNT(*) AS total FROM (
        SELECT player_a_id AS player FROM matches WHERE event_id = ? AND ${BLOCKING}
        UNION ALL SELECT player_b_id FROM matches WHERE event_id = ? AND ${BLOCKING}
      ) GROUP BY player HAVING total > 1
    )`, eventId, eventId);

  // 2) No court may host two live matches.
  check('COURT_DOUBLE_BOOKED', 'CRITICAL', `
    SELECT COUNT(*) AS count, court_id AS sample FROM matches
    WHERE event_id = ? AND court_id IS NOT NULL AND ${BLOCKING}
    GROUP BY court_id HAVING COUNT(*) > 1`, eventId);

  // 3) The same pair may not be open twice.
  check('DUPLICATE_OPEN_PAIR', 'CRITICAL', `
    SELECT COUNT(*) AS count, pair_key AS sample FROM matches
    WHERE event_id = ? AND pair_key IS NOT NULL AND ${OPEN}
    GROUP BY pair_key HAVING COUNT(*) > 1`, eventId);

  // 4) Every reference must exist inside the same event (no phantom entities).
  check('ORPHAN_REFERENCE', 'CRITICAL', `
    SELECT COUNT(*) AS count, m.match_id AS sample FROM matches m
    WHERE m.event_id = ? AND (
      NOT EXISTS (SELECT 1 FROM participants p WHERE p.participant_id = m.player_a_id AND p.event_id = m.event_id)
      OR NOT EXISTS (SELECT 1 FROM participants p WHERE p.participant_id = m.player_b_id AND p.event_id = m.event_id)
      OR (m.court_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM courts c WHERE c.court_id = m.court_id AND c.event_id = m.event_id))
      OR (m.class_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM classes cl WHERE cl.class_id = m.class_id AND cl.event_id = m.event_id))
      OR (m.bracket_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.bracket_id = m.bracket_id AND tb.event_id = m.event_id))
    )`, eventId);

  // 5) A completed match needs a valid, decidable score.
  check('INVALID_COMPLETED_SCORE', 'CRITICAL', `
    SELECT COUNT(*) AS count, match_id AS sample FROM matches
    WHERE event_id = ? AND status = 'COMPLETED' AND (
      score_a IS NULL OR score_b IS NULL OR score_a = score_b
      OR winner_id IS NULL OR (winner_id <> player_a_id AND winner_id <> player_b_id))`, eventId);

  // 6) The stored result row must agree with the match row (no split truth).
  check('RESULT_MISMATCH', 'CRITICAL', `
    SELECT COUNT(*) AS count, m.match_id AS sample FROM matches m JOIN results r ON r.match_id = m.match_id
    WHERE m.event_id = ? AND (r.score_a <> m.score_a OR r.score_b <> m.score_b OR r.winner_id <> m.winner_id)`, eventId);

  // 7) A result without a completed match, or a completed match without a result.
  //    A player's report waiting to be confirmed (ENTERED / DISPUTED on a match still
  //    in PLAYING or RESULT_PENDING) is the designed two-step state, not an orphan.
  check('ORPHAN_RESULT', 'CRITICAL', `
    SELECT COUNT(*) AS count, r.result_id AS sample FROM results r JOIN matches m ON m.match_id = r.match_id
    WHERE m.event_id = ? AND m.status <> 'COMPLETED'
      AND NOT (m.status IN ('PLAYING','RESULT_PENDING') AND r.status IN ('ENTERED','DISPUTED'))`, eventId);

  // 7b) Confirmation left to rot: a report nobody confirmed past the event's timeout,
  //     and a pair of claims the operator has not resolved yet.
  check('RESULT_UNCONFIRMED', 'WARNING', `
    SELECT COUNT(*) AS count, r.result_id AS sample FROM results r
    JOIN matches m ON m.match_id = r.match_id JOIN events e ON e.event_id = m.event_id
    WHERE m.event_id = ? AND r.status = 'ENTERED' AND m.status <> 'COMPLETED'
      AND datetime(r.entered_at) <= datetime('now', '-' || e.result_confirm_timeout_minutes || ' minutes')`, eventId);
  check('RESULT_DISPUTED', 'WARNING', `
    SELECT COUNT(*) AS count, r.result_id AS sample FROM results r JOIN matches m ON m.match_id = r.match_id
    WHERE m.event_id = ? AND r.status = 'DISPUTED'`, eventId);
  check('COMPLETED_WITHOUT_RESULT', 'WARNING', `
    SELECT COUNT(*) AS count, m.match_id AS sample FROM matches m
    WHERE m.event_id = ? AND m.status = 'COMPLETED' AND NOT EXISTS (
      SELECT 1 FROM results r WHERE r.match_id = m.match_id)`, eventId);

  // 8) Timeline sanity: a match cannot end before it starts.
  check('END_BEFORE_START', 'CRITICAL', `
    SELECT COUNT(*) AS count, match_id AS sample FROM matches
    WHERE event_id = ? AND start_time IS NOT NULL AND end_time IS NOT NULL AND end_time < start_time`, eventId);

  // 9) Requests must point at real players of this event and their match link must exist.
  check('INVALID_REQUEST', 'CRITICAL', `
    SELECT COUNT(*) AS count, r.request_id AS sample FROM match_requests r
    WHERE r.event_id = ? AND (
      NOT EXISTS (SELECT 1 FROM participants p WHERE p.participant_id = r.requester_id AND p.event_id = r.event_id)
      OR NOT EXISTS (SELECT 1 FROM participants p WHERE p.participant_id = r.target_player_id AND p.event_id = r.event_id)
      OR (r.matched_match_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.match_id = r.matched_match_id AND m.event_id = r.event_id))
    )`, eventId);
  check('REQUEST_MATCHED_TO_NON_MATCH', 'WARNING', `
    SELECT COUNT(*) AS count, r.request_id AS sample FROM match_requests r
    LEFT JOIN matches m ON m.match_id = r.matched_match_id
    WHERE r.event_id = ? AND r.status = 'MATCHED' AND m.match_id IS NULL`, eventId);

  // 10) Court status must reflect the match actually holding it.
  check('COURT_STATE_STALE', 'WARNING', `
    SELECT COUNT(*) AS count, c.court_id AS sample FROM courts c
    WHERE c.event_id = ? AND c.enabled = 1 AND c.status IN ('PLAYING','CALLING','RESULT_PENDING','RESERVED')
      AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.court_id = c.court_id AND ${BLOCKING})`, eventId);
  // 11) Winner must be one of the two players on every scored match, even if not completed.
  check('WINNER_NOT_IN_MATCH', 'CRITICAL', `
    SELECT COUNT(*) AS count, match_id AS sample FROM matches
    WHERE event_id = ? AND winner_id IS NOT NULL AND winner_id NOT IN (player_a_id, player_b_id)`, eventId);

  // 12) Score without completion (half written row).
  check('SCORE_ON_OPEN_MATCH', 'WARNING', `
    SELECT COUNT(*) AS count, match_id AS sample FROM matches
    WHERE event_id = ? AND ${OPEN} AND (score_a IS NOT NULL OR score_b IS NOT NULL)`, eventId);

  // 13) A bracket slot holds at most one live card (the unique index enforces it,
  //     the check catches a database that was patched behind the app's back).
  check('BRACKET_SLOT_DUPLICATE', 'CRITICAL', `
    SELECT COUNT(*) AS count, MIN(m.match_id) AS sample FROM matches m
    JOIN tournament_brackets b ON b.bracket_id = m.bracket_id
    WHERE b.event_id = ? AND m.bracket_round IS NOT NULL AND m.status <> 'CANCELLED'
    GROUP BY m.bracket_id, m.bracket_round, m.bracket_slot HAVING COUNT(*) > 1`, eventId);

  // 14) Both feeders decided but the next card missing: the draw has stalled.
  check('BRACKET_ADVANCE_MISSED', 'CRITICAL', `
    SELECT COUNT(*) AS count, m.match_id AS sample FROM matches m
    JOIN tournament_brackets b ON b.bracket_id = m.bracket_id
    JOIN matches sibling ON sibling.bracket_id = m.bracket_id
      AND sibling.bracket_round = m.bracket_round
      AND sibling.bracket_slot = CASE WHEN m.bracket_slot % 2 = 0 THEN m.bracket_slot + 1 ELSE m.bracket_slot - 1 END
      AND sibling.status = 'COMPLETED' AND sibling.winner_id IS NOT NULL
    WHERE b.event_id = ? AND b.status = 'OPEN' AND m.status = 'COMPLETED' AND m.winner_id IS NOT NULL
      AND m.bracket_round < b.rounds
      AND NOT EXISTS (SELECT 1 FROM matches nxt WHERE nxt.bracket_id = m.bracket_id
        AND nxt.bracket_round = m.bracket_round + 1 AND nxt.bracket_slot = m.bracket_slot / 2
        AND nxt.status <> 'CANCELLED')`, eventId);

  // 15) A decided final has to close its bracket, with the same champion recorded.
  check('BRACKET_FINAL_UNCLOSED', 'CRITICAL', `
    SELECT COUNT(*) AS count, b.bracket_id AS sample FROM tournament_brackets b
    JOIN matches f ON f.bracket_id = b.bracket_id AND f.bracket_round = b.rounds AND f.bracket_slot = 0
    WHERE b.event_id = ? AND (
      (b.status = 'OPEN' AND f.status = 'COMPLETED' AND f.winner_id IS NOT NULL)
      OR (b.status = 'COMPLETED' AND (b.winner_id IS NULL OR b.winner_id <> f.winner_id)))`, eventId);

  // 16) Round-1 cards may only hold seeded players of their own bracket.
  check('BRACKET_SEED_UNKNOWN', 'CRITICAL', `
    SELECT COUNT(*) AS count, m.match_id AS sample FROM matches m
    JOIN tournament_brackets b ON b.bracket_id = m.bracket_id
    WHERE b.event_id = ? AND m.bracket_round = 1 AND (
      NOT EXISTS (SELECT 1 FROM tournament_seeds ts WHERE ts.bracket_id = m.bracket_id AND ts.participant_id = m.player_a_id)
      OR NOT EXISTS (SELECT 1 FROM tournament_seeds ts WHERE ts.bracket_id = m.bracket_id AND ts.participant_id = m.player_b_id))`, eventId);

  return {
    eventId,
    checkedAt: new Date().toISOString(),
    checks: 20,
    violations,
    clean: violations.every((item) => item.severity !== 'CRITICAL'),
  };
}

/** Sample ids make a QA failure actionable instead of a bare count. */
export function sampleIds(db: DB, eventId: string, limit = 5): Array<Record<string, string>> {
  return asRows<Record<string, string>>(db.prepare(`SELECT match_id AS id, status, source FROM matches
    WHERE event_id = ? ORDER BY updated_at DESC LIMIT ?`).all(eventId, limit));
}
