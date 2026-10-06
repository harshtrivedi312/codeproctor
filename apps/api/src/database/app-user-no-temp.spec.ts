// app_user has no TEMPORARY on the database (ADR 0006 section 8.8, DL-26). PostgreSQL grants it to
// PUBLIC on every new database; the app_user_no_temp migration revokes that, keeps it for the
// owner, and fails instead of only warning when the running role cannot revoke it.
//
// Real Postgres 16 (Testcontainers; Docker is required) with the real migrations.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { startMigratedDatabase } from './testing/migrated-postgres';
import type { MigratedDatabase } from './testing/migrated-postgres';

const MIGRATION_SQL = readFileSync(
  resolve(__dirname, '../../../../prisma/migrations/20261006001500_app_user_no_temp/migration.sql'),
  'utf8',
);

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function sqlState(url: string, sql: string): Promise<string | undefined> {
  return withClient(url, async (client) => {
    try {
      await client.query(sql);
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    }
  });
}

describe('app_user has no TEMPORARY on the database (NFR-04, TC-006; ADR 0006 section 8.8)', () => {
  let db: MigratedDatabase;

  beforeAll(async () => {
    db = await startMigratedDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('TC-006 has_database_privilege: app_user has neither TEMPORARY nor CREATE', async () => {
    const row = await withClient(db.appUserUrl, async (client) => {
      const result = await client.query<{ temp: boolean; create: boolean }>(
        `SELECT has_database_privilege('app_user', current_database(), 'TEMPORARY') AS temp,
                has_database_privilege('app_user', current_database(), 'CREATE') AS create`,
      );
      return result.rows[0];
    });
    expect(row).toEqual({ temp: false, create: false });
  });

  it('TC-006 PUBLIC no longer holds TEMPORARY in the database ACL', async () => {
    const grantees = await withClient(db.ownerUrl, async (client) => {
      const result = await client.query<{ grantee: string }>(
        `SELECT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
           FROM pg_database d, aclexplode(d.datacl) a
          WHERE d.datname = current_database() AND a.privilege_type = 'TEMPORARY'
          ORDER BY 1`,
      );
      return result.rows.map((r) => r.grantee);
    });
    expect(grantees).not.toContain('PUBLIC');
    expect(grantees).not.toContain('app_user');
    expect(grantees.length).toBeGreaterThan(0); // the owner keeps it explicitly
  });

  it('TC-006 app_user cannot create a temporary table (42501)', async () => {
    expect(await sqlState(db.appUserUrl, 'CREATE TEMP TABLE t_probe (x int)')).toBe('42501');
    expect(
      await sqlState(db.appUserUrl, 'CREATE TEMPORARY TABLE t_probe (x int) ON COMMIT DROP'),
    ).toBe('42501');
  });

  it('TC-006 the owner can still create a temporary table (backup re-application, restore drill)', async () => {
    expect(await sqlState(db.ownerUrl, 'CREATE TEMP TABLE t_probe (x int)')).toBeUndefined();
  });

  it('TC-006 re-running the migration as the owner is harmless and keeps the result', async () => {
    expect(await sqlState(db.ownerUrl, MIGRATION_SQL)).toBeUndefined();
    expect(await sqlState(db.appUserUrl, 'CREATE TEMP TABLE t_probe (x int)')).toBe('42501');
  });

  it('TC-006 run by a role that does not own the database, the migration fails instead of only warning', async () => {
    // Put PUBLIC's default back, then run the migration as a role that cannot revoke it: REVOKE
    // only warns there, so the check at the end must raise.
    const password = randomBytes(24).toString('hex');
    await withClient(db.ownerUrl, async (client) => {
      await client.query(`CREATE ROLE not_owner LOGIN PASSWORD ${client.escapeLiteral(password)}`);
      await client.query(
        `DO $$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO PUBLIC', current_database()); END $$`,
      );
    });
    try {
      const notOwner = new URL(db.ownerUrl);
      notOwner.username = 'not_owner';
      notOwner.password = password;
      const failure = await withClient(notOwner.toString(), async (client) => {
        try {
          await client.query(MIGRATION_SQL);
          return undefined;
        } catch (error) {
          return error as { code?: string; message?: string };
        }
      });
      expect(failure?.code).toBe('P0001'); // RAISE EXCEPTION
      expect(failure?.message).toContain('app_user still has TEMPORARY on database');
      expect(failure?.message).toContain('not_owner');
    } finally {
      // Back to the migrated state, as the owner.
      await withClient(db.ownerUrl, async (client) => {
        await client.query(MIGRATION_SQL);
        await client.query('DROP ROLE not_owner');
      });
    }
    expect(await sqlState(db.appUserUrl, 'CREATE TEMP TABLE t_probe (x int)')).toBe('42501');
  });
});
