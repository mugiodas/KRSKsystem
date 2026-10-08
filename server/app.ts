import express, { type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { DB } from './db.js';
import { asRow } from './db.js';
import { authMiddleware, clearSession, issueSession, requireAuth, verifyPassword, type AuthedRequest } from './auth.js';
import { ApiError, errorHandler, sendData } from './http.js';
import { createCoreRouter } from './routes/core.js';
import { createMatchRouter } from './routes/matches.js';
import { createRequestRouter } from './routes/requests.js';
import { createEngineRouter } from './routes/engine.js';
import { createAnnouncementRouter } from './routes/announcements.js';
import { createParticipantRouter } from './routes/participant.js';
import { maybeRunEngine } from './services/autoEngine.js';

export function createApp(db: DB) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(authMiddleware(db));

  app.get('/api/health', (_req, res) => {
    const database = db.prepare('SELECT 1 AS ok').get() as { ok: number };
    res.json({ status: database.ok === 1 ? 'ok' : 'error', timestamp: new Date().toISOString() });
  });

  app.get('/api/demo/accounts', (_req, res) => {
    res.json({ data: [
      { role: 'OWNER', email: 'owner@krsk.local', password: 'krsk-demo', label: 'オーナー' },
      { role: 'ADMIN', email: 'admin@krsk.local', password: 'krsk-demo', label: '運営スタッフ' },
      { role: 'VIEWER', email: 'viewer@krsk.local', password: 'krsk-demo', label: '閲覧スタッフ' },
      { role: 'PARTICIPANT', email: 'p01@demo.local', password: 'demo', label: '古谷 莉歩' },
    ] });
  });

  app.post('/api/auth/login', (req: Request, res: Response) => {
    const input = z.object({ email: z.string().email(), password: z.string().min(1).max(200) }).parse(req.body);
    const user = asRow<{
      user_id: string; email: string; display_name: string; password_hash: string;
      role: 'OWNER' | 'ADMIN' | 'VIEWER' | 'PARTICIPANT'; participant_id: string | null; active: number;
    }>(db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(input.email.trim()));
    if (!user || !user.active || !verifyPassword(input.password, user.password_hash)) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'メールアドレスまたはパスワードが違います。');
    }
    issueSession(db, res, user.user_id);
    sendData(res, {
      userId: user.user_id, email: user.email, displayName: user.display_name,
      role: user.role, participantId: user.participant_id,
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    clearSession(db, req, res);
    res.status(204).end();
  });

  app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
    sendData(res, req.auth);
  });

  app.use('/api', requireAuth, createCoreRouter(db));
  app.use('/api', requireAuth, createMatchRouter(db, (eventId) => maybeRunEngine(db, eventId)));
  app.use('/api', requireAuth, createRequestRouter(db));
  app.use('/api', requireAuth, createEngineRouter(db, (eventId) => maybeRunEngine(db, eventId)));
  app.use('/api', requireAuth, createAnnouncementRouter(db));
  app.use('/api', requireAuth, createParticipantRouter(db));

  const dist = resolve('dist');
  if (process.env.NODE_ENV === 'production' && existsSync(dist)) {
    app.use(express.static(dist, { maxAge: '1h', index: false }));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api') && req.accepts('html')) {
        res.sendFile(resolve(dist, 'index.html'));
      } else next();
    });
  }

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'APIが見つかりません。' } });
  });
  app.use(errorHandler);
  return app;
}
