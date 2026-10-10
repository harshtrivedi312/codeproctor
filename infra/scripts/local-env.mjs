// Writes a working local .env (and apps/web/.env.local) for docs/local-run.md.
//
//   node infra/scripts/local-env.mjs [--dir <repository root>] [--top-up]
//
// Copies .env.example and replaces every `change-me` with a fresh random value, so a local run needs
// no hand editing and no two machines share a secret. The database passwords are random too, and the
// two database URLs carry the same ones. It also writes apps/web/.env.local with the API base URL the
// web app needs (the API serves under /api, which the web default http://localhost:4000 lacks) and the
// MinIO origin the browser may upload to and play recordings from (NEXT_PUBLIC_UPLOAD_ORIGINS feeds the
// CSP connect-src; it must be the origin of the presigned URLs, i.e. S3_ENDPOINT).
//
// `--top-up` is for an .env that already exists: it APPENDS the independent secrets that .env.example
// has gained since (for example QUESTION_OPTION_ID_SECRET) and that the file lacks, and touches
// nothing else (database and object-store passwords stay as they are). It prints the names only.
//
// Local development only: the values are for a database on this machine. It never overwrites a file
// that exists or rewrites a value in it (delete it first to start again), and it never prints a value. Staging, pilot and
// production load their secrets from their own stores (ADR 0009), not from this script.
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NAME = 'local-env';

/**
 * Generated values that depend on another value (the two database URLs carry the passwords, the S3
 * secret is the MinIO login, the Judge0 ones belong to databases that may already exist): never
 * appended by `--top-up`, since a new value would disagree with what is already running.
 */
export const COUPLED = new Set([
  'POSTGRES_PASSWORD',
  'APP_USER_PASSWORD',
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'MINIO_ROOT_PASSWORD',
  'S3_SECRET_ACCESS_KEY',
  'JUDGE0_AUTH_TOKEN',
  'JUDGE0_AUTHZ_TOKEN',
  'JUDGE0_DB_PASSWORD',
  'JUDGE0_REDIS_PASSWORD',
]);

/**
 * What `--top-up` may append: independent random secrets only. An allowlist, so a future key that
 * depends on something already running is never appended by default.
 */
export const INDEPENDENT = [
  'JWT_ACCESS_SECRET',
  'COOKIE_SECRET',
  'JWT_CANDIDATE_SECRET',
  'OTP_PEPPER',
  'QUESTION_OPTION_ID_SECRET',
];

const hex = (bytes) => randomBytes(bytes).toString('hex');
const b64 = (bytes) => randomBytes(bytes).toString('base64');

/**
 * The .env text for a local run, built from the text of .env.example. Pure apart from randomness.
 * `supports` says which local-only API features exist in this checkout (see `detectSupport`): when the
 * API supports them, the commented demo lines (the dev mail sink, the execution stub) are switched on.
 */
export function buildLocalEnv(example, supports = { smtpDev: false, execStub: false }) {
  const values = generatedValues();
  const lines = example.split('\n').map((line) => {
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (m === null || !(m[1] in values)) return line;
    return `${m[1]}=${values[m[1]]}`;
  });
  let text = lines.join('\n');
  if (!/^WORKER_HMAC_KEY=/m.test(text)) text += workerBlock();
  if (supports.smtpDev) {
    text = text
      .replace(/^EMAIL_PROVIDER=noop$/m, 'EMAIL_PROVIDER=smtp-dev')
      .replace(/^# (SMTP_DEV_HOST=.*)$/m, '$1')
      .replace(/^# (SMTP_DEV_PORT=.*)$/m, '$1');
  }
  if (supports.execStub) text = text.replace(/^# (JUDGE0_MODE=stub)$/m, '$1');
  // Anything still marked change-me would stop the API or ship a known value: refuse instead.
  const left = [...text.matchAll(/^([A-Za-z0-9_]+)=.*change-me/gm)].map((m) => m[1]);
  if (left.length > 0) throw new Error(`no local value is known for: ${left.join(', ')}`);
  return text;
}

/** A fresh set of the generated local values (keys that .env.example marks change-me). */
function generatedValues() {
  const postgresPassword = hex(16);
  const appUserPassword = hex(16);
  const minioPassword = hex(16);
  const values = {
    POSTGRES_PASSWORD: postgresPassword,
    APP_USER_PASSWORD: appUserPassword,
    DATABASE_URL: `postgresql://app_user:${appUserPassword}@127.0.0.1:5432/codeproctor`,
    MIGRATION_DATABASE_URL: `postgresql://codeproctor:${postgresPassword}@127.0.0.1:5432/codeproctor`,
    JWT_ACCESS_SECRET: b64(48),
    COOKIE_SECRET: b64(48),
    JWT_CANDIDATE_SECRET: b64(48),
    OTP_PEPPER: b64(48),
    QUESTION_OPTION_ID_SECRET: b64(48),
    ENCRYPTION_KEY: b64(32),
    SESSION_KEY_ENC_KEY_k1: b64(32),
    MINIO_ROOT_PASSWORD: minioPassword,
    S3_SECRET_ACCESS_KEY: minioPassword,
    JUDGE0_AUTH_TOKEN: hex(24),
    JUDGE0_AUTHZ_TOKEN: hex(24),
    JUDGE0_DB_PASSWORD: hex(16),
    JUDGE0_REDIS_PASSWORD: hex(16),
  };
  return values;
}

/**
 * The lines to append to an existing .env (pure apart from randomness): a fresh random value for every
 * key that .env.example still marks `change-me`, that is in INDEPENDENT (an allowlist: nothing else is
 * ever appended) and that `existing` does not define. A key counts as defined for `KEY=`, `export
 * KEY=`, ` KEY =` and any value, even an empty or placeholder one; only a commented-out line does not.
 * Returns { keys, text, unknown }: `text` is '' when nothing is missing; `unknown` names the
 * `change-me` keys of the example that have no independent generator (the script cannot fill them).
 */
export function topUpLocalEnv(example, existing) {
  const generated = generatedValues();
  const wanted = [...example.matchAll(/^([A-Za-z0-9_]+)=.*change-me/gm)].map((m) => m[1]);
  const defined = new Set(
    [...existing.matchAll(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=/gm)].map((m) => m[1]),
  );
  const keys = wanted.filter((k) => INDEPENDENT.includes(k) && !defined.has(k));
  const unknown = wanted.filter(
    (k) => !INDEPENDENT.includes(k) && !COUPLED.has(k) && !defined.has(k),
  );
  if (keys.length === 0) return { keys, text: '', unknown };
  const lead = existing === '' || existing.endsWith('\n') ? '' : '\n';
  const block = [
    '# --- appended by `node infra/scripts/local-env.mjs --top-up`: secrets added to .env.example later ---',
    ...keys.map((k) => `${k}=${generated[k]}`),
    '',
  ].join('\n');
  return { keys, text: `${lead}${block}`, unknown };
}

/** The face-match worker's local settings (apps/worker/tools/be08/run-local.sh): a fresh signing key per machine. */
function workerBlock() {
  return [
    '',
    '# --- Face-match worker, local demo (apps/worker/tools/be08/run-local.sh; ADR 0014) ---',
    '# The signing key is shared with the API once it has a worker client (none on main yet); the origin',
    '# must equal S3_ENDPOINT exactly. Without the model files the worker reports not ready and the',
    '# identity check answers MANUAL_REVIEW.',
    'WORKER_BASE_URL=http://127.0.0.1:8000',
    'WORKER_HMAC_KEY_ID=local1',
    `WORKER_HMAC_KEY=${b64(32)}`,
    'WORKER_OBJECT_STORE_BUCKET=codeproctor-media',
    'WORKER_OBJECT_STORE_ORIGINS=http://127.0.0.1:9000',
    '',
  ].join('\n');
}

/** Which local-only API features this checkout has: read from the API's environment schema. */
export function detectSupport(root) {
  let schema = '';
  try {
    schema = readFileSync(join(root, 'apps/api/src/config/env.ts'), 'utf8');
  } catch {
    // No API sources: nothing is switched on.
  }
  return { smtpDev: schema.includes("'smtp-dev'"), execStub: /JUDGE0_MODE\s*:/.test(schema) };
}

export const WEB_ENV_LOCAL = [
  'NEXT_PUBLIC_API_URL=http://localhost:4000/api',
  'NEXT_PUBLIC_UPLOAD_ORIGINS=http://127.0.0.1:9000',
  '',
].join('\n');

function main() {
  let args = process.argv.slice(2);
  const topUp = args.includes('--top-up');
  args = args.filter((a) => a !== '--top-up');
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  if (args.length === 2 && args[0] === '--dir') root = resolve(args[1]);
  else if (args.length > 0) {
    console.error(
      `${NAME}: usage: node infra/scripts/local-env.mjs [--dir <repository root>] [--top-up]`,
    );
    process.exit(1);
  }
  const examplePath = join(root, '.env.example');
  const envPath = join(root, '.env');
  const webPath = join(root, 'apps/web/.env.local');
  if (!existsSync(examplePath)) {
    console.error(`${NAME}: ${examplePath} does not exist.`);
    process.exit(1);
  }
  if (topUp) {
    if (!existsSync(envPath)) {
      console.error(`${NAME}: --top-up needs an existing .env; run without it to write one.`);
      process.exit(1);
    }
    try {
      const existing = readFileSync(envPath, 'utf8');
      // Local development only (ADR 0009): never write into an .env that is not one.
      if (!/^\s*APP_ENV\s*=\s*development\s*$/m.test(existing)) {
        console.error(
          `${NAME}: .env does not say APP_ENV=development; --top-up is for a local run only.`,
        );
        process.exit(1);
      }
      const { keys, text, unknown } = topUpLocalEnv(readFileSync(examplePath, 'utf8'), existing);
      if (unknown.length > 0)
        console.error(
          `${NAME}: warning: .env.example asks for ${unknown.join(', ')} and this script has no local value for it; set it by hand.`,
        );
      if (keys.length === 0) {
        console.log('.env has every secret this script can generate; nothing appended.');
        return;
      }
      appendFileSync(envPath, text, { mode: 0o600 });
      console.log(
        `appended ${keys.length} missing secret(s) to .env: ${keys.join(', ')} (existing values untouched).`,
      );
    } catch (error) {
      console.error(`${NAME}: ${error instanceof Error ? error.message : 'failed.'}`);
      process.exit(1);
    }
    return;
  }
  if (existsSync(envPath)) {
    console.error(
      `${NAME}: .env already exists and is left as it is. Delete it first to start again.`,
    );
    process.exit(1);
  }
  let text;
  const notes = [];
  try {
    const supports = detectSupport(root);
    text = buildLocalEnv(readFileSync(examplePath, 'utf8'), supports);
    notes.push(
      supports.smtpDev
        ? 'mail: Mailpit (smtp-dev) is on.'
        : 'mail: the API has no dev mail sink yet; mail is dropped (noop).',
      supports.execStub
        ? 'execution: the local stub is on.'
        : 'execution: the API has no local stub yet.',
    );
  } catch (error) {
    console.error(`${NAME}: ${error instanceof Error ? error.message : 'failed.'}`);
    process.exit(1);
  }
  writeFileSync(envPath, text, { mode: 0o600, flag: 'wx' });
  console.log('wrote .env (random local secrets; git-ignored).');
  for (const note of notes) console.log(note);
  if (existsSync(webPath)) {
    console.log('apps/web/.env.local already exists and is left as it is.');
  } else {
    mkdirSync(dirname(webPath), { recursive: true });
    writeFileSync(webPath, WEB_ENV_LOCAL, { flag: 'wx' });
    console.log('wrote apps/web/.env.local (the API base URL for the web app).');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
