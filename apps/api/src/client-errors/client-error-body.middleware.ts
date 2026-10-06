import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { markEarlyRejection } from '../common/early-rejection';

/** Hard cap on the body of the public client-error route (C-32). */
export const CLIENT_ERROR_MAX_BODY_BYTES = 16 * 1024;
/** Deepest `[` / `{` nesting a report may have; the real DTO is one level deep. */
export const CLIENT_ERROR_MAX_JSON_DEPTH = 20;

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;

/**
 * Refuses the request without answering it here: records the status for the guard that runs
 * after the throttler, so a rejected body still counts against the per-IP and global budgets
 * (FU-BE-100). The body is never read further, and the framing headers are dropped so the global
 * body parsers skip the request instead of reading it before the throttler runs.
 */
function reject(req: Request, next: NextFunction, status: number, detail: string): void {
  markEarlyRejection(req, { status, detail });
  delete req.headers['content-length'];
  delete req.headers['transfer-encoding'];
  delete req.headers['content-type'];
  next();
}

/** True when `[` and `{` nest deeper than `max` outside strings. Linear, no recursion. */
export function exceedsJsonDepth(text: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 92) escaped = true;
      else if (c === 34) inString = false;
    } else if (c === 34) {
      inString = true;
    } else if (c === 91 || c === 123) {
      depth += 1;
      if (depth > max) return true;
    } else if (c === 93 || c === 125) {
      depth -= 1;
    }
  }
  return false;
}

/**
 * Reads and parses the JSON body of POST /client-errors itself, so the limit holds whatever the
 * framing (Content-Length or chunked): bytes are counted as they stream in and the request is
 * refused at the cap (413), or after `timeoutMs` of reading (408, slowloris). A body that is not
 * JSON is 415 (so a cross-site form post cannot reach the global urlencoded parser) and a
 * compressed body is 415 (never inflated). A request with no body falls through and validation
 * answers 400. Every refusal is recorded and answered later by ClientErrorRejectionGuard, after
 * the throttler has counted the request (see `reject`).
 *
 * How the global parser is skipped: after this middleware has consumed the stream, body-parser 2
 * sees `onFinished.isFinished(req)` and calls next() without reading; `req.body` is what we set.
 */
export function createClientErrorBody(timeoutMs: number): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.method !== 'POST') return next();
    const encoding = req.headers['content-encoding'];
    if (encoding !== undefined && encoding.toLowerCase() !== 'identity') {
      return reject(req, next, 415, 'Compressed bodies are not accepted.');
    }
    const declared = req.headers['content-length'];
    if (declared !== undefined) {
      const length = Number(declared);
      if (!Number.isFinite(length) || length < 0 || length > CLIENT_ERROR_MAX_BODY_BYTES) {
        return reject(req, next, 413, 'The report is too large.');
      }
    }
    const hasBody =
      req.headers['transfer-encoding'] !== undefined ||
      (declared !== undefined && Number(declared) > 0);
    if (!hasBody) return next();
    if (!JSON_TYPE.test(req.headers['content-type'] ?? '')) {
      return reject(req, next, 415, 'Send the report as application/json.');
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      stop();
      req.pause();
      reject(req, next, 408, 'The report body arrived too slowly.');
    }, timeoutMs);
    timer.unref();
    const stop = (): void => {
      done = true;
      clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
    };
    const onData = (chunk: Buffer): void => {
      received += chunk.length;
      if (received > CLIENT_ERROR_MAX_BODY_BYTES) {
        stop();
        req.pause();
        reject(req, next, 413, 'The report is too large.');
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      stop();
      const text = Buffer.concat(chunks).toString('utf8');
      if (exceedsJsonDepth(text, CLIENT_ERROR_MAX_JSON_DEPTH)) {
        return reject(req, next, 400, 'The body is nested too deeply.');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return reject(req, next, 400, 'The body is not valid JSON.');
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return reject(req, next, 400, 'The body must be a JSON object.');
      }
      req.body = parsed;
      next();
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.once('close', () => {
      done = true;
      clearTimeout(timer);
    });
    req.once('error', () => {
      done = true;
      clearTimeout(timer);
    });
  };
}
