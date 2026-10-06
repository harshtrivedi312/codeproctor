import { HttpException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Fixed details for a body-parser error: never the body, never the parser's own message. */
export const BODY_PARSER_DETAIL: Record<number, string> = {
  400: 'The request body is not valid.',
  413: 'The request body is too large.',
  415: 'The request body encoding is not supported.',
};

/** The 4xx status of an http-errors error from body-parser or raw-body (it has a `type`). */
export function bodyParserStatus(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const { status, type } = exception as { status?: unknown; type?: unknown };
  if (typeof type !== 'string' || typeof status !== 'number') return undefined;
  return BODY_PARSER_DETAIL[status] !== undefined ? status : undefined;
}

type ParserType = 'json' | 'urlencoded';

/**
 * Builds a body parser WITHOUT registering it. `express` is not a direct dependency, and Nest only
 * exposes its parsers through `useBodyParser`, which does `adapter.use(parser)`; this captures
 * that one call so the parser can be wrapped and mounted where we want (FU-BE-104).
 */
function captureParser(
  app: INestApplication,
  type: ParserType,
  options: Record<string, unknown>,
): RequestHandler {
  const express = app as NestExpressApplication;
  const adapter = express.getHttpAdapter() as unknown as { use: (...args: unknown[]) => unknown };
  const original = Object.getOwnPropertyDescriptor(adapter, 'use');
  let captured: RequestHandler | undefined;
  adapter.use = (...args: unknown[]): unknown => {
    captured = args[0] as RequestHandler;
    return adapter;
  };
  try {
    express.useBodyParser(type, options);
  } finally {
    if (original) Object.defineProperty(adapter, 'use', original);
    else delete (adapter as { use?: unknown }).use;
  }
  if (!captured) throw new Error('Could not build the body parser');
  return captured;
}

/**
 * Runs `parser` and turns its failures into HttpExceptions with a fixed detail (413 too large,
 * 400 malformed, 415 bad charset). Left alone, Nest rewraps a malformed-JSON SyntaxError as
 * BadRequestException(err.message), and V8's message can quote a snippet of the body (FU-BE-103).
 */
function mapParserErrors(parser: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    parser(req, res, (err?: unknown) => {
      const status = err === undefined ? undefined : bodyParserStatus(err);
      if (status !== undefined) next(new HttpException(BODY_PARSER_DETAIL[status] ?? '', status));
      else next(err);
    });
  };
}

/** A 1 MB-style JSON parser for one mount path; anonymous to Nest's "already applied" check. */
export function createScopedJsonParser(app: INestApplication, limit: string): RequestHandler {
  return mapParserErrors(captureParser(app, 'json', { limit }));
}

/**
 * The global JSON and urlencoded parsers at Nest's defaults (100 KB), with mapped errors. They are
 * registered under the names Nest looks for (`jsonParser`, `urlencodedParser`), so Nest does not
 * add its own unwrapped copies at init.
 */
export function useDefaultBodyParsers(app: INestApplication): void {
  const json = mapParserErrors(captureParser(app, 'json', {}));
  const urlencoded = mapParserErrors(captureParser(app, 'urlencoded', { extended: true }));
  app.use(named('jsonParser', json));
  app.use(named('urlencodedParser', urlencoded));
}

/** Express reports a layer by its function name, which is what Nest's "already applied" test reads. */
function named(name: string, handler: RequestHandler): RequestHandler {
  const wrapped: RequestHandler = (req, res, next) => {
    handler(req, res, next);
  };
  Object.defineProperty(wrapped, 'name', { value: name });
  return wrapped;
}
