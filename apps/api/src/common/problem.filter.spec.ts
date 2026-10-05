import { ArgumentsHost, ForbiddenException, HttpException } from '@nestjs/common';
import { CodedForbiddenException, reauthFailed } from './coded.exception';
import { ProblemFilter } from './problem.filter';

function run(exception: unknown): { status: number; body: Record<string, unknown> } {
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    status(s: number) {
      status = s;
      return this;
    },
    type() {
      return this;
    },
    json(b: Record<string, unknown>) {
      body = b;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ headers: {}, id: 'trace-1', originalUrl: '/api/v1/x?y=1' }),
      getResponse: () => res,
    }),
  } as unknown as ArgumentsHost;
  new ProblemFilter().catch(exception, host);
  return { status, body };
}

describe('ProblemFilter code extension (ADR 0001 C-9)', () => {
  it('TC-003: a coded 403 carries its machine code next to traceId', () => {
    const { status, body } = run(reauthFailed());
    expect(status).toBe(403);
    expect(body.code).toBe('REAUTH_FAILED');
    expect(body.traceId).toBe('trace-1');
  });

  it('TC-003: a plain exception that carries a code field does not reflect it', () => {
    const plain = new ForbiddenException({ message: 'no', code: 'REAUTH_FAILED' });
    expect(run(plain).body.code).toBeUndefined();
    const other = Object.assign(new Error('boom'), { code: 'REAUTH_FAILED' });
    expect(run(other).body.code).toBeUndefined();
  });

  it('TC-003: a 5xx never carries a code', () => {
    const coded = new CodedForbiddenException('x', 'REAUTH_FAILED');
    Object.assign(coded, { getStatus: () => 500 });
    expect(run(coded).body.code).toBeUndefined();
    expect(run(new HttpException('down', 503)).body.code).toBeUndefined();
  });
});
