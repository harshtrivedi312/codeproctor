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

describe('ProblemFilter org-scope failure (FR-103, TC-008)', () => {
  it('TC-008: a query without an org context is a fixed 403 that leaks nothing', () => {
    const { OrgContextMissingError } =
      jest.requireActual<typeof import('../database/errors')>('../database/errors');
    const { status, body } = run(new OrgContextMissingError('Session.findMany'));
    expect(status).toBe(403);
    expect(body).toEqual({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'Access denied.',
      instance: '/api/v1/x',
      traceId: 'trace-1',
    });
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/Session|findMany|OrgContext|runAsUser|README/);
  });

  it('TC-008: other org-scope errors stay a generic 500', () => {
    const { OrgScopeViolationError } =
      jest.requireActual<typeof import('../database/errors')>('../database/errors');
    expect(run(new OrgScopeViolationError('x')).status).toBe(500);
  });
});
