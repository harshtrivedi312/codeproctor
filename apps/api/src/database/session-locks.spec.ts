// guardLive, lockForAccommodation and lockAnySession (ADR 0013 section 5.7, ADR 0015 section 6, ADR 0006
// section 8.5) against a fake transaction client: no database. The fake records every call, so the tests pin
// the exact statements the functions ask for (the read, the same-value updateMany, its `where`), the retry
// count and the scope refusals. The same functions against a real Postgres 16, with two connections, are in
// session-locks-postgres.spec.ts.
//
// What depends on the shape of the generated `SessionStatus` enum (it has no ERASED member until PR #91,
// ADR 0004 section 9) is tested through the REAL guardLive export with the enums module replaced: see
// session-locks-enum-erased.spec.ts and session-locks-enum-absent.spec.ts, which share
// testing/guard-live-cases.ts. `guardLiveWith`, which used to take the member as a parameter, is gone (S1 of
// the review of #208): the module's export surface is pinned below. FR-704, NFR-05 (erasure), NFR-04
// (tenant isolation), TC-008, TC-094.
import * as sessionLocks from './session-locks';
import { SessionStatus } from '../generated/prisma/enums.js';
import {
  AccommodationLockedError,
  SESSION_LOCK_ERROR_CODES,
  OrgScopeError,
  OrgScopeViolationError,
  SessionLockRetryError,
  SessionNotFoundError,
} from './errors';
import { OrgContextService, SYSTEM_SCOPE_REASONS } from './org-context';
import type { SystemScopeReason } from './org-context';
import {
  MAX_LOCK_ATTEMPTS,
  erasedStatusOf,
  guardLive,
  lockAnySession,
  lockForAccommodation,
} from './session-locks';
import type { SessionLockTx } from './session-locks';
import {
  FAKE_ERASED,
  ORG,
  SID,
  fakeTx,
  inService,
  inStaff,
  moving,
  reads,
  shape,
  steady,
  updates,
} from './testing/session-lock-fakes';

describe('the module surface (S1 of the review of #208): the three locks and nothing else that locks', () => {
  it('TC-008 the exports are exactly the three locks, erasedStatusOf and MAX_LOCK_ATTEMPTS: no guardLive without the ERASED stop', () => {
    expect(Object.keys(sessionLocks).sort()).toEqual([
      'MAX_LOCK_ATTEMPTS',
      'erasedStatusOf',
      'guardLive',
      'lockAnySession',
      'lockForAccommodation',
    ]);
    expect(Object.hasOwn(sessionLocks, 'guardLiveWith')).toBe(false);
  });
});

describe('guardLive with the REAL generated enum (ADR 0013 section 5.7): FR-704, NFR-05, NFR-04, TC-008, TC-094', () => {
  const generatedHasErased = Object.hasOwn(SessionStatus, 'ERASED');

  it('TC-008 takes ERASED from the generated enum: the NOT condition is in the where exactly when session_status has ERASED', async () => {
    const { tx, calls } = fakeTx(steady('PAUSED'));
    await expect(inService(() => guardLive(tx, SID))).resolves.toBe('LIVE');
    const where = updates(calls)[0]?.args.where;
    expect(Object.hasOwn(where ?? {}, 'NOT')).toBe(generatedHasErased);
    expect(shape(calls)).toBe('RU');
  });

  it('NFR-05 TC-094 a row that reads ERASED returns ERASED and writes nothing, whatever the generated client knows (N1)', async () => {
    const { tx, calls } = fakeTx(steady(FAKE_ERASED));
    await expect(inService(() => guardLive(tx, SID))).resolves.toBe('ERASED');
    expect(shape(calls)).toBe('R');
  });

  it('TC-008 erasedStatusOf reads the enum object: present, absent, and not from the prototype', () => {
    expect(erasedStatusOf({ ...SessionStatus, ERASED: FAKE_ERASED })).toBe('ERASED');
    // An enum without the member, built from the real one so the test means the same before and after #91.
    const withoutErased = Object.fromEntries(
      Object.entries(SessionStatus).filter(([name]) => name !== 'ERASED'),
    ) as Record<string, (typeof SessionStatus)[keyof typeof SessionStatus]>;
    expect(erasedStatusOf(withoutErased)).toBeUndefined();
    expect(erasedStatusOf(Object.create({ ERASED: FAKE_ERASED }) as Record<string, never>)).toBe(
      undefined,
    );
    expect(erasedStatusOf(SessionStatus)).toBe(generatedHasErased ? 'ERASED' : undefined);
  });
});

/**
 * The two locks that work in ANY status, ERASED included, share one implementation and differ in the error
 * of the lost compare-and-set: lockForAccommodation (a route: 409 ACCOMMODATION_LOCKED, ADR 0015 section 6) and
 * lockAnySession (a job: BullMQ retries it, ADR 0013 section 5.7 `withAnySession`).
 */
const ANY_STATUS_LOCKS = [
  // Each in the scope it passes in (ADR 0006 section 8.5): lockForAccommodation in STAFF, lockAnySession in SERVICE.
  ['lockForAccommodation', lockForAccommodation, AccommodationLockedError, inStaff],
  ['lockAnySession', lockAnySession, SessionLockRetryError, inService],
] as const;

describe.each(ANY_STATUS_LOCKS)(
  '%s (ADR 0015 section 6, ADR 0013 section 5.7): the lock call, FR-704, NFR-04, TC-008',
  (_name, lock, LostError, inScope) => {
    const run = (tx: SessionLockTx) => inScope(() => lock(tx, SID));

    it('TC-008 reads the status, writes the same status once with status in the where, and returns it', async () => {
      const { tx, calls } = fakeTx(steady('COMPLETED'));
      await expect(run(tx)).resolves.toBe('COMPLETED');
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
        await expect(run(tx)).resolves.toBe(status);
        const [update] = updates(calls);
        expect(update?.args.where).toEqual({ id: SID, status });
        expect(Object.hasOwn(update?.args.where ?? {}, 'NOT')).toBe(false);
        expect(update?.args.data).toEqual({ status });
      }
    });

    it('TC-008 an ERASED session is locked and its status returned, so the reduction on it can run', async () => {
      const { tx, calls } = fakeTx(steady(FAKE_ERASED));
      await expect(run(tx)).resolves.toBe('ERASED');
      expect(updates(calls)).toHaveLength(1);
    });

    it('TC-008 no row throws SessionNotFoundError (the route answers 404, the job is dropped) and sends no update', async () => {
      const { tx, calls } = fakeTx({ read: () => null, update: () => 1 });
      await expect(run(tx)).rejects.toBeInstanceOf(SessionNotFoundError);
      expect(shape(calls)).toBe('R');
    });

    it('TC-008 0 rows, then a re-read: retries on the new status and returns what it read under the lock', async () => {
      const { tx, calls } = fakeTx(moving(['VERIFIED', 'IN_PROGRESS'], 1));
      await expect(run(tx)).resolves.toBe('IN_PROGRESS');
      expect(shape(calls)).toBe('RURU');
      expect(updates(calls).map((c) => c.args.where.status)).toEqual(['VERIFIED', 'IN_PROGRESS']);
    });

    it('TC-008 a re-read of ERASED is locked like any status: it never stops on ERASED', async () => {
      const { tx, calls } = fakeTx(moving(['IN_PROGRESS', FAKE_ERASED], 1));
      await expect(run(tx)).resolves.toBe('ERASED');
      expect(shape(calls)).toBe('RURU');
      expect(updates(calls)[1]?.args.where).toEqual({ id: SID, status: FAKE_ERASED });
    });

    it('TC-008 three lost tries throw their own retry error (409 ACCOMMODATION_LOCKED for the route, a BullMQ retry for the job), never more than 3 updates', async () => {
      const { tx, calls } = fakeTx(moving(['OPENED', 'CONSENTED', 'VERIFIED', 'IN_PROGRESS']));
      await expect(run(tx)).rejects.toBeInstanceOf(LostError);
      expect(updates(calls)).toHaveLength(MAX_LOCK_ATTEMPTS);
    });

    it('TC-008 a row that vanishes between the tries throws SessionNotFoundError', async () => {
      const { tx } = fakeTx({ read: (n) => (n === 0 ? 'OPENED' : null), update: () => 0 });
      await expect(run(tx)).rejects.toBeInstanceOf(SessionNotFoundError);
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
      await expect(run(tx)).rejects.toBe(boom);
      expect(attempts).toBe(1);
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
    const job = await inService(() => lockAnySession(lost(), SID)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(job).toBeInstanceOf(SessionLockRetryError);
    expect(job).not.toBeInstanceOf(AccommodationLockedError);
    const route = await inStaff(() => lockForAccommodation(lost(), SID)).then(
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
      expect(await inStaff(() => lockForAccommodation(a.tx, SID))).toBe(
        await inService(() => lockAnySession(b.tx, SID)),
      );
      expect(a.calls).toEqual(b.calls);
    }
  });
});

describe('each lock passes only in its own scopes (the merged ADR 0006 section 8.5, FU-DB-240): NFR-04, TC-008', () => {
  const orgContext = new OrgContextService();
  /**
   * What each lock passes in, written out BY HAND from the merged ADR 0006 section 8.5 (not read from the policy table):
   * guardLive SERVICE and STAFF; lockAnySession SERVICE only; lockForAccommodation STAFF and the plain org job scope.
   */
  const LOCKS = [
    ['guardLive', guardLive, { service: true, staff: true, plainOrg: false }],
    ['lockForAccommodation', lockForAccommodation, { service: false, staff: true, plainOrg: true }],
    ['lockAnySession', lockAnySession, { service: true, staff: false, plainOrg: false }],
  ] as const;
  const stateGrant = {
    model: 'Session',
    columns: ['status', 'pauseReasons', 'submittedAt'],
    ids: [SID],
  };
  const user = { orgId: ORG, userId: SID, role: 'RECRUITER' } as const;

  /** The error of a refused call, which must name no value. */
  const refusal = async (run: () => Promise<unknown>): Promise<Error> => {
    const error = await run().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OrgScopeViolationError);
    const text = `${(error as Error).message} ${(error as Error).stack ?? ''}`;
    expect(text).not.toContain(SID);
    expect(text).not.toContain(ORG);
    return error as Error;
  };

  describe.each(LOCKS)('%s', (_name, lock, allowed) => {
    it('TC-008 is refused in system scope, whatever the reason: no org filter, so no statement is sent', async () => {
      for (const reason of Object.keys(SYSTEM_SCOPE_REASONS) as SystemScopeReason[]) {
        const { tx, calls } = fakeTx(steady('OPENED'));
        const error = await refusal(() => orgContext.runSystem(reason, () => lock(tx, SID)));
        expect(error.message).toMatch(/system scope/i);
        expect(calls).toEqual([]);
      }
    });

    it('TC-008 is refused in a CANDIDATE scope, with no grant: no statement is sent', async () => {
      const { tx, calls } = fakeTx(steady('OPENED'));
      const error = await refusal(() => orgContext.runAsCandidate(ORG, SID, () => lock(tx, SID)));
      expect(error.message).toMatch(/CANDIDATE scope/);
      expect(calls).toEqual([]);
    });

    it('TC-008 is refused in a CANDIDATE scope under an active SessionStateService grant too (transition() holds one): the ruling is not relaxed', async () => {
      const { tx, calls } = fakeTx(steady('OPENED'));
      await refusal(() =>
        orgContext.runAsCandidate(ORG, SID, () =>
          orgContext.withGrant(stateGrant, () => lock(tx, SID)),
        ),
      );
      expect(calls).toEqual([]);
    });

    it('TC-008 is refused in a CANDIDATE scope that was narrowed with runInOrg of the same org: the binding stays', async () => {
      const { tx, calls } = fakeTx(steady('OPENED'));
      await refusal(() =>
        orgContext.runAsCandidate(ORG, SID, () => orgContext.runInOrg(ORG, () => lock(tx, SID))),
      );
      expect(calls).toEqual([]);
    });

    it('TC-008 is refused with no scope at all, and sends nothing', async () => {
      const { tx, calls } = fakeTx(steady('OPENED'));
      const error = await refusal(() => lock(tx, SID));
      expect(error.message).toMatch(/no scope at all/);
      expect(calls).toEqual([]);
    });

    it('TC-008 the scope is refused before the client-itself check', async () => {
      const client = {
        $connect: () => Promise.resolve(),
        session: fakeTx(steady('OPENED')).tx.session,
      };
      const error = await refusal(() =>
        orgContext.runAsCandidate(ORG, SID, () =>
          // @ts-expect-error the client has $connect, so it is not a SessionLockTx
          lock(client, SID),
        ),
      );
      expect(error.message).toMatch(/CANDIDATE scope/);
    });

    it(`TC-008 a SERVICE scope (runAsSessionJob) is ${allowed.service ? 'allowed' : 'REFUSED'}`, async () => {
      const { tx, calls } = fakeTx(steady('OPENED'));
      const run = () => orgContext.runAsSessionJob(ORG, SID, () => lock(tx, SID));
      if (allowed.service) {
        await expect(run()).resolves.toBeDefined();
        expect(shape(calls)).toBe('RU');
      } else {
        const error = await refusal(run);
        expect(error.message).toMatch(/refused in a SERVICE scope/);
        expect(calls).toEqual([]);
      }
    });

    it(`TC-008 a STAFF scope (runAsUser), also under the SessionStateService grant, is ${allowed.staff ? 'allowed' : 'REFUSED'}`, async () => {
      for (const grant of [false, true]) {
        const { tx, calls } = fakeTx(steady('OPENED'));
        const run = () =>
          orgContext.runAsUser(user, () =>
            grant ? orgContext.withGrant(stateGrant, () => lock(tx, SID)) : lock(tx, SID),
          );
        if (allowed.staff) {
          await expect(run()).resolves.toBeDefined();
          expect(shape(calls)).toBe('RU');
        } else {
          const error = await refusal(run);
          expect(error.message).toMatch(/refused in a STAFF scope/);
          expect(calls).toEqual([]);
        }
      }
    });

    it(`TC-008 a plain org scope (runInOrg: no user, no session, not system), also under a grant, is ${allowed.plainOrg ? 'allowed' : 'REFUSED'}`, async () => {
      for (const grant of [false, true]) {
        const { tx, calls } = fakeTx(steady('OPENED'));
        const run = () =>
          orgContext.runInOrg(ORG, () =>
            grant ? orgContext.withGrant(stateGrant, () => lock(tx, SID)) : lock(tx, SID),
          );
        if (allowed.plainOrg) {
          await expect(run()).resolves.toBeDefined();
          expect(shape(calls)).toBe('RU');
        } else {
          const error = await refusal(run);
          expect(error.message).toMatch(/plain org scope/);
          expect(calls).toEqual([]);
        }
      }
    });
  });

  describe('lockForAccommodation in a plain runInOrg (Database B retention site; ADR 0015 section 6(b))', () => {
    it('TC-008 passes in an org scope with no user, no session, not system, in any status: ERASED is locked too, with the same same-value write', async () => {
      const { tx, calls } = fakeTx(steady('COMPLETED'));
      await expect(orgContext.runInOrg(ORG, () => lockForAccommodation(tx, SID))).resolves.toBe(
        'COMPLETED',
      );
      expect(shape(calls)).toBe('RU');
      const erased = fakeTx(steady(FAKE_ERASED));
      await expect(
        orgContext.runInOrg(ORG, () => lockForAccommodation(erased.tx, SID)),
      ).resolves.toBe('ERASED');
    });

    it('TC-008 a SERVICE caller of lockForAccommodation does not exist (R-4 has no SERVICE caller): it is refused, like CANDIDATE and system', async () => {
      const { tx, calls } = fakeTx(steady('OPENED'));
      await refusal(() =>
        orgContext.runAsSessionJob(ORG, SID, () => lockForAccommodation(tx, SID)),
      );
      await refusal(() => orgContext.runAsCandidate(ORG, SID, () => lockForAccommodation(tx, SID)));
      await refusal(() =>
        orgContext.runSystem('RETENTION_ERASURE', () => lockForAccommodation(tx, SID)),
      );
      expect(calls).toEqual([]);
    });
  });

  describe('lockAnySession is for jobs only (SERVICE): a STAFF caller does not exist, withAnySession is a job entry', () => {
    it('TC-008 a STAFF scope and a plain org scope are refused, SERVICE passes', async () => {
      const { tx, calls } = fakeTx(steady('OPENED'));
      await refusal(() => orgContext.runAsUser(user, () => lockAnySession(tx, SID)));
      await refusal(() => orgContext.runInOrg(ORG, () => lockAnySession(tx, SID)));
      expect(calls).toEqual([]);
      await expect(
        orgContext.runAsSessionJob(ORG, SID, () => lockAnySession(tx, SID)),
      ).resolves.toBe('OPENED');
    });
  });
});

describe('nesting: the STAFF and plain-org split is advisory until the ADR 0006 nesting rows are built (N-e, FU-DB-241): NFR-04, TC-008', () => {
  const orgContext = new OrgContextService();
  const user = { orgId: ORG, userId: SID, role: 'RECRUITER' } as const;

  it('TC-008 a runInOrg nested in STAFF drops the user: it is a plain org scope (ADR 0006 says the actor stays STAFF; Planned)', async () => {
    const { tx, calls } = fakeTx(steady('OPENED'));
    // guardLive passes in STAFF but is refused in the plain org scope the nesting produces today.
    await expect(
      orgContext.runAsUser(user, () => orgContext.runInOrg(ORG, () => guardLive(tx, SID))),
    ).rejects.toBeInstanceOf(OrgScopeViolationError);
    expect(calls).toEqual([]);
    // lockForAccommodation passes in both, so the nesting is invisible to it.
    await expect(
      orgContext.runAsUser(user, () =>
        orgContext.runInOrg(ORG, () => lockForAccommodation(tx, SID)),
      ),
    ).resolves.toBe('OPENED');
  });

  it('TC-008 runAsUser from a plain org scope is a STAFF scope (ADR 0006 says a plain org scope never becomes a user scope; Planned)', async () => {
    const { tx } = fakeTx(steady('OPENED'));
    await expect(
      orgContext.runInOrg(ORG, () => orgContext.runAsUser(user, () => guardLive(tx, SID))),
    ).resolves.toBe('LIVE');
    // lockAnySession is refused for STAFF, so the escalation gains nothing there.
    await expect(
      orgContext.runInOrg(ORG, () => orgContext.runAsUser(user, () => lockAnySession(tx, SID))),
    ).rejects.toBeInstanceOf(OrgScopeViolationError);
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
      await expect(
        // @ts-expect-error the client has $connect or $disconnect, so it is not a SessionLockTx
        inService(() => guardLive(client, SID)),
      ).rejects.toBeInstanceOf(OrgScopeViolationError);
      expect(calls).toEqual([]);
    },
  );

  it.each(['$connect', '$disconnect'] as const)(
    'TC-008 lockForAccommodation and lockAnySession refuse an object with %s before any statement',
    async (connection) => {
      const { client, calls } = clientItself(connection);
      await expect(
        // @ts-expect-error the client has $connect or $disconnect, so it is not a SessionLockTx
        inStaff(() => lockForAccommodation(client, SID)),
      ).rejects.toBeInstanceOf(OrgScopeViolationError);
      await expect(
        // @ts-expect-error the same for the job lock
        inService(() => lockAnySession(client, SID)),
      ).rejects.toBeInstanceOf(OrgScopeViolationError);
      expect(calls).toEqual([]);
    },
  );

  it('TC-008 the refusal names no value, and a transaction-shaped object (no $connect) is accepted', async () => {
    const { client } = clientItself('$connect');
    const error = await inService(() =>
      // @ts-expect-error not a SessionLockTx
      guardLive(client, SID),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(`${(error as Error).message}`).not.toContain(SID);
    const { tx } = fakeTx(steady('OPENED'));
    expect(Object.hasOwn(tx, '$connect') || Object.hasOwn(tx, '$disconnect')).toBe(false);
    await expect(inService(() => guardLive(tx, SID))).resolves.toBe('LIVE');
  });

  it('TC-008 the check is a heuristic (the README says so): an object that has neither method passes it, as { session: prisma.client.session } would', async () => {
    const calls: string[] = [];
    const fake = fakeTx(steady('OPENED'));
    const lookalike: SessionLockTx = {
      session: {
        findUnique: (args) => {
          calls.push('R');
          return fake.tx.session.findUnique(args);
        },
        updateMany: (args) => {
          calls.push('U');
          return fake.tx.session.updateMany(args);
        },
      },
    };
    await expect(inService(() => guardLive(lookalike, SID))).resolves.toBe('LIVE');
    expect(calls).toEqual(['R', 'U']);
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

  it('TC-008 each has a stable `code` that the ProblemFilter and busy-lock.ts can switch on (no SQLSTATE, so no 500)', () => {
    expect(new SessionNotFoundError().code).toBe('SESSION_NOT_FOUND');
    expect(new SessionLockRetryError().code).toBe('SESSION_LOCK_RETRY');
    expect(new AccommodationLockedError().code).toBe('ACCOMMODATION_LOCKED');
    expect(SESSION_LOCK_ERROR_CODES).toEqual({
      notFound: 'SESSION_NOT_FOUND',
      retry: 'SESSION_LOCK_RETRY',
      accommodationLocked: 'ACCOMMODATION_LOCKED',
    });
    expect(new Set(Object.values(SESSION_LOCK_ERROR_CODES)).size).toBe(3);
  });

  it('TC-008 S1 the code table and the three prototypes are frozen: a write or a defineProperty anywhere cannot change what every error reports', () => {
    expect(Object.isFrozen(SESSION_LOCK_ERROR_CODES)).toBe(true);
    for (const type of [SessionNotFoundError, SessionLockRetryError, AccommodationLockedError]) {
      expect({ type: type.name, frozen: Object.isFrozen(type.prototype) }).toEqual({
        type: type.name,
        frozen: true,
      });
      // The code getter cannot be replaced, redefined, shadowed on the prototype or deleted.
      expect(() => {
        Object.defineProperty(type.prototype, 'code', { get: () => 'BUSY' });
      }).toThrow(TypeError);
      expect(() => {
        (type.prototype as unknown as { code: string }).code = 'BUSY';
      }).toThrow(TypeError);
      expect(() => {
        delete (type.prototype as unknown as Record<string, unknown>)['code'];
      }).toThrow(TypeError);
      expect(() => {
        (type.prototype as unknown as Record<string, unknown>)['extra'] = 1;
      }).toThrow(TypeError);
    }
    expect(() => {
      (SESSION_LOCK_ERROR_CODES as { retry: string }).retry = 'BUSY';
    }).toThrow(TypeError);
    expect(() => {
      Object.defineProperty(SESSION_LOCK_ERROR_CODES, 'retry', { value: 'BUSY' });
    }).toThrow(TypeError);
    expect(() => {
      delete (SESSION_LOCK_ERROR_CODES as Record<string, unknown>)['notFound'];
    }).toThrow(TypeError);
    // Nothing changed.
    expect(new SessionLockRetryError().code).toBe('SESSION_LOCK_RETRY');
    expect(new SessionNotFoundError().code).toBe('SESSION_NOT_FOUND');
    expect(new AccommodationLockedError().code).toBe('ACCOMMODATION_LOCKED');
    expect(SESSION_LOCK_ERROR_CODES.retry).toBe('SESSION_LOCK_RETRY');
    // The base class and the scoping errors are not frozen by this: only the three prototypes are.
    expect(Object.isFrozen(Error.prototype)).toBe(false);
    expect(Object.isFrozen(OrgScopeError.prototype)).toBe(false);
  });

  it('TC-008 the code is read-only and not an own property: it cannot be reassigned and never shows in a serialised error', () => {
    for (const error of [
      new SessionNotFoundError(),
      new SessionLockRetryError(),
      new AccommodationLockedError(),
    ]) {
      expect(Object.hasOwn(error, 'code')).toBe(false);
      expect(() => {
        (error as { code: string }).code = 'BUSY';
      }).toThrow(TypeError);
      expect(JSON.parse(JSON.stringify(error))).toEqual({ name: error.name });
    }
  });

  it('TC-008 the real locks throw them with their codes: a lost compare-and-set gives SESSION_LOCK_RETRY or ACCOMMODATION_LOCKED, no row gives SESSION_NOT_FOUND', async () => {
    const lost = () => fakeTx(moving(['OPENED', 'CONSENTED', 'VERIFIED', 'IN_PROGRESS'])).tx;
    const codeOf = async (run: () => Promise<unknown>): Promise<unknown> => {
      const error = await run().then(
        () => undefined,
        (e: unknown) => e,
      );
      return (error as { code?: unknown }).code;
    };
    expect(await codeOf(() => inService(() => guardLive(lost(), SID)))).toBe('SESSION_LOCK_RETRY');
    expect(await codeOf(() => inService(() => lockAnySession(lost(), SID)))).toBe(
      'SESSION_LOCK_RETRY',
    );
    expect(await codeOf(() => inStaff(() => lockForAccommodation(lost(), SID)))).toBe(
      'ACCOMMODATION_LOCKED',
    );
    const none = fakeTx({ read: () => null, update: () => 1 }).tx;
    expect(await codeOf(() => inService(() => guardLive(none, SID)))).toBe('SESSION_NOT_FOUND');
    expect(await codeOf(() => inStaff(() => lockForAccommodation(none, SID)))).toBe(
      'SESSION_NOT_FOUND',
    );
  });
});
