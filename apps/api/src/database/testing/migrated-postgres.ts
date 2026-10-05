// A throwaway Postgres 16 with the real migrations applied, for the database tests (ADR 0009
// section 4.2, DB-05, DB-08). Docker is required.
//
// 1. Start postgres:16 (Testcontainers). The container's own user owns the schema.
// 2. Apply the real migrations with `prisma migrate deploy` as that owner (MIGRATION_DATABASE_URL
//    points at the container only). The audit_append_only migration creates app_user.
// 3. Give app_user a random password for this run (ADR 0006 section 7.4). infra/scripts/
//    set-app-user-password.mjs cannot be reused: it refuses any database that is not the local
//    Compose Postgres on port 5432.
// The tests then connect as app_user through the real client factory, so they run against the real
// grants. Nothing here ever touches the development database.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';

const REPO_ROOT = resolve(__dirname, '../../../../..');

/** One distinct SQL statement as Postgres saw it (parameters shown as $1, $2) and how often it ran. */
export interface StatementCount {
  readonly query: string;
  readonly calls: number;
}

export interface MigratedDatabase {
  /** Connection string of the schema owner (the container's user). Use it for fixtures and checks. */
  readonly ownerUrl: string;
  /** Connection string of app_user, as the API connects at runtime. */
  readonly appUserUrl: string;
  /**
   * Statements app_user has sent to Postgres, from pg_stat_statements. Only with
   * `statementStats: true`: Postgres is then started with the extension preloaded.
   */
  readonly statements: {
    reset(): Promise<void>;
    read(): Promise<StatementCount[]>;
  };
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Record every statement app_user sends (pg_stat_statements), for statement-count tests. */
  readonly statementStats?: boolean;
}

function prismaCli(): string {
  return createRequire(resolve(REPO_ROOT, 'package.json')).resolve('prisma/build/index.js');
}

function migrateDeploy(ownerUrl: string): void {
  // Never run a migration against a database that is not a fresh throwaway container.
  const { hostname, port } = new URL(ownerUrl);
  if (!['localhost', '127.0.0.1'].includes(hostname) || port === '5432') {
    throw new Error('Refusing to migrate: the test database must be a Testcontainers instance.');
  }
  execFileSync(process.execPath, [prismaCli(), 'migrate', 'deploy'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // The shell's value wins over the repository .env that prisma.config.ts loads.
      MIGRATION_DATABASE_URL: ownerUrl,
      // No update check or telemetry call from a test.
      CHECKPOINT_DISABLE: '1',
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
    },
    stdio: 'pipe',
  });
}

async function setAppUserPassword(ownerUrl: string, password: string): Promise<void> {
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query(`ALTER ROLE app_user WITH PASSWORD ${client.escapeLiteral(password)}`);
  } finally {
    await client.end();
  }
}

async function ownerQuery<T extends Record<string, unknown>>(
  ownerUrl: string,
  sql: string,
): Promise<T[]> {
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

export async function startMigratedDatabase(options: StartOptions = {}): Promise<MigratedDatabase> {
  let image = new PostgreSqlContainer('postgres:16');
  if (options.statementStats === true) {
    // Arguments for the postgres server (the image entrypoint adds the command name).
    image = image.withCommand([
      '-c',
      'shared_preload_libraries=pg_stat_statements',
      '-c',
      'pg_stat_statements.track=all',
      '-c',
      'pg_stat_statements.track_utility=on',
      '-c',
      'pg_stat_statements.max=10000',
    ]);
  }
  const container = await image.start();
  try {
    const ownerUrl = container.getConnectionUri();
    migrateDeploy(ownerUrl);
    if (options.statementStats === true) {
      await ownerQuery(ownerUrl, 'CREATE EXTENSION pg_stat_statements');
    }

    const password = randomBytes(24).toString('hex');
    await setAppUserPassword(ownerUrl, password);
    const appUser = new URL(ownerUrl);
    appUser.username = 'app_user';
    appUser.password = password;

    const statements = {
      reset: async (): Promise<void> => {
        await ownerQuery(ownerUrl, 'SELECT pg_stat_statements_reset()');
      },
      read: async (): Promise<StatementCount[]> => {
        const rows = await ownerQuery<{ query: string; calls: number }>(
          ownerUrl,
          `SELECT query, calls::int AS calls FROM pg_stat_statements
           WHERE userid = (SELECT oid FROM pg_roles WHERE rolname = 'app_user')
             AND dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
           ORDER BY query`,
        );
        return rows.map((row) => ({ query: row.query, calls: row.calls }));
      },
    };

    return {
      ownerUrl,
      appUserUrl: appUser.toString(),
      statements,
      stop: async () => {
        await container.stop();
      },
    };
  } catch (error) {
    await container.stop();
    throw error;
  }
}
