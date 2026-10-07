// DL-37, FU-BE-42: database lock contention is 503 + Retry-After on every route.
import { ArgumentsHost, ConflictException, HttpException, Logger } from '@nestjs/common';
import { CodedConflictException, CodedForbiddenException } from './coded.exception';
import { AuditWriteAfterCommitError } from '../audit/audit-write-after-commit.error';
import { Prisma } from '../generated/prisma/client.js';
import { lockContentionCode } from './db-contention';
import { ProblemFilter } from './problem.filter';

const LEAK = 'UPDATE "sessions" SET "status"=$1 /* leak-marker-7c1e */ WHERE token_hash=abc123';

interface Out {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function run(exception: unknown, headersSent = false): Out & { destroyed: boolean } {
  const out = { status: 0, body: {}, headers: {}, destroyed: false } as Out & {
    destroyed: boolean;
  };
  const res = {
    headersSent,
    destroy() {
      out.destroyed = true;
    },
    setHeader(k: string, v: string) {
      out.headers[k] = v;
    },
    status(s: number) {
      out.status = s;
      return this;
    },
    type() {
      return this;
    },
    json(b: Record<string, unknown>) {
      out.body = b;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: {},
        id: 'trace-1',
        method: 'POST',
        originalUrl: '/api/v1/x?y=1',
      }),
      getResponse: () => res,
    }),
  } as unknown as ArgumentsHost;
  new ProblemFilter().catch(exception, host);
  return out;
}

const known = (code: string, meta?: Record<string, unknown>): Error =>
  new Prisma.PrismaClientKnownRequestError(`Invalid invocation: ${LEAK}`, {
    code,
    clientVersion: '7.10.0',
    meta,
  });

/** What the pg adapter hands Prisma: an Error with the SQLSTATE in its cause payload. */
const adapterError = (sqlstate: string): Error =>
  Object.assign(new Error(LEAK), {
    name: 'DriverAdapterError',
    cause: { kind: 'postgres', originalCode: sqlstate, originalMessage: LEAK, table: 'sessions' },
  });

const pgError = (sqlstate: string): Error =>
  Object.assign(new Error(LEAK), { name: 'DatabaseError', code: sqlstate });

const CASES: { name: string; code: string; make: () => Error }[] = [];
for (const sqlstate of ['55P03', '40P01', '40001']) {
  CASES.push(
    {
      name: `${sqlstate} as a Prisma known error with the adapter error in meta`,
      code: sqlstate,
      make: () => known('P2010', { driverAdapterError: adapterError(sqlstate) }),
    },
    {
      name: `${sqlstate} as a bare driver adapter error`,
      code: sqlstate,
      make: () => adapterError(sqlstate),
    },
    {
      name: `${sqlstate} as a pg error nested in a cause chain`,
      code: sqlstate,
      make: () => new Error(LEAK, { cause: new Error(LEAK, { cause: pgError(sqlstate) }) }),
    },
  );
}
for (const code of ['P2028', 'P2034']) {
  CASES.push(
    { name: `${code} as a Prisma known error`, code, make: () => known(code) },
    {
      name: `${code} with a driver adapter cause`,
      code,
      make: () => known(code, { driverAdapterError: adapterError('40P01') }),
    },
  );
}

/**
 * The real pool-wait timeout, captured through Prisma 7.10 + @prisma/adapter-pg with a pool of max 1
 * held by a long query (database/pool-timeout.spec.ts): a bare Error, no code, no cause, no meta.
 */
const poolTimeout = (): Error => new Error('timeout exceeded when trying to connect');

describe('ProblemFilter database lock contention (DL-37, FU-BE-42, NFR-04)', () => {
  let warn: jest.SpyInstance<void, unknown[]>;
  let error: jest.SpyInstance<void, unknown[]>;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(CASES)('FU-BE-42: $name is 503 with Retry-After and a fixed body', ({ make, code }) => {
    const { status, body, headers } = run(make());
    expect(status).toBe(503);
    expect(headers['Retry-After']).toMatch(/^[1-9]\d*$/);
    expect(Number(headers['Retry-After'])).toBeLessThanOrEqual(2);
    expect(Number(headers['Retry-After'])).toBeGreaterThanOrEqual(1);
    expect(body).toEqual({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      detail: 'The service is busy; retry shortly.',
      code: 'BUSY',
      instance: '/api/v1/x',
      traceId: 'trace-1',
    });
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(logged).toContain(code);
    expect(logged).toContain('trace-1');
    expect(logged).not.toMatch(/leak-marker|UPDATE|sessions|token_hash|abc123/);
    expect(JSON.stringify(body)).not.toMatch(/leak-marker|UPDATE|sessions|token_hash|P20/);
  });

  it('FU-BE-42: the log line carries the class name and the code only', () => {
    run(known('P2034'));
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields] = warn.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toEqual({
      traceId: 'trace-1',
      errorName: 'PrismaClientKnownRequestError',
      lockCode: 'P2034',
    });
  });

  it('FU-BE-42: headers already sent: nothing is written, the socket is destroyed, for every error class', () => {
    for (const e of [known('P2028'), new Error('boom'), new HttpException('x', 500)]) {
      const out = run(e, true);
      expect(out.status).toBe(0);
      expect(out.headers['Retry-After']).toBeUndefined();
      expect(out.destroyed).toBe(true);
    }
  });

  it('FU-BE-42: P2028 is logged at error level (a closed transaction is a code bug), the rest at warn', () => {
    run(known('P2028'));
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/leak-marker|UPDATE/);
    error.mockClear();
    run(known('P2034'));
    run(adapterError('55P03'));
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('DL-37: an OrgScopeError subclass or an HttpException is never remapped, nor are their causes followed', () => {
    const { OrgScopeViolationError } =
      jest.requireActual<typeof import('../database/errors')>('../database/errors');
    const scope = Object.assign(new OrgScopeViolationError('x'), { code: '55P03' });
    expect(run(scope).status).toBe(500);
    const wrapped = new OrgScopeViolationError('x');
    Object.assign(wrapped, { cause: pgError('55P03') });
    expect(lockContentionCode(wrapped)).toBeUndefined();
    expect(
      lockContentionCode(new ConflictException('x', { cause: pgError('40P01') })),
    ).toBeUndefined();
  });

  it('FU-BE-42: other Prisma codes keep their behaviour (P2002, P2025 stay 500)', () => {
    for (const code of ['P2002', 'P2025', 'P2003']) {
      const { status, headers, body } = run(known(code));
      expect(status).toBe(500);
      expect(headers['Retry-After']).toBeUndefined();
      expect(body.detail).toBeUndefined(); // unchanged: unknown errors carry no detail
    }
  });

  it('FU-BE-42: an unknown error is 500, and an unrelated SQLSTATE is not remapped', () => {
    expect(run(new Error('boom')).status).toBe(500);
    expect(run(adapterError('23505')).status).toBe(500);
    expect(run(adapterError('22P02')).status).toBe(500);
    expect(run('a string').status).toBe(500);
  });

  it('FU-BE-42: an HttpException keeps its status, even with a lock code on it', () => {
    const conflict = Object.assign(new ConflictException('dup'), { code: '55P03' });
    const r = run(conflict);
    expect(r.status).toBe(409);
    expect(r.headers['Retry-After']).toBeUndefined();
    expect(run(new HttpException('x', 404)).status).toBe(404);
  });

  it('DL-37: a coded 409 or 403 built with BUSY (cast) never emits it', () => {
    const busy = 'BUSY' as unknown as ConstructorParameters<typeof CodedConflictException>[1];
    const conflict = run(new CodedConflictException('x', busy));
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBeUndefined();
    const forbidden = run(new CodedForbiddenException('x', busy));
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBeUndefined();
  });

  it('DL-37 (P-37): an audit write failure after commit is a fixed 500: no Retry-After, no code, no detail, never 503', () => {
    const { status, body, headers } = run(new AuditWriteAfterCommitError('USER_INVITED'));
    expect(status).toBe(500);
    expect(headers['Retry-After']).toBeUndefined();
    expect(body).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      instance: '/api/v1/x',
      traceId: 'trace-1',
    });
    // The error log carries the error name and the audit action (api-contract section 8) and
    // nothing else beyond the trace id.
    expect(error).toHaveBeenCalledWith(
      { traceId: 'trace-1', errorName: 'AuditWriteAfterCommitError', auditAction: 'USER_INVITED' },
      'Audit write after commit failed',
    );
    // Even when something lock-shaped is attached, the type wins and nothing is remapped.
    const withCode = Object.assign(new AuditWriteAfterCommitError('USER_INVITED'), {
      code: '55P03',
    });
    expect(run(withCode).status).toBe(500);
  });

  it('FU-BE-42: a cyclic or very deep cause chain terminates', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    a.cause = a;
    expect(lockContentionCode(a)).toBeUndefined();
    let deep: Error = pgError('55P03');
    for (let i = 0; i < 20; i++) deep = new Error('x', { cause: deep });
    expect(lockContentionCode(deep)).toBeUndefined();
    expect(lockContentionCode(new Error('x', { cause: pgError('40P01') }))).toBe('40P01');
  });

  it('FU-BE-197, DL-42, NFR-09: a pool-wait timeout is 503 + Retry-After 2 + BUSY, body has no detail from the driver, logged at error level by name and token only', () => {
    const { status, body, headers } = run(poolTimeout());
    expect(status).toBe(503);
    expect(headers['Retry-After']).toBe('2');
    expect(body).toEqual({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      detail: 'The service is busy; retry shortly.',
      code: 'BUSY',
      instance: '/api/v1/x',
      traceId: 'trace-1',
    });
    expect(JSON.stringify(body)).not.toMatch(/timeout exceeded|connect/);
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      { traceId: 'trace-1', errorName: 'Error', lockCode: 'POOL_TIMEOUT' },
      'Database pool wait timed out',
    );
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/timeout exceeded/);
  });

  it('FU-BE-197, DL-42: the pool timeout matcher finds the shape bare, in a cause chain and as Prisma P2024, and nothing else', () => {
    expect(lockContentionCode(poolTimeout())).toBe('POOL_TIMEOUT');
    expect(lockContentionCode(new Error('wrapped', { cause: poolTimeout() }))).toBe('POOL_TIMEOUT');
    expect(lockContentionCode(known('P2024'))).toBe('POOL_TIMEOUT');
    expect(run(known('P2024')).status).toBe(503);
    // A different message, a partial message and a non-Error carrying the text are not matches.
    expect(lockContentionCode(new Error('Connection terminated due to connection timeout'))).toBe(
      undefined,
    );
    expect(lockContentionCode(new Error('timeout exceeded when trying to connect to x'))).toBe(
      undefined,
    );
    expect(lockContentionCode({ message: 'timeout exceeded when trying to connect' })).toBe(
      undefined,
    );
    expect(lockContentionCode('timeout exceeded when trying to connect')).toBeUndefined();
    // Our own errors are never reclassified, nor are their causes followed.
    expect(
      lockContentionCode(new ConflictException('x', { cause: poolTimeout() })),
    ).toBeUndefined();
    const own = new HttpException('timeout exceeded when trying to connect', 500);
    expect(run(own).status).toBe(500);
  });

  it('FU-BE-197, DL-42, P-37: a pool timeout carried by AuditWriteAfterCommitError is still the fixed 500, never BUSY', () => {
    const e = Object.assign(new AuditWriteAfterCommitError('USER_INVITED'), {
      cause: poolTimeout(),
    });
    const { status, body, headers } = run(e);
    expect(status).toBe(500);
    expect(headers['Retry-After']).toBeUndefined();
    expect(body.code).toBeUndefined();
  });

  it('FU-BE-197: a hostile getter on the message does not break detection', () => {
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new Error('boom');
      },
    });
    expect(lockContentionCode(hostile)).toBeUndefined();
  });
});
