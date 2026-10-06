// DL-37, FU-BE-42: database lock contention is 503 + Retry-After on every route.
import { ArgumentsHost, ConflictException, HttpException, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { lockContentionCode } from './db-contention';
import { ProblemFilter } from './problem.filter';

const LEAK = 'UPDATE "sessions" SET "status"=$1 /* leak-marker-7c1e */ WHERE token_hash=abc123';

interface Out {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function run(exception: unknown, headersSent = false): Out {
  const out: Out = { status: 0, body: {}, headers: {} };
  const res = {
    headersSent,
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
for (const sqlstate of ['55P03', '40P01']) {
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

describe('ProblemFilter database lock contention (DL-37, FU-BE-42, NFR-04)', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
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
    expect(body).toEqual({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      detail: 'The service is busy; retry shortly.',
      instance: '/api/v1/x',
      traceId: 'trace-1',
    });
    expect(body).not.toHaveProperty('code');
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

  it('FU-BE-42: headers already sent: no crash, nothing written', () => {
    const out = run(known('P2028'), true);
    expect(out.status).toBe(0);
    expect(out.headers['Retry-After']).toBeUndefined();
  });

  it('FU-BE-42: other Prisma codes keep their behaviour (P2002, P2025 stay 500)', () => {
    for (const code of ['P2002', 'P2025', 'P2003']) {
      const { status, headers, body } = run(known(code));
      expect(status).toBe(500);
      expect(headers['Retry-After']).toBeUndefined();
      expect(body.detail).toBeUndefined(); // unchanged: unknown errors carry no detail
    }
  });

  it('FU-BE-42: an unknown error is 500, and a serialization failure (40001) is not remapped', () => {
    expect(run(new Error('boom')).status).toBe(500);
    expect(run(adapterError('40001')).status).toBe(500);
    expect(run('a string').status).toBe(500);
  });

  it('FU-BE-42: an HttpException keeps its status, even with a lock code on it', () => {
    const conflict = Object.assign(new ConflictException('dup'), { code: '55P03' });
    const r = run(conflict);
    expect(r.status).toBe(409);
    expect(r.headers['Retry-After']).toBeUndefined();
    expect(run(new HttpException('x', 404)).status).toBe(404);
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
});
