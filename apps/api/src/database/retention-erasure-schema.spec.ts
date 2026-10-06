// ADR 0004 section 9 migrations (accepted, D-54): the ERASED and CLOSED_ERASED enum values (9.5), the partial index for the retention
// markers (9.2), and no DELETE or TRUNCATE on sessions for app_user (9.3). Serves FR-704 and NFR-05.
// A real Postgres 16 (Testcontainers, Docker required) with the real migrations applied; the code
// under test connects as app_user through the real client factory, so the real grants are in force.
// Fixtures and the teardown path use the owner role.
//
// The grants checks follow the pattern of TC-006 (audit_logs is append-only for app_user): ask the
// catalog, then try the statement and expect 42501. TC-008 (tc-008-org-isolation.spec.ts) and the CS-4
// SERVICE matrix (cs4-session-isolation.spec.ts) run the per-model delete checks, each with a Session branch.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import type { PrismaClient } from '../generated/prisma/client.js';
import { AppealStatus, SessionStatus } from '../generated/prisma/enums.js';
import { createPrismaClient } from './create-prisma-client';
import { OrgContextService } from './org-context';
import { createOrgScopedClient } from './org-scope.extension';
import { startMigratedDatabase } from './testing/migrated-postgres';
import type { MigratedDatabase } from './testing/migrated-postgres';
import { createTenant } from './testing/tenant-fixtures';
import type { TenantFixture } from './testing/tenant-fixtures';

/** The statement's outcome as `code:message`, or `allowed`. */
async function outcome(client: Client, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await client.query(sql, params);
  } catch (error) {
    const err = error as { code?: string; message: string };
    return `${err.code}:${err.message}`;
  }
  return 'allowed';
}

async function enumLabels(client: Client, typeName: string): Promise<string[]> {
  const result = await client.query<{ label: string }>(
    `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = $1 ORDER BY e.enumsortorder`,
    [typeName],
  );
  return result.rows.map((row) => row.label);
}

/** The EXPLAIN plan as one text block. */
async function plan(client: Client, sql: string): Promise<string> {
  const result = await client.query<Record<string, string>>(`EXPLAIN (COSTS OFF) ${sql}`);
  return result.rows.map((row) => row['QUERY PLAN']).join('\n');
}

describe('ADR 0004 section 9 migrations: erasure statuses, retention marker index, no session delete (FR-704, NFR-05)', () => {
  let db: MigratedDatabase;
  let ownerPrisma: PrismaClient;
  let appPrisma: PrismaClient;
  let owner: Client;
  let appUser: Client;
  let orgContext: OrgContextService;
  let scoped: ReturnType<typeof createOrgScopedClient>;
  let T: TenantFixture;

  beforeAll(async () => {
    db = await startMigratedDatabase();
    ownerPrisma = createPrismaClient(db.ownerUrl);
    appPrisma = createPrismaClient(db.appUserUrl);
    orgContext = new OrgContextService();
    scoped = createOrgScopedClient(appPrisma, orgContext);
    owner = new Client({ connectionString: db.ownerUrl });
    appUser = new Client({ connectionString: db.appUserUrl });
    await owner.connect();
    await appUser.connect();
    T = await createTenant(ownerPrisma, 'erase');
  });

  afterAll(async () => {
    await appUser?.end();
    await owner?.end();
    await appPrisma?.$disconnect();
    await ownerPrisma?.$disconnect();
    await db?.stop();
  });

  describe('the new enum values (ADR 0004 section 9.5, ADR 0008 deltas)', () => {
    it('FR-704 session_status ends with ERASED, after the thirteen values it had, in their old order', async () => {
      expect(await enumLabels(owner, 'session_status')).toEqual([
        'INVITED',
        'OPENED',
        'CONSENTED',
        'VERIFIED',
        'IN_PROGRESS',
        'PAUSED',
        'SUBMITTED',
        'GRADED',
        'UNDER_REVIEW',
        'COMPLETED',
        'EXPIRED',
        'APPEALED',
        'DECLINED',
        'ERASED',
      ]);
    });

    it('FR-704 appeal_status ends with CLOSED_ERASED, after OPEN, UPHELD and OVERTURNED', async () => {
      expect(await enumLabels(owner, 'appeal_status')).toEqual([
        'OPEN',
        'UPHELD',
        'OVERTURNED',
        'CLOSED_ERASED',
      ]);
    });

    it('FR-704 the generated client has both values, and app_user can move a session to ERASED and an open appeal to CLOSED_ERASED', async () => {
      // Each value lives in its own migration, so it is usable here, in a later transaction.
      const X = await createTenant(ownerPrisma, 'erase-status');
      const sessionId = X.rows.Session.filter.id as string;
      const appealId = X.rows.Appeal.filter.id as string;
      const [session, appeal] = await orgContext.runInOrg(X.orgId, async () => [
        await scoped.session.update({
          where: { id: sessionId },
          data: { status: SessionStatus.ERASED },
        }),
        await scoped.appeal.update({
          where: { id: appealId },
          data: { status: AppealStatus.CLOSED_ERASED },
        }),
      ]);
      expect(session.status).toBe('ERASED');
      // appeals_check ties new_verdict to OVERTURNED only, so CLOSED_ERASED keeps it NULL.
      expect(appeal).toMatchObject({ status: 'CLOSED_ERASED', newVerdict: null });
      const stored = await owner.query<{ status: string }>(
        `SELECT status::text AS status FROM sessions WHERE id = $1`,
        [sessionId],
      );
      expect(stored.rows[0]?.status).toBe('ERASED');
    });
  });

  describe('the partial index for the retention markers (ADR 0004 section 9.2, ADR 0008 delta)', () => {
    it('NFR-05 audit_logs_retention_marker_idx is a plain btree on (action, entity_id) with exactly the three marker actions as its predicate', async () => {
      const result = await owner.query<{ indexdef: string; indisunique: boolean }>(
        `SELECT i.indexdef, x.indisunique
         FROM pg_indexes i
         JOIN pg_class c ON c.relname = i.indexname
         JOIN pg_index x ON x.indexrelid = c.oid
         WHERE i.schemaname = 'public' AND i.tablename = 'audit_logs'
           AND i.indexname = 'audit_logs_retention_marker_idx'`,
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.indisunique).toBe(false);
      expect(result.rows[0]?.indexdef).toBe(
        'CREATE INDEX audit_logs_retention_marker_idx ON public.audit_logs USING btree (action, entity_id) ' +
          "WHERE (action = ANY (ARRAY['RETENTION_FACE_DONE'::text, 'RETENTION_MEDIA_DONE'::text, 'RETENTION_RESULTS_DONE'::text]))",
      );
    });

    it('NFR-05 the "eligible and no marker" NOT EXISTS query of ADR 0004 section 9.2 can use the marker index, and the existing indexes stay', async () => {
      // A few thousand ordinary audit rows and some markers, in a transaction that is rolled back,
      // so a small table does not make the planner prefer a sequential scan.
      await owner.query('BEGIN');
      try {
        await owner.query(`INSERT INTO organizations (name) VALUES ('explain org')`);
        await owner.query(
          `INSERT INTO audit_logs (org_id, action, entity_type, entity_id)
           SELECT (SELECT id FROM organizations WHERE name = 'explain org'), 'SESSION_STARTED', 'session',
                  gen_random_uuid()::text
           FROM generate_series(1, 20000)`,
        );
        await owner.query(
          `INSERT INTO audit_logs (org_id, action, entity_type, entity_id)
           SELECT (SELECT id FROM organizations WHERE name = 'explain org'), 'RETENTION_MEDIA_DONE', 'session',
                  gen_random_uuid()::text
           FROM generate_series(1, 50)`,
        );
        await owner.query('ANALYZE audit_logs');

        // The marker lookup for one session: the index is chosen without any planner switch.
        const lookup = await plan(
          owner,
          `SELECT 1 FROM audit_logs a
           WHERE a.action = 'RETENTION_MEDIA_DONE' AND a.entity_type = 'session' AND a.entity_id = 'x'`,
        );
        expect(lookup).toContain('Index Scan using audit_logs_retention_marker_idx on audit_logs');

        // The daily check as 9.2 describes it (anchor-based eligibility, NOT EXISTS against the
        // marker, entity_id compared with sessions.id::text). Sequential scans are switched off,
        // because the sessions table is nearly empty here: the point is that the planner can match
        // the query to the index predicate.
        await owner.query('SET LOCAL enable_seqscan = off');
        const daily = await plan(
          owner,
          `SELECT s.id FROM sessions s
           WHERE s.retention_anchor_at <= now()
             AND NOT EXISTS (
               SELECT 1 FROM audit_logs a
               WHERE a.action = 'RETENTION_MEDIA_DONE' AND a.entity_type = 'session'
                 AND a.entity_id = s.id::text)`,
        );
        expect(daily).toContain('audit_logs_retention_marker_idx');
        expect(daily).toContain('sessions_retention_anchor_at_idx');
      } finally {
        await owner.query('ROLLBACK');
      }
    });
  });

  describe('no DELETE and no TRUNCATE on sessions for app_user (ADR 0004 section 9.3, ADR 0006 section 7.2 delta)', () => {
    const sessionId = (): string => T.rows.Session.filter.id as string;
    const consentCount = async (client: Client): Promise<number> =>
      Number(
        (
          await client.query<{ n: string }>(
            `SELECT count(*) AS n FROM consents WHERE session_id = $1`,
            [sessionId()],
          )
        ).rows[0]?.n,
      );

    it('NFR-05 TC-006 has_table_privilege: app_user has neither DELETE nor TRUNCATE on sessions, and still has SELECT, INSERT and UPDATE', async () => {
      const result = await appUser.query<Record<string, boolean | string>>(
        `SELECT current_user AS who,
                has_table_privilege(current_user, 'sessions', 'DELETE') AS del,
                has_table_privilege(current_user, 'sessions', 'TRUNCATE') AS trunc,
                has_table_privilege(current_user, 'sessions', 'SELECT') AS sel,
                has_table_privilege(current_user, 'sessions', 'INSERT') AS ins,
                has_table_privilege(current_user, 'sessions', 'UPDATE') AS upd`,
      );
      expect(result.rows[0]).toEqual({
        who: 'app_user',
        del: false,
        trunc: false,
        sel: true,
        ins: true,
        upd: true,
      });
    });

    it('NFR-05 TC-094 the migration fails, rather than passing open, when a DELETE from another grantor survives its REVOKE (ADR 0004 section 9.3)', async () => {
      // The migration's own REVOKE and post-check, run again on top of a grant the owner did not make.
      const sql = readFileSync(
        resolve(
          __dirname,
          '../../../../prisma/migrations/20261006174300_retention_marker_index_and_no_session_delete/migration.sql',
        ),
        'utf8',
      );
      const revokeAndCheck = sql.slice(
        sql.indexOf('REVOKE DELETE, TRUNCATE ON "sessions" FROM app_user;'),
      );
      expect(revokeAndCheck.startsWith('REVOKE')).toBe(true);
      await owner.query('BEGIN');
      try {
        await owner.query('CREATE ROLE tmp_other_grantor NOLOGIN');
        await owner.query('GRANT DELETE ON sessions TO tmp_other_grantor WITH GRANT OPTION');
        await owner.query('SET ROLE tmp_other_grantor');
        await owner.query('GRANT DELETE ON sessions TO app_user');
        await owner.query('RESET ROLE');
        await expect(owner.query(revokeAndCheck)).rejects.toThrow(
          /app_user still has DELETE or TRUNCATE on sessions/,
        );
      } finally {
        await owner.query('ROLLBACK');
      }
      // Rolled back: app_user is as the migrations left it.
      const after = await appUser.query<{ del: boolean }>(
        `SELECT has_table_privilege(current_user, 'sessions', 'DELETE') AS del`,
      );
      expect(after.rows[0]?.del).toBe(false);
    });

    it('NFR-05 TC-006 the privilege assertion catches a later GRANT ... ON ALL TABLES, which would silently undo the REVOKE (ADR 0004 section 9.3)', async () => {
      // The audit_append_only migration grants with GRANT ... ON ALL TABLES. A later migration that
      // repeats the pattern re-grants DELETE on sessions. Run that grant in a transaction and roll it
      // back: the check from the test above must flip, so it can fail, and nothing is left changed.
      await owner.query('BEGIN');
      try {
        await owner.query(
          'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user',
        );
        const regranted = await owner.query<{ del: boolean }>(
          `SELECT has_table_privilege('app_user', 'sessions', 'DELETE') AS del`,
        );
        expect(regranted.rows[0]?.del).toBe(true);
      } finally {
        await owner.query('ROLLBACK');
      }
      const after = await owner.query<{ del: boolean; trunc: boolean }>(
        `SELECT has_table_privilege('app_user', 'sessions', 'DELETE') AS del,
                has_table_privilege('app_user', 'sessions', 'TRUNCATE') AS trunc`,
      );
      expect(after.rows[0]).toEqual({ del: false, trunc: false });
    });

    it('FR-704 TC-006 DELETE FROM sessions and TRUNCATE sessions as app_user are refused with 42501, and the consent row survives', async () => {
      expect(await consentCount(appUser)).toBe(1);
      expect(await outcome(appUser, 'DELETE FROM sessions')).toMatch(/^42501:/);
      expect(await outcome(appUser, 'DELETE FROM sessions WHERE id = $1', [sessionId()])).toMatch(
        /^42501:/,
      );
      // No row can match this one, and the statement is refused all the same: the privilege check
      // comes before the search.
      expect(
        await outcome(appUser, 'DELETE FROM sessions WHERE id = $1', [
          '00000000-0000-4000-8000-000000000000',
        ]),
      ).toMatch(/^42501:/);
      expect(await outcome(appUser, 'TRUNCATE sessions')).toMatch(/^42501:/);
      expect(await outcome(appUser, 'TRUNCATE sessions CASCADE')).toMatch(/^42501:/);
      const left = await appUser.query(`SELECT 1 FROM sessions WHERE id = $1`, [sessionId()]);
      expect(left.rowCount).toBe(1);
      expect(await consentCount(appUser)).toBe(1);
      expect(await consentCount(owner)).toBe(1);
    });

    it('FR-704 TC-008 session.delete and session.deleteMany through the org-scoped client are refused in org scope and in the retention and erasure system scope, and the consent row survives', async () => {
      const refused = /permission denied for table sessions/i;
      await orgContext.runInOrg(T.orgId, async () => {
        await expect(scoped.session.delete({ where: { id: sessionId() } })).rejects.toThrow(
          refused,
        );
        await expect(scoped.session.deleteMany({ where: { id: sessionId() } })).rejects.toThrow(
          refused,
        );
        await expect(scoped.session.deleteMany()).rejects.toThrow(refused);
      });
      await orgContext.runSystem('RETENTION_ERASURE', async () => {
        await expect(scoped.session.delete({ where: { id: sessionId() } })).rejects.toThrow(
          refused,
        );
        await expect(scoped.session.deleteMany({ where: { id: sessionId() } })).rejects.toThrow(
          refused,
        );
        await expect(scoped.session.deleteMany()).rejects.toThrow(refused);
      });
      expect(await ownerPrisma.session.count({ where: { id: sessionId() } })).toBe(1);
      expect(await consentCount(appUser)).toBe(1);
    });

    it('FR-704 deleting a session parent as app_user cannot cascade into sessions: the foreign keys from sessions are NO ACTION, so the delete is refused and the session and its consent survive', async () => {
      // The REVOKE stops a direct DELETE only. A foreign key ON DELETE CASCADE from a parent into
      // sessions would delete the rows with the privileges of the table owner, past the REVOKE.
      // Pin that no such key exists (a later migration that adds one fails here).
      const keys = await owner.query<{ name: string; parent: string; action: string }>(
        `SELECT c.conname AS name, c.confrelid::regclass::text AS parent, c.confdeltype::text AS action
         FROM pg_constraint c WHERE c.conrelid = 'public.sessions'::regclass AND c.contype = 'f'
         ORDER BY c.conname`,
      );
      expect(keys.rows.map((row) => `${row.parent}:${row.action}`).sort()).toEqual([
        'invitations:a',
        'organizations:a',
      ]);
      // And the behaviour: each parent delete fails with 23503 (foreign_key_violation).
      for (const [sql, id] of [
        ['DELETE FROM invitations WHERE id = $1', T.rows.Invitation.filter.id],
        ['DELETE FROM candidates WHERE id = $1', T.rows.Candidate.filter.id],
        ['DELETE FROM organizations WHERE id = $1', T.orgId],
      ] as const) {
        expect(await outcome(appUser, sql, [id])).toMatch(/^23503:/);
      }
      expect(await ownerPrisma.session.count({ where: { id: sessionId() } })).toBe(1);
      expect(await consentCount(appUser)).toBe(1);
    });

    it('FR-704 as the migration owner a session delete works (the teardown and seed-cleanup path), and it removes the consent row, which is why app_user must not have it', async () => {
      const X = await createTenant(ownerPrisma, 'erase-teardown');
      const id = X.rows.Session.filter.id as string;
      const before = await owner.query(`SELECT 1 FROM consents WHERE session_id = $1`, [id]);
      expect(before.rowCount).toBe(1);
      // database.md as it stands: appeals.session_review_id is NO ACTION while session_reviews
      // cascades from sessions, so a session whose review has an appeal cannot be deleted, even by
      // the owner, until the appeal is. Teardown deletes the appeal first.
      await expect(ownerPrisma.session.delete({ where: { id } })).rejects.toMatchObject({
        code: 'P2003',
      });
      await ownerPrisma.appeal.delete({ where: { id: X.rows.Appeal.filter.id as string } });
      await ownerPrisma.session.delete({ where: { id } });
      const after = await owner.query(`SELECT 1 FROM consents WHERE session_id = $1`, [id]);
      expect(after.rowCount).toBe(0);
    });
  });
});
