// Refusals that come before the seed connects to anything (DB-04; Q-28; ADR 0009 section 4.4).
//
// The seed gives four staff accounts one well-known password, so it runs only when APP_ENV is
// exactly "development" and only against a database on this machine. `pnpm db:seed` already runs the
// localhost guard first; the seed repeats it, so `prisma db seed` run directly is guarded too.
// Messages name variables and hosts, never a URL, a password or a hash.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/** The development staff password (Q-28). Never printed, logged or placed in a message. */
export const DEMO_PASSWORD = 'ChangeMe!2026';

export class SeedRefusal extends Error {}

export type SeedEnv = Readonly<Record<string, string | undefined>>;

/** A value that is safe to show: short, with no characters that could carry a secret. */
function printable(value: string): string {
  return /^[A-Za-z0-9_.-]{1,32}$/.test(value) ? `"${value}"` : '(not printable)';
}

/** Q-28: only development may seed the known password. Unset, empty or any other value refuses. */
export function requireDevelopment(env: SeedEnv): void {
  if (env.APP_ENV === 'development') return;
  const shown = env.APP_ENV === undefined || env.APP_ENV === '' ? 'unset' : printable(env.APP_ENV);
  throw new SeedRefusal(
    `refusing to seed: APP_ENV is ${shown}. The demo seed creates staff accounts with a known password, ` +
      'so it runs only when APP_ENV is "development" (Q-28). Staging, pilot and production never use it.',
  );
}

export interface DatabaseTarget {
  readonly name: 'DATABASE_URL' | 'MIGRATION_DATABASE_URL';
  readonly url: string;
}

/**
 * The seed reads only DATABASE_URL (app_user, preferred) or, when that is empty, MIGRATION_DATABASE_URL
 * (the owner role). Both are checked by the localhost guard.
 */
export function chooseDatabaseUrl(env: SeedEnv): DatabaseTarget {
  const runtime = env.DATABASE_URL;
  const target: DatabaseTarget =
    runtime !== undefined && runtime !== ''
      ? { name: 'DATABASE_URL', url: runtime }
      : { name: 'MIGRATION_DATABASE_URL', url: env.MIGRATION_DATABASE_URL ?? '' };
  if (target.url === '') {
    throw new SeedRefusal(
      'refusing to seed: neither DATABASE_URL nor MIGRATION_DATABASE_URL is set.',
    );
  }
  // The guard checks the trimmed value; pg-connection-string reads a leading space, NBSP or BOM
  // differently (FU-DB-23). Hand the driver exactly what the guard saw, or nothing.
  if (target.url !== target.url.trim()) {
    throw new SeedRefusal(
      `refusing to seed: ${target.name} has leading or trailing whitespace. Remove it.`,
    );
  }
  return target;
}

/** Runs infra/scripts/assert-local-db.mjs, the guard `pnpm db:seed` runs first. */
export function runLocalGuard(repoRoot: string): void {
  try {
    execFileSync(process.execPath, [resolve(repoRoot, 'infra/scripts/assert-local-db.mjs')], {
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = typeof stderr === 'string' ? stderr.trim() : '';
    throw new SeedRefusal(
      `refusing to seed: the localhost guard failed.${detail === '' ? '' : `\n${detail}`}`,
    );
  }
}

interface PgClientLike {
  readonly host?: string;
}
interface PgModule {
  readonly Client: new (config: { connectionString: string }) => PgClientLike;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Second line of defence, as in set-app-user-password.mjs: the host the driver resolves from the
 * URL must be this machine, whatever the guard parsed. Builds a client and never connects.
 */
export function assertResolvedHostIsLocal(url: string, repoRoot: string): void {
  const requireFromApi = createRequire(resolve(repoRoot, 'apps/api/package.json'));
  const pg = requireFromApi('pg') as PgModule;
  let host: string;
  try {
    host = String(new pg.Client({ connectionString: url }).host);
  } catch {
    throw new SeedRefusal(
      'refusing to seed: the database URL could not be parsed. Check it for a malformed %-sequence.',
    );
  }
  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw new SeedRefusal(
      'refusing to seed: the database client resolved the URL to a host other than this machine.',
    );
  }
}
