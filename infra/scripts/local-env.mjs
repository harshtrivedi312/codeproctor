// Writes a working local .env (and apps/web/.env.local) for docs/local-run.md.
//
//   node infra/scripts/local-env.mjs [--dir <repository root>]
//
// Copies .env.example and replaces every `change-me` with a fresh random value, so a local run needs
// no hand editing and no two machines share a secret. The database passwords are random too, and the
// two database URLs carry the same ones. It also writes apps/web/.env.local with the API base URL the
// web app needs (the API serves under /api, which the web default http://localhost:4000 lacks).
//
// Local development only: the values are for a database on this machine. It never overwrites a file
// that exists (delete it first to start again), and it never prints a value. Staging, pilot and
// production load their secrets from their own stores (ADR 0009), not from this script.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NAME = 'local-env';

const hex = (bytes) => randomBytes(bytes).toString('hex');
const b64 = (bytes) => randomBytes(bytes).toString('base64');

/** The .env text for a local run, built from the text of .env.example. Pure apart from randomness. */
export function buildLocalEnv(example) {
  const postgresPassword = hex(16);
  const appUserPassword = hex(16);
  const values = {
    POSTGRES_PASSWORD: postgresPassword,
    APP_USER_PASSWORD: appUserPassword,
    DATABASE_URL: `postgresql://app_user:${appUserPassword}@127.0.0.1:5432/codeproctor`,
    MIGRATION_DATABASE_URL: `postgresql://codeproctor:${postgresPassword}@127.0.0.1:5432/codeproctor`,
    JWT_ACCESS_SECRET: b64(48),
    COOKIE_SECRET: b64(48),
    JWT_CANDIDATE_SECRET: b64(48),
    OTP_PEPPER: b64(48),
    ENCRYPTION_KEY: b64(32),
    SESSION_KEY_ENC_KEY_k1: b64(32),
    JUDGE0_AUTH_TOKEN: hex(24),
    JUDGE0_AUTHZ_TOKEN: hex(24),
    JUDGE0_DB_PASSWORD: hex(16),
    JUDGE0_REDIS_PASSWORD: hex(16),
  };
  const lines = example.split('\n').map((line) => {
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (m === null || !(m[1] in values)) return line;
    return `${m[1]}=${values[m[1]]}`;
  });
  const text = lines.join('\n');
  // Anything still marked change-me would stop the API or ship a known value: refuse instead.
  const left = [...text.matchAll(/^([A-Za-z0-9_]+)=.*change-me/gm)].map((m) => m[1]);
  if (left.length > 0) throw new Error(`no local value is known for: ${left.join(', ')}`);
  return text;
}

export const WEB_ENV_LOCAL = 'NEXT_PUBLIC_API_URL=http://localhost:4000/api\n';

function main() {
  const args = process.argv.slice(2);
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  if (args.length === 2 && args[0] === '--dir') root = resolve(args[1]);
  else if (args.length > 0) {
    console.error(`${NAME}: usage: node infra/scripts/local-env.mjs [--dir <repository root>]`);
    process.exit(1);
  }
  const examplePath = join(root, '.env.example');
  const envPath = join(root, '.env');
  const webPath = join(root, 'apps/web/.env.local');
  if (!existsSync(examplePath)) {
    console.error(`${NAME}: ${examplePath} does not exist.`);
    process.exit(1);
  }
  if (existsSync(envPath)) {
    console.error(
      `${NAME}: .env already exists and is left as it is. Delete it first to start again.`,
    );
    process.exit(1);
  }
  let text;
  try {
    text = buildLocalEnv(readFileSync(examplePath, 'utf8'));
  } catch (error) {
    console.error(`${NAME}: ${error instanceof Error ? error.message : 'failed.'}`);
    process.exit(1);
  }
  writeFileSync(envPath, text, { mode: 0o600, flag: 'wx' });
  console.log('wrote .env (random local secrets; git-ignored).');
  if (existsSync(webPath)) {
    console.log('apps/web/.env.local already exists and is left as it is.');
  } else {
    mkdirSync(dirname(webPath), { recursive: true });
    writeFileSync(webPath, WEB_ENV_LOCAL, { flag: 'wx' });
    console.log('wrote apps/web/.env.local (the API base URL for the web app).');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
