// guardLive, lockForAccommodation and lockAnySession (ADR 0013 section 5.7, ADR 0015 section 6, ADR 0006 section 8.5)
// against a real Postgres 16 started by Testcontainers, with the real migrations applied by
// `prisma migrate deploy`. The code under test connects as app_user through the real client factory and
// the org-scope extension, so the real grants and the real scope filters are in force; fixtures and
// probes use the owner role. Synthetic data only. What is covered:
//   - the locks in a SERVICE session scope (runAsSessionJob after detachForSessionJob) and a STAFF scope
//     (runAsUser); lockForAccommodation, and ONLY it, also in a plain org job scope (runInOrg, the retention
//     jobs); the status is unchanged after the call; and the retention lock order in ONE transaction (an
//     advisory lock through runRawSql, then the sessions row lock, then invitations);
//   - another org's session, another session of the same org (in a session scope) and an unknown id:
//     SessionNotFoundError, no UPDATE sent, the row untouched, in plain runInOrg too;
//   - the refused scopes (the hub's actor allowlist): CANDIDATE scope with or without a grant, system scope,
//     no scope at all, and a plain runInOrg for guardLive and lockAnySession: OrgScopeViolationError before any
//     statement, nothing written;
//   - statement counts (pg_stat_statements): one SELECT and one UPDATE on the happy path, nothing extra;
//     and the ADR 0015 section 8 spike: the any-status locks send exactly one UPDATE;
//   - lock semantics with two connections: while a transaction holds the lock, an UPDATE of the status
//     from another connection WAITS, and a child-table insert (media_chunks, proctor_events) does NOT
//     (FOR NO KEY UPDATE against FOR KEY SHARE), in both directions; the lock mode is read from the
//     tuple with pgrowlocks;
//   - the real race: a status change that commits while the guard's UPDATE waits on the row lock is
//     seen by the re-read, and is never reverted;
//   - the retry: a status change between the read and the update (forced through a proxied tx) is
//     re-read, and three changes in a row end in the retry error with the last status untouched;
//   - ERASED against the real enum (PR #91 is on main): a row set to ERASED by the owner, guardLive writes nothing,
//     the other two lock it, the fence wins a real race, and the NOT-ERASED clause is in guardLive's UPDATE text only;
//     they skip, with the reason in their name, only against a client generated before #91.
// The logic with a fake transaction (every branch, the exact arguments) is in session-locks.spec.ts.
// Every probe has a short lock_timeout or a polling deadline, so a broken lock fails the test and never
// hangs it. FR-704, NFR-05 (erasure), NFR-04, TC-008, TC-094.
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { setCandidateFacts } from './candidate-facts';
import { createPrismaClient } from './create-prisma-client';
import {
  AccommodationLockedError,
  OrgScopeViolationError,
  SessionLockRetryError,
  SessionNotFoundError,
} from './errors';
import { OrgContextService, SYSTEM_SCOPE_REASONS } from './org-context';
import type { SystemScopeReason } from './org-context';
import { createOrgScopedClient } from './org-scope.extension';
import { guardLive, lockAnySession, lockForAccommodation } from './session-locks';
import type { SessionLockTx } from './session-locks';
import type { PrismaClient } from '../generated/prisma/client.js';
import { SessionStatus } from '../generated/prisma/enums.js';
import { startMigratedDatabase } from './testing/migrated-postgres';
import type { MigratedDatabase } from './testing/migrated-postgres';
import { createCandidateChain, createTenant } from './testing/tenant-fixtures';
import type { SessionChain, TenantFixture } from './testing/tenant-fixtures';

/** True once PR #91 (ADR 0004 section 9) has added ERASED to session_status and the client is regenerated. */
const ENUM_HAS_ERASED = Object.hasOwn(SessionStatus, 'ERASED');
const itWithErased = ENUM_HAS_ERASED ? it : it.skip;
const SKIP_NOTE =
  ' [SKIPPED: session_status has no ERASED until PR #91 (ADR 0004 section 9) merges]';

/** The statuses to cycle through. ERASED is excluded on purpose: it has its own tests. */
const ORDINARY = Object.values(SessionStatus).filter(
  (status) => (status as string) !== 'ERASED',
) as readonly SessionStatus[];

/** Probe limits: long enough for a loaded CI machine, short enough that a broken lock fails fast. */
const LOCK_TIMEOUT_MS = 400;
const POLL_DEADLINE_MS = 8000;
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

type LockFunction = (tx: SessionLockTx, sessionId: string) => Promise<unknown>;
/** The two that work in ANY status, ERASED included (they share one implementation). */
const ANY_STATUS_LOCKS: ReadonlyArray<readonly [string, LockFunction]> = [
  ['lockForAccommodation', lockForAccommodation],
  ['lockAnySession', lockAnySession],
];
const LOCKS: ReadonlyArray<readonly [string, LockFunction]> = [
  ['guardLive', guardLive],
  ['lockForAccommodation', lockForAccommodation],
  ['lockAnySession', lockAnySession],
];

describe('guardLive, lockForAccommodation and lockAnySession against Postgres (FR-704, NFR-04, TC-008)', () => {
  let db: MigratedDatabase;
  let owner: PrismaClient;
  let base: PrismaClient;
  let client: ReturnType<typeof createOrgScopedClient>;
  /** A probe connection of the owner role: reads pg_stat_activity, xmin, pgrowlocks. */
  let probe: Client;
  const orgContext = new OrgContextService();
  /** Org 1. */
  let T: TenantFixture;
  /** Org 2, another tenant. */
  let O: SessionChain;
  let counter = 0;

  /** A session of org 1 of its own, so a test can change its status freely. */
  const freshChain = (label: string): Promise<SessionChain> => {
    counter += 1;
    return createCandidateChain(owner, T, `${label}-${counter}`);
  };

  // ---- the scopes the callers use -----------------------------------------------------------
  const asService = <R>(chain: SessionChain, fn: () => Promise<R>): Promise<R> =>
    orgContext.detachForSessionJob(() =>
      orgContext.runAsSessionJob(chain.orgId, chain.sessionId, fn),
    );
  const asStaff = <R>(orgId: string, fn: () => Promise<R>): Promise<R> =>
    orgContext.runAsUser({ orgId, userId: T.userId, role: 'RECRUITER' }, fn);
  const asOrg = <R>(orgId: string, fn: () => Promise<R>): Promise<R> =>
    orgContext.runInOrg(orgId, fn);
  /**
   * The scope a lock passes in (the merged ADR 0006 section 8.5): lockForAccommodation in STAFF, guardLive and
   * lockAnySession in SERVICE (guardLive passes in STAFF too, which has its own tests).
   */
  const asHome = <R>(lock: LockFunction, chain: SessionChain, fn: () => Promise<R>): Promise<R> =>
    lock === lockForAccommodation ? asStaff(chain.orgId, fn) : asService(chain, fn);
  const asCandidate = <R>(chain: SessionChain, fn: () => Promise<R>): Promise<R> =>
    orgContext.runAsCandidate(chain.orgId, chain.sessionId, async () => {
      setCandidateFacts(orgContext, {
        candidateId: chain.candidateId,
        invitationId: chain.invitationId,
        testId: chain.testId,
      });
      return fn();
    });

  /** The call, as a caller makes it: the first statement of an interactive transaction. */
  const lockIn = <R>(lock: LockFunction, sessionId: string): Promise<R> =>
    client.$transaction((tx) => lock(tx, sessionId) as Promise<R>, TX_OPTIONS);

  // ---- probes ---------------------------------------------------------------------------------
  const statusOf = async (id: string): Promise<string> => {
    const { rows } = await probe.query<{ status: string }>(
      'SELECT status::text AS status FROM sessions WHERE id = $1::uuid',
      [id],
    );
    return (rows[0] as { status: string }).status;
  };
  /** xmin changes with every write to the row, a same-value UPDATE included: "nothing written" is "xmin the same". */
  const xminOf = async (id: string): Promise<string> => {
    const { rows } = await probe.query<{ x: string }>(
      'SELECT xmin::text AS x FROM sessions WHERE id = $1::uuid',
      [id],
    );
    return (rows[0] as { x: string }).x;
  };
  const setStatus = async (id: string, status: string): Promise<void> => {
    await probe.query('UPDATE sessions SET status = $2::session_status WHERE id = $1::uuid', [
      id,
      status,
    ]);
  };

  interface Counts {
    readonly select: number;
    readonly update: number;
    readonly insert: number;
    /** Every other statement text: BEGIN and COMMIT of the transaction, and nothing else is expected. */
    readonly other: string[];
    readonly updateTexts: string[];
  }
  const counts = async (): Promise<Counts> => {
    const rows = await db.statements.read();
    const sum = (re: RegExp): number =>
      rows.filter((r) => re.test(r.query)).reduce((n, r) => n + r.calls, 0);
    return {
      select: sum(/^\s*SELECT/i),
      update: sum(/^\s*UPDATE/i),
      insert: sum(/^\s*INSERT/i),
      other: rows
        .filter((r) => !/^\s*(SELECT|UPDATE|INSERT)/i.test(r.query))
        .map((r) => r.query.trim().toUpperCase()),
      updateTexts: rows.filter((r) => /^\s*UPDATE/i.test(r.query)).map((r) => r.query),
    };
  };
  /** `other` holds only the transaction's own BEGIN and COMMIT. */
  const onlyBeginAndCommit = (other: readonly string[]): boolean =>
    other.every((q) => q === 'BEGIN' || q === 'COMMIT');

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** Polls pg_stat_activity until some backend is waiting on a lock in a statement that matches `text`. */
  async function waitUntilBlocked(text: string): Promise<void> {
    const deadline = Date.now() + POLL_DEADLINE_MS;
    while (Date.now() < deadline) {
      const { rows } = await probe.query(
        `SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database() AND usename = 'app_user' AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock' AND query LIKE $1`,
        [`%${text}%`],
      );
      if (rows.length > 0) return;
      await sleep(25);
    }
    throw new Error('no backend ever waited on a lock: the lock did not block');
  }

  /** A connection as app_user, closed when `fn` ends. */
  async function asAppUser<R>(fn: (connection: Client) => Promise<R>): Promise<R> {
    const connection = new Client({ connectionString: db.appUserUrl });
    await connection.connect();
    try {
      return await fn(connection);
    } finally {
      await connection.end();
    }
  }
  const lockTimeout = (connection: Client): Promise<unknown> =>
    connection.query(`SET lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);

  /**
   * A transaction that takes `lock` on the session and holds it until `release()`. `held` resolves once
   * the lock is taken (and rejects if taking it failed), `done` when the transaction has committed.
   */
  async function hold(
    chain: SessionChain,
    lock: LockFunction,
  ): Promise<{ result: Promise<unknown>; release: () => Promise<unknown> }> {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let taken!: () => void;
    const held = new Promise<void>((resolve) => {
      taken = resolve;
    });
    const result = asHome(lock, chain, () =>
      client.$transaction(async (tx) => {
        const outcome = await lock(tx, chain.sessionId);
        taken();
        await gate;
        return outcome;
      }, TX_OPTIONS),
    );
    // If the lock call fails, `result` rejects and the race rejects with it: the test fails, it does not hang.
    await Promise.race([held, result]);
    return {
      result,
      release: () => {
        open();
        return result;
      },
    };
  }

  beforeAll(async () => {
    db = await startMigratedDatabase({ statementStats: true });
    owner = createPrismaClient(db.ownerUrl);
    T = await createTenant(owner, 'lk');
    O = (await createTenant(owner, 'lo')).chain;
    base = createPrismaClient(db.appUserUrl);
    client = createOrgScopedClient(base, orgContext);
    probe = new Client({ connectionString: db.ownerUrl });
    await probe.connect();
    await probe.query('CREATE EXTENSION IF NOT EXISTS pgrowlocks');
  }, 180_000);

  afterAll(async () => {
    await probe?.end();
    await base?.$disconnect();
    await owner?.$disconnect();
    await db?.stop();
  });

  // ================================================================================================
  describe('guardLive: the happy path in every scope that may call it', () => {
    it('TC-008 the real transaction client fits SessionLockTx, and a SERVICE writer gets LIVE with the status unchanged', async () => {
      const chain = await freshChain('svc');
      for (const status of ORDINARY) {
        await setStatus(chain.sessionId, status);
        const result = await asService(chain, () => lockIn<string>(guardLive, chain.sessionId));
        expect({ status, result }).toEqual({ status, result: 'LIVE' });
        expect(await statusOf(chain.sessionId)).toBe(status);
      }
    });

    it('TC-008 a STAFF scope (the proctor-resume route) gets LIVE with the status unchanged', async () => {
      const chain = await freshChain('staff');
      await setStatus(chain.sessionId, 'PAUSED');
      const result = await asStaff(chain.orgId, () => lockIn<string>(guardLive, chain.sessionId));
      expect(result).toBe('LIVE');
      expect(await statusOf(chain.sessionId)).toBe('PAUSED');
    });

    it('TC-008 the write really happens: the row is locked and rewritten (xmin moves), with the same value', async () => {
      const chain = await freshChain('xmin');
      const before = await xminOf(chain.sessionId);
      await asService(chain, () => lockIn(guardLive, chain.sessionId));
      expect(await xminOf(chain.sessionId)).not.toBe(before);
      expect(await statusOf(chain.sessionId)).toBe('INVITED');
    });
  });

  // ================================================================================================
  describe.each(ANY_STATUS_LOCKS)('%s: the happy path in the scope it passes in', (_name, lock) => {
    it('TC-008 returns the status it read under the lock, for every status, and leaves it unchanged', async () => {
      const chain = await freshChain('acc');
      for (const status of ORDINARY) {
        await setStatus(chain.sessionId, status);
        const result = await asHome(lock, chain, () => lockIn<string>(lock, chain.sessionId));
        expect({ status, result }).toEqual({ status, result: status });
        expect(await statusOf(chain.sessionId)).toBe(status);
      }
    });
  });

  // ================================================================================================
  // The locks that run in a STAFF scope (guardLive, lockForAccommodation): lockAnySession has no STAFF scope, and is
  // not in this table (its other-org case is the SERVICE one below).
  describe.each(LOCKS.filter(([, lock]) => lock !== lockAnySession))(
    "%s: another org's session in a STAFF scope",
    (_name, lock) => {
      it('TC-008 throws SessionNotFoundError, sends no UPDATE and leaves the row untouched (STAFF scope, and the plain org scope for lockForAccommodation)', async () => {
        const before = await xminOf(O.sessionId);
        const statusBefore = await statusOf(O.sessionId);
        // lockForAccommodation also runs in a plain org job scope (hub ruling): another org's session reads
        // no row there either, so it never locks a row of another org.
        const runs: Array<<R>(orgId: string, fn: () => Promise<R>) => Promise<R>> =
          lock === lockForAccommodation ? [asStaff, asOrg] : [asStaff];
        expect(runs.length).toBeGreaterThan(0);
        for (const run of runs) {
          await db.statements.reset();
          await expect(run(T.orgId, () => lockIn(lock, O.sessionId))).rejects.toBeInstanceOf(
            SessionNotFoundError,
          );
          const c = await counts();
          expect(c.update).toBe(0);
          expect(c.select).toBe(1);
        }
        expect(await xminOf(O.sessionId)).toBe(before);
        expect(await statusOf(O.sessionId)).toBe(statusBefore);
      });
    },
  );

  // The locks that run in a SERVICE session scope (guardLive, lockAnySession): lockForAccommodation is refused there.
  describe.each(LOCKS.filter(([, lock]) => lock !== lockForAccommodation))(
    "%s: another session's id in a SERVICE session scope",
    (_name, lock) => {
      it("TC-008 another session's id (same org, or another org) and an unknown id are not found", async () => {
        const mine = await freshChain('scope-mine');
        const other = await freshChain('scope-other');
        const before = { other: await xminOf(other.sessionId), org2: await xminOf(O.sessionId) };
        for (const id of [other.sessionId, O.sessionId, randomUUID()]) {
          await db.statements.reset();
          await expect(asService(mine, () => lockIn(lock, id))).rejects.toBeInstanceOf(
            SessionNotFoundError,
          );
          expect((await counts()).update).toBe(0);
        }
        expect(await xminOf(other.sessionId)).toBe(before.other);
        expect(await xminOf(O.sessionId)).toBe(before.org2);
      });
    },
  );

  // ================================================================================================
  describe.each(LOCKS)('%s: a session that is not in its scope', (_name, lock) => {
    it('TC-008 an unknown id throws SessionNotFoundError and sends no UPDATE', async () => {
      const chain = await freshChain('unknown');
      await db.statements.reset();
      await expect(asHome(lock, chain, () => lockIn(lock, randomUUID()))).rejects.toBeInstanceOf(
        SessionNotFoundError,
      );
      const c = await counts();
      expect({ select: c.select, update: c.update }).toEqual({ select: 1, update: 0 });
    });

    it('TC-008 the error message carries no id', async () => {
      const mine = await freshChain('msg');
      const error = await asHome(lock, mine, () => lockIn(lock, O.sessionId)).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SessionNotFoundError);
      const text = `${(error as Error).message} ${(error as Error).stack ?? ''}`;
      expect(text).not.toContain(O.sessionId);
      expect(text).not.toContain(mine.orgId);
    });

    it('TC-008 no scope at all is refused by the lock itself, before any statement', async () => {
      const chain = await freshChain('noscope');
      const xmin = await xminOf(chain.sessionId);
      await db.statements.reset();
      const error = await lockIn(lock, chain.sessionId).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(OrgScopeViolationError);
      expect((error as Error).message).toMatch(/no scope at all/);
      const c = await counts();
      expect({ select: c.select, update: c.update }).toEqual({ select: 0, update: 0 });
      expect(await xminOf(chain.sessionId)).toBe(xmin);
    });
  });

  // ================================================================================================
  describe.each(LOCKS)(
    '%s: refused scopes fail closed before any statement (hub rulings)',
    (_name, lock) => {
      /** What SessionStateService.transition() enters in a CANDIDATE scope: the status columns, this session. */
      const stateGrant = (chain: SessionChain) => ({
        model: 'Session',
        columns: ['status', 'pauseReasons', 'submittedAt'],
        ids: [chain.sessionId],
      });
      /** Runs `run`, expects an OrgScopeViolationError that matches `pattern` and names no value, and that nothing was sent or written. */
      async function expectRefused(
        chain: SessionChain,
        pattern: RegExp,
        run: () => Promise<unknown>,
      ): Promise<void> {
        const xmin = await xminOf(chain.sessionId);
        const status = await statusOf(chain.sessionId);
        await db.statements.reset();
        const error = await run().then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(OrgScopeViolationError);
        expect((error as Error).message).toMatch(pattern);
        const text = `${(error as Error).message} ${(error as Error).stack ?? ''}`;
        expect(text).not.toContain(chain.sessionId);
        expect(text).not.toContain(chain.orgId);
        // Refused by the lock itself: no SELECT and no UPDATE reached Postgres, and the row was not rewritten.
        const c = await counts();
        expect({ select: c.select, update: c.update }).toEqual({ select: 0, update: 0 });
        expect(await xminOf(chain.sessionId)).toBe(xmin);
        expect(await statusOf(chain.sessionId)).toBe(status);
      }

      it('TC-008 a CANDIDATE scope is refused, with no grant: candidate paths use transition()', async () => {
        const chain = await freshChain('cand');
        await setStatus(chain.sessionId, 'IN_PROGRESS');
        await expectRefused(chain, /CANDIDATE scope/, () =>
          asCandidate(chain, () => lockIn(lock, chain.sessionId)),
        );
      });

      it('TC-008 a CANDIDATE scope is refused under an active SessionStateService grant too, for its own session or another: the ruling is not relaxed', async () => {
        const chain = await freshChain('cand2');
        const other = await freshChain('cand3');
        await expectRefused(chain, /CANDIDATE scope/, () =>
          asCandidate(chain, () =>
            orgContext.withGrant(stateGrant(chain), () => lockIn(lock, chain.sessionId)),
          ),
        );
        await expectRefused(chain, /CANDIDATE scope/, () =>
          asCandidate(chain, () =>
            orgContext.withGrant(stateGrant(other), () => lockIn(lock, chain.sessionId)),
          ),
        );
      });

      it('TC-008 system scope is refused, whatever the reason: it has no org filter', async () => {
        const chain = await freshChain('sys');
        for (const reason of Object.keys(SYSTEM_SCOPE_REASONS) as SystemScopeReason[]) {
          await expectRefused(chain, /system scope/, () =>
            orgContext.runSystem(reason, () => lockIn(lock, chain.sessionId)),
          );
        }
      });
    },
  );

  // ================================================================================================
  describe('the scopes each lock passes in (the merged ADR 0006 section 8.5): the others are refused before any statement', () => {
    /** Runs `run`, expects an OrgScopeViolationError that matches `pattern`, and that nothing was sent or written. */
    async function expectRefusedHere(
      chain: SessionChain,
      pattern: RegExp,
      run: () => Promise<unknown>,
    ): Promise<void> {
      const xmin = await xminOf(chain.sessionId);
      await db.statements.reset();
      const error = await run().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(OrgScopeViolationError);
      expect((error as Error).message).toMatch(pattern);
      expect(`${(error as Error).message}`).not.toContain(chain.sessionId);
      const c = await counts();
      expect({ select: c.select, update: c.update }).toEqual({ select: 0, update: 0 });
      expect(await xminOf(chain.sessionId)).toBe(xmin);
    }

    it.each([
      ['guardLive', guardLive],
      ['lockAnySession', lockAnySession],
    ] as const)(
      'TC-008 %s is refused in a plain runInOrg before any statement',
      async (_name, lock) => {
        const chain = await freshChain('plain');
        await expectRefusedHere(chain, /plain org scope/, () =>
          asOrg(chain.orgId, () => lockIn(lock, chain.sessionId)),
        );
      },
    );

    it('TC-008 lockAnySession is refused in a STAFF scope: it is a job lock (SERVICE only), withAnySession is a job entry', async () => {
      const chain = await freshChain('anystaff');
      await expectRefusedHere(chain, /refused in a STAFF scope/, () =>
        asStaff(chain.orgId, () => lockIn(lockAnySession, chain.sessionId)),
      );
    });

    it('TC-008 lockForAccommodation is refused in a SERVICE session scope: R-4 has no SERVICE caller and none may be added', async () => {
      const chain = await freshChain('accservice');
      await expectRefusedHere(chain, /refused in a SERVICE scope/, () =>
        asService(chain, () => lockIn(lockForAccommodation, chain.sessionId)),
      );
    });

    it('TC-008 guardLive passes in SERVICE and in STAFF (the proctor-resume method)', async () => {
      const chain = await freshChain('guardboth');
      expect(await asService(chain, () => lockIn<string>(guardLive, chain.sessionId))).toBe('LIVE');
      expect(await asStaff(chain.orgId, () => lockIn<string>(guardLive, chain.sessionId))).toBe(
        'LIVE',
      );
    });

    it('TC-008 lockForAccommodation passes in a plain runInOrg, in any status, and leaves the status unchanged', async () => {
      const chain = await freshChain('plain2');
      for (const status of ORDINARY) {
        await setStatus(chain.sessionId, status);
        const result = await asOrg(chain.orgId, () =>
          lockIn<string>(lockForAccommodation, chain.sessionId),
        );
        expect({ status, result }).toEqual({ status, result: status });
        expect(await statusOf(chain.sessionId)).toBe(status);
      }
    });

    it('TC-008 lockForAccommodation in a plain runInOrg sends 1 SELECT and 1 UPDATE, with the org filter in both', async () => {
      const chain = await freshChain('plain3');
      await db.statements.reset();
      await asOrg(chain.orgId, () => lockIn(lockForAccommodation, chain.sessionId));
      const c = await counts();
      expect({ select: c.select, update: c.update }).toEqual({ select: 1, update: 1 });
      expect(onlyBeginAndCommit(c.other)).toBe(true);
      expect(c.updateTexts[0]).toContain('"org_id" = $4');
    });

    it("TC-008 another org's session in a plain runInOrg reads no row: SessionNotFoundError, no UPDATE, the row untouched (the job's own query gives the id, the org filter does the rest)", async () => {
      const xmin = await xminOf(O.sessionId);
      await db.statements.reset();
      await expect(
        asOrg(T.orgId, () => lockIn(lockForAccommodation, O.sessionId)),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
      const c = await counts();
      expect({ select: c.select, update: c.update }).toEqual({ select: 1, update: 0 });
      expect(await xminOf(O.sessionId)).toBe(xmin);
    });

    it('TC-008 retention lock order in ONE transaction: the advisory lock (raw SQL, org scope), then the sessions row lock (lockForAccommodation), then invitations', async () => {
      const chain = await freshChain('retention');
      const key = `retention:${chain.candidateId}`;
      const held = await asOrg(chain.orgId, () =>
        client.$transaction(async (tx) => {
          // 1. the ADR 0004 per-candidate advisory lock: raw SQL, so it needs runRawSql, and a session scope would refuse it.
          await orgContext.runRawSql(
            'retention advisory lock of one candidate (test)',
            () =>
              tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS locked`,
          );
          // 2. the sessions row lock, through the model API, in the same transaction.
          const status = await lockForAccommodation(tx, chain.sessionId);
          // 3. invitations, after the sessions lock (a same-value write stands for the accommodations compare-and-set).
          const invitation = await tx.invitation.findUnique({
            where: { id: chain.invitationId },
            select: { windowStart: true },
          });
          const written = await tx.invitation.updateMany({
            where: { id: chain.invitationId },
            data: { windowStart: invitation?.windowStart as Date },
          });
          const locks = await orgContext.runRawSql(
            "read this backend's advisory locks (test)",
            () =>
              tx.$queryRaw<Array<{ n: number }>>`
              SELECT count(*)::int AS n FROM pg_locks
              WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
          );
          return { status, written: written.count, advisory: locks[0]?.n };
        }, TX_OPTIONS),
      );
      expect(held).toEqual({ status: 'INVITED', written: 1, advisory: 1 });
      // Everything was released with the transaction.
      const { rows } = await probe.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'",
      );
      expect(rows[0]?.n).toBe(0);
    });
  });

  // ================================================================================================
  describe.each(LOCKS)('%s: grants (ADR 0013 CS-4.4, CS-4 PR 2): FU-DB-232', (_name, lock) => {
    /** What SessionStateService.transition() enters: the status columns, this session. */
    const stateGrant = (chain: SessionChain) => ({
      model: 'Session',
      columns: ['status', 'pauseReasons', 'submittedAt'],
      ids: [chain.sessionId],
    });

    it('TC-008 the scopes a lock passes in need no grant for the same-value status write, and an active grant changes nothing', async () => {
      const chain = await freshChain('grant1');
      const runs: Array<(fn: () => Promise<unknown>) => Promise<unknown>> = [];
      if (lock !== lockForAccommodation) runs.push((fn) => asService(chain, fn)); // SERVICE: not for lockForAccommodation
      if (lock !== lockAnySession) runs.push((fn) => asStaff(chain.orgId, fn)); // STAFF: not for lockAnySession
      for (const run of runs) {
        const plain = await run(() => lockIn<string>(lock, chain.sessionId));
        const granted = await run(() =>
          orgContext.withGrant(stateGrant(chain), () => lockIn<string>(lock, chain.sessionId)),
        );
        expect(granted).toBe(plain);
      }
      expect(await statusOf(chain.sessionId)).toBe('INVITED');
    });
  });

  // ================================================================================================
  describe.each(LOCKS)('%s: the client itself is not a transaction client', (_name, lock) => {
    it('TC-008 is refused before any statement: outside a transaction the lock would be released at once', async () => {
      const chain = await freshChain('notx');
      const xmin = await xminOf(chain.sessionId);
      await db.statements.reset();
      await expect(
        asHome(lock, chain, () =>
          // @ts-expect-error the client has $connect, so it is not a SessionLockTx: this does not compile
          lock(client, chain.sessionId),
        ),
      ).rejects.toBeInstanceOf(OrgScopeViolationError);
      expect(await db.statements.read()).toEqual([]);
      expect(await xminOf(chain.sessionId)).toBe(xmin);
    });
  });

  // ================================================================================================
  describe('statement counts (pg_stat_statements): nothing extra', () => {
    it('TC-008 guardLive on the happy path sends exactly 1 SELECT and 1 UPDATE inside BEGIN and COMMIT', async () => {
      const chain = await freshChain('count-g');
      await db.statements.reset();
      await asService(chain, () => lockIn(guardLive, chain.sessionId));
      const c = await counts();
      expect({ select: c.select, update: c.update, insert: c.insert }).toEqual({
        select: 1,
        update: 1,
        insert: 0,
      });
      expect(onlyBeginAndCommit(c.other)).toBe(true);
    });

    it('TC-008 guardLive sends the same two statements in a STAFF scope', async () => {
      const chain = await freshChain('count-so');
      await db.statements.reset();
      await asStaff(chain.orgId, () => lockIn(guardLive, chain.sessionId));
      const c = await counts();
      expect({ select: c.select, update: c.update }).toEqual({ select: 1, update: 1 });
      expect(onlyBeginAndCommit(c.other)).toBe(true);
    });

    it.each(ANY_STATUS_LOCKS)(
      'TC-008 ADR 0015 section 8 spike: %s under Prisma 7 sends exactly 1 SELECT and 1 UPDATE, and the UPDATE touches `status` only',
      async (_name, lock) => {
        const chain = await freshChain('count-a');
        await db.statements.reset();
        await asHome(lock, chain, () => lockIn(lock, chain.sessionId));
        const c = await counts();
        expect({ select: c.select, update: c.update, insert: c.insert }).toEqual({
          select: 1,
          update: 1,
          insert: 0,
        });
        expect(onlyBeginAndCommit(c.other)).toBe(true);
        // One UPDATE of one column: `status` is the only column in the SET list (`sessions` has no
        // updated_at), and it has no RETURNING. Prisma casts the enum parameters, so the text is not `= $1`.
        expect(c.updateTexts).toHaveLength(1);
        const text = c.updateTexts[0] as string;
        expect(text).toMatch(
          /^UPDATE "public"\."sessions" SET "status" = CAST\(\$1::text AS "public"\."session_status"\) WHERE /,
        );
        expect(text).not.toMatch(/RETURNING/i);
        // The where is the compare-and-set: the row, the status that was read, and the org from the scope.
        expect(text).toMatch(
          /"sessions"\."id" = \$2 AND "public"\."sessions"\."status" = CAST\(\$3::text /,
        );
        expect(text).toContain('"org_id" = $4');
      },
    );

    it('TC-008 a lost compare-and-set adds exactly one re-read and one more UPDATE: 2 SELECT and 2 UPDATE', async () => {
      const chain = await freshChain('count-r');
      await db.statements.reset();
      await asService(chain, () =>
        client.$transaction(async (tx) => {
          const changeAfterFirstRead = afterReads(tx, async (n) => {
            if (n === 0) await setStatus(chain.sessionId, 'OPENED');
          });
          return guardLive(changeAfterFirstRead, chain.sessionId);
        }, TX_OPTIONS),
      );
      const c = await counts();
      expect({ select: c.select, update: c.update }).toEqual({ select: 2, update: 2 });
    });
  });

  /**
   * A transaction client that runs `hook(n)` right after the n-th read (from 0), outside the
   * transaction and committed: another transaction changes the status between the read and the write.
   */
  function afterReads(tx: SessionLockTx, hook: (n: number) => Promise<void>): SessionLockTx {
    let reads = 0;
    return {
      session: {
        findUnique: async (args) => {
          const row = await tx.session.findUnique(args);
          const n = reads;
          reads += 1;
          await hook(n);
          return row;
        },
        updateMany: (args) => tx.session.updateMany(args),
      },
    };
  }

  // ================================================================================================
  describe.each(LOCKS)(
    '%s: lock semantics with two connections (FOR NO KEY UPDATE)',
    (_name, lock) => {
      it('TC-008 while the lock is held, an UPDATE of the status from another connection WAITS (lock_timeout fires)', async () => {
        const chain = await freshChain('wait');
        const holder = await hold(chain, lock);
        try {
          await asAppUser(async (t2) => {
            await lockTimeout(t2);
            await expect(
              t2.query('UPDATE sessions SET status = $2::session_status WHERE id = $1::uuid', [
                chain.sessionId,
                'OPENED',
              ]),
            ).rejects.toMatchObject({ code: '55P03' }); // lock_not_available
          });
        } finally {
          await holder.release();
        }
        // The lock is gone with the commit: the same UPDATE now goes through.
        await setStatus(chain.sessionId, 'OPENED');
        expect(await statusOf(chain.sessionId)).toBe('OPENED');
      }, 60_000);

      it('TC-008 while the lock is held, an UPDATE waits and then proceeds once the transaction commits (it was blocked, not refused)', async () => {
        const chain = await freshChain('wait2');
        const holder = await hold(chain, lock);
        let blocked: Promise<unknown> | undefined;
        let finished = false;
        const t2 = new Client({ connectionString: db.appUserUrl });
        await t2.connect();
        try {
          blocked = t2
            .query('UPDATE sessions SET status = $2::session_status WHERE id = $1::uuid', [
              chain.sessionId,
              'EXPIRED',
            ])
            .then(() => {
              finished = true;
            });
          await waitUntilBlocked('UPDATE sessions SET status');
          expect(finished).toBe(false);
          await holder.release();
          await blocked;
          expect(finished).toBe(true);
          expect(await statusOf(chain.sessionId)).toBe('EXPIRED');
        } finally {
          await holder.release().catch(() => undefined);
          await blocked?.catch(() => undefined);
          await t2.end();
        }
      }, 60_000);

      it('TC-008 while the lock is held, a child-table insert (media_chunks, proctor_events) does NOT wait: FOR KEY SHARE does not conflict', async () => {
        const chain = await freshChain('child');
        const holder = await hold(chain, lock);
        try {
          await asAppUser(async (t2) => {
            await lockTimeout(t2);
            // Control: the lock really is held, an UPDATE of the same row is refused within the timeout.
            await expect(
              t2.query('UPDATE sessions SET status = $2::session_status WHERE id = $1::uuid', [
                chain.sessionId,
                'OPENED',
              ]),
            ).rejects.toMatchObject({ code: '55P03' });
            // The inserts take FOR KEY SHARE on the session row through the foreign key: no wait, no error.
            await t2.query(
              `INSERT INTO media_chunks (session_id, stream, seq, started_at, duration_ms)
             VALUES ($1::uuid, 'WEBCAM', 77, now(), 5000)`,
              [chain.sessionId],
            );
            await t2.query(
              `INSERT INTO proctor_events (session_id, type, severity, occurred_at)
             VALUES ($1::uuid, 'TAB_SWITCH', 'LOW', now())`,
              [chain.sessionId],
            );
          });
        } finally {
          await holder.release();
        }
        const { rows } = await probe.query<{ c: number }>(
          `SELECT (SELECT count(*) FROM media_chunks WHERE session_id = $1::uuid AND seq = 77)::int
              + (SELECT count(*) FROM proctor_events WHERE session_id = $1::uuid AND batch_seq IS NULL)::int AS c`,
          [chain.sessionId],
        );
        expect(rows[0]?.c).toBe(2);
      }, 60_000);

      it('TC-008 the other direction: an open child-table insert (FOR KEY SHARE held) does not make the lock wait', async () => {
        const chain = await freshChain('child2');
        await asAppUser(async (t2) => {
          await t2.query('BEGIN');
          try {
            await t2.query(
              `INSERT INTO media_chunks (session_id, stream, seq, started_at, duration_ms)
             VALUES ($1::uuid, 'AUDIO', 78, now(), 5000)`,
              [chain.sessionId],
            );
            // The insert is uncommitted and holds KEY SHARE on the session row. The lock call completes anyway.
            let timer: NodeJS.Timeout | undefined;
            const stillWaiting = new Promise<string>((resolve) => {
              timer = setTimeout(() => resolve('STILL WAITING'), 5000);
            });
            try {
              const outcome = await Promise.race([
                asHome(lock, chain, () => lockIn<string>(lock, chain.sessionId)),
                stillWaiting,
              ]);
              expect(outcome).not.toBe('STILL WAITING');
            } finally {
              clearTimeout(timer);
            }
          } finally {
            await t2.query('ROLLBACK');
          }
        });
      }, 60_000);

      it('TC-008 the tuple lock mode is "No Key Update" (pgrowlocks), not "Update": that is why child inserts are not stalled', async () => {
        const chain = await freshChain('mode');
        const holder = await hold(chain, lock);
        try {
          const { rows: ctid } = await probe.query<{ c: string }>(
            'SELECT ctid::text AS c FROM sessions WHERE id = $1::uuid',
            [chain.sessionId],
          );
          const { rows } = await probe.query<{ modes: string[] }>(
            `SELECT modes FROM pgrowlocks('public.sessions') WHERE locked_row::text = $1`,
            [ctid[0]?.c],
          );
          expect(rows).toHaveLength(1);
          expect(rows[0]?.modes).toEqual(['No Key Update']);
        } finally {
          await holder.release();
        }
      }, 60_000);

      it('TC-008 the lock is on the row, not the table: another session of the same org is not blocked', async () => {
        const chain = await freshChain('row1');
        const other = await freshChain('row2');
        const holder = await hold(chain, lock);
        try {
          await asAppUser(async (t2) => {
            await lockTimeout(t2);
            await t2.query('UPDATE sessions SET status = $2::session_status WHERE id = $1::uuid', [
              other.sessionId,
              'OPENED',
            ]);
          });
        } finally {
          await holder.release();
        }
        expect(await statusOf(other.sessionId)).toBe('OPENED');
      }, 60_000);

      it('TC-008 two callers of the lock on one session are serialised: the second waits for the first to commit', async () => {
        const chain = await freshChain('serial');
        const holder = await hold(chain, lock);
        let second: Promise<string> | undefined;
        let secondDone = false;
        try {
          second = asHome(lock, chain, () => lockIn<string>(lock, chain.sessionId)).then((r) => {
            secondDone = true;
            return r;
          });
          await waitUntilBlocked('UPDATE "public"."sessions"');
          expect(secondDone).toBe(false);
        } finally {
          await holder.release();
        }
        expect(await second).toBe(lock === guardLive ? 'LIVE' : 'INVITED');
      }, 60_000);
    },
  );

  // ================================================================================================
  describe.each(LOCKS)(
    '%s: a status change forced between the read and the update',
    (name, lock) => {
      const expectedOn = (status: string): string => (name === 'guardLive' ? 'LIVE' : status);

      it('TC-008 the compare-and-set loses (0 rows), the re-read sees the new status, and the lock is taken on THAT status: never reverted', async () => {
        const chain = await freshChain('retry1');
        await setStatus(chain.sessionId, 'INVITED');
        const result = await asHome(lock, chain, () =>
          client.$transaction(
            (tx) =>
              lock(
                afterReads(tx, async (n) => {
                  if (n === 0) await setStatus(chain.sessionId, 'OPENED');
                }),
                chain.sessionId,
              ),
            TX_OPTIONS,
          ),
        );
        expect(result).toBe(expectedOn('OPENED'));
        // The same-value write named the status it had read, so the concurrent change was not undone.
        expect(await statusOf(chain.sessionId)).toBe('OPENED');
      });

      it('TC-008 two changes in a row are still handled: the third try wins', async () => {
        const chain = await freshChain('retry2');
        const steps = ['OPENED', 'CONSENTED'];
        const result = await asHome(lock, chain, () =>
          client.$transaction(
            (tx) =>
              lock(
                afterReads(tx, async (n) => {
                  const next = steps[n];
                  if (next !== undefined) await setStatus(chain.sessionId, next);
                }),
                chain.sessionId,
              ),
            TX_OPTIONS,
          ),
        );
        expect(result).toBe(expectedOn('CONSENTED'));
        expect(await statusOf(chain.sessionId)).toBe('CONSENTED');
      });

      it('TC-008 three changes in a row end in the retry error after exactly 3 UPDATEs, and the last concurrent status stands', async () => {
        const chain = await freshChain('retry3');
        const steps = ['OPENED', 'CONSENTED', 'VERIFIED'];
        await db.statements.reset();
        const error = await asHome(lock, chain, () =>
          client.$transaction(
            (tx) =>
              lock(
                afterReads(tx, async (n) => {
                  const next = steps[n];
                  if (next !== undefined) await setStatus(chain.sessionId, next);
                }),
                chain.sessionId,
              ),
            TX_OPTIONS,
          ),
        ).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(
          name === 'lockForAccommodation' ? AccommodationLockedError : SessionLockRetryError,
        );
        // 1 read + 3 re-reads... the hook's own writes use the probe (owner) connection, not counted here.
        const c = await counts();
        expect({ select: c.select, update: c.update }).toEqual({ select: 4, update: 3 });
        expect(await statusOf(chain.sessionId)).toBe('VERIFIED');
        expect(`${(error as Error).message}`).not.toContain(chain.sessionId);
      });
    },
  );

  // ================================================================================================
  describe('the real race: a status change commits while the UPDATE waits on the row lock', () => {
    it.each(LOCKS)(
      'TC-008 %s: the change that commits first is re-read and kept, the guard locks the new status',
      async (name, lock) => {
        const chain = await freshChain('race');
        const racer = new Client({ connectionString: db.ownerUrl });
        await racer.connect();
        let pending: Promise<unknown> | undefined;
        try {
          await racer.query('BEGIN');
          await racer.query(
            "UPDATE sessions SET status = 'EXPIRED'::session_status WHERE id = $1::uuid",
            [chain.sessionId],
          );
          await db.statements.reset();
          pending = asHome(lock, chain, () => lockIn(lock, chain.sessionId));
          // The read does not block (MVCC), the UPDATE does: it waits on the racer's row lock.
          await waitUntilBlocked('UPDATE "public"."sessions"');
          await racer.query('COMMIT');
          expect(await pending).toBe(name === 'guardLive' ? 'LIVE' : 'EXPIRED');
        } finally {
          await racer.query('ROLLBACK').catch(() => undefined);
          await racer.end();
          await pending?.catch(() => undefined);
        }
        expect(await statusOf(chain.sessionId)).toBe('EXPIRED');
        // The read saw INVITED, the UPDATE found 0 rows after the wait, the re-read saw EXPIRED, then 1 row.
        const c = await counts();
        expect({ select: c.select, update: c.update }).toEqual({ select: 2, update: 2 });
      },
      60_000,
    );
  });

  // ================================================================================================
  describe('ERASED against the real enum (PR #91, ADR 0004 section 9)', () => {
    const setErased = (id: string): Promise<unknown> =>
      probe.query("UPDATE sessions SET status = 'ERASED'::session_status WHERE id = $1::uuid", [
        id,
      ]);

    itWithErased(
      `NFR-05 TC-094 the NOT-ERASED clause is in guardLive's UPDATE text, and in no other lock's${ENUM_HAS_ERASED ? '' : SKIP_NOTE}`,
      async () => {
        const g = await freshChain('erasedtext1');
        await db.statements.reset();
        await asService(g, () => lockIn(guardLive, g.sessionId));
        const guard = (await counts()).updateTexts;
        expect(guard).toHaveLength(1);
        // id = $2 AND status = <read> ($3) AND (NOT status = 'ERASED' ($4)) AND the scope's filters: the exclusion is
        // part of the compare-and-set, and a parameter of its own.
        expect(guard[0]).toMatch(
          /"sessions"\."status" = CAST\(\$3::text AS "public"\."session_status"\) AND \(NOT "public"\."sessions"\."status" = CAST\(\$4::text AS "public"\."session_status"\)\)/,
        );
        for (const [name, lock] of ANY_STATUS_LOCKS) {
          const chain = await freshChain(`erasedtext-${name}`);
          await db.statements.reset();
          await asHome(lock, chain, () => lockIn(lock, chain.sessionId));
          const texts = (await counts()).updateTexts;
          expect({ name, texts: texts.length }).toEqual({ name, texts: 1 });
          expect({ name, notErased: /\bNOT\b/.test(texts[0] as string) }).toEqual({
            name,
            notErased: false,
          });
        }
      },
    );

    itWithErased(
      `NFR-05 TC-094 guardLive returns ERASED for an erased session and writes nothing (xmin the same)${ENUM_HAS_ERASED ? '' : SKIP_NOTE}`,
      async () => {
        const chain = await freshChain('erased1');
        await setErased(chain.sessionId);
        const xmin = await xminOf(chain.sessionId);
        await db.statements.reset();
        expect(await asService(chain, () => lockIn(guardLive, chain.sessionId))).toBe('ERASED');
        expect(await xminOf(chain.sessionId)).toBe(xmin);
        expect((await counts()).update).toBe(0);
        expect(await statusOf(chain.sessionId)).toBe('ERASED');
      },
    );

    itWithErased.each(ANY_STATUS_LOCKS)(
      `NFR-05 TC-094 %s locks an ERASED session and returns ERASED (the reduction and the erasure-compatible jobs must run on it)${ENUM_HAS_ERASED ? '' : SKIP_NOTE}`,
      async (_name, lock) => {
        const chain = await freshChain('erased2');
        await setErased(chain.sessionId);
        const xmin = await xminOf(chain.sessionId);
        expect(await asHome(lock, chain, () => lockIn<string>(lock, chain.sessionId))).toBe(
          'ERASED',
        );
        expect(await xminOf(chain.sessionId)).not.toBe(xmin); // it did take the row lock
        expect(await statusOf(chain.sessionId)).toBe('ERASED');
      },
    );

    itWithErased(
      `NFR-05 TC-094 the fence wins the race: ERASED committed while the guard's UPDATE waits, so guardLive returns ERASED and writes nothing${ENUM_HAS_ERASED ? '' : SKIP_NOTE}`,
      async () => {
        const chain = await freshChain('erased3');
        const racer = new Client({ connectionString: db.ownerUrl });
        await racer.connect();
        let pending: Promise<unknown> | undefined;
        try {
          await racer.query('BEGIN');
          await racer.query(
            "UPDATE sessions SET status = 'ERASED'::session_status WHERE id = $1::uuid",
            [chain.sessionId],
          );
          pending = asService(chain, () => lockIn(guardLive, chain.sessionId));
          await waitUntilBlocked('UPDATE "public"."sessions"');
          await racer.query('COMMIT');
          expect(await pending).toBe('ERASED');
        } finally {
          await racer.query('ROLLBACK').catch(() => undefined);
          await racer.end();
          await pending?.catch(() => undefined);
        }
        expect(await statusOf(chain.sessionId)).toBe('ERASED');
      },
      60_000,
    );

    itWithErased(
      `NFR-05 TC-094 an ERASED write is excluded in the database too: the update's own where refuses a row that became ERASED${ENUM_HAS_ERASED ? '' : SKIP_NOTE}`,
      async () => {
        // The status moves to ERASED right after the read: the compare-and-set loses, the re-read says ERASED.
        const chain = await freshChain('erased4');
        const result = await asService(chain, () =>
          client.$transaction(
            (tx) =>
              guardLive(
                afterReads(tx, async (n) => {
                  if (n === 0) await setErased(chain.sessionId);
                }),
                chain.sessionId,
              ),
            TX_OPTIONS,
          ),
        );
        expect(result).toBe('ERASED');
        expect(await statusOf(chain.sessionId)).toBe('ERASED');
      },
    );
  });
});
