import { SessionLockRetryError } from '../database/errors';
import { BUSY_LOCK_RETRY_AFTER_SECONDS, busyLockToProblem, isBusyLockError } from './busy-lock';

const withCode = (code: string, wrap = 0): Error => {
  let e: Error = Object.assign(new Error('pg'), { code });
  for (let i = 0; i < wrap; i++) e = Object.assign(new Error('wrap'), { cause: e });
  return e;
};

describe('busyLockToProblem (ADR 0013 5.7, lock order: 55P03 and 40P01 are 503, never 409 or 500)', () => {
  it('ADR 0013 5.7: lock timeout, deadlock, Prisma conflict, the retry error and wrapped causes are 503 LOCK_BUSY with Retry-After', () => {
    for (const e of [
      withCode('55P03'),
      withCode('40P01'),
      withCode('P2034'),
      withCode('55P03', 3),
      new SessionLockRetryError(),
      Object.assign(new Error('x'), { code: 'P2010', meta: { code: '40P01' } }),
    ]) {
      expect(isBusyLockError(e)).toBe(true);
      const problem = busyLockToProblem(e);
      expect(problem?.getStatus()).toBe(503);
      expect(problem?.code).toBe('LOCK_BUSY');
      expect(problem?.extensions.retryAfterSeconds).toBe(BUSY_LOCK_RETRY_AFTER_SECONDS);
    }
  });

  it('ADR 0013 5.7: Prisma 7 with the pg adapter carries the SQLSTATE in meta.driverAdapterError.cause and in cause.originalCode; P2028 (transaction timeout) is busy too', () => {
    const viaMeta = Object.assign(new Error('P2010'), {
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '55P03' } } },
    });
    const viaMetaCode = Object.assign(new Error('P2010'), {
      meta: { driverAdapterError: { cause: { code: '40P01' } } },
    });
    const bare = Object.assign(new Error('DriverAdapterError'), {
      cause: { originalCode: '40P01' },
    });
    for (const e of [
      viaMeta,
      viaMetaCode,
      bare,
      Object.assign(new Error('timeout'), { code: 'P2028' }),
    ]) {
      expect(isBusyLockError(e)).toBe(true);
    }
    const notBusy = Object.assign(new Error('x'), {
      meta: { driverAdapterError: { cause: { originalCode: '23505' } } },
    });
    expect(isBusyLockError(notBusy)).toBe(false);
  });

  it('ADR 0013 5.7: any other error is not a busy lock (null), so the caller keeps its own error', () => {
    for (const e of [
      withCode('P2002'),
      withCode('23505'),
      new Error('boom'),
      null,
      undefined,
      'x',
      withCode('55P03', 9),
    ]) {
      expect(isBusyLockError(e)).toBe(false);
      expect(busyLockToProblem(e)).toBeNull();
    }
  });
});
