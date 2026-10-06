// SPIKE for ADR 0015 section 8 (db-engineer row; section 6 "Lock mechanism", "Spike"): under
// Prisma 7's query compiler (ADR 0009), does the lock call of `lockForAccommodation` emit exactly one
// UPDATE statement, and what does Prisma send for a jsonb `equals` filter in `updateMany`?
//
// Two calls are measured, both through the org-scoped client in an org scope entered with
// runAsUser (STAFF scope), in an interactive transaction at READ COMMITTED:
//   1. The sessions lock of ADR 0015 section 6, step 2:
//        tx.session.updateMany({ where: { id, status: <status read> }, data: { status: <same> } })
//   2. The jsonb compare-and-set of section 6, Concurrency (a), in the shape the Delivery Lead gave
//      for this spike:
//        tx.invitation.updateMany({ where: { id, orgId, accommodations: { equals: <raw read> } },
//                                   data: { accommodations: <same> } })
//      (and the same without the explicit orgId, which is what a service writes: the scope adds it).
//
// How the statements are counted: pg_stat_statements on a real Postgres 16 (Testcontainers; Docker
// is required), as auth-bootstrap.spec.ts does. It records what the SERVER executed and how often
// (`calls`), normalised with $1, $2: parameter values are never recorded, and the client factory
// has no query or parameter logging (create-prisma-client.ts), so parameter logging is off.
//
// The test file is the record of the finding; the numbers and SQL are asserted, not just printed.
import { Client } from 'pg';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from './create-prisma-client';
import { OrgContextService } from './org-context';
import type { AuthenticatedUser } from './org-context';
import { createOrgScopedClient } from './org-scope.extension';
import type { OrgScopedPrismaClient } from './org-scope.extension';
import { startMigratedDatabase } from './testing/migrated-postgres';
import type { MigratedDatabase, StatementCount } from './testing/migrated-postgres';
import { createTenant } from './testing/tenant-fixtures';
import type { TenantFixture } from './testing/tenant-fixtures';

/** Statements Prisma sends around an interactive transaction at an explicit isolation level. */
const TRANSACTION_STATEMENTS: StatementCount[] = [
  { query: 'BEGIN', calls: 1 },
  { query: 'COMMIT', calls: 1 },
  { query: 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED', calls: 1 },
];
const isTransactionControl = (statement: StatementCount): boolean =>
  TRANSACTION_STATEMENTS.some((control) => control.query === statement.query);
const byQuery = (a: StatementCount, b: StatementCount): number => a.query.localeCompare(b.query);

// What Prisma 7.10.0 sends, as Postgres normalises it. One line each, so a change shows in a diff.
const UPDATE_INVITATION_WITH_ORG_ID =
  'UPDATE "public"."invitations" SET "accommodations" = $1 WHERE ("public"."invitations"."id" = $2 AND "public"."invitations"."org_id" = $3 AND "public"."invitations"."accommodations"::jsonb = $4 AND "public"."invitations"."org_id" = $5)';
const UPDATE_INVITATION =
  'UPDATE "public"."invitations" SET "accommodations" = $1 WHERE ("public"."invitations"."id" = $2 AND "public"."invitations"."accommodations"::jsonb = $3 AND "public"."invitations"."org_id" = $4)';
const UPDATE_SESSION =
  'UPDATE "public"."sessions" SET "status" = CAST($1::text AS "public"."session_status") WHERE ("public"."sessions"."id" = $2 AND "public"."sessions"."status" = CAST($3::text AS "public"."session_status") AND "public"."sessions"."org_id" = $4)';

/** The client Prisma hands to an interactive transaction callback. */
type ScopedTransaction = Omit<
  OrgScopedPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

/** A jsonb value as Prisma returned it. A NOT NULL column never returns null. */
function raw(value: Prisma.JsonValue | undefined): Prisma.InputJsonValue {
  if (value === null || value === undefined) throw new Error('accommodations is NOT NULL');
  return value;
}

describe('lockForAccommodation spike (ADR 0015 section 8; FR-305)', () => {
  let db: MigratedDatabase;
  let owner: PrismaClient;
  let base: PrismaClient;
  let ownerSql: Client;
  let client: OrgScopedPrismaClient;
  let A: TenantFixture;
  let staffA: AuthenticatedUser;
  let invitationId: string;
  let sessionId: string;
  const orgContext = new OrgContextService();

  /** The statements app_user sent to Postgres while `run` ran, as the server counted them. */
  async function statementsOf(run: () => Promise<unknown>): Promise<StatementCount[]> {
    await db.statements.reset();
    await run();
    return (await db.statements.read()).sort(byQuery);
  }

  const asStaff = <T>(fn: () => T): Promise<Awaited<T>> =>
    orgContext.runAsUser(staffA, fn) as Promise<Awaited<T>>;

  /** An interactive transaction at READ COMMITTED, as ADR 0015 section 6 requires. */
  const readCommitted = <T>(fn: (tx: ScopedTransaction) => Promise<T>): Promise<T> =>
    asStaff(() => client.$transaction(fn, { isolationLevel: 'ReadCommitted' }));

  const readAccommodations = async (): Promise<Prisma.InputJsonValue> =>
    raw((await owner.invitation.findUniqueOrThrow({ where: { id: invitationId } })).accommodations);

  /** The row version Postgres wrote last: it changes whenever an UPDATE writes a new tuple. */
  async function xminOf(table: 'sessions' | 'invitations', id: string): Promise<string> {
    const result = await ownerSql.query<{ xmin: string }>(
      `SELECT xmin::text AS xmin FROM ${table} WHERE id = $1`,
      [id],
    );
    const xmin = result.rows[0]?.xmin;
    if (xmin === undefined) throw new Error(`no ${table} row ${id}`);
    return xmin;
  }

  beforeAll(async () => {
    db = await startMigratedDatabase({ statementStats: true });
    owner = createPrismaClient(db.ownerUrl);
    base = createPrismaClient(db.appUserUrl);
    client = createOrgScopedClient(base, orgContext);
    ownerSql = new Client({ connectionString: db.ownerUrl });
    await ownerSql.connect();
    A = await createTenant(owner, 'a');
    staffA = { orgId: A.orgId, userId: A.userId, role: 'RECRUITER' };
    invitationId = A.rows.Invitation.filter['id'] as string;
    sessionId = A.rows.Session.filter['id'] as string;
    // A stored value like a real one after years of change: a legacy key, a nested object and an
    // array, and keys in an order jsonb will rewrite.
    await owner.invitation.update({
      where: { id: invitationId },
      data: {
        accommodations: {
          notes: 'synthetic',
          legacyKey: { nested: [1, 2, { deep: true }] },
          extraTimePct: 50,
          disabledDetectors: ['GAZE'],
        },
      },
    });
  });

  afterAll(async () => {
    await ownerSql?.end();
    await base?.$disconnect();
    await owner?.$disconnect();
    await db?.stop();
  });

  // ---- 1. the sessions lock -------------------------------------------------------------------

  describe('the sessions lock: session.updateMany({ where: { id, status: <read> }, data: { status: <same> } })', () => {
    it('ADR 0015 section 8: the updateMany emits exactly one UPDATE and nothing else but the transaction control, with READ COMMITTED set', async () => {
      const status = (await owner.session.findUniqueOrThrow({ where: { id: sessionId } })).status;
      let changed = -1;
      const statements = await statementsOf(async () => {
        await readCommitted(async (tx) => {
          changed = (
            await tx.session.updateMany({
              where: { id: sessionId, status },
              data: { status },
            })
          ).count;
        });
      });
      expect(changed).toBe(1);
      expect(statements).toEqual(
        [...TRANSACTION_STATEMENTS, { query: UPDATE_SESSION, calls: 1 }].sort(byQuery),
      );
    });

    it('ADR 0015 section 8: the whole lock call (read the status in scope, then the updateMany) is one SELECT and one UPDATE; the SELECT is the explicit read, Prisma adds none', async () => {
      let changed = -1;
      const statements = await statementsOf(async () => {
        await readCommitted(async (tx) => {
          const row = await tx.session.findFirst({
            where: { id: sessionId },
            select: { status: true },
          });
          if (row === null) throw new Error('404');
          changed = (
            await tx.session.updateMany({
              where: { id: sessionId, status: row.status },
              data: { status: row.status },
            })
          ).count;
        });
      });
      expect(changed).toBe(1);
      const dml = statements.filter((statement) => !isTransactionControl(statement));
      expect(dml.map((statement) => [statement.query.split(' ')[0], statement.calls])).toEqual([
        ['SELECT', 1],
        ['UPDATE', 1],
      ]);
      expect(dml.find((statement) => statement.query.startsWith('UPDATE'))?.query).toBe(
        UPDATE_SESSION,
      );
    });

    it('ADR 0015 section 8: when the status moved in between, the one UPDATE changes 0 rows (the caller re-reads and retries); no extra statement', async () => {
      let changed = -1;
      const statements = await statementsOf(async () => {
        await readCommitted(async (tx) => {
          changed = (
            await tx.session.updateMany({
              where: { id: sessionId, status: 'GRADED' },
              data: { status: 'GRADED' },
            })
          ).count;
        });
      });
      expect(changed).toBe(0);
      expect(statements).toEqual(
        [...TRANSACTION_STATEMENTS, { query: UPDATE_SESSION, calls: 1 }].sort(byQuery),
      );
    });

    it('ADR 0015 section 6: Prisma does not skip the same-value write; Postgres writes a new row version (xmin changes), which is the row lock', async () => {
      const before = await xminOf('sessions', sessionId);
      const status = (await owner.session.findUniqueOrThrow({ where: { id: sessionId } })).status;
      await readCommitted((tx) =>
        tx.session.updateMany({ where: { id: sessionId, status }, data: { status } }),
      );
      expect(await xminOf('sessions', sessionId)).not.toBe(before);
      expect((await owner.session.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe(
        status,
      );
    });

    it('ADR 0015 section 6: the lock is FOR NO KEY UPDATE: an identity_checks insert (FOR KEY SHARE on the session) is not blocked, a heartbeat update is', async () => {
      // A second connection with a short lock_timeout, so "blocked" is an error, not a hang.
      const other = new Client({ connectionString: db.ownerUrl });
      await other.connect();
      try {
        await other.query("SET lock_timeout = '800ms'");
        const status = (await owner.session.findUniqueOrThrow({ where: { id: sessionId } })).status;
        let release: () => void = () => undefined;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let locked: () => void = () => undefined;
        const lockTaken = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const holder = readCommitted(async (tx) => {
          await tx.session.updateMany({ where: { id: sessionId, status }, data: { status } });
          locked();
          await released;
        });
        await lockTaken;
        try {
          // The candidate's upload path: an identity_checks row for this session (attempt 2).
          await other.query('INSERT INTO identity_checks (session_id, attempt) VALUES ($1, 2)', [
            sessionId,
          ]);
          // A transition's or the heartbeat's UPDATE of the same session waits for the lock.
          await expect(
            other.query('UPDATE sessions SET last_heartbeat = now() WHERE id = $1', [sessionId]),
          ).rejects.toMatchObject({ code: '55P03' }); // lock_not_available
        } finally {
          release();
          await holder;
        }
      } finally {
        await other.end();
      }
    });
  });

  // ---- 2. the jsonb compare-and-set -----------------------------------------------------------

  describe('the jsonb compare-and-set: invitation.updateMany({ where: { id, orgId, accommodations: { equals: <raw read> } }, data: { accommodations: <same> } })', () => {
    it('ADR 0015 section 8: with a jsonb equals filter, the updateMany still emits exactly one UPDATE and no preceding SELECT; the filter is "accommodations"::jsonb = $n', async () => {
      const value = await readAccommodations();
      let changed = -1;
      const statements = await statementsOf(async () => {
        await readCommitted(async (tx) => {
          changed = (
            await tx.invitation.updateMany({
              where: { id: invitationId, orgId: A.orgId, accommodations: { equals: value } },
              data: { accommodations: value },
            })
          ).count;
        });
      });
      expect(changed).toBe(1);
      expect(statements).toEqual(
        [...TRANSACTION_STATEMENTS, { query: UPDATE_INVITATION_WITH_ORG_ID, calls: 1 }].sort(
          byQuery,
        ),
      );
    });

    it('ADR 0015 section 8: without an explicit orgId (what a service writes) the scope adds org_id, and it is still one UPDATE', async () => {
      const value = await readAccommodations();
      let changed = -1;
      const statements = await statementsOf(async () => {
        await readCommitted(async (tx) => {
          changed = (
            await tx.invitation.updateMany({
              where: { id: invitationId, accommodations: { equals: value } },
              data: { accommodations: value },
            })
          ).count;
        });
      });
      expect(changed).toBe(1);
      expect(statements).toEqual(
        [...TRANSACTION_STATEMENTS, { query: UPDATE_INVITATION, calls: 1 }].sort(byQuery),
      );
    });

    it('ADR 0015 section 6 (a): read the raw value in the transaction, then compare-and-set: one SELECT (the explicit read) and one UPDATE', async () => {
      let changed = -1;
      const statements = await statementsOf(async () => {
        await readCommitted(async (tx) => {
          const row = await tx.invitation.findFirst({
            where: { id: invitationId },
            select: { accommodations: true },
          });
          const value = raw(row?.accommodations);
          changed = (
            await tx.invitation.updateMany({
              where: { id: invitationId, accommodations: { equals: value } },
              data: { accommodations: { ...(value as Record<string, unknown>), extraTimePct: 50 } },
            })
          ).count;
        });
      });
      expect(changed).toBe(1);
      const dml = statements.filter((statement) => !isTransactionControl(statement));
      expect(dml.map((statement) => [statement.query.split(' ')[0], statement.calls])).toEqual([
        ['SELECT', 1],
        ['UPDATE', 1],
      ]);
    });

    it('ADR 0015 section 6 (a): 0 rows changed (a stale value) is one UPDATE and count 0, with no SELECT', async () => {
      let changed = -1;
      const statements = await statementsOf(async () => {
        await readCommitted(async (tx) => {
          changed = (
            await tx.invitation.updateMany({
              where: { id: invitationId, accommodations: { equals: { extraTimePct: 99 } } },
              data: { accommodations: { extraTimePct: 99 } },
            })
          ).count;
        });
      });
      expect(changed).toBe(0);
      expect(statements).toEqual(
        [...TRANSACTION_STATEMENTS, { query: UPDATE_INVITATION, calls: 1 }].sort(byQuery),
      );
      // Nothing was written.
      expect((await readAccommodations()) as Record<string, unknown>).toHaveProperty('legacyKey');
    });

    it('ADR 0015 section 6 (a): jsonb equality is semantic: the raw value matches in another key order and whitespace, but a zod-parsed copy that drops the legacy key does not', async () => {
      const value = (await readAccommodations()) as Record<string, unknown>;
      const reordered = Object.fromEntries(Object.entries(value).reverse());
      const stripped = Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== 'legacyKey'),
      ) as Prisma.InputJsonValue;
      const casWith = (equals: Prisma.InputJsonValue): Promise<number> =>
        readCommitted(
          async (tx) =>
            (
              await tx.invitation.updateMany({
                where: { id: invitationId, accommodations: { equals } },
                data: { accommodations: value as Prisma.InputJsonObject },
              })
            ).count,
        );
      expect(await casWith(reordered as Prisma.InputJsonObject)).toBe(1);
      expect(await casWith(stripped)).toBe(0);
      // Numbers compare as numbers: 50 and 50.0 are the same jsonb value.
      expect(await casWith({ ...value, extraTimePct: 50.0 } as Prisma.InputJsonObject)).toBe(1);
    });

    it('ADR 0015 section 6: the same-value write is a real UPDATE (xmin changes), so it also serialises against another writer of the invitation', async () => {
      const value = await readAccommodations();
      const before = await xminOf('invitations', invitationId);
      await readCommitted((tx) =>
        tx.invitation.updateMany({
          where: { id: invitationId, accommodations: { equals: value } },
          data: { accommodations: value },
        }),
      );
      expect(await xminOf('invitations', invitationId)).not.toBe(before);
    });
  });

  // ---- 3. related shapes of the same section --------------------------------------------------

  describe('related writes of ADR 0015 section 6 on identity_checks, a path model with no org_id', () => {
    it('ADR 0015 section 8: updateMany and deleteMany on identity_checks by { sessionId, status } are one statement each, the org scope as an EXISTS subquery on sessions, with no preceding SELECT', async () => {
      let counts: number[] = [];
      const pending = await owner.identityCheck.count({ where: { sessionId, status: 'PENDING' } });
      expect(pending).toBeGreaterThan(0);
      const statements = await statementsOf(async () => {
        await readCommitted(async (tx) => {
          const updated = await tx.identityCheck.updateMany({
            where: { sessionId, status: 'PENDING' },
            data: { videoCheckDone: null },
          });
          const deleted = await tx.identityCheck.deleteMany({
            where: { sessionId, status: 'WAIVED' },
          });
          counts = [updated.count, deleted.count];
        });
      });
      // Every PENDING row of the session changes in one statement; no WAIVED row exists (0 rows).
      expect(counts).toEqual([pending, 0]);
      const dml = statements.filter((statement) => !isTransactionControl(statement));
      expect(dml.map((statement) => [statement.query.split(' ')[0], statement.calls])).toEqual([
        ['DELETE', 1],
        ['UPDATE', 1],
      ]);
      for (const statement of dml) {
        expect(statement.query).toContain('EXISTS(SELECT');
        expect(statement.query).toContain('"public"."sessions"');
      }
    });
  });
});
