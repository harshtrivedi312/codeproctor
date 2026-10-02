// Guard for the local-only database scripts (db:migrate, db:seed, db:reset).
// ADR 0009 section 4.4, D-31, D-37, review S4. Exits 1 unless every database URL points at this
// machine. It always runs the check: it has no "run only when executed directly" test, so a
// changed path or a different way of starting it cannot skip the check silently.
//
//   node infra/scripts/assert-local-db.mjs                 localhost guard
//   node infra/scripts/assert-local-db.mjs --compose-port  also require the Compose postgres port
//
// Reads .env from the repository root the same way prisma.config.ts does: values already set
// in the shell win. On failure it prints only host names, never a URL or credentials.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { findPortProblems, findProblems, readComposePort } from './local-db-guard.mjs';

const args = process.argv.slice(2);
const wantComposePort = args.includes('--compose-port');
if (args.some((arg) => arg !== '--compose-port')) {
  console.error('assert-local-db: unknown argument. Usage: assert-local-db.mjs [--compose-port]');
  process.exit(1);
}

const repoRoot = new URL('../../', import.meta.url);
const envPath = new URL('.env', repoRoot);
let dotenv = {};
if (existsSync(envPath)) {
  dotenv = parseEnv(readFileSync(envPath, 'utf8'));
  process.loadEnvFile(envPath);
}

const problems = findProblems({ env: process.env, dotenv });

if (wantComposePort && problems.length === 0) {
  let composePort;
  try {
    composePort = readComposePort(fileURLToPath(repoRoot));
  } catch {
    problems.push(
      'Docker Compose did not report a port for the postgres service. Is the local stack running (pnpm dev:infra)?',
    );
  }
  if (composePort !== undefined) {
    problems.push(...findPortProblems({ env: process.env, composePort }));
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`assert-local-db: ${problem}`);
  console.error('assert-local-db: refusing to run. These scripts only touch a local database.');
  process.exit(1);
}
console.log('assert-local-db: database URLs point at this machine.');
