// Gives the local app_user role its password (ADR 0006 section 7.4, brief DB-03).
// The audit_append_only migration creates app_user with no password; no migration may hold one.
// This script runs after `prisma migrate dev` (infra/scripts/db-migrate) and after
// `prisma migrate reset` (infra/scripts/db-reset). It is idempotent.
//
//   node infra/scripts/set-app-user-password.mjs [--if-role-exists]
//
// It checks pg_roles first, so a missing role never reaches the server as an ALTER ROLE statement
// that carries the password (the server could log it). A missing role is an error, unless
// --if-role-exists is given: then the script says so and exits 0. db-migrate passes the flag,
// because `prisma migrate dev --create-only` can run before the audit_append_only migration has
// created the role (FU-DB-26).
//
// Local only. It runs the localhost guard first and refuses on any problem. It reads
// APP_USER_PASSWORD from the shell or from the repository-root .env, in the same order as
// prisma.config.ts: values already set in the shell win. It connects as the owner role with
// MIGRATION_DATABASE_URL through the `pg` client (not psql), so the value never appears on a
// command line, and it quotes the value with client.escapeLiteral. It prints only
// "app_user password set". Failure messages never include the password or a URL.
//
// pg gets exactly the string the guard checked (FU-DB-23). The guard validates the trimmed URL,
// and pg-connection-string treats a leading space, NBSP or BOM differently: it resolves the value
// against a dummy host and sends the whole URL, password included, as the database name. So a
// value that is not already trimmed is refused.
//
// That check does not cover every input. A URL that starts with a C0 control character such as
// \u0001 and then has a space or a bad %-sequence passes both the guard (the URL parser strips the
// control character) and the trim check (trim() does not remove it), and pg-connection-string still
// resolves it against the dummy host. For that input the host check below, made on the host the
// client resolved before connect(), is the only defence (FU-DB-31).
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

const args = process.argv.slice(2);
const ifRoleExists = args.length === 1 && args[0] === '--if-role-exists';
if (args.length > 0 && !ifRoleExists) {
  fail('takes no arguments except --if-role-exists.');
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

// The guard has validated MIGRATION_DATABASE_URL.trim(). Pass pg that exact string or nothing.
// The message names the variable, never its value.
const databaseUrl = process.env.MIGRATION_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl !== databaseUrl.trim()) {
  fail('MIGRATION_DATABASE_URL has leading or trailing whitespace. Remove it.');
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

const SAFE_ERROR_CODE = /^[A-Z0-9_]{1,40}$/;
const ROLE_MISSING =
  'the app_user role does not exist yet. Run the migrations first (pnpm db:migrate).';

/** A message for a failure. It never uses the driver's own text, which could echo a value. */
function describeFailure(error) {
  // Raised while pg parses the URL, before any connection: for example a malformed %-sequence.
  if (error instanceof URIError) {
    return 'MIGRATION_DATABASE_URL could not be parsed. Check it for a malformed %-sequence.';
  }
  // The code comes from the driver or, for a server error, from the server. Print it only when it
  // looks like a code, so nothing else can ride along in it (FU-DB-33).
  const rawCode = typeof error?.code === 'string' ? error.code : '';
  const code = SAFE_ERROR_CODE.test(rawCode) ? rawCode : '';
  switch (code) {
    case 'ENOENT':
      return 'a file named in MIGRATION_DATABASE_URL (for example sslrootcert) was not found.';
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
      return 'could not connect to the local database. Is the local stack running (pnpm dev:infra)?';
    case '28P01':
    case '28000':
      return 'the owner role was refused. Check MIGRATION_DATABASE_URL and POSTGRES_PASSWORD in .env.';
    case '3D000':
      return 'the database in MIGRATION_DATABASE_URL does not exist.';
    case '42704':
      return ROLE_MISSING;
    case '42501':
      return 'the owner role may not change app_user. MIGRATION_DATABASE_URL must be the owner role.';
    default:
      return `failed (${code === '' ? 'no error code' : code}).`;
  }
}

// 3. Connect as the owner role and set the password. The client is built inside the try, so a
//    URL that pg cannot parse ends in our own message and never in a stack trace.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
let client;
let failure;
let skipped = false;
try {
  client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  // An error on a connection with no query running would otherwise be thrown from an event emitter,
  // with a stack trace instead of our message. Ignore it: each query's own promise reports its
  // failures (FU-DB-33).
  client.on('error', () => undefined);
  // Whatever the guard saw, the host pg resolved must be this machine. No host is printed.
  if (!LOOPBACK_HOSTS.has(String(client.host).toLowerCase())) {
    failure =
      'the database client resolved MIGRATION_DATABASE_URL to a host other than this machine. Refusing to connect.';
  } else {
    await client.connect();
    const found = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'app_user'");
    if (found.rowCount === 0) {
      if (ifRoleExists) skipped = true;
      else failure = ROLE_MISSING;
    } else {
      await client.query(`ALTER ROLE app_user WITH PASSWORD ${client.escapeLiteral(password)}`);
    }
  }
} catch (error) {
  failure = describeFailure(error);
} finally {
  await client?.end().catch(() => undefined);
}

if (failure !== undefined) {
  fail(failure);
}
console.log(
  skipped ? 'app_user does not exist yet, so no password was set' : 'app_user password set',
);
