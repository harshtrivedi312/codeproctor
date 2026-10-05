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

export interface MigratedDatabase {
  /** Connection string of the schema owner (the container's user). Use it for fixtures and checks. */
  readonly ownerUrl: string;
  /** Connection string of app_user, as the API connects at runtime. */
  readonly appUserUrl: string;
  stop(): Promise<void>;
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

export async function startMigratedDatabase(): Promise<MigratedDatabase> {
  const container = await new PostgreSqlContainer('postgres:16').start();
  try {
    const ownerUrl = container.getConnectionUri();
    migrateDeploy(ownerUrl);

    const password = randomBytes(24).toString('hex');
    await setAppUserPassword(ownerUrl, password);
    const appUser = new URL(ownerUrl);
    appUser.username = 'app_user';
    appUser.password = password;

    return {
      ownerUrl,
      appUserUrl: appUser.toString(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (error) {
    await container.stop();
    throw error;
  }
}
