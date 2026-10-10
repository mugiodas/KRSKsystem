import { Router, type Response } from 'express';
import type { DB } from '../db.js';
import { requireRole, type AuthedRequest } from '../auth.js';
import { sendData } from '../http.js';
import { ensureEventAccess, requireEvent } from './core.js';
import { buildEventReport, reportToCsv } from '../services/report.js';
import { runIntegrityChecks } from '../services/integrity.js';

function param(req: AuthedRequest, key: string): string {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

/**
 * Phase 6 endpoints: the printed report and the integrity switch. Both read
 * only, so any role with event access can pull the numbers; the raw QA dump is
 * restricted to staff because it exposes identifiers.
 */
export function createReportRouter(db: DB): Router {
  const router = Router();

  // The report lists every participant's record, so it is staff only: the
  // participant phone keeps its own, narrower aggregate instead.
  router.get('/events/:eventId/report', requireRole('OWNER', 'ADMIN', 'VIEWER'), (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    requireEvent(db, eventId);
    sendData(res, buildEventReport(db, eventId));
  });

  router.get('/events/:eventId/report.csv', requireRole('OWNER', 'ADMIN', 'VIEWER'), (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    requireEvent(db, eventId);
    const report = buildEventReport(db, eventId);
    const name = report.eventName.replace(/[^\w\u3000-\u9FFF-]+/g, '_');
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${name}-report.csv"`);
    res.send(reportToCsv(report));
  });

  router.get('/events/:eventId/integrity', requireRole('OWNER', 'ADMIN'), (req: AuthedRequest, res: Response) => {
    const eventId = param(req, 'eventId');
    ensureEventAccess(db, req, eventId);
    requireEvent(db, eventId);
    sendData(res, runIntegrityChecks(db, eventId));
  });

  return router;
}
