import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Hard cap on the body of the public client-error route (C-32). */
export const CLIENT_ERROR_MAX_BODY_BYTES = 16 * 1024;

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;

function problem(req: Request, res: Response, status: number, title: string, detail: string): void {
  const inbound = req.headers['x-request-id'];
  const traceId =
    typeof inbound === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(inbound) ? inbound : randomUUID();
  res.setHeader('x-request-id', traceId);
  res.setHeader('Connection', 'close');
  res
    .status(status)
    .type('application/problem+json')
    .json({ type: 'about:blank', title, status, detail, instance: req.path, traceId });
}

/**
 * Reads and parses the JSON body of POST /client-errors itself, counting bytes as they stream in
 * and refusing at the cap whatever the framing (Content-Length, chunked, HTTP/2). It never inflates
 * a compressed body (415), and marks the request as parsed so the global parser skips it. The
 * Content-Length fast path rejects an honest oversize client before reading anything.
 */
export function clientErrorBody(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'POST') return next();
  const encoding = req.headers['content-encoding'];
  if (encoding !== undefined && encoding.toLowerCase() !== 'identity') {
    return problem(req, res, 415, 'Unsupported Media Type', 'Compressed bodies are not accepted.');
  }
  const declared = req.headers['content-length'];
  if (declared !== undefined) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0 || length > CLIENT_ERROR_MAX_BODY_BYTES) {
      return problem(req, res, 413, 'Payload Too Large', 'The report is too large.');
    }
  }
  // Not JSON: leave the stream alone; the body stays empty and validation answers 400.
  if (!JSON_TYPE.test(req.headers['content-type'] ?? '')) return next();

  const chunks: Buffer[] = [];
  let received = 0;
  let done = false;
  const finish = (): void => {
    done = true;
    req.removeListener('data', onData);
    req.removeListener('end', onEnd);
  };
  const onData = (chunk: Buffer): void => {
    if (done) return;
    received += chunk.length;
    if (received > CLIENT_ERROR_MAX_BODY_BYTES) {
      finish();
      problem(req, res, 413, 'Payload Too Large', 'The report is too large.');
      res.once('finish', () => req.destroy());
      return;
    }
    chunks.push(chunk);
  };
  const onEnd = (): void => {
    if (done) return;
    finish();
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      (req as Request & { _body?: boolean })._body = true;
      req.body = parsed;
      next();
    } catch {
      problem(req, res, 400, 'Bad Request', 'The body is not valid JSON.');
    }
  };
  req.on('data', onData);
  req.on('end', onEnd);
  req.once('error', () => {
    done = true;
  });
}
