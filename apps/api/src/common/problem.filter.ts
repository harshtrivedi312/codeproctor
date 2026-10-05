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
import { CodedForbiddenException } from './coded.exception';
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
  409: 'Conflict',
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

    const inbound = req.headers['x-request-id'];
    const traceId =
      typeof req.id === 'string' ? req.id : typeof inbound === 'string' ? inbound : '';
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const problem: ProblemDetails = {
      type: 'about:blank',
      title: TITLES[status] ?? (status >= 500 ? 'Server Error' : 'Error'),
      status,
      instance: req.originalUrl.split('?')[0] ?? '',
      traceId,
    };

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'string') {
        problem.detail = body;
      } else if (typeof body === 'object' && body !== null) {
        const { message } = body as { message?: unknown };
        if (Array.isArray(message)) {
          problem.detail = 'Request validation failed';
          problem.errors = message.map(String);
        } else if (typeof message === 'string') {
          problem.detail = message;
        }
      }
      // Only our own coded exceptions may set `code`, and never on a 5xx.
      if (exception instanceof CodedForbiddenException && status < 500) {
        problem.code = exception.code;
      }
      if (status >= 500 && status !== 503) problem.detail = 'The service is unavailable or failed';
    } else {
      this.logger.error(
        { err: exception instanceof Error ? exception : new Error('Non-Error thrown'), traceId },
        'Unhandled exception',
      );
    }

    res.status(status).type('application/problem+json').json(problem);
  }
}
