// Raw body handling for the two signed batch routes (ADR 0013 section 2, "Verification order").
//
// The signature covers the request bytes, so the server needs them untouched: no re-serialisation.
// And the order matters: the candidate guard and the state check run BEFORE the size limit is
// enforced "while streaming", then the signature, then parsing. A body-parser in front would read
// (and cap at 100 KB) before any of that, so `holdBatchBody` runs first and hides the content type
// from the global parsers (they skip a request they do not recognise); the handler then calls
// `readBatchBody`, which counts bytes as they stream in and stops at the limit.
//
// No request Content-Encoding is accepted (415): a compressed body is never inflated, so a zip bomb
// cannot reach the parser, and the limit is measured on the bytes that are signed.
import { HttpStatus } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { CodedHttpException } from '../common/coded.exception';

const HELD_CONTENT_TYPE = Symbol('heldContentType');
type HeldRequest = Request & { [HELD_CONTENT_TYPE]?: string };

const JSON_TYPE = /^application\/json\s*(;.*)?$/i;

/** Express middleware: move the content type aside so the global body parsers skip the request. */
export function holdBatchBody(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const held = req as HeldRequest;
    held[HELD_CONTENT_TYPE] = req.headers['content-type'] ?? '';
    delete req.headers['content-type'];
    next();
  };
}

function tooLarge(): CodedHttpException {
  return new CodedHttpException(
    HttpStatus.PAYLOAD_TOO_LARGE,
    'The request body is too large.',
    'PAYLOAD_TOO_LARGE',
  );
}

/**
 * The exact request bytes, at most `limit` of them. 415 for a compressed or non-JSON body, 413 as
 * soon as the declared length or the streamed bytes pass the limit (the rest is discarded, never
 * buffered).
 */
export function readBatchBody(req: Request, limit: number): Promise<Buffer> {
  const encoding = req.headers['content-encoding'];
  if (encoding !== undefined && encoding.toLowerCase() !== 'identity') {
    return Promise.reject(
      new CodedHttpException(
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        'Compressed request bodies are not accepted.',
        'UNSUPPORTED_MEDIA_TYPE',
      ),
    );
  }
  const type = (req as HeldRequest)[HELD_CONTENT_TYPE] ?? req.headers['content-type'] ?? '';
  if (!JSON_TYPE.test(type)) {
    return Promise.reject(
      new CodedHttpException(
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        'Send the batch as application/json.',
        'UNSUPPORTED_MEDIA_TYPE',
      ),
    );
  }
  const declared = req.headers['content-length'];
  if (declared !== undefined) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0 || length > limit) {
      req.resume();
      return Promise.reject(tooLarge());
    }
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        reject(tooLarge());
        return; // keep draining without storing, so the client sees the 413
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks, size));
    });
    req.on('error', (err) => {
      if (!over) reject(err);
    });
    req.on('close', () => {
      if (!over && !req.complete) {
        reject(
          new CodedHttpException(
            HttpStatus.BAD_REQUEST,
            'The request body was not fully received.',
            'VALIDATION_FAILED',
          ),
        );
      }
    });
  });
}
