import type { DB } from './db.js';
import { nowIso, transaction } from './db.js';
import { createUser } from './auth.js';

export const DEMO_EVENT_ID = 'evt_demo_krsk';
/** A second demo event in event mode C, so the tournament draw can be tried out end to end. */
export const TOURNAMENT_DEMO_EVENT_ID = 'evt_demo_tournament';

const demoParticipants = [
  ['古谷 莉歩', 'ふるたに りほ', '唐崎ジュニア', '6年', 'FEMALE', 1320],
  ['山本 悠真', 'やまもと ゆうま', '唐崎ジュニア', '6年', 'MALE', 1340],
  ['田中 美羽', 'たなか みう', '瀬田北BC', '5年', 'FEMALE', 1280],
  ['中村 颯太', 'なかむら そうた', '大津シャトル', '6年', 'MALE', 1300],
  ['佐々木 結衣', 'ささき ゆい', '草津JBC', '5年', 'FEMALE', 1250],
  ['木村 陽翔', 'きむら はると', '唐崎ジュニア', '5年', 'MALE', 1270],
  ['伊藤 心春', 'いとう こはる', '守山ジュニア', '6年', 'FEMALE', 1310],
  ['渡辺 大和', 'わたなべ やまと', '瀬田北BC', '6年', 'MALE', 1290],
  ['小林 咲良', 'こばやし さくら', '大津シャトル', '5年', 'FEMALE', 1220],
  ['加藤 蓮', 'かとう れん', '草津JBC', '5年', 'MALE', 1240],
  ['吉田 葵', 'よしだ あおい', '唐崎ジュニア', '4年', 'FEMALE', 1100],
  ['山田 陸', 'やまだ りく', '瀬田北BC', '4年', 'MALE', 1120],
  ['松本 ひなた', 'まつもと ひなた', '守山ジュニア', '4年', 'FEMALE', 1060],
  ['井上 湊', 'いのうえ みなと', '大津シャトル', '4年', 'MALE', 1090],
  ['清水 凛', 'しみず りん', '草津JBC', '3年', 'FEMALE', 1020],
  ['林 樹', 'はやし いつき', '唐崎ジュニア', '4年', 'MALE', 1080],
  ['斎藤 芽依', 'さいとう めい', '瀬田北BC', '3年', 'FEMALE', 980],
  ['森 悠人', 'もり ゆうと', '守山ジュニア', '3年', 'MALE', 1000],
  ['池田 紬', 'いけだ つむぎ', '大津シャトル', '3年', 'FEMALE', 960],
  ['橋本 蒼', 'はしもと あおい', '草津JBC', '3年', 'MALE', 990],
] as const;

export function seedDatabase(db: DB): void {
  const hasUsers = Number((db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count) > 0;
  let ownerId = (db.prepare("SELECT user_id FROM users WHERE role = 'OWNER' ORDER BY created_at LIMIT 1").get() as { user_id: string } | undefined)?.user_id;
  if (!hasUsers) {
    transaction(db, () => {
      ownerId = createUser(db, { email: 'owner@krsk.local', displayName: 'KRSK オーナー', password: 'krsk-demo', role: 'OWNER' });
      createUser(db, { email: 'admin@krsk.local', displayName: '大会運営', password: 'krsk-demo', role: 'ADMIN' });
      createUser(db, { email: 'viewer@krsk.local', displayName: '閲覧スタッフ', password: 'krsk-demo', role: 'VIEWER' });
    });
  }

  const exists = db.prepare('SELECT 1 FROM events WHERE event_id = ?').get(DEMO_EVENT_ID);
  if (!exists) {
  const now = new Date();
  const start = new Date(now.getTime() - 45 * 60_000);
  const end = new Date(now.getTime() + 5 * 60 * 60_000);
  const created = nowIso();

  transaction(db, () => {
    db.prepare(`INSERT INTO events (
      event_id, event_name, event_date, venue, start_time, end_time, status, event_mode, current_phase,
      max_participants, entry_fee, description, created_at, updated_at, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, 'RUNNING', 'LEAGUE_REQUEST', 'LEAGUE', 60, 500, ?, ?, ?, ?)`)
      .run(DEMO_EVENT_ID, 'KRSK SYSTEM DEMO EVENT', now.toISOString().slice(0, 10), '唐崎市民体育館',
        start.toISOString(), end.toISOString(), '20名・2クラス・4コートの操作可能なデモイベントです。', created, created, ownerId ?? null);
      // 会場スクリーン（ログイン不要の提示用URL）。デモはその場で開けるよう固定値にしておきますが、
      // 運営がリンクを作り直し／無効化した後は上書きしません（この INSERT 時のみ設定するため）。
      db.prepare('UPDATE events SET screen_token = ? WHERE event_id = ?').run('krsk-demo-screen', DEMO_EVENT_ID);

    db.prepare(`INSERT INTO classes (class_id, event_id, class_name, display_order, description, enabled, created_at, updated_at)
      VALUES ('cls_demo_a', ?, 'Aクラス', 1, '競技経験が長い選手', 1, ?, ?),
             ('cls_demo_b', ?, 'Bクラス', 2, '基礎から試合経験を積む選手', 1, ?, ?)`)
      .run(DEMO_EVENT_ID, created, created, DEMO_EVENT_ID, created, created);

    const insertParticipant = db.prepare(`INSERT INTO participants (
      participant_id, event_id, name, name_normalized, name_kana, club, grade, gender, category, class_id, rating,
      active, checked_in, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SINGLES', ?, ?, 1, 1, ?, ?)`);

    demoParticipants.forEach(([name, kana, club, grade, gender, rating], index) => {
      const participantId = `demo_p${String(index + 1).padStart(2, '0')}`;
      insertParticipant.run(participantId, DEMO_EVENT_ID, name, normalizeName(name), kana, club, grade, gender,
        index < 10 ? 'cls_demo_a' : 'cls_demo_b', rating, created, created);
      createUser(db, {
        email: `p${String(index + 1).padStart(2, '0')}@demo.local`,
        displayName: name,
        password: 'demo',
        role: 'PARTICIPANT',
        participantId,
      });
    });

    const courtInsert = db.prepare(`INSERT INTO courts (
      court_id, event_id, court_number, court_name, status, available_from, available_to, priority, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'AVAILABLE', ?, ?, ?, 1, ?, ?)`);
    for (let i = 1; i <= 4; i += 1) {
      courtInsert.run(`court_demo_${i}`, DEMO_EVENT_ID, i, `COURT ${i}`, start.toISOString(), end.toISOString(), i, created, created);
    }

    db.prepare(`INSERT INTO announcements
      (announcement_id, event_id, title, body, severity, active, created_by, created_at, updated_at)
      VALUES ('ann_demo_1', ?, '本日の練習試合', '次の試合が表示されたら指定コートへ集合してください。結果は試合後に入力できます。', 'INFO', 1, ?, ?, ?)`)
      .run(DEMO_EVENT_ID, ownerId ?? null, created, created);
  });
  }
  seedDemoMatches(db, ownerId ?? null);
  seedTournamentDemo(db, ownerId ?? null);
}

/**
 * The mode C demo: 8 checked-in players, 2 courts, no matches yet. The operator
 * opens the トーナメント表 tab, previews the seeded draw, generates it and plays
 * the whole bracket without leaving the board.
 */
function seedTournamentDemo(db: DB, ownerId: string | null): void {
  if (db.prepare('SELECT 1 FROM events WHERE event_id = ?').get(TOURNAMENT_DEMO_EVENT_ID)) return;
  const now = new Date();
  const start = new Date(now.getTime() - 10 * 60_000);
  const end = new Date(now.getTime() + 150 * 60_000);
  const created = nowIso();
  transaction(db, () => {
    db.prepare(`INSERT INTO events (
      event_id, event_name, event_date, venue, start_time, end_time, status, event_mode, current_phase,
      max_participants, entry_fee, description, created_at, updated_at, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, 'RUNNING', 'LEAGUE_TOURNAMENT_REQUEST', 'LEAGUE', 16, 500, ?, ?, ?, ?)`)
      .run(TOURNAMENT_DEMO_EVENT_ID, 'KRSK SYSTEM DEMO トーナメント', now.toISOString().slice(0, 10), '唐崎市民体育館',
        start.toISOString(), end.toISOString(),
        '8名・1クラス・2コート。トーナメント表の自動生成から結果入力までを試すデモイベントです。', created, created, ownerId);
      db.prepare('UPDATE events SET screen_token = ? WHERE event_id = ?').run('krsk-demo-draw', TOURNAMENT_DEMO_EVENT_ID);

    db.prepare(`INSERT INTO classes (class_id, event_id, class_name, display_order, description, enabled, created_at, updated_at)
      VALUES ('cls_demo_t', ?, 'トーナメント', 1, 'シード順でドローを作成する練習会', 1, ?, ?)`).run(TOURNAMENT_DEMO_EVENT_ID, created, created);

    const insertParticipant = db.prepare(`INSERT INTO participants (
      participant_id, event_id, name, name_normalized, name_kana, club, grade, gender, category, class_id, rating,
      active, checked_in, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SINGLES', 'cls_demo_t', ?, 1, 1, ?, ?)`);
    demoParticipants.slice(0, 8).forEach(([name, kana, club, grade, gender, rating], index) => {
      const participantId = `demo_t${String(index + 1).padStart(2, '0')}`;
      insertParticipant.run(participantId, TOURNAMENT_DEMO_EVENT_ID, name, normalizeName(name), kana, club, grade, gender,
        Number(rating) - index * 10, created, created);
      createUser(db, {
        email: `t${String(index + 1).padStart(2, '0')}@demo.local`,
        displayName: name,
        password: 'demo',
        role: 'PARTICIPANT',
        participantId,
      });
    });

    const courtInsert = db.prepare(`INSERT INTO courts (
      court_id, event_id, court_number, court_name, status, available_from, available_to, priority, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'AVAILABLE', ?, ?, ?, 1, ?, ?)`);
    for (let i = 1; i <= 2; i += 1) {
      courtInsert.run(`court_demo_t_${i}`, TOURNAMENT_DEMO_EVENT_ID, i, `COURT ${i}`, start.toISOString(), end.toISOString(), i, created, created);
    }

    db.prepare(`INSERT INTO announcements
      (announcement_id, event_id, title, body, severity, active, created_by, created_at, updated_at)
      VALUES ('ann_demo_t', ?, 'トーナメント表を試せます', '「トーナメント表」タブで自動生成を選ぶと、シード順と終了時刻の見込みをプレビューしてからドローを作成します。', 'INFO', 1, ?, ?, ?)`)
      .run(TOURNAMENT_DEMO_EVENT_ID, ownerId, created, created);
  });
}

function seedDemoMatches(db: DB, ownerId: string | null): void {
  const count = Number((db.prepare('SELECT COUNT(*) AS count FROM matches WHERE event_id = ?').get(DEMO_EVENT_ID) as { count: number }).count);
  if (count > 0 || !ownerId) return;
  const now = new Date();
  const isoMinutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  transaction(db, () => {
    const matchInsert = db.prepare(`INSERT INTO matches (
      match_id, event_id, phase, class_id, player_a_id, player_b_id, scheduled_time, called_time, start_time, end_time,
      court_id, status, source, priority_score, score_a, score_b, winner_id, result_id, created_by, created_at, updated_at
    ) VALUES (?, ?, 'LEAGUE', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AUTO', 0, ?, ?, ?, ?, ?, ?, ?)`);
    const completed = [
      ['seed_match_01', 'demo_p07', 'demo_p08', 15, 11, 38],
      ['seed_match_02', 'demo_p09', 'demo_p10', 13, 15, 36],
      ['seed_match_03', 'demo_p11', 'demo_p12', 15, 8, 31],
      ['seed_match_04', 'demo_p13', 'demo_p14', 12, 15, 28],
      ['seed_match_05', 'demo_p15', 'demo_p16', 15, 9, 23],
      ['seed_match_06', 'demo_p17', 'demo_p18', 15, 13, 18],
      ['seed_match_07', 'demo_p01', 'demo_p05', 15, 12, 14],
      ['seed_match_08', 'demo_p02', 'demo_p06', 11, 15, 12],
      // A rematch for two of them, so the demo shows realised waiting time and a
      // player who has already played more than once.
      ['seed_match_09', 'demo_p07', 'demo_p09', 15, 12, 6],
    ] as const;
    for (const [index, [id, a, b, scoreA, scoreB, endedAgo]] of completed.entries()) {
      const resultId = `seed_result_${id.slice(-2)}`;
      const classId = Number(a.slice(-2)) <= 10 ? 'cls_demo_a' : 'cls_demo_b';
      const end = isoMinutesAgo(endedAgo);
      const start = isoMinutesAgo(endedAgo + 12);
      const created = isoMinutesAgo(endedAgo + 16);
      const winner = scoreA > scoreB ? a : b;
      // Played matches did occupy a court, and the report's utilisation figures need that.
      const court = `court_demo_${(index % 4) + 1}`;
      matchInsert.run(id, DEMO_EVENT_ID, classId, a, b, created, created, start, end, court, 'COMPLETED', scoreA, scoreB, winner, resultId, ownerId, created, end);
      db.prepare(`INSERT INTO results (result_id, match_id, score_a, score_b, winner_id, entered_by, confirmed_by, status, entered_at, confirmed_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?)`)
        .run(resultId, id, scoreA, scoreB, winner, ownerId, ownerId, end, end, end);
    }

    const active = [
      ['seed_live_01', 'demo_p03', 'demo_p04', 'court_demo_1', 'PLAYING', 'cls_demo_a'],
      ['seed_live_02', 'demo_p19', 'demo_p20', 'court_demo_2', 'RESULT_PENDING', 'cls_demo_b'],
      ['seed_live_03', 'demo_p01', 'demo_p02', 'court_demo_3', 'COURT_ASSIGNED', 'cls_demo_a'],
    ] as const;
    for (const [id, a, b, court, status, classId] of active) {
      const called = isoMinutesAgo(status === 'COURT_ASSIGNED' ? 1 : 10);
      const started = status === 'COURT_ASSIGNED' ? null : isoMinutesAgo(8);
      const ended = status === 'RESULT_PENDING' ? isoMinutesAgo(1) : null;
      matchInsert.run(id, DEMO_EVENT_ID, classId, a, b, called, called, started, ended, court, status, null, null, null, null, ownerId, called, ended ?? started ?? called);
    }
    db.prepare("UPDATE courts SET status = 'PLAYING' WHERE court_id = 'court_demo_1'").run();
    db.prepare("UPDATE courts SET status = 'RESULT_PENDING' WHERE court_id = 'court_demo_2'").run();
    db.prepare("UPDATE courts SET status = 'CALLING' WHERE court_id = 'court_demo_3'").run();

    const waiting = [
      ['seed_wait_01', 'demo_p07', 'demo_p09', 'cls_demo_a'],
      ['seed_wait_02', 'demo_p08', 'demo_p10', 'cls_demo_a'],
      ['seed_wait_03', 'demo_p11', 'demo_p13', 'cls_demo_b'],
      ['seed_wait_04', 'demo_p12', 'demo_p14', 'cls_demo_b'],
      ['seed_wait_05', 'demo_p15', 'demo_p17', 'cls_demo_b'],
      ['seed_wait_06', 'demo_p16', 'demo_p18', 'cls_demo_b'],
    ] as const;
    waiting.forEach(([id, a, b, classId], index) => {
      const created = isoMinutesAgo(7 - index);
      matchInsert.run(id, DEMO_EVENT_ID, classId, a, b, new Date(now.getTime() + index * 15 * 60_000).toISOString(), null, null, null, null, 'WAITING', null, null, null, null, ownerId, created, created);
    });

    db.prepare(`INSERT INTO match_requests (request_id, event_id, requester_id, target_player_id, priority, status, created_at, updated_at)
      VALUES ('seed_req_01', ?, 'demo_p01', 'demo_p10', 1, 'ACTIVE', ?, ?),
             ('seed_req_02', ?, 'demo_p10', 'demo_p01', 2, 'ACTIVE', ?, ?),
             ('seed_req_03', ?, 'demo_p11', 'demo_p16', 2, 'ACTIVE', ?, ?)`)
      .run(DEMO_EVENT_ID, isoMinutesAgo(25), isoMinutesAgo(25), DEMO_EVENT_ID, isoMinutesAgo(20), isoMinutesAgo(20), DEMO_EVENT_ID, isoMinutesAgo(12), isoMinutesAgo(12));
  });
}

export function normalizeName(value: string): string {
  return value.normalize('NFKC').replace(/[\s　]+/g, '').toLocaleLowerCase('ja');
}
