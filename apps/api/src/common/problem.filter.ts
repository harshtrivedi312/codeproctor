// Global exception filter: every error leaves as RFC 7807 problem JSON (ADR 0001 C-9).
// Unknown errors never leak their message or stack to the client.
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { BODY_PARSER_DETAIL, bodyParserStatus } from './body-parsers';
import {
  LOCK_CONTENTION_CODE,
  LOCK_CONTENTION_DETAIL,
  LOCK_CONTENTION_RETRY_AFTER_SECONDS,
  lockContentionCode,
} from './db-contention';
import { getEarlyRejection } from './early-rejection';
import { resolveRequestId } from './request-id';
import { OrgContextMissingError, OrgScopeError } from '../database/errors';
import { scrubPrismaError } from '../database/error-scrub';
import { CodedConflictException, CodedForbiddenException } from './coded.exception';
import type { ProblemCode } from './coded.exception';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance: string;
  traceId: string;
  errors?: string[];
  /** Stable machine code, present only where a route defines one (e.g. REAUTH_FAILED). */
  code?: ProblemCode;
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  408: 'Request Timeout',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    // Normally pino-http has set req.id. Errors raised before it (a body-parser failure) fall back
    // to a validated inbound id or a fresh one, never a raw header value (FU-BE-12).
    const traceId =
      typeof req.id === 'string'
        ? req.id
        : resolveRequestId(req.headers['x-request-id'], req.originalUrl);
    // A query ran with no org context (a bug, or a public route that touches org data). It fails
    // closed with a fixed 403 that names nothing; the cause is logged by error name only, with
    // the trace id, so the bug is not masked (FR-103, TC-008).
    const noScope = exception instanceof OrgContextMissingError;
    const parserStatus = bodyParserStatus(exception);
    // Database lock contention (DL-37, FU-BE-42): 503 + Retry-After on every route. An
    // HttpException is never reclassified.
    const lockCode =
      exception instanceof HttpException || exception instanceof OrgScopeError
        ? undefined
        : lockContentionCode(exception);
    const status = noScope
      ? HttpStatus.FORBIDDEN
      : exception instanceof HttpException
        ? exception.getStatus()
        : lockCode !== undefined
          ? HttpStatus.SERVICE_UNAVAILABLE
          : (parserStatus ?? HttpStatus.INTERNAL_SERVER_ERROR);

    const problem: ProblemDetails = {
      type: 'about:blank',
      title: TITLES[status] ?? (status >= 500 ? 'Server Error' : 'Error'),
      status,
      instance: req.originalUrl.split('?')[0] ?? '',
      traceId,
    };

    if (noScope) {
      this.logger.error({ traceId, errorName: exception.name }, 'Query without an org context');
      problem.detail = 'Access denied.';
    } else if (lockCode !== undefined) {
      // Class name and the fixed code token only: the message can hold SQL and parameters.
      // P2028 also means a closed or unknown transaction (a code bug), so it is logged at error
      // level to be noticed when it recurs; the genuine lock cases stay at warn.
      const fields = {
        traceId,
        errorName: exception instanceof Error ? exception.name : 'NonError',
        lockCode,
      };
      if (lockCode === 'P2028') this.logger.error(fields, 'Database transaction error');
      else this.logger.warn(fields, 'Database lock contention');
      problem.detail = LOCK_CONTENTION_DETAIL;
      // Set here, never copied from the error.
      problem.code = LOCK_CONTENTION_CODE;
      if (!res.headersSent) {
        res.setHeader('Retry-After', String(LOCK_CONTENTION_RETRY_AFTER_SECONDS));
      }
    } else if (parserStatus !== undefined) {
      problem.detail = BODY_PARSER_DETAIL[parserStatus];
    } else if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'string') {
        problem.detail = body;
      } else if (typeof body === 'object' && body !== null) {
        const { message } = body as { message?: unknown };
        if (Array.isArray(message)) {
          problem.detail = 'Request validation failed';
          problem.errors = message.map(String);
        } else if (typeof message === 'string') {
          // Nest's default 404 is `Cannot GET /path?query`: the query string may carry a token, so
          // the route-not-found detail is fixed (FU-BE-13).
          problem.detail =
            status === 404 && message.startsWith(`Cannot ${req.method} `)
              ? 'Route not found.'
              : message;
        }
      }
      // Only our own coded exceptions may set `code`, and never on a 5xx.
      if (
        (exception instanceof CodedForbiddenException ||
          exception instanceof CodedConflictException) &&
        status < 500 &&
        // BUSY is set by the lock path only, whatever a coded exception was built with.
        (exception.code as string) !== LOCK_CONTENTION_CODE
      ) {
        problem.code = exception.code;
      }
      if (status >= 500) {
        // Fixed message, class name and trace id only: never the body, which may carry values.
        this.logger.error({ traceId, errorName: exception.name, status }, 'Request failed');
      }
      if (status >= 500 && status !== 503) problem.detail = 'The service is unavailable or failed';
    } else {
      // A Prisma or driver error can carry argument values (a passwordHash, a token hash) in its
      // message and meta: scrub it before it reaches the log (FU-DB-70, FU-DB-112).
      const err = exception instanceof Error ? scrubPrismaError(exception) : undefined;
      this.logger.error(
        { err: err instanceof Error ? err : new Error('Non-Error thrown'), traceId },
        'Unhandled exception',
      );
    }

    // Headers already sent (an error while the response was streaming): nothing more can be
    // written, and ending the response would make a truncated 200 look complete. Destroy the
    // socket so the client sees an aborted response. Applies to every error class.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    // A request refused before the throttler never had its body read: close the connection after
    // the answer (no immediate destroy: that can RST and hide the answer; the leftover is capped by
    // the server requestTimeout) (client-errors, FU-BE-100).
    if (getEarlyRejection(req)) {
      res.setHeader('Connection', 'close');
    }
    res.status(status).type('application/problem+json').json(problem);
  }
}
