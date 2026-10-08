import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type DB = DatabaseSync;

export function createDatabase(path = process.env.DATABASE_PATH ?? './data/krsk.sqlite'): DB {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  migrate(db);
  ensureSchema(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('OWNER','ADMIN','VIEWER','PARTICIPANT')),
      participant_id TEXT,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      event_name TEXT NOT NULL,
      event_date TEXT NOT NULL,
      venue TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','READY','RUNNING','PAUSED','COMPLETED','CANCELLED')),
      event_mode TEXT NOT NULL DEFAULT 'LEAGUE_REQUEST' CHECK (event_mode IN ('LEAGUE_REQUEST','REQUEST_ONLY','LEAGUE_TOURNAMENT_REQUEST')),
      current_phase TEXT NOT NULL DEFAULT 'LEAGUE' CHECK (current_phase IN ('LEAGUE','TOURNAMENT','REQUEST')),
      max_participants INTEGER NOT NULL DEFAULT 60 CHECK (max_participants BETWEEN 2 AND 500),
      entry_fee INTEGER NOT NULL DEFAULT 0 CHECK (entry_fee >= 0),
      description TEXT NOT NULL DEFAULT '',
      default_match_minutes INTEGER NOT NULL DEFAULT 15 CHECK (default_match_minutes BETWEEN 3 AND 120),
      minimum_rest_minutes INTEGER NOT NULL DEFAULT 8 CHECK (minimum_rest_minutes BETWEEN 0 AND 120),
      maximum_rest_minutes INTEGER NOT NULL DEFAULT 30 CHECK (maximum_rest_minutes BETWEEN 1 AND 300),
      result_input_grace_minutes INTEGER NOT NULL DEFAULT 3 CHECK (result_input_grace_minutes BETWEEN 0 AND 30),
      late_match_cutoff_minutes INTEGER NOT NULL DEFAULT 5 CHECK (late_match_cutoff_minutes BETWEEN 0 AND 60),
      safety_margin_minutes INTEGER NOT NULL DEFAULT 5 CHECK (safety_margin_minutes BETWEEN 0 AND 60),
      league_match_count INTEGER NOT NULL DEFAULT 4 CHECK (league_match_count BETWEEN 1 AND 50),
      league_type TEXT NOT NULL DEFAULT 'LIMITED_ROUND_ROBIN' CHECK (league_type IN ('FULL_ROUND_ROBIN','LIMITED_ROUND_ROBIN')),
      ranking_rule TEXT NOT NULL DEFAULT 'WINS_WINRATE_DIFF_POINTS',
      allow_request INTEGER NOT NULL DEFAULT 1 CHECK (allow_request IN (0,1)),
      allow_rematch INTEGER NOT NULL DEFAULT 0 CHECK (allow_rematch IN (0,1)),
      allow_same_day_repeat INTEGER NOT NULL DEFAULT 0 CHECK (allow_same_day_repeat IN (0,1)),
      auto_court_assignment INTEGER NOT NULL DEFAULT 1 CHECK (auto_court_assignment IN (0,1)),
      auto_rematch INTEGER NOT NULL DEFAULT 0 CHECK (auto_rematch IN (0,1)),
      no_show_enabled INTEGER NOT NULL DEFAULT 1 CHECK (no_show_enabled IN (0,1)),
      notification_enabled INTEGER NOT NULL DEFAULT 1 CHECK (notification_enabled IN (0,1)),
      auto_engine_enabled INTEGER NOT NULL DEFAULT 1 CHECK (auto_engine_enabled IN (0,1)),
      weight_request_priority REAL NOT NULL DEFAULT 40,
      weight_waiting REAL NOT NULL DEFAULT 1,
      weight_match_balance REAL NOT NULL DEFAULT 9,
      weight_unplayed REAL NOT NULL DEFAULT 16,
      weight_rating REAL NOT NULL DEFAULT 12,
      weight_time_fit REAL NOT NULL DEFAULT 6,
      penalty_recent REAL NOT NULL DEFAULT 18,
      penalty_repeat REAL NOT NULL DEFAULT 22,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT REFERENCES users(user_id),
      row_version INTEGER NOT NULL DEFAULT 1,
      CHECK (datetime(end_time) > datetime(start_time))
    );

    CREATE TABLE IF NOT EXISTS classes (
      class_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
      class_name TEXT NOT NULL,
      display_order INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(event_id, class_name)
    );
    CREATE INDEX IF NOT EXISTS idx_classes_event ON classes(event_id, display_order);

    CREATE TABLE IF NOT EXISTS participants (
      participant_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      name_normalized TEXT NOT NULL,
      name_kana TEXT NOT NULL DEFAULT '',
      club TEXT NOT NULL DEFAULT '',
      grade TEXT NOT NULL DEFAULT '',
      gender TEXT NOT NULL DEFAULT 'OTHER' CHECK (gender IN ('MALE','FEMALE','OTHER','UNSPECIFIED')),
      category TEXT NOT NULL DEFAULT 'SINGLES',
      class_id TEXT REFERENCES classes(class_id) ON DELETE SET NULL,
      rating INTEGER NOT NULL DEFAULT 1000 CHECK (rating BETWEEN 0 AND 5000),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
      checked_in INTEGER NOT NULL DEFAULT 1 CHECK (checked_in IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(event_id, name_normalized)
    );
    CREATE INDEX IF NOT EXISTS idx_participants_event ON participants(event_id, active, class_id);

    CREATE TABLE IF NOT EXISTS courts (
      court_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
      court_number INTEGER NOT NULL CHECK (court_number > 0),
      court_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','RESERVED','CALLING','PLAYING','RESULT_PENDING','BLOCKED','MAINTENANCE')),
      available_from TEXT NOT NULL,
      available_to TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(event_id, court_number),
      UNIQUE(event_id, court_name),
      CHECK (datetime(available_to) > datetime(available_from))
    );
    CREATE INDEX IF NOT EXISTS idx_courts_event ON courts(event_id, enabled, priority);

    CREATE TABLE IF NOT EXISTS matches (
      match_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
      phase TEXT NOT NULL CHECK (phase IN ('LEAGUE','REQUEST','TOURNAMENT')),
      class_id TEXT REFERENCES classes(class_id) ON DELETE SET NULL,
      player_a_id TEXT NOT NULL REFERENCES participants(participant_id),
      player_b_id TEXT NOT NULL REFERENCES participants(participant_id),
      scheduled_time TEXT,
      called_time TEXT,
      start_time TEXT,
      end_time TEXT,
      court_id TEXT REFERENCES courts(court_id),
      status TEXT NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING','CALLED','COURT_ASSIGNED','PLAYING','RESULT_PENDING','COMPLETED','CANCELLED','DISPUTED','NO_SHOW')),
      source TEXT NOT NULL DEFAULT 'AUTO' CHECK (source IN ('AUTO','MANUAL','REQUEST','ADMIN')),
      priority_score REAL NOT NULL DEFAULT 0,
      pair_key TEXT,
      score_breakdown TEXT,
      score_a INTEGER CHECK (score_a IS NULL OR score_a BETWEEN 0 AND 99),
      score_b INTEGER CHECK (score_b IS NULL OR score_b BETWEEN 0 AND 99),
      winner_id TEXT REFERENCES participants(participant_id),
      result_id TEXT,
      created_by TEXT REFERENCES users(user_id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1,
      CHECK (player_a_id <> player_b_id),
      CHECK (winner_id IS NULL OR winner_id = player_a_id OR winner_id = player_b_id),
      CHECK (score_a IS NULL OR score_b IS NULL OR score_a <> score_b)
    );
    CREATE INDEX IF NOT EXISTS idx_matches_event_status ON matches(event_id, status, scheduled_time);
    CREATE INDEX IF NOT EXISTS idx_matches_players ON matches(event_id, player_a_id, player_b_id);
    CREATE INDEX IF NOT EXISTS idx_matches_court ON matches(court_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_unique_open_pair
      ON matches(event_id, pair_key)
      WHERE pair_key IS NOT NULL AND status IN ('WAITING','CALLED','COURT_ASSIGNED','PLAYING','RESULT_PENDING');

    CREATE TABLE IF NOT EXISTS results (
      result_id TEXT PRIMARY KEY,
      match_id TEXT NOT NULL UNIQUE REFERENCES matches(match_id) ON DELETE CASCADE,
      score_a INTEGER NOT NULL CHECK (score_a BETWEEN 0 AND 99),
      score_b INTEGER NOT NULL CHECK (score_b BETWEEN 0 AND 99),
      winner_id TEXT NOT NULL REFERENCES participants(participant_id),
      entered_by TEXT NOT NULL REFERENCES users(user_id),
      confirmed_by TEXT REFERENCES users(user_id),
      status TEXT NOT NULL DEFAULT 'ENTERED' CHECK (status IN ('ENTERED','CONFIRMED','DISPUTED','CORRECTED')),
      entered_at TEXT NOT NULL,
      confirmed_at TEXT,
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1,
      CHECK (score_a <> score_b)
    );

    CREATE TABLE IF NOT EXISTS match_requests (
      request_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
      requester_id TEXT NOT NULL REFERENCES participants(participant_id),
      target_player_id TEXT NOT NULL REFERENCES participants(participant_id),
      priority INTEGER NOT NULL CHECK (priority IN (1,2,3)),
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','MATCHED','CANCELLED','EXPIRED')),
      matched_match_id TEXT REFERENCES matches(match_id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1,
      CHECK (requester_id <> target_player_id)
    );
    CREATE INDEX IF NOT EXISTS idx_requests_active ON match_requests(event_id, status, requester_id, target_player_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_unique_active
      ON match_requests(event_id, requester_id, target_player_id) WHERE status = 'ACTIVE';

    CREATE TABLE IF NOT EXISTS announcements (
      announcement_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO','IMPORTANT','URGENT')),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
      created_by TEXT REFERENCES users(user_id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    /* Single-elimination brackets (event mode C). Only resolved pairings become
       matches, so a bracket never holds a phantom card: an unplayed slot is simply
       absent and the next round appears once both of its feeders are decided. */
    CREATE TABLE IF NOT EXISTS tournament_brackets (
      bracket_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
      class_id TEXT NOT NULL REFERENCES classes(class_id) ON DELETE CASCADE,
      format TEXT NOT NULL DEFAULT 'SINGLE_ELIM' CHECK (format IN ('SINGLE_ELIM')),
      size INTEGER NOT NULL CHECK (size BETWEEN 2 AND 256),
      rounds INTEGER NOT NULL CHECK (rounds BETWEEN 1 AND 8),
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','COMPLETED','CANCELLED')),
      winner_id TEXT REFERENCES participants(participant_id),
      created_by TEXT REFERENCES users(user_id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_tournament_bracket_event ON tournament_brackets(event_id, status, class_id);

    CREATE TABLE IF NOT EXISTS tournament_seeds (
      bracket_id TEXT NOT NULL REFERENCES tournament_brackets(bracket_id) ON DELETE CASCADE,
      slot INTEGER NOT NULL CHECK (slot >= 0),
      participant_id TEXT NOT NULL REFERENCES participants(participant_id) ON DELETE CASCADE,
      seed INTEGER NOT NULL CHECK (seed >= 1),
      PRIMARY KEY (bracket_id, slot)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tournament_seeds_player ON tournament_seeds(bracket_id, participant_id);

    CREATE TABLE IF NOT EXISTS audit_logs (
      audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT REFERENCES events(event_id) ON DELETE CASCADE,
      actor_id TEXT REFERENCES users(user_id),
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_announcements_event ON announcements(event_id, active DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_logs(event_id, created_at DESC);

    CREATE TRIGGER IF NOT EXISTS participant_class_same_event_insert
    BEFORE INSERT ON participants WHEN NEW.class_id IS NOT NULL
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM classes WHERE class_id = NEW.class_id AND event_id = NEW.event_id
      ) THEN RAISE(ABORT, 'class_event_mismatch') END;
    END;

    CREATE TRIGGER IF NOT EXISTS participant_class_same_event_update
    BEFORE UPDATE OF class_id, event_id ON participants WHEN NEW.class_id IS NOT NULL
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM classes WHERE class_id = NEW.class_id AND event_id = NEW.event_id
      ) THEN RAISE(ABORT, 'class_event_mismatch') END;
    END;

    CREATE TRIGGER IF NOT EXISTS match_entities_same_event_insert
    BEFORE INSERT ON matches
    BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM participants WHERE participant_id = NEW.player_a_id AND event_id = NEW.event_id)
        THEN RAISE(ABORT, 'player_a_event_mismatch') END;
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM participants WHERE participant_id = NEW.player_b_id AND event_id = NEW.event_id)
        THEN RAISE(ABORT, 'player_b_event_mismatch') END;
      SELECT CASE WHEN NEW.court_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM courts WHERE court_id = NEW.court_id AND event_id = NEW.event_id)
        THEN RAISE(ABORT, 'court_event_mismatch') END;
    END;

    CREATE TRIGGER IF NOT EXISTS match_entities_same_event_update
    BEFORE UPDATE OF player_a_id, player_b_id, court_id, event_id ON matches
    BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM participants WHERE participant_id = NEW.player_a_id AND event_id = NEW.event_id)
        THEN RAISE(ABORT, 'player_a_event_mismatch') END;
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM participants WHERE participant_id = NEW.player_b_id AND event_id = NEW.event_id)
        THEN RAISE(ABORT, 'player_b_event_mismatch') END;
      SELECT CASE WHEN NEW.court_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM courts WHERE court_id = NEW.court_id AND event_id = NEW.event_id)
        THEN RAISE(ABORT, 'court_event_mismatch') END;
    END;

    CREATE TRIGGER IF NOT EXISTS no_player_overlap_insert
    BEFORE INSERT ON matches WHEN NEW.status IN ('CALLED','COURT_ASSIGNED','PLAYING','RESULT_PENDING')
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM matches m
        WHERE m.event_id = NEW.event_id
          AND m.status IN ('CALLED','COURT_ASSIGNED','PLAYING','RESULT_PENDING')
          AND (m.player_a_id IN (NEW.player_a_id, NEW.player_b_id) OR m.player_b_id IN (NEW.player_a_id, NEW.player_b_id))
      ) THEN RAISE(ABORT, 'participant_already_in_active_match') END;
    END;

    CREATE TRIGGER IF NOT EXISTS no_player_overlap_update
    BEFORE UPDATE OF status, player_a_id, player_b_id ON matches WHEN NEW.status IN ('CALLED','COURT_ASSIGNED','PLAYING','RESULT_PENDING')
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM matches m
        WHERE m.match_id <> NEW.match_id AND m.event_id = NEW.event_id
          AND m.status IN ('CALLED','COURT_ASSIGNED','PLAYING','RESULT_PENDING')
          AND (m.player_a_id IN (NEW.player_a_id, NEW.player_b_id) OR m.player_b_id IN (NEW.player_a_id, NEW.player_b_id))
      ) THEN RAISE(ABORT, 'participant_already_in_active_match') END;
    END;

    CREATE TRIGGER IF NOT EXISTS no_court_overlap_insert
    BEFORE INSERT ON matches WHEN NEW.court_id IS NOT NULL AND NEW.status IN ('COURT_ASSIGNED','PLAYING','RESULT_PENDING')
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM matches m WHERE m.event_id = NEW.event_id AND m.court_id = NEW.court_id
        AND m.status IN ('COURT_ASSIGNED','PLAYING','RESULT_PENDING')
      ) THEN RAISE(ABORT, 'court_already_in_active_match') END;
    END;

    CREATE TRIGGER IF NOT EXISTS no_court_overlap_update
    BEFORE UPDATE OF status, court_id ON matches WHEN NEW.court_id IS NOT NULL AND NEW.status IN ('COURT_ASSIGNED','PLAYING','RESULT_PENDING')
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM matches m WHERE m.match_id <> NEW.match_id AND m.event_id = NEW.event_id AND m.court_id = NEW.court_id
        AND m.status IN ('COURT_ASSIGNED','PLAYING','RESULT_PENDING')
      ) THEN RAISE(ABORT, 'court_already_in_active_match') END;
    END;
  `);
}

/** Canonical, order-independent key so the same pair cannot hold two open matches. */
export function pairKey(playerAId: string, playerBId: string): string {
  return playerAId < playerBId ? `${playerAId}|${playerBId}` : `${playerBId}|${playerAId}`;
}

function ensureColumn(db: DB, table: string, column: string, definition: string): void {
  const columns = asRows<{ name: string }>(db.prepare('SELECT name FROM pragma_table_info(?)').all(table));
  if (!columns.some((entry) => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

/** Idempotent schema upgrades for databases created by an earlier release. */
export function ensureSchema(db: DB): void {
  ensureColumn(db, 'matches', 'pair_key', 'pair_key TEXT');
  ensureColumn(db, 'matches', 'bracket_id', 'bracket_id TEXT REFERENCES tournament_brackets(bracket_id) ON DELETE SET NULL');
  ensureColumn(db, 'matches', 'bracket_round', 'bracket_round INTEGER');
  ensureColumn(db, 'matches', 'bracket_slot', 'bracket_slot INTEGER');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_bracket_slot
    ON matches(bracket_id, bracket_round, bracket_slot) WHERE bracket_id IS NOT NULL`);
  db.exec(`UPDATE matches SET pair_key = CASE WHEN player_a_id < player_b_id
    THEN player_a_id || '|' || player_b_id ELSE player_b_id || '|' || player_a_id END
    WHERE pair_key IS NULL`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_unique_open_pair
    ON matches(event_id, pair_key)
    WHERE pair_key IS NOT NULL AND status IN ('WAITING','CALLED','COURT_ASSIGNED','PLAYING','RESULT_PENDING')`);
}

export function transaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

export function asRows<T>(rows: unknown): T[] {
  return rows as T[];
}

export function asRow<T>(row: unknown): T | undefined {
  return row as T | undefined;
}
