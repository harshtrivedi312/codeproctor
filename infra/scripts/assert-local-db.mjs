// Guard for the local-only database scripts (db:migrate, db:seed, db:reset).
// ADR 0009 section 4.4, D-31, review S4. Exits 1 unless every database URL points at this machine.
//
// Reads .env from the repository root the same way prisma.config.ts does: values already set
// in the shell win. On failure it prints only the host name, never a URL or credentials.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { parseEnv } from 'node:util';

// Prisma's AI-agent consent variable. It may be set only inside infra/scripts/db-reset.
export const CONSENT_VAR = 'PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const CONNECTION_PARAMS_THAT_OVERRIDE_HOST = new Set(['host', 'hostaddr']);

/** A host name that is safe to print. Anything else is replaced, so no secret can leak. */
function printable(host) {
  if (host === '') return '(none)';
  return /^[a-z0-9.:[\]-]{1,253}$/.test(host) ? host : '(not printable)';
}

/** Returns a message when the URL may point away from this machine, otherwise null. */
function urlProblem(name, raw) {
  if (raw === undefined || raw.trim() === '') {
    return `${name} is empty or not set.`;
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return `${name} is not a valid URL.`;
  }
  const host = url.hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    return `${name} points at host "${printable(host)}", which is not this machine.`;
  }
  for (const key of url.searchParams.keys()) {
    if (CONNECTION_PARAMS_THAT_OVERRIDE_HOST.has(key.toLowerCase())) {
      return `${name} (host "${printable(host)}") has a host or hostaddr query parameter, which can override the host.`;
    }
  }
  return null;
}

/**
 * @param {{ env: Record<string, string | undefined>, dotenv?: Record<string, string | undefined> }} input
 *   env is the effective environment (shell values win over .env); dotenv is the parsed .env file.
 * @returns {string[]} one message per problem; empty when the guard passes
 */
export function findProblems({ env, dotenv = {} }) {
  const problems = [];

  if (CONSENT_VAR in env || CONSENT_VAR in dotenv) {
    problems.push(
      `${CONSENT_VAR} is set in the environment or in .env. ` +
        'It may be set only inside infra/scripts/db-reset (ADR 0009 section 4.4).',
    );
  }

  const migrationProblem = urlProblem('MIGRATION_DATABASE_URL', env.MIGRATION_DATABASE_URL);
  if (migrationProblem) problems.push(migrationProblem);

  if (env.DATABASE_URL !== undefined) {
    const runtimeProblem = urlProblem('DATABASE_URL', env.DATABASE_URL);
    if (runtimeProblem) problems.push(runtimeProblem);
  }

  return problems;
}

function main() {
  const envPath = new URL('../../.env', import.meta.url);
  let dotenv = {};
  if (existsSync(envPath)) {
    dotenv = parseEnv(readFileSync(envPath, 'utf8'));
    process.loadEnvFile(envPath);
  }

  const problems = findProblems({ env: process.env, dotenv });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`assert-local-db: ${problem}`);
    console.error('assert-local-db: refusing to run. These scripts only touch a local database.');
    process.exit(1);
  }
  console.log('assert-local-db: database URLs point at this machine.');
}

// Run main() only when executed directly, so tests can import findProblems.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename) {
  main();
}
