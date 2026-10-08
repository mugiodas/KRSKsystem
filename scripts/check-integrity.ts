import { createDatabase } from '../server/db.js';
import { runIntegrityChecks, VIOLATION_LABELS } from '../server/services/integrity.js';

/**
 * Command line QA switch (spec section 43):
 *
 *   npm run integrity                              every event in the database
 *   npm run integrity -- --event evt_demo_krsk     one event
 *   npm run integrity -- --json                    machine readable output
 *
 * Exit code 1 means at least one CRITICAL violation was found, so it can gate a
 * deploy or a nightly check against a production copy. Nothing here is modified:
 * the tool only reads.
 */
const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const eventFlag = args.indexOf('--event');
const wantedEvent = eventFlag >= 0 ? args[eventFlag + 1] : undefined;

const db = createDatabase();
try {
  const events = wantedEvent
    ? db.prepare('SELECT event_id, event_name, status FROM events WHERE event_id = ?').all(wantedEvent)
    : db.prepare('SELECT event_id, event_name, status FROM events ORDER BY event_date, event_name').all();
  if ((events as unknown[]).length === 0) {
    console.error(wantedEvent ? `event not found: ${wantedEvent}` : 'no events in this database - start the app once to seed the demo event');
    process.exitCode = 1;
  } else {
    const results = (events as Array<{ event_id: string; event_name: string; status: string }>).map((event) => ({
      event,
      report: runIntegrityChecks(db, event.event_id),
    }));
    const critical = results.reduce((total, item) => total + item.report.violations
      .filter((violation) => violation.severity === 'CRITICAL')
      .reduce((sum, violation) => sum + violation.count, 0), 0);

    if (jsonOutput) {
      console.log(JSON.stringify({ checkedAt: new Date().toISOString(), critical, results }, null, 2));
    } else {
      for (const { event, report } of results) {
        const head = `${event.event_name} (${event.event_id}, ${event.status})`;
        if (report.clean) {
          console.log(`PASS  ${head}  ${report.checks} checks, 0 violations`);
          continue;
        }
        console.log(`FAIL  ${head}`);
        for (const violation of report.violations) {
          const label = VIOLATION_LABELS[violation.code] ?? violation.code;
          console.log(`  ${violation.severity === 'CRITICAL' ? '!' : '?'} ${violation.code} ${label} x${violation.count}${violation.sample ? `  e.g. ${violation.sample}` : ''}`);
        }
      }
      console.log(`\n${results.length} event(s) checked, ${critical} critical violation(s).`);
    }
    if (critical > 0) process.exitCode = 1;
  }
} finally {
  db.close();
}
