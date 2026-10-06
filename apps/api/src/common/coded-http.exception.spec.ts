import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { CodedHttpException } from './coded.exception';
import { ProblemFilter } from './problem.filter';

function run(exception: unknown): {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
} {
  let status = 0;
  let body: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  const res = {
    status(s: number) {
      status = s;
      return this;
    },
    type() {
      return this;
    },
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    json(b: Record<string, unknown>) {
      body = b;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: {},
        id: 'trace-9',
        originalUrl: '/api/v1/candidate/session/start?x=1',
      }),
      getResponse: () => res,
    }),
  } as unknown as ArgumentsHost;
  new ProblemFilter().catch(exception, host);
  return { status, body, headers };
}

describe('Problem JSON codes for candidate routes (ADR 0013 section 5.1)', () => {
  it('TC-097: a 429 carries its code, retryAfterSeconds and a Retry-After header', () => {
    const { status, body, headers } = run(
      new CodedHttpException(HttpStatus.TOO_MANY_REQUESTS, 'Wait.', 'OTP_COOLDOWN', {
        retryAfterSeconds: 27,
      }),
    );
    expect(status).toBe(429);
    expect(body.code).toBe('OTP_COOLDOWN');
    expect(body.retryAfterSeconds).toBe(27);
    expect(body.traceId).toBe('trace-9');
    expect(headers['Retry-After']).toBe('27');
  });

  it('FR-609: SESSION_NOT_ACTIVE carries the session status as `sessionStatus` (RFC 7807 `status` stays the HTTP code)', () => {
    const { status, body } = run(
      new CodedHttpException(HttpStatus.CONFLICT, 'No.', 'SESSION_NOT_ACTIVE', {
        sessionStatus: 'SUBMITTED',
      }),
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({
      code: 'SESSION_NOT_ACTIVE',
      status: 409,
      sessionStatus: 'SUBMITTED',
    });
  });

  it('NFR-04: an extension can never overwrite a standard member such as status, title or traceId', () => {
    const { body } = run(
      new CodedHttpException(HttpStatus.CONFLICT, 'No.', 'SESSION_NOT_ACTIVE', {
        title: 'hijacked',
        traceId: 'hijacked',
        detail: 'hijacked',
      }),
    );
    expect(body.title).toBe('Conflict');
    expect(body.traceId).toBe('trace-9');
    expect(body.detail).toBe('No.');
  });
});
