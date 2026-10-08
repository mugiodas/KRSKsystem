import { createDatabase } from './db.js';
import { seedDatabase } from './seed.js';
import { createApp } from './app.js';
import { confirmStaleResults } from './services/results.js';

const db = createDatabase();
seedDatabase(db);

// Results a player reported but nobody confirmed must not hold a court forever.
// The engine also sweeps on every state change; this tick covers a quiet gym.
const sweep = setInterval(() => {
  const running = db.prepare(`SELECT event_id FROM events WHERE status = 'RUNNING'`).all() as Array<{ event_id: string }>;
  for (const row of running) {
    try {
      const swept = confirmStaleResults(db, row.event_id);
      if (swept.confirmed + swept.disputed > 0) console.log(`[KRSK] 結果を自動確定しました ${row.event_id}: ${swept.confirmed + swept.disputed}件`);
    } catch (error) {
      console.error('[KRSK] result sweep failed', row.event_id, error);
    }
  }
}, 30_000);
sweep.unref();

const port = Number(process.env.PORT ?? 3001);
const app = createApp(db);
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`KRSK SYSTEM API listening on http://0.0.0.0:${port}`);
});

function shutdown(): void {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
