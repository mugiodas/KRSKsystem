import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { DB } from './db.js';
import { asRow, makeId, nowIso } from './db.js';

export type Role = 'OWNER' | 'ADMIN' | 'VIEWER' | 'PARTICIPANT';

export interface AuthUser {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  participantId: string | null;
}

export interface AuthedRequest extends Request {
  auth?: AuthUser;
}

const COOKIE = 'krsk_session';
const SESSION_DAYS = 14;

/**
 * Whether the session cookie carries `Secure`.
 *
 * `Secure` is the right default for a deployment behind https, but a gym runs
 * this on a LAN where the phones reach the machine over plain http — and a
 * `Secure` cookie is simply never returned there, so login would appear to work
 * and then fall over on the next request. `COOKIE_SECURE=0` is that switch.
 */
export function cookieSecure(): boolean {
  const flag = (process.env.COOKIE_SECURE ?? '').trim().toLowerCase();
  if (flag === '') return process.env.NODE_ENV === 'production';
  return !['0', 'false', 'no', 'off'].includes(flag);
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algorithm, salt, expected] = stored.split('$');
  if (algorithm !== 'scrypt' || !salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function issueSession(db: DB, res: Response, userId: string): void {
  const token = randomBytes(32).toString('base64url');
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(createdAt);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(tokenHash(token), userId, expiresAt, createdAt);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(),
    maxAge: SESSION_DAYS * 86_400_000,
    path: '/',
  });
}

export function clearSession(db: DB, req: Request, res: Response): void {
  const token = req.cookies?.[COOKIE] as string | undefined;
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
  res.clearCookie(COOKIE, { path: '/' });
}

export function authMiddleware(db: DB) {
  return (req: AuthedRequest, _res: Response, next: NextFunction): void => {
    const token = req.cookies?.[COOKIE] as string | undefined;
    if (!token) return next();
    const user = asRow<{
      user_id: string;
      email: string;
      display_name: string;
      role: Role;
      participant_id: string | null;
      active: number;
      expires_at: string;
    }>(db.prepare(`
      SELECT u.user_id, u.email, u.display_name, u.role, u.participant_id, u.active, s.expires_at
      FROM sessions s JOIN users u ON u.user_id = s.user_id
      WHERE s.token_hash = ?
    `).get(tokenHash(token)));
    if (!user || !user.active || user.expires_at <= nowIso()) {
      if (user) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
      return next();
    }
    req.auth = {
      userId: user.user_id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      participantId: user.participant_id,
    };
    next();
  };
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'ログインが必要です。' } });
    return;
  }
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'ログインが必要です。' } });
      return;
    }
    if (!roles.includes(req.auth.role)) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'この操作を行う権限がありません。' } });
      return;
    }
    next();
  };
}

export function createUser(
  db: DB,
  input: { email: string; displayName: string; password: string; role: Role; participantId?: string | null },
): string {
  const id = makeId('usr');
  const now = nowIso();
  db.prepare(`INSERT INTO users
    (user_id, email, display_name, password_hash, role, participant_id, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(id, input.email.trim().toLowerCase(), input.displayName.trim(), hashPassword(input.password), input.role,
      input.participantId ?? null, now, now);
  return id;
}
