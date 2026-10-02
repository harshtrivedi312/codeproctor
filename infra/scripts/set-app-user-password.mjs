// Gives the local app_user role its password (ADR 0006 section 7.4, brief DB-03).
// The audit_append_only migration creates app_user with no password; no migration may hold one.
// This script runs after `prisma migrate dev` (infra/scripts/db-migrate) and after
// `prisma migrate reset` (infra/scripts/db-reset). It is idempotent.
//
//   node infra/scripts/set-app-user-password.mjs
//
// Local only. It runs the localhost guard first and refuses on any problem. It reads
// APP_USER_PASSWORD from the shell or from the repository-root .env, in the same order as
// prisma.config.ts: values already set in the shell win. It connects as the owner role with
// MIGRATION_DATABASE_URL through the `pg` client (not psql), so the value never appears on a
// command line, and it quotes the value with client.escapeLiteral. It prints only
// "app_user password set". Failure messages never include the password or a URL.
//
// Staging, pilot and production never use this script. They set the password at provisioning,
// from the vault (ADR 0006 section 7.4, D-38).
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseEnv } from 'node:util';
import { findProblems } from './local-db-guard.mjs';

const NAME = 'set-app-user-password';

function fail(message) {
  console.error(`${NAME}: ${message}`);
  process.exit(1);
}

if (process.argv.length > 2) {
  fail('takes no arguments.');
}

// Same .env handling as assert-local-db.mjs and prisma.config.ts: shell values win.
const repoRoot = new URL('../../', import.meta.url);
const envPath = new URL('.env', repoRoot);
let dotenv = {};
if (existsSync(envPath)) {
  dotenv = parseEnv(readFileSync(envPath, 'utf8'));
  process.loadEnvFile(envPath);
}

// 1. The localhost guard, before anything is read or connected.
const problems = findProblems({ env: process.env, dotenv });
if (problems.length > 0) {
  for (const problem of problems) console.error(`${NAME}: ${problem}`);
  fail('refusing to run. This script only touches a local database.');
}

const password = process.env.APP_USER_PASSWORD;
if (password === undefined || password === '') {
  fail('APP_USER_PASSWORD is not set in the shell or in .env.');
}

// 2. `pg` is a dependency of apps/api, not of the repository root, so resolve it from there.
//    It is loaded only after the guard has passed.
const requireFromApi = createRequire(new URL('apps/api/package.json', repoRoot));
let Client;
try {
  ({ Client } = requireFromApi('pg'));
} catch {
  fail('the pg package is not installed. Run pnpm install.');
}

/** A message for a failure. It never uses the driver's own text, which could echo a value. */
function describeFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  switch (code) {
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
      return 'could not connect to the local database. Is the local stack running (pnpm dev:infra)?';
    case '28P01':
    case '28000':
      return 'the owner role was refused. Check MIGRATION_DATABASE_URL and POSTGRES_PASSWORD in .env.';
    case '3D000':
      return 'the database in MIGRATION_DATABASE_URL does not exist.';
    case '42704':
      return 'the app_user role does not exist yet. Run the migrations first (pnpm db:migrate).';
    case '42501':
      return 'the owner role may not change app_user. MIGRATION_DATABASE_URL must be the owner role.';
    default:
      return `failed (${code === '' ? 'no error code' : code}).`;
  }
}

// 3. Connect as the owner role and set the password.
const client = new Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
  connectionTimeoutMillis: 10_000,
});
let failure;
try {
  await client.connect();
  await client.query(`ALTER ROLE app_user WITH PASSWORD ${client.escapeLiteral(password)}`);
} catch (error) {
  failure = describeFailure(error);
} finally {
  await client.end().catch(() => undefined);
}

if (failure !== undefined) {
  fail(failure);
}
console.log('app_user password set');
