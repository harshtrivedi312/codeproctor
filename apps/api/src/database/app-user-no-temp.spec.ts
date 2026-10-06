// app_user has no TEMPORARY and no CREATE on the database (ADR 0006 section 8.8, DL-26).
// PostgreSQL grants TEMPORARY to PUBLIC on every new database; the app_user_no_temp migration
// revokes that, keeps it for the owner, and fails instead of only warning when the running role
// cannot revoke it.
//
// Real Postgres 16 (Testcontainers; Docker is required) with the real migrations. The container's
// own user is a superuser, so the hosted case (an owner without SUPERUSER, as on RDS or Neon) runs
// in a scratch database owned by a NOSUPERUSER role.
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

const OK = 'ok';

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** `OK` when the statement succeeds, else the SQLSTATE (or the message if there is none). */
async function outcome(url: string, sql: string): Promise<string> {
  return withClient(url, async (client) => {
    try {
      await client.query(sql);
      return OK;
    } catch (error) {
      const { code, message } = error as { code?: string; message?: string };
      return code ?? `no SQLSTATE: ${String(message)}`;
    }
  });
}

function urlFor(base: string, user: string, password: string, database?: string): string {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  if (database !== undefined) url.pathname = `/${database}`;
  return url.toString();
}

describe('app_user has no TEMPORARY or CREATE on the database (NFR-04, TC-008; ADR 0006 section 8.8, DL-26)', () => {
  let db: MigratedDatabase;

  beforeAll(async () => {
    db = await startMigratedDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('TC-008 has_database_privilege: app_user has neither TEMPORARY nor CREATE', async () => {
    const row = await withClient(db.appUserUrl, async (client) => {
      const result = await client.query<{ temp: boolean; create: boolean }>(
        `SELECT has_database_privilege('app_user', current_database(), 'TEMPORARY') AS temp,
                has_database_privilege('app_user', current_database(), 'CREATE') AS create`,
      );
      return result.rows[0];
    });
    expect(row).toEqual({ temp: false, create: false });
  });

  it('TC-008 only the database owner holds TEMPORARY in the database ACL, not PUBLIC', async () => {
    const { grantees, owner } = await withClient(db.ownerUrl, async (client) => {
      const result = await client.query<{ grantee: string }>(
        `SELECT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
           FROM pg_database d, aclexplode(d.datacl) a
          WHERE d.datname = current_database() AND a.privilege_type = 'TEMPORARY'
          ORDER BY 1`,
      );
      const datdba = await client.query<{ owner: string }>(
        'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()',
      );
      return { grantees: result.rows.map((r) => r.grantee), owner: datdba.rows[0]?.owner };
    });
    expect(grantees).toEqual([owner]);
  });

  it('TC-008 app_user cannot create a temporary table (42501)', async () => {
    expect(await outcome(db.appUserUrl, 'CREATE TEMP TABLE t_probe (x int)')).toBe('42501');
    expect(
      await outcome(db.appUserUrl, 'CREATE TEMPORARY TABLE t_probe (x int) ON COMMIT DROP'),
    ).toBe('42501');
  });

  it('TC-008 re-running the migration as the owner is harmless and keeps the result', async () => {
    expect(await outcome(db.ownerUrl, MIGRATION_SQL)).toBe(OK);
    expect(await outcome(db.appUserUrl, 'CREATE TEMP TABLE t_probe (x int)')).toBe('42501');
  });

  it('TC-008 a direct grant to app_user is revoked too, not only PUBLIC', async () => {
    await withClient(db.ownerUrl, async (client) => {
      await client.query(
        `DO $$ BEGIN EXECUTE format('GRANT TEMPORARY, CREATE ON DATABASE %I TO app_user', current_database()); END $$`,
      );
    });
    expect(await outcome(db.appUserUrl, 'CREATE TEMP TABLE t_probe (x int)')).toBe(OK);
    expect(await outcome(db.ownerUrl, MIGRATION_SQL)).toBe(OK);
    expect(await outcome(db.appUserUrl, 'CREATE TEMP TABLE t_probe (x int)')).toBe('42501');
  });

  it('TC-008 an owner without SUPERUSER (as on RDS or Neon) can run it and keeps TEMPORARY', async () => {
    const password = randomBytes(24).toString('hex');
    await withClient(db.ownerUrl, async (client) => {
      await client.query(
        `CREATE ROLE ns_owner LOGIN NOSUPERUSER PASSWORD ${client.escapeLiteral(password)}`,
      );
      await client.query('CREATE DATABASE scratch_ns OWNER ns_owner');
    });
    try {
      const nsOwner = urlFor(db.ownerUrl, 'ns_owner', password, 'scratch_ns');
      expect(await outcome(nsOwner, MIGRATION_SQL)).toBe(OK);
      expect(await outcome(nsOwner, 'CREATE TEMP TABLE t_probe (x int)')).toBe(OK);
      const appUserInScratch = new URL(db.appUserUrl);
      appUserInScratch.pathname = '/scratch_ns';
      expect(await outcome(appUserInScratch.toString(), 'CREATE TEMP TABLE t_probe (x int)')).toBe(
        '42501',
      );
    } finally {
      await withClient(db.ownerUrl, async (client) => {
        await client.query('DROP DATABASE IF EXISTS scratch_ns');
        await client.query('DROP ROLE IF EXISTS ns_owner');
      });
    }
  });

  it('TC-008 run by a role that does not own the database, the migration fails instead of only warning', async () => {
    // Put PUBLIC's default back, then run the migration as a role that cannot revoke it: REVOKE
    // only warns there, so the check at the end must raise.
    const password = randomBytes(24).toString('hex');
    await withClient(db.ownerUrl, async (client) => {
      await client.query(`CREATE ROLE not_owner LOGIN PASSWORD ${client.escapeLiteral(password)}`);
      await client.query(
        `DO $$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO PUBLIC', current_database()); END $$`,
      );
    });
    let failure: { code?: string; message?: string } | undefined;
    try {
      failure = await withClient(urlFor(db.ownerUrl, 'not_owner', password), async (client) => {
        try {
          await client.query(MIGRATION_SQL);
          return undefined;
        } catch (error) {
          return error as { code?: string; message?: string };
        }
      });
    } finally {
      // Back to the migrated state, as the owner. A failure here must not hide the one above.
      await withClient(db.ownerUrl, async (client) => {
        await client.query(MIGRATION_SQL);
        await client.query('DROP ROLE IF EXISTS not_owner');
      }).catch(() => undefined);
    }
    expect(failure?.code).toBe('P0001'); // RAISE EXCEPTION
    expect(failure?.message).toContain('app_user still has TEMPORARY or CREATE on database');
    expect(failure?.message).toContain('not_owner');
    expect(await outcome(db.appUserUrl, 'CREATE TEMP TABLE t_probe (x int)')).toBe('42501');
  });
});
