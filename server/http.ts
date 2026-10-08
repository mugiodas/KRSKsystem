import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function asyncRoute<T extends Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown> | unknown,
) {
  return (req: T, res: Response, next: NextFunction): void => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof ApiError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details } });
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: '入力内容を確認してください。', details: error.flatten() },
    });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  const constraintMap: Record<string, [string, string]> = {
    'UNIQUE constraint failed: participants.event_id, participants.name_normalized': ['DUPLICATE_PARTICIPANT', '同じ名前の参加者がすでに登録されています。'],
    idx_matches_unique_open_pair: ['DUPLICATE_PAIR', 'この組み合わせの試合はすでに待機中または進行中です。'],
    idx_requests_unique_active: ['DUPLICATE_REQUEST', '同じ相手への対戦希望はすでに登録されています。'],
    participant_already_in_active_match: ['PARTICIPANT_BUSY', '選手はすでに別の進行中試合に入っています。'],
    court_already_in_active_match: ['COURT_BUSY', 'コートはすでに使用中です。'],
    class_event_mismatch: ['INVALID_CLASS', 'このイベントに存在しないクラスです。'],
    player_a_event_mismatch: ['INVALID_PARTICIPANT', '選手Aはこのイベントに存在しません。'],
    player_b_event_mismatch: ['INVALID_PARTICIPANT', '選手Bはこのイベントに存在しません。'],
    court_event_mismatch: ['INVALID_COURT', 'このイベントに存在しないコートです。'],
  };
  const mapped = Object.entries(constraintMap).find(([needle]) => message.includes(needle));
  if (mapped) {
    res.status(409).json({ error: { code: mapped[1][0], message: mapped[1][1] } });
    return;
  }
  if (message.includes('UNIQUE constraint failed')) {
    res.status(409).json({ error: { code: 'DUPLICATE', message: '同じデータがすでに登録されています。' } });
    return;
  }
  if (message.includes('CHECK constraint failed') || message.includes('FOREIGN KEY constraint failed')) {
    res.status(400).json({ error: { code: 'INTEGRITY_ERROR', message: 'データの整合性を確認してください。' } });
    return;
  }
  console.error(error);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '予期しないエラーが発生しました。' } });
}

export function toCamel<T = unknown>(value: unknown): T {
  if (Array.isArray(value)) return value.map((item) => toCamel(item)) as T;
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const camel = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
      output[camel] = toCamel(child);
    }
    return output as T;
  }
  return value as T;
}

export function sendData(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data: toCamel(data) });
}
