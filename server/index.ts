import { createDatabase } from './db.js';
import { seedDatabase } from './seed.js';
import { createApp } from './app.js';

const db = createDatabase();
seedDatabase(db);

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
