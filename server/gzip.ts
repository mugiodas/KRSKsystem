import { gzipSync, constants } from 'node:zlib';
import type { NextFunction, Request, Response } from 'express';

const MINIMUM_BYTES = 1024;

/**
 * The board polls a ~175 kB snapshot every four seconds, and that JSON is almost all
 * repeated key names, so it compresses by roughly 90%. Doing it here with node:zlib
 * keeps the venue Wi-Fi traffic down without pulling in another dependency.
 *
 * Only `res.json` payloads are touched: downloads, static files and small responses
 * pass through untouched, and clients that do not advertise gzip get plain JSON.
 */
export function gzipJson(req: Request, res: Response, next: NextFunction): void {
  const encoding = String(req.headers['accept-encoding'] ?? '');
  if (!encoding.includes('gzip')) {
    next();
    return;
  }
  const sendJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    const text = JSON.stringify(body);
    if (text.length < MINIMUM_BYTES) return sendJson(body);
    const payload = gzipSync(Buffer.from(text, 'utf8'), { level: constants.Z_BEST_SPEED });
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-encoding', 'gzip');
    res.setHeader('vary', 'accept-encoding');
    res.setHeader('content-length', String(payload.length));
    res.removeHeader('transfer-encoding');
    return res.end(payload);
  }) as Response['json'];
  next();
}
