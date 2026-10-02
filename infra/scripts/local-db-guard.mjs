// Checks behind the local-only database scripts (db:migrate, db:seed, db:reset).
// ADR 0009 section 4.4, D-31, D-37, review S4. Pure functions, so tests can import them.
// infra/scripts/assert-local-db.mjs runs them. Messages never contain a URL or credentials.
import { execFileSync } from 'node:child_process';

// Prisma's AI-agent consent variable. It may be set only inside infra/scripts/db-reset.
export const CONSENT_VAR = 'PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION';

// libpq settings that can send a connection somewhere other than the host in the URL.
export const LIBPQ_REDIRECT_VARS = ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE'];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const CONNECTION_PARAMS_THAT_OVERRIDE_HOST = new Set(['host', 'hostaddr', 'service']);
const DEFAULT_POSTGRES_PORT = '5432';

/** A host name that is safe to print. Anything else is replaced, so no secret can leak. */
function printable(host) {
  if (host === '') return '(none)';
  return /^[a-z0-9.:[\]-]{1,253}$/.test(host) ? host : '(not printable)';
}

/** Parses a database URL. Returns { url } or { problem }. The problem text never echoes the URL. */
function parseDatabaseUrl(name, raw) {
  if (raw === undefined || raw.trim() === '') {
    return { problem: `${name} is empty or not set.` };
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return { problem: `${name} is not a valid URL.` };
  }
  if (!POSTGRES_PROTOCOLS.has(url.protocol)) {
    return { problem: `${name} is not a postgres:// or postgresql:// URL.` };
  }
  return { url };
}

/** Returns a message when the URL may point away from this machine, otherwise null. */
function urlProblem(name, raw) {
  const { url, problem } = parseDatabaseUrl(name, raw);
  if (url === undefined) return problem;
  const host = url.hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    return `${name} points at host "${printable(host)}", which is not this machine.`;
  }
  // searchParams decodes percent-encoded names, so ?%68ost= is caught as well.
  for (const key of url.searchParams.keys()) {
    if (CONNECTION_PARAMS_THAT_OVERRIDE_HOST.has(key.toLowerCase())) {
      return `${name} (host "${printable(host)}") has a host, hostaddr or service query parameter, which can override the host.`;
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

  for (const name of LIBPQ_REDIRECT_VARS) {
    if (name in env) {
      problems.push(
        `${name} is set. libpq can use it to connect somewhere other than the URL's host.`,
      );
    }
  }

  const migrationProblem = urlProblem('MIGRATION_DATABASE_URL', env.MIGRATION_DATABASE_URL);
  if (migrationProblem) problems.push(migrationProblem);

  if (env.DATABASE_URL !== undefined) {
    const runtimeProblem = urlProblem('DATABASE_URL', env.DATABASE_URL);
    if (runtimeProblem) problems.push(runtimeProblem);
  }

  return problems;
}

/** Reads the port from the output of `docker compose port`, for example "127.0.0.1:5432". */
export function parseComposePort(output) {
  const firstLine = output.split('\n').find((line) => line.trim() !== '') ?? '';
  const match = /:(\d{1,5})$/.exec(firstLine.trim());
  return match?.[1] === undefined ? null : match[1];
}

/**
 * The host port that Docker Compose publishes for the local postgres service (D-37).
 * Throws when Compose is not running or the command fails.
 * @param {string} cwd the repository root
 */
export function readComposePort(cwd) {
  const output = execFileSync(
    'docker',
    ['compose', '-f', 'infra/docker-compose.yml', 'port', 'postgres', '5432'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 },
  );
  const port = parseComposePort(output);
  if (port === null) throw new Error('no published port');
  return port;
}

/**
 * D-37: every database URL must use the port Compose publishes for the local postgres.
 * @param {{ env: Record<string, string | undefined>, composePort: string }} input
 * @returns {string[]}
 */
export function findPortProblems({ env, composePort }) {
  const problems = [];
  const names = [
    'MIGRATION_DATABASE_URL',
    ...(env.DATABASE_URL === undefined ? [] : ['DATABASE_URL']),
  ];
  for (const name of names) {
    const { url } = parseDatabaseUrl(name, env[name]);
    if (url === undefined) continue; // findProblems already reported it
    const port = url.port === '' ? DEFAULT_POSTGRES_PORT : url.port;
    if (port !== composePort) {
      problems.push(
        `${name} uses port ${port}, but the local Compose postgres is published on port ${composePort}.`,
      );
    }
  }
  return problems;
}
