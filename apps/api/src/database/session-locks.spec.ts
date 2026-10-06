// guardLive and lockForAccommodation (ADR 0013 section 5.7, ADR 0015 section 6, ADR 0006 section 8.5)
// against a fake transaction client: no database. The fake records every call, so the tests pin the
// exact statements the functions ask for (the read, the same-value updateMany, its `where`), the retry
// count and the ERASED rules. The same functions against a real Postgres 16, with two connections, are in
// session-locks-postgres.spec.ts.
//
// `session_status` has no ERASED member until PR #91 (ADR 0004 section 9). guardLiveWith takes the
// member as a parameter, so the "enum has ERASED" branch runs here today: FAKE_ERASED stands in for it,
// and the fake tx accepts it because the type is widened with a double assertion that stays valid after
// #91. FR-704 (retention and erasure), NFR-04 (tenant isolation), TC-008.
import { SessionStatus } from '../generated/prisma/enums.js';
import {
  AccommodationLockedError,
  OrgScopeError,
  OrgScopeViolationError,
  SessionLockRetryError,
  SessionNotFoundError,
} from './errors';
import {
  MAX_LOCK_ATTEMPTS,
  erasedStatusOf,
  guardLive,
  guardLiveWith,
  lockAnySession,
  lockForAccommodation,
} from './session-locks';
import type { SessionLockTx, SessionLockWhere } from './session-locks';

const SID = '11111111-1111-4111-8111-111111111111';
/** Stands in for `SessionStatus.ERASED` while the generated enum lacks it. Valid after #91 too. */
const FAKE_ERASED = 'ERASED' as string as SessionStatus;

type Call =
  | { readonly op: 'findUnique'; readonly args: unknown }
  | { readonly op: 'updateMany'; readonly args: { where: SessionLockWhere; data: unknown } };

interface Script {
  /** The status the n-th read (from 0) returns; null is "no row". */
  readonly read: (n: number) => SessionStatus | null;
  /** The row count of the n-th update (from 0). */
  readonly update: (n: number, where: SessionLockWhere) => number;
}

/** A hard cap, so a loop that never ends (a mutation) fails the test instead of hanging it. */
const RUNAWAY = 40;

function fakeTx(script: Script): { tx: SessionLockTx; calls: Call[] } {
  const calls: Call[] = [];
  let reads = 0;
  let updates = 0;
  const guardRunaway = (): void => {
    if (calls.length > RUNAWAY) throw new Error('runaway: the lock loop does not end');
  };
  const tx: SessionLockTx = {
    session: {
      findUnique: (args) => {
        calls.push({ op: 'findUnique', args });
        guardRunaway();
        const status = script.read(reads);
        reads += 1;
        return Promise.resolve(status === null ? null : { status });
      },
      updateMany: (args) => {
        calls.push({ op: 'updateMany', args });
        guardRunaway();
        const count = script.update(updates, args.where);
        updates += 1;
        return Promise.resolve({ count });
      },
    },
  };
  return { tx, calls };
}

const reads = (calls: readonly Call[]): Call[] => calls.filter((c) => c.op === 'findUnique');
const updates = (calls: readonly Call[]): Array<Extract<Call, { op: 'updateMany' }>> =>
  calls.filter((c): c is Extract<Call, { op: 'updateMany' }> => c.op === 'updateMany');
/** The order of the calls: R for a read, U for an update. */
const shape = (calls: readonly Call[]): string =>
  calls.map((c) => (c.op === 'findUnique' ? 'R' : 'U')).join('');

/** One row of status `status`, and every update wins. */
const steady = (status: SessionStatus): Script => ({ read: () => status, update: () => 1 });
/** The status read changes with each read; every update loses until `winAt` (never, by default). */
const moving = (statuses: readonly SessionStatus[], winAt = Number.POSITIVE_INFINITY): Script => ({
  read: (n) => statuses[Math.min(n, statuses.length - 1)] ?? null,
  update: (n) => (n >= winAt ? 1 : 0),
});

/** Both modes of guardLive: the enum without ERASED (main today) and with it (after #91). */
const MODES = [
  ['the enum has no ERASED', undefined],
  ['the enum has ERASED', FAKE_ERASED],
] as const;

describe('guardLive (ADR 0013 section 5.7): the lock call, FR-704, NFR-04, TC-008', () => {
  describe.each(MODES)('%s', (_mode, erased) => {
    const run = (tx: SessionLockTx) => guardLiveWith(tx, SID, erased);

    it("TC-008 reads the status in the caller's scope, then writes the SAME status once: one read, one updateMany", async () => {
      const { tx, calls } = fakeTx(steady('IN_PROGRESS'));
      await expect(run(tx)).resolves.toBe('LIVE');
      expect(shape(calls)).toBe('RU');
      expect(reads(calls)[0]).toEqual({
        op: 'findUnique',
        args: { where: { id: SID }, select: { status: true } },
      });
      const where =
        erased === undefined
          ? { id: SID, status: 'IN_PROGRESS' }
          : { id: SID, status: 'IN_PROGRESS', NOT: { status: erased } };
      expect(updates(calls)[0]?.args).toEqual({ where, data: { status: 'IN_PROGRESS' } });
    });

    it('TC-008 the compare-and-set names the status that was read, for every status', async () => {
      for (const status of Object.values(SessionStatus)) {
        if (status === erased) continue; // an ERASED row is not locked (below)
        const { tx, calls } = fakeTx(steady(status));
        await expect(run(tx)).resolves.toBe('LIVE');
        const [update] = updates(calls);
        expect(update?.args.where.status).toBe(status);
        expect(update?.args.data).toEqual({ status });
      }
    });

    it('TC-008 returns LIVE for 1 row, and the ERASED condition is in the where only when the enum has ERASED', async () => {
      const { tx, calls } = fakeTx(steady('PAUSED'));
      await run(tx);
      const where = updates(calls)[0]?.args.where;
      expect(Object.hasOwn(where ?? {}, 'NOT')).toBe(erased !== undefined);
      if (erased !== undefined) expect(where?.NOT).toEqual({ status: erased });
    });

    it('TC-008 no row (another org, unknown id) throws SessionNotFoundError and sends no update', async () => {
      const { tx, calls } = fakeTx({ read: () => null, update: () => 1 });
      await expect(run(tx)).rejects.toBeInstanceOf(SessionNotFoundError);
      expect(shape(calls)).toBe('R');
    });

    it('TC-008 0 rows, then the re-read finds another status: retries on THAT status and returns LIVE', async () => {
      const { tx, calls } = fakeTx(moving(['OPENED', 'CONSENTED'], 1));
      await expect(run(tx)).resolves.toBe('LIVE');
      expect(shape(calls)).toBe('RURU');
      expect(updates(calls).map((c) => c.args.where.status)).toEqual(['OPENED', 'CONSENTED']);
      expect(updates(calls).map((c) => c.args.data)).toEqual([
        { status: 'OPENED' },
        { status: 'CONSENTED' },
      ]);
    });

    it('TC-008 retries at most 3 times in total, then throws SessionLockRetryError', async () => {
      expect(MAX_LOCK_ATTEMPTS).toBe(3);
      const { tx, calls } = fakeTx(moving(['OPENED', 'CONSENTED', 'VERIFIED', 'IN_PROGRESS']));
      await expect(run(tx)).rejects.toBeInstanceOf(SessionLockRetryError);
      // Three updates. The re-read after the last lost update decides ERASED or not; it is not a fourth try.
      expect(updates(calls)).toHaveLength(3);
      expect(shape(calls)).toBe('RURURUR');
    });

    it('TC-008 the third try may still win: 2 lost updates, then LIVE', async () => {
      const { tx, calls } = fakeTx(moving(['OPENED', 'CONSENTED', 'VERIFIED'], 2));
      await expect(run(tx)).resolves.toBe('LIVE');
      expect(shape(calls)).toBe('RURURU');
    });

    it('TC-008 a row that vanishes between the tries throws SessionNotFoundError, not a retry error', async () => {
      const { tx } = fakeTx({ read: (n) => (n === 0 ? 'OPENED' : null), update: () => 0 });
      await expect(run(tx)).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    it('TC-008 an error from the database is not retried and is not swallowed', async () => {
      const boom = new Error('connection lost');
      const calls: string[] = [];
      const tx: SessionLockTx = {
        session: {
          findUnique: () => Promise.resolve({ status: 'OPENED' }),
          updateMany: () => {
            calls.push('U');
            return Promise.reject(boom);
          },
        },
      };
      await expect(run(tx)).rejects.toBe(boom);
      expect(calls).toEqual(['U']);
    });

    it('TC-008 the errors carry no value: never the session id', async () => {
      for (const make of [
        () => run(fakeTx({ read: () => null, update: () => 1 }).tx),
        () => run(fakeTx(moving(['OPENED', 'CONSENTED', 'VERIFIED', 'IN_PROGRESS'])).tx),
      ]) {
        const error = await make().then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(Error);
        expect(JSON.stringify(error)).not.toContain(SID);
        expect(String((error as Error).message)).not.toContain(SID);
        expect((error as Error).stack ?? '').not.toContain(SID);
        expect(error).not.toBeInstanceOf(OrgScopeError);
      }
    });
  });

  describe('the enum has ERASED (the fence, ADR 0004 section 9)', () => {
    const run = (tx: SessionLockTx) => guardLiveWith(tx, SID, FAKE_ERASED);

    it('TC-008 a read status of ERASED returns ERASED and writes nothing', async () => {
      const { tx, calls } = fakeTx(steady(FAKE_ERASED));
      await expect(run(tx)).resolves.toBe('ERASED');
      expect(shape(calls)).toBe('R');
      expect(updates(calls)).toHaveLength(0);
    });

    it('TC-008 0 rows and a re-read of ERASED returns ERASED: the fence won the race, nothing is written', async () => {
      const { tx, calls } = fakeTx(moving(['IN_PROGRESS', FAKE_ERASED]));
      await expect(run(tx)).resolves.toBe('ERASED');
      expect(shape(calls)).toBe('RUR');
      expect(updates(calls)).toHaveLength(1);
      expect(updates(calls)[0]?.args.where.status).toBe('IN_PROGRESS');
    });

    it('TC-008 the update that lost excluded ERASED, so it could never have written on an erased row', async () => {
      const { tx, calls } = fakeTx(moving(['IN_PROGRESS', 'SUBMITTED', FAKE_ERASED]));
      await expect(run(tx)).resolves.toBe('ERASED');
      for (const update of updates(calls)) {
        expect(update.args.where.NOT).toEqual({ status: FAKE_ERASED });
        expect(update.args.data).not.toEqual({ status: FAKE_ERASED });
      }
    });

    it('TC-008 the last lost try re-reads too: ERASED there is ERASED, not a retry error', async () => {
      const { tx, calls } = fakeTx(moving(['OPENED', 'CONSENTED', 'VERIFIED', FAKE_ERASED]));
      await expect(run(tx)).resolves.toBe('ERASED');
      expect(updates(calls)).toHaveLength(3);
      expect(shape(calls)).toBe('RURURUR');
    });

    it('TC-008 any other status never makes it return ERASED', async () => {
      for (const status of Object.values(SessionStatus)) {
        if (status === FAKE_ERASED) continue;
        const { tx } = fakeTx(steady(status));
        await expect(run(tx)).resolves.toBe('LIVE');
      }
    });
  });

  describe('guardLive itself uses the generated enum', () => {
    it('TC-008 takes ERASED from the generated enum: the exclusion is in the where exactly when session_status has ERASED', async () => {
      const { tx, calls } = fakeTx(steady('PAUSED'));
      await expect(guardLive(tx, SID)).resolves.toBe('LIVE');
      const where = updates(calls)[0]?.args.where;
      const generatedHasErased = Object.hasOwn(SessionStatus, 'ERASED');
      expect(Object.hasOwn(where ?? {}, 'NOT')).toBe(generatedHasErased);
      expect(shape(calls)).toBe('RU');
    });

    it('TC-008 erasedStatusOf reads the enum object: present, absent, and not from the prototype', () => {
      expect(erasedStatusOf({ ...SessionStatus, ERASED: FAKE_ERASED })).toBe('ERASED');
      expect(erasedStatusOf({ ...SessionStatus })).toBeUndefined();
      expect(erasedStatusOf(Object.create({ ERASED: FAKE_ERASED }) as Record<string, never>)).toBe(
        undefined,
      );
      expect(erasedStatusOf(SessionStatus)).toBe(
        Object.hasOwn(SessionStatus, 'ERASED') ? 'ERASED' : undefined,
      );
    });
  });
});

/**
 * The two locks that work in ANY status, ERASED included, share one implementation and differ in the error
 * of the lost compare-and-set: lockForAccommodation (a route: 409 ACCOMMODATION_LOCKED, ADR 0015 section 6) and
 * lockAnySession (a job: BullMQ retries it, ADR 0013 section 5.7 `withAnySession`).
 */
const ANY_STATUS_LOCKS = [
  ['lockForAccommodation', lockForAccommodation, AccommodationLockedError],
  ['lockAnySession', lockAnySession, SessionLockRetryError],
] as const;

describe.each(ANY_STATUS_LOCKS)(
  '%s (ADR 0015 section 6, ADR 0013 section 5.7): the lock call, FR-704, NFR-04, TC-008',
  (_name, lock, LostError) => {
    it('TC-008 reads the status, writes the same status once with status in the where, and returns it', async () => {
      const { tx, calls } = fakeTx(steady('COMPLETED'));
      await expect(lock(tx, SID)).resolves.toBe('COMPLETED');
      expect(shape(calls)).toBe('RU');
      expect(reads(calls)[0]).toEqual({
        op: 'findUnique',
        args: { where: { id: SID }, select: { status: true } },
      });
      expect(updates(calls)[0]?.args).toEqual({
        where: { id: SID, status: 'COMPLETED' },
        data: { status: 'COMPLETED' },
      });
    });

    it('TC-008 locks a session in ANY status and returns it, with no ERASED exclusion at all', async () => {
      for (const status of [...Object.values(SessionStatus), FAKE_ERASED]) {
        const { tx, calls } = fakeTx(steady(status));
        await expect(lock(tx, SID)).resolves.toBe(status);
        const [update] = updates(calls);
        expect(update?.args.where).toEqual({ id: SID, status });
        expect(Object.hasOwn(update?.args.where ?? {}, 'NOT')).toBe(false);
        expect(update?.args.data).toEqual({ status });
      }
    });

    it('TC-008 an ERASED session is locked and its status returned, so the reduction on it can run', async () => {
      const { tx, calls } = fakeTx(steady(FAKE_ERASED));
      await expect(lock(tx, SID)).resolves.toBe('ERASED');
      expect(updates(calls)).toHaveLength(1);
    });

    it('TC-008 no row throws SessionNotFoundError (the route answers 404, the job is dropped) and sends no update', async () => {
      const { tx, calls } = fakeTx({ read: () => null, update: () => 1 });
      await expect(lock(tx, SID)).rejects.toBeInstanceOf(SessionNotFoundError);
      expect(shape(calls)).toBe('R');
    });

    it('TC-008 0 rows, then a re-read: retries on the new status and returns what it read under the lock', async () => {
      const { tx, calls } = fakeTx(moving(['VERIFIED', 'IN_PROGRESS'], 1));
      await expect(lock(tx, SID)).resolves.toBe('IN_PROGRESS');
      expect(shape(calls)).toBe('RURU');
      expect(updates(calls).map((c) => c.args.where.status)).toEqual(['VERIFIED', 'IN_PROGRESS']);
    });

    it('TC-008 a re-read of ERASED is locked like any status: it never stops on ERASED', async () => {
      const { tx, calls } = fakeTx(moving(['IN_PROGRESS', FAKE_ERASED], 1));
      await expect(lock(tx, SID)).resolves.toBe('ERASED');
      expect(shape(calls)).toBe('RURU');
      expect(updates(calls)[1]?.args.where).toEqual({ id: SID, status: FAKE_ERASED });
    });

    it('TC-008 three lost tries throw their own retry error (409 ACCOMMODATION_LOCKED for the route, a BullMQ retry for the job), never more than 3 updates', async () => {
      const { tx, calls } = fakeTx(moving(['OPENED', 'CONSENTED', 'VERIFIED', 'IN_PROGRESS']));
      await expect(lock(tx, SID)).rejects.toBeInstanceOf(LostError);
      expect(updates(calls)).toHaveLength(MAX_LOCK_ATTEMPTS);
    });

    it('TC-008 a row that vanishes between the tries throws SessionNotFoundError', async () => {
      const { tx } = fakeTx({ read: (n) => (n === 0 ? 'OPENED' : null), update: () => 0 });
      await expect(lock(tx, SID)).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    it('TC-008 an error from the database is not retried and is not swallowed', async () => {
      const boom = new Error('deadlock detected');
      let attempts = 0;
      const tx: SessionLockTx = {
        session: {
          findUnique: () => Promise.resolve({ status: 'OPENED' }),
          updateMany: () => {
            attempts += 1;
            return Promise.reject(boom);
          },
        },
      };
      await expect(lock(tx, SID)).rejects.toBe(boom);
      expect(attempts).toBe(1);
    });

    it('TC-008 the errors carry no value: never the session id', async () => {
      for (const make of [
        () => lock(fakeTx({ read: () => null, update: () => 1 }).tx, SID),
        () => lock(fakeTx(moving(['OPENED', 'CONSENTED', 'VERIFIED', 'IN_PROGRESS'])).tx, SID),
      ]) {
        const error = await make().then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(Error);
        expect(JSON.stringify(error)).not.toContain(SID);
        expect((error as Error).message).not.toContain(SID);
        expect((error as Error).stack ?? '').not.toContain(SID);
        expect(error).not.toBeInstanceOf(OrgScopeError);
      }
    });
  },
);

describe('each lock throws the retry error of its caller (ADR 0013 section 5.7, ADR 0015 section 6)', () => {
  const lost = () => fakeTx(moving(['OPENED', 'CONSENTED', 'VERIFIED', 'IN_PROGRESS'])).tx;

  it('TC-008 lockAnySession fails a job with SessionLockRetryError, never a 409 error; lockForAccommodation the reverse', async () => {
    const job = await lockAnySession(lost(), SID).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(job).toBeInstanceOf(SessionLockRetryError);
    expect(job).not.toBeInstanceOf(AccommodationLockedError);
    const route = await lockForAccommodation(lost(), SID).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(route).toBeInstanceOf(AccommodationLockedError);
    expect(route).not.toBeInstanceOf(SessionLockRetryError);
  });

  it('TC-008 the two any-status locks send the same statements for the same session: one implementation', async () => {
    for (const status of [...Object.values(SessionStatus), FAKE_ERASED]) {
      const a = fakeTx(moving([status, 'OPENED'], 1));
      const b = fakeTx(moving([status, 'OPENED'], 1));
      expect(await lockForAccommodation(a.tx, SID)).toBe(await lockAnySession(b.tx, SID));
      expect(a.calls).toEqual(b.calls);
    }
  });
});

describe('the lock needs a transaction client, not the client itself (ADR 0013 section 5.7)', () => {
  /**
   * The shape of `prisma.client`: the two calls, and the connection methods that Prisma removes from an
   * interactive transaction client (`$transaction` is no discriminator: Prisma 7 leaves it on `tx`).
   */
  function clientItself(connection: '$connect' | '$disconnect') {
    const calls: string[] = [];
    const session = {
      findUnique: () => {
        calls.push('R');
        return Promise.resolve({ status: 'OPENED' as const });
      },
      updateMany: () => {
        calls.push('U');
        return Promise.resolve({ count: 1 });
      },
    };
    const client =
      connection === '$connect'
        ? { $connect: () => Promise.resolve(), session }
        : { $disconnect: () => Promise.resolve(), session };
    return { client, calls };
  }

  it.each(['$connect', '$disconnect'] as const)(
    'TC-008 guardLive refuses an object with %s (the client itself) before any statement: the lock would be released at once',
    async (connection) => {
      const { client, calls } = clientItself(connection);
      // @ts-expect-error the client has $connect or $disconnect, so it is not a SessionLockTx
      await expect(guardLive(client, SID)).rejects.toBeInstanceOf(OrgScopeViolationError);
      // @ts-expect-error the same for the inner function
      await expect(guardLiveWith(client, SID, FAKE_ERASED)).rejects.toBeInstanceOf(
        OrgScopeViolationError,
      );
      expect(calls).toEqual([]);
    },
  );

  it.each(['$connect', '$disconnect'] as const)(
    'TC-008 lockForAccommodation and lockAnySession refuse an object with %s before any statement',
    async (connection) => {
      const { client, calls } = clientItself(connection);
      // @ts-expect-error the client has $connect or $disconnect, so it is not a SessionLockTx
      await expect(lockForAccommodation(client, SID)).rejects.toBeInstanceOf(
        OrgScopeViolationError,
      );
      // @ts-expect-error the same for the job lock
      await expect(lockAnySession(client, SID)).rejects.toBeInstanceOf(OrgScopeViolationError);
      expect(calls).toEqual([]);
    },
  );

  it('TC-008 the refusal names no value, and a transaction-shaped object (no $connect) is accepted', async () => {
    const { client } = clientItself('$connect');
    // @ts-expect-error not a SessionLockTx
    const error = await guardLive(client, SID).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(`${(error as Error).message}`).not.toContain(SID);
    const { tx } = fakeTx(steady('OPENED'));
    expect(Object.hasOwn(tx, '$connect') || Object.hasOwn(tx, '$disconnect')).toBe(false);
    await expect(guardLive(tx, SID)).resolves.toBe('LIVE');
  });
});

describe('the three errors (ADR 0013 section 5.7, ADR 0015 section 6)', () => {
  it('TC-008 each has its own name and a fixed message, and is a plain Error, not an OrgScopeError', () => {
    for (const [error, name] of [
      [new SessionNotFoundError(), 'SessionNotFoundError'],
      [new SessionLockRetryError(), 'SessionLockRetryError'],
      [new AccommodationLockedError(), 'AccommodationLockedError'],
    ] as const) {
      expect(error.name).toBe(name);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(OrgScopeError);
      expect(error.message.length).toBeGreaterThan(10);
    }
    expect(new SessionNotFoundError()).not.toBeInstanceOf(SessionLockRetryError);
    expect(new SessionLockRetryError()).not.toBeInstanceOf(AccommodationLockedError);
  });
});
