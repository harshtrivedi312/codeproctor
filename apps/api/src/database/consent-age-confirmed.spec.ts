// D-55 (owner decision C-30; FR-401): `consents.age_confirmed_at`, the candidate's 18-or-older
// confirmation. Migration 20261006182916_consent_age_confirmed_at adds one nullable timestamptz column
// and nothing else: no CHECK, no backfill, no GRANT. Rows that exist before the migration, and declined
// rows, keep NULL; the value is set at sign by ConsentService (BE-07), under the ADR 0013 CS-4.4 create
// grant (candidate-interim.spec.ts and cs4-columns-grants.spec.ts cover that side).
//
// There is deliberately NO CHECK (signed_at IS NULL OR age_confirmed_at IS NOT NULL): Postgres evaluates
// a CHECK on every later UPDATE of the row, even a NOT VALID one, so it would block the consent-PDF
// job's update of pdf_key, pdf_generated_at and copy_emailed_at on a row signed before C-30. These tests
// pin that decision: the database accepts a signed row without the timestamp, and the job can update it.
//
// Real Postgres 16 (Testcontainers; Docker is required) with the real migrations applied by
// `prisma migrate deploy`. The structure tests read the catalog as the schema owner; the privilege tests
// connect as app_user, the way the API does at runtime.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from './create-prisma-client';
import { startMigratedDatabase } from './testing/migrated-postgres';
import type { MigratedDatabase } from './testing/migrated-postgres';
import { createCandidateChain, createTenant } from './testing/tenant-fixtures';
import type { SessionChain, TenantFixture } from './testing/tenant-fixtures';

const MIGRATION = '20261006182916_consent_age_confirmed_at';
const MIGRATIONS_DIR = resolve(__dirname, '../../../../prisma/migrations');
const WHEN = new Date('2026-10-06T12:00:00.000Z');
const LATER = new Date('2026-10-06T13:00:00.000Z');

describe('consents.age_confirmed_at (FR-401, C-30, D-55)', () => {
  let db: MigratedDatabase;
  let owner: PrismaClient;
  let appUser: PrismaClient;
  let appPg: Client;
  let pg: Client;
  let T: TenantFixture;
  let counter = 0;

  /** A session of the tenant with no consent row, as the sign route finds it. */
  async function sessionWithoutConsent(): Promise<SessionChain> {
    counter += 1;
    const chain = await createCandidateChain(owner, T, `age${counter}`);
    await owner.consent.delete({ where: { id: chain.rows.Consent.filter.id as string } });
    return chain;
  }

  /** The `consents` columns of the row of a session, as the owner reads them. */
  async function rowOf(sessionId: string): Promise<Record<string, unknown> | undefined> {
    const result = await pg.query<Record<string, unknown>>(
      'SELECT * FROM consents WHERE session_id = $1',
      [sessionId],
    );
    return result.rows[0];
  }

  beforeAll(async () => {
    db = await startMigratedDatabase();
    owner = createPrismaClient(db.ownerUrl);
    appUser = createPrismaClient(db.appUserUrl);
    pg = new Client({ connectionString: db.ownerUrl });
    await pg.connect();
    appPg = new Client({ connectionString: db.appUserUrl });
    await appPg.connect();
    T = await createTenant(owner, 'age');
  });

  afterAll(async () => {
    await appPg?.end();
    await pg?.end();
    await appUser?.$disconnect();
    await owner?.$disconnect();
    await db?.stop();
  });

  // ---- the migration ---------------------------------------------------------------------------

  describe('what the migration created', () => {
    it('FR-401 C-30 the column exists, is nullable, has type timestamp with time zone and no default', async () => {
      const result = await pg.query<{
        data_type: string;
        udt_name: string;
        is_nullable: string;
        column_default: string | null;
        datetime_precision: number;
      }>(
        `SELECT data_type, udt_name, is_nullable, column_default, datetime_precision
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'consents' AND column_name = 'age_confirmed_at'`,
      );
      expect(result.rows).toEqual([
        {
          data_type: 'timestamp with time zone',
          udt_name: 'timestamptz',
          is_nullable: 'YES',
          column_default: null,
          datetime_precision: 6,
        },
      ]);
    });

    it('FR-401 C-30 consents has 12 columns: the 11 of the freeze and age_confirmed_at, the last one (the migration appends)', async () => {
      const result = await pg.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'consents' ORDER BY ordinal_position`,
      );
      expect(result.rows.map((row) => row.column_name)).toEqual([
        'id',
        'session_id',
        'consent_text_id',
        'signed_name',
        'signed_at',
        'declined_at',
        'ip',
        'user_agent',
        'pdf_key',
        'pdf_generated_at',
        'copy_emailed_at',
        'age_confirmed_at',
      ]);
    });

    it('FR-401 C-30 D-55 there is no CHECK on the column: the two CHECKs of consents are the freeze ones, and none names age_confirmed_at', async () => {
      const result = await pg.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = 'consents'::regclass AND contype = 'c' ORDER BY conname`,
      );
      expect(Object.fromEntries(result.rows.map((row) => [row.conname, row.def]))).toEqual({
        consents_check: 'CHECK (((signed_at IS NULL) <> (declined_at IS NULL)))',
        consents_check1: 'CHECK (((signed_at IS NULL) OR (signed_name IS NOT NULL)))',
      });
      // Nothing else in the catalog refers to the column either: no constraint of any kind and no index.
      const refers = await pg.query<{ kind: string }>(
        `SELECT 'constraint' AS kind FROM pg_constraint c
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'age_confirmed_at'
           WHERE c.conrelid = 'consents'::regclass AND a.attnum = ANY (c.conkey)
         UNION ALL
         SELECT 'index' FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attname = 'age_confirmed_at'
           WHERE i.indrelid = 'consents'::regclass AND a.attnum = ANY (i.indkey)`,
      );
      expect(refers.rows).toEqual([]);
    });

    it('FR-401 C-30 D-55 the migration is the one ALTER TABLE ADD COLUMN and nothing else: no CHECK, no backfill, no GRANT', () => {
      const sql = readFileSync(resolve(MIGRATIONS_DIR, MIGRATION, 'migration.sql'), 'utf8')
        .replace(/--[^\n]*/g, '')
        .trim();
      const statements = sql
        .split(';')
        .map((statement) => statement.replace(/\s+/g, ' ').trim())
        .filter((statement) => statement !== '');
      expect(statements).toEqual([
        'ALTER TABLE "consents" ADD COLUMN "age_confirmed_at" TIMESTAMPTZ(6)',
      ]);
    });

    it('FR-401 C-30 the migration is later than the ADR 0015 ones, and deploy recorded it as finished', async () => {
      const names = readdirSync(MIGRATIONS_DIR)
        .filter((entry) => /^\d{14}_/.test(entry))
        .sort();
      expect(names.indexOf(MIGRATION)).toBeGreaterThan(
        names.indexOf('20261006174715_identity_check_waiver_columns'),
      );
      const result = await pg.query<{ migration_name: string }>(
        `SELECT migration_name FROM _prisma_migrations
         WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`,
        [MIGRATION],
      );
      expect(result.rows).toHaveLength(1);
    });
  });

  // ---- rows before C-30, and the PDF job ---------------------------------------------------------

  describe('rows with no confirmation (declined rows and rows signed before C-30)', () => {
    it('FR-401 C-30 the fixture rows signed without the column have NULL there (they are the pre-C-30 rows)', async () => {
      const result = await pg.query<{ age_confirmed_at: Date | null; signed_at: Date | null }>(
        'SELECT age_confirmed_at, signed_at FROM consents WHERE session_id = $1',
        [T.chain.sessionId],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.signed_at).not.toBeNull();
      expect(result.rows[0]?.age_confirmed_at).toBeNull();
    });

    it('FR-401 C-30 D-55 no CHECK: a signed row with no age_confirmed_at is accepted, and so is one with it, and a decline with none', async () => {
      const signedWithout = await sessionWithoutConsent();
      const signedWith = await sessionWithoutConsent();
      const declined = await sessionWithoutConsent();
      await pg.query(
        `INSERT INTO consents (session_id, consent_text_id, signed_name, signed_at)
         VALUES ($1, $2, 'Synthetic Name', $3)`,
        [signedWithout.sessionId, T.consentTextId, WHEN],
      );
      await pg.query(
        `INSERT INTO consents (session_id, consent_text_id, signed_name, signed_at, age_confirmed_at)
         VALUES ($1, $2, 'Synthetic Name', $3, $3)`,
        [signedWith.sessionId, T.consentTextId, WHEN],
      );
      await pg.query(
        `INSERT INTO consents (session_id, consent_text_id, declined_at) VALUES ($1, $2, $3)`,
        [declined.sessionId, T.consentTextId, WHEN],
      );
      expect((await rowOf(signedWithout.sessionId))?.age_confirmed_at).toBeNull();
      expect((await rowOf(signedWith.sessionId))?.age_confirmed_at).toEqual(WHEN);
      expect((await rowOf(declined.sessionId))?.age_confirmed_at).toBeNull();
    });

    it('FR-401 C-30 D-55 the consent-PDF job can update a signed row that has no age_confirmed_at (pdf_key, pdf_generated_at, copy_emailed_at), as app_user and as the owner', async () => {
      const chain = await sessionWithoutConsent();
      await pg.query(
        `INSERT INTO consents (session_id, consent_text_id, signed_name, signed_at)
         VALUES ($1, $2, 'Synthetic Name', $3)`,
        [chain.sessionId, T.consentTextId, WHEN],
      );
      // The job's own update, through the model API as app_user (the real grants).
      const changed = await appUser.consent.updateMany({
        where: { sessionId: chain.sessionId },
        data: {
          pdfKey: `orgs/${chain.orgId}/consents/${chain.sessionId}/consent.pdf`,
          pdfGeneratedAt: WHEN,
          copyEmailedAt: LATER,
        },
      });
      expect(changed).toEqual({ count: 1 });
      expect(await rowOf(chain.sessionId)).toMatchObject({
        pdf_generated_at: WHEN,
        copy_emailed_at: LATER,
        signed_at: WHEN,
        age_confirmed_at: null,
      });
      // And as the owner (the erasure path nulls ip, user_agent and pdf_key of a signed row the same way).
      await pg.query(
        `UPDATE consents SET signed_name = 'Erased', ip = NULL, user_agent = NULL, pdf_key = NULL
         WHERE session_id = $1`,
        [chain.sessionId],
      );
      expect(await rowOf(chain.sessionId)).toMatchObject({
        signed_name: 'Erased',
        pdf_key: null,
        age_confirmed_at: null,
      });
    });

    it('FR-401 C-30 the two existing CHECKs still hold: one of signed_at and declined_at, and the name with a signature', async () => {
      const chain = await sessionWithoutConsent();
      await expect(
        pg.query(
          `INSERT INTO consents (session_id, consent_text_id, signed_at, age_confirmed_at)
           VALUES ($1, $2, $3, $3)`,
          [chain.sessionId, T.consentTextId, WHEN],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'consents_check1' });
      await expect(
        pg.query(
          `INSERT INTO consents (session_id, consent_text_id, age_confirmed_at) VALUES ($1, $2, $3)`,
          [chain.sessionId, T.consentTextId, WHEN],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'consents_check' });
    });
  });

  // ---- the role ----------------------------------------------------------------------------------

  describe('app_user (ADR 0006 section 7: table-level grants cover the new column)', () => {
    it('FR-401 C-30 app_user can insert and read the column with plain SQL, and no GRANT in the migration was needed', async () => {
      const chain = await sessionWithoutConsent();
      await appPg.query(
        `INSERT INTO consents (session_id, consent_text_id, signed_name, signed_at, age_confirmed_at)
         VALUES ($1, $2, 'Synthetic Name', $3, $3)`,
        [chain.sessionId, T.consentTextId, WHEN],
      );
      const read = await appPg.query<{ age_confirmed_at: Date }>(
        'SELECT age_confirmed_at FROM consents WHERE session_id = $1',
        [chain.sessionId],
      );
      expect(read.rows[0]?.age_confirmed_at).toEqual(WHEN);
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE']) {
        const has = await pg.query<{ ok: boolean }>(
          `SELECT has_column_privilege('app_user', 'consents', 'age_confirmed_at', $1) AS ok`,
          [privilege],
        );
        expect({ privilege, ok: has.rows[0]?.ok }).toEqual({ privilege, ok: true });
      }
    });

    it('FR-401 C-30 audit_logs stays append-only and sessions has no DELETE for app_user: this migration did not undo either REVOKE', async () => {
      const result = await pg.query<{ ok: boolean; what: string }>(
        `SELECT has_table_privilege('app_user', 'sessions', 'DELETE') AS ok, 'sessions DELETE' AS what
         UNION ALL SELECT has_table_privilege('app_user', 'audit_logs', 'UPDATE'), 'audit_logs UPDATE'
         UNION ALL SELECT has_table_privilege('app_user', 'audit_logs', 'DELETE'), 'audit_logs DELETE'`,
      );
      expect(result.rows.map((row) => `${row.what}=${row.ok}`)).toEqual([
        'sessions DELETE=false',
        'audit_logs UPDATE=false',
        'audit_logs DELETE=false',
      ]);
    });
  });
});
