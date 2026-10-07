// Gives one seeded, not-yet-started invitation a link you can open (docs/local-run.md).
//
//   node infra/scripts/demo-invite.mjs
//
// `pnpm db:seed` creates invitations whose token hashes are placeholders, so no link opens. This
// picks the seeded candidate whose session is still INVITED, stores the SHA-256 of a fresh random
// token on the invitation (the API looks a link up by that hash, FR-106), opens its window from one
// hour ago to seven days from now, and prints the link. Run it again for a new link; the old one
// stops working. It prints the candidate's email too: the one-time code goes to that address.
//
// Local development only. It refuses unless APP_ENV is "development" and every database URL is on
// this machine (the same localhost guard as pnpm db:seed), and connects as the owner role with
// MIGRATION_DATABASE_URL through `pg`. Synthetic seed data only; it never prints a URL or password.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseEnv } from 'node:util';
import { findProblems } from './local-db-guard.mjs';

const NAME = 'demo-invite';
const WEB_ORIGIN = 'http://localhost:3000';

function fail(message) {
  console.error(`${NAME}: ${message}`);
  process.exit(1);
}

if (process.argv.length > 2) fail('takes no arguments.');

// Same .env handling as the other local scripts: shell values win.
const repoRoot = new URL('../../', import.meta.url);
const envPath = new URL('.env', repoRoot);
let dotenv = {};
if (existsSync(envPath)) {
  dotenv = parseEnv(readFileSync(envPath, 'utf8'));
  process.loadEnvFile(envPath);
}

if (process.env.APP_ENV !== 'development') {
  fail('APP_ENV must be "development": the demo invitation is for a local database only.');
}
const problems = findProblems({ env: process.env, dotenv });
if (problems.length > 0) {
  for (const problem of problems) console.error(`${NAME}: ${problem}`);
  fail('refusing to run. This script only touches a local database.');
}
const databaseUrl = process.env.MIGRATION_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl !== databaseUrl.trim()) {
  fail('MIGRATION_DATABASE_URL is not set, or has leading or trailing whitespace.');
}

const requireFromApi = createRequire(new URL('apps/api/package.json', repoRoot));
let Client;
try {
  ({ Client } = requireFromApi('pg'));
} catch {
  fail('the pg package is not installed. Run pnpm install.');
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const SAFE_ERROR_CODE = /^[A-Z0-9_]{1,40}$/;
const token = randomBytes(32).toString('base64url');
const tokenHash = createHash('sha256').update(token).digest('hex');

let client;
try {
  client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  client.on('error', () => undefined);
  if (!LOOPBACK_HOSTS.has(String(client.host).toLowerCase())) {
    fail('the database client resolved MIGRATION_DATABASE_URL to a host other than this machine.');
  }
  await client.connect();
  await client.query('BEGIN');
  const picked = await client.query(
    `SELECT i.id, c.email
       FROM invitations i
       JOIN sessions s ON s.invitation_id = i.id AND s.org_id = i.org_id
       JOIN candidates c ON c.id = i.candidate_id AND c.org_id = i.org_id
      WHERE s.status = 'INVITED'
      ORDER BY i.created_at, i.id
      LIMIT 1
      FOR UPDATE OF i`,
  );
  if (picked.rowCount === 0) {
    await client.query('ROLLBACK');
    fail('no seeded invitation is still INVITED. Run pnpm db:seed on a fresh database first.');
  }
  const { id, email } = picked.rows[0];
  await client.query(
    `UPDATE invitations
        SET token_hash = $1,
            window_start = now() - interval '1 hour',
            window_end = now() + interval '7 days',
            used_at = NULL
      WHERE id = $2`,
    [tokenHash, id],
  );
  await client.query('COMMIT');
  console.log(`candidate: ${email}`);
  console.log(`link:      ${WEB_ORIGIN}/t/${token}`);
  console.log(
    'The window is open for seven days. The one-time code is emailed to the address above.',
  );
} catch (error) {
  const rawCode = typeof error?.code === 'string' ? error.code : '';
  const code = SAFE_ERROR_CODE.test(rawCode) ? rawCode : '';
  try {
    await client?.query('ROLLBACK');
  } catch {
    // The connection may be gone: nothing to roll back.
  }
  if (code === 'ECONNREFUSED') {
    fail('could not connect to the local database. Is the local stack running?');
  }
  fail(`failed (${code === '' ? 'no error code' : code}).`);
} finally {
  await client?.end().catch(() => undefined);
}
