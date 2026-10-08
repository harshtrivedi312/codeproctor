// Writes a working local .env (and apps/web/.env.local) for docs/local-run.md.
//
//   node infra/scripts/local-env.mjs [--dir <repository root>]
//
// Copies .env.example and replaces every `change-me` with a fresh random value, so a local run needs
// no hand editing and no two machines share a secret. The database passwords are random too, and the
// two database URLs carry the same ones. It also writes apps/web/.env.local with the API base URL the
// web app needs (the API serves under /api, which the web default http://localhost:4000 lacks) and the
// MinIO origin the browser may upload to and play recordings from (NEXT_PUBLIC_UPLOAD_ORIGINS feeds the
// CSP connect-src; it must be the origin of the presigned URLs, i.e. S3_ENDPOINT).
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

/**
 * The .env text for a local run, built from the text of .env.example. Pure apart from randomness.
 * `supports` says which local-only API features exist in this checkout (see `detectSupport`): when the
 * API supports them, the commented demo lines (the dev mail sink, the execution stub) are switched on.
 */
export function buildLocalEnv(example, supports = { smtpDev: false, execStub: false }) {
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
    ENCRYPTION_KEY: b64(32),
    SESSION_KEY_ENC_KEY_k1: b64(32),
    MINIO_ROOT_PASSWORD: minioPassword,
    S3_SECRET_ACCESS_KEY: minioPassword,
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
