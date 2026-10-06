import {
  ArgumentsHost,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { CodedConflictException, CodedForbiddenException, reauthFailed } from './coded.exception';
import { ProblemFilter } from './problem.filter';

function run(
  exception: unknown,
  reqOverrides: Record<string, unknown> = {},
): { status: number; body: Record<string, unknown> } {
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
      getRequest: () => ({
        headers: {},
        id: 'trace-1',
        method: 'GET',
        originalUrl: '/api/v1/x?y=1',
        ...reqOverrides,
      }),
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

  it('FR-203: a coded 409 carries VARIANT_HAS_AI_REFERENCES', () => {
    const { status, body } = run(new CodedConflictException('x', 'VARIANT_HAS_AI_REFERENCES'));
    expect(status).toBe(409);
    expect(body.code).toBe('VARIANT_HAS_AI_REFERENCES');
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

describe('ProblemFilter scrubs Prisma errors before logging (TC-003, NFR-04, FU-BE-83)', () => {
  it('TC-003, NFR-04: a validation error whose message holds an argument value is logged without that value', () => {
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

  it('TC-003, NFR-04: a bare driver adapter error from a failed transaction commit is logged without its values, keeping kind and SQLSTATE', () => {
    const { Logger } = jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common');
    const secret = 'leaked-token-hash-4f9c';
    const error = Object.assign(new Error(`could not serialize: ${secret}`), {
      name: 'DriverAdapterError',
      cause: {
        kind: 'TransactionWriteConflict',
        originalCode: '22P02',
        originalMessage: `row (${secret}) conflicted`,
        detail: `Key (token_hash)=(${secret})`,
      },
    });
    const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const { status, body } = run(error);
      expect(status).toBe(500);
      expect(JSON.stringify(body)).not.toContain(secret);
      const logged = JSON.stringify(
        spy.mock.calls.map(([first]) => {
          const e = (first as { err: Error & { cause?: unknown } }).err;
          return { message: e.message, stack: e.stack, name: e.name, cause: e.cause };
        }),
      );
      expect(logged).not.toContain(secret);
      expect(logged).toContain('TransactionWriteConflict');
      expect(logged).toContain('22P02');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('ProblemFilter body-parser errors, 404 and trace id (FU-BE-103, FU-BE-13, FU-BE-12)', () => {
  const tooLarge = Object.assign(new Error('request entity too large'), {
    status: 413,
    type: 'entity.too.large',
    body: 'SECRET-BODY',
  });
  const badJson = Object.assign(new SyntaxError('Unexpected token S in JSON'), {
    status: 400,
    type: 'entity.parse.failed',
    body: '{"password":"SECRET-BODY"',
  });

  it('FR-201: an oversize body is 413 problem+json with a fixed detail', () => {
    const { status, body } = run(tooLarge);
    expect(status).toBe(413);
    expect(body).toMatchObject({ title: 'Payload Too Large', status: 413 });
    expect(JSON.stringify(body)).not.toContain('SECRET-BODY');
  });

  it('FR-201: malformed JSON is 400 and never echoes the body or the parser message', () => {
    const { status, body } = run(badJson);
    expect(status).toBe(400);
    expect(body.detail).toBe('The request body is not valid.');
    expect(JSON.stringify(body)).not.toContain('SECRET-BODY');
    expect(JSON.stringify(body)).not.toContain('Unexpected token');
  });

  it('FR-201: an unsupported charset or encoding is 415; an untyped error stays 500', () => {
    expect(
      run(Object.assign(new Error('x'), { status: 415, type: 'charset.unsupported' })).status,
    ).toBe(415);
    expect(run(Object.assign(new Error('x'), { status: 413 })).status).toBe(500);
    expect(run(Object.assign(new Error('x'), { status: 500, type: 'entity.x' })).status).toBe(500);
  });

  it('FU-BE-13: the default 404 detail is fixed and does not echo the query string', () => {
    const notFound = new NotFoundException('Cannot GET /api/v1/nope?token=secret');
    const { body } = run(notFound, { originalUrl: '/api/v1/nope?token=secret' });
    expect(body.detail).toBe('Route not found.');
    expect(body.instance).toBe('/api/v1/nope');
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('FU-BE-13: a route handler 404 keeps its own message', () => {
    expect(run(new HttpException('Question not found', 404)).body.detail).toBe(
      'Question not found',
    );
  });

  it('FU-BE-12: without req.id the traceId is a validated inbound id or a fresh one, never raw', () => {
    const noId = { id: undefined };
    expect(
      run(tooLarge, { ...noId, headers: { 'x-request-id': 'good-id-12345' } }).body.traceId,
    ).toBe('good-id-12345');
    const bad = run(tooLarge, {
      ...noId,
      headers: { 'x-request-id': '<script>alert(1)</script>' },
    });
    expect(bad.body.traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(run(tooLarge, { ...noId, headers: {} }).body.traceId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
