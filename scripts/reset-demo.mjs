/**
 * Deletes the development database so the next `npm run dev` re-seeds the demo event
 * from scratch. Only the file configured by DATABASE_PATH (default ./data/krsk.sqlite)
 * is touched, and the WAL sidecars are removed with it.
 *
 *   npm run demo:reset
 *   npm run demo:reset -- --keep-backup     # moves the old file aside instead
 */
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const keepBackup = process.argv.includes('--keep-backup');
const file = resolve(process.env.DATABASE_PATH ?? './data/krsk.sqlite');
const sides = [file, `${file}-wal`, `${file}-shm`].filter((path) => existsSync(path));

if (sides.length === 0) {
  console.log(`no database at ${file} - nothing to reset`);
  process.exit(0);
}

if (keepBackup) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(dirname(file), { recursive: true });
  for (const path of sides) renameSync(path, `${path}.before-${stamp}`);
  console.log(`moved ${sides.length} file(s) aside with suffix .before-${stamp}`);
} else {
  for (const path of sides) rmSync(path, { force: true });
  console.log(`removed ${sides.length} file(s); the next start will re-seed the demo event`);
}
