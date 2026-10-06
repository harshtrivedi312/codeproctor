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

describe('ProblemFilter logging of failures (S8)', () => {
  it('FR-103: a missing org context and a 5xx are logged at error level by name and trace id only', () => {
    const { OrgContextMissingError } =
      jest.requireActual<typeof import('../database/errors')>('../database/errors');
    const { Logger } = jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common');
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      run(new OrgContextMissingError('Session.findMany'));
      run(new HttpException('boom with a secret value', 500));
      const logged = JSON.stringify(error.mock.calls);
      expect(error).toHaveBeenCalledTimes(2);
      expect(logged).toContain('OrgContextMissingError');
      expect(logged).toContain('trace-1');
      expect(logged).not.toMatch(/Session|findMany|secret value/);
    } finally {
      error.mockRestore();
    }
  });
});

describe('ProblemFilter scrubs Prisma errors before logging (NFR-04, FU-BE-83)', () => {
  it('NFR-04: a validation error whose message holds an argument value is logged without that value', () => {
    const { Prisma } = jest.requireActual<typeof import('../generated/prisma/client')>(
      '../generated/prisma/client',
    );
    const { Logger } = jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common');
    const secret = '$argon2id$v=19$m=19456,t=2,p=1$c2VjcmV0$leaked-hash-value';
    const error = new Prisma.PrismaClientValidationError(
      `Invalid \`prisma.user.update()\` invocation:\n{ data: { passwordHash: "${secret}" } }`,
      { clientVersion: '7.10.0' },
    );
    const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const { status, body } = run(error);
      expect(status).toBe(500);
      expect(JSON.stringify(body)).not.toContain(secret);
      const logged = JSON.stringify(
        spy.mock.calls.map(([first]) => {
          const e = (first as { err: Error }).err;
          return {
            message: e.message,
            stack: e.stack,
            name: e.name,
            traceId: (first as { traceId: string }).traceId,
          };
        }),
      );
      expect(logged).not.toContain(secret);
      expect(logged).toContain('PrismaClientValidationError');
      expect(logged).toContain('trace-1');
    } finally {
      spy.mockRestore();
    }
  });
});
