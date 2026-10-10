// local-env.mjs (docs/local-run.md): the .env it writes is complete, consistent and local.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { findProblems } from './local-db-guard.mjs';
import { REPO_ROOT } from './test-support.mjs';
import { COUPLED, INDEPENDENT, buildLocalEnv, detectSupport, topUpLocalEnv } from './local-env.mjs';

const SCRIPT = `${REPO_ROOT}infra/scripts/local-env.mjs`;

describe('local-env (local demo)', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'local-env-'));
    copyFileSync(`${REPO_ROOT}.env.example`, join(dir, '.env.example'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const run = (...args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });

  it('writes .env and apps/web/.env.local, never prints a value, and never overwrites', () => {
    const r = run('--dir', dir);
    assert.equal(r.status, 0, r.stderr);
    const env = parseEnv(readFileSync(join(dir, '.env'), 'utf8'));
    for (const secret of [env.JWT_ACCESS_SECRET, env.COOKIE_SECRET, env.POSTGRES_PASSWORD])
      assert.doesNotMatch(r.stdout + r.stderr, new RegExp(secret.replace(/[+/=]/g, '.')));
    const web = parseEnv(readFileSync(join(dir, 'apps/web/.env.local'), 'utf8'));
    assert.equal(web.NEXT_PUBLIC_API_URL, 'http://localhost:4000/api');
    // The CSP connect-src needs the MinIO origin that the presigned URLs carry (S3_ENDPOINT).
    assert.equal(web.NEXT_PUBLIC_UPLOAD_ORIGINS, 'http://127.0.0.1:9000');
    if (process.platform !== 'win32')
      assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600, '.env is private to the user');
    const before = readFileSync(join(dir, '.env'), 'utf8');
    const again = run('--dir', dir);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already exists/);
    assert.equal(readFileSync(join(dir, '.env'), 'utf8'), before);
  });

  it('every change-me is replaced, secrets are long enough, and the two database URLs match the passwords', () => {
    const text = readFileSync(join(dir, '.env'), 'utf8');
    const env = parseEnv(text);
    for (const [k, v] of Object.entries(env)) assert.doesNotMatch(v, /change-me/, k);
    for (const k of ['JWT_ACCESS_SECRET', 'COOKIE_SECRET', 'JWT_CANDIDATE_SECRET', 'OTP_PEPPER'])
      assert.ok(env[k].length >= 32, k);
    for (const k of ['ENCRYPTION_KEY', 'SESSION_KEY_ENC_KEY_k1'])
      assert.equal(Buffer.from(env[k], 'base64').length, 32, k);
    assert.notEqual(env.JWT_ACCESS_SECRET, env.JWT_CANDIDATE_SECRET);
    assert.equal(new URL(env.DATABASE_URL).password, env.APP_USER_PASSWORD);
    assert.equal(new URL(env.MIGRATION_DATABASE_URL).password, env.POSTGRES_PASSWORD);
    assert.equal(env.APP_ENV, 'development');
  });

  it('the result passes the localhost guard that db:migrate and db:seed run', () => {
    const env = parseEnv(readFileSync(join(dir, '.env'), 'utf8'));
    assert.deepEqual(findProblems({ env, dotenv: env }), []);
  });

  it('the MinIO login and the S3 keys are the same local values, and the object store points at MinIO', () => {
    const env = parseEnv(readFileSync(join(dir, '.env'), 'utf8'));
    assert.equal(env.S3_SECRET_ACCESS_KEY, env.MINIO_ROOT_PASSWORD);
    assert.equal(env.S3_ACCESS_KEY_ID, env.MINIO_ROOT_USER);
    assert.ok(env.MINIO_ROOT_PASSWORD.length >= 8);
    assert.equal(env.S3_ENDPOINT, 'http://127.0.0.1:9000');
    assert.equal(env.S3_REGION, 'us-east-1');
    assert.equal(env.S3_FORCE_PATH_STYLE, 'true');
    assert.equal(env.S3_MEDIA_BUCKET, 'codeproctor-media');
  });

  it('the dev mail sink and the execution stub are switched on only when the API supports them', () => {
    const example = readFileSync(`${REPO_ROOT}.env.example`, 'utf8');
    const off = parseEnv(buildLocalEnv(example, { smtpDev: false, execStub: false }));
    assert.equal(off.EMAIL_PROVIDER, 'noop');
    assert.equal(off.SMTP_DEV_HOST, undefined);
    assert.equal(off.JUDGE0_MODE, undefined);
    const on = parseEnv(buildLocalEnv(example, { smtpDev: true, execStub: true }));
    assert.equal(on.EMAIL_PROVIDER, 'smtp-dev');
    assert.equal(on.SMTP_DEV_HOST, '127.0.0.1');
    assert.equal(on.SMTP_DEV_PORT, '1025');
    assert.equal(on.JUDGE0_MODE, 'stub');
    assert.equal(on.APP_ENV, 'development');
  });

  it('detectSupport reads the API environment schema', () => {
    const root = mkdtempSync(join(tmpdir(), 'local-env-support-'));
    try {
      assert.deepEqual(detectSupport(root), { smtpDev: false, execStub: false });
      mkdirSync(join(root, 'apps/api/src/config'), { recursive: true });
      writeFileSync(
        join(root, 'apps/api/src/config/env.ts'),
        "EMAIL_PROVIDER: z.enum(['ses', 'noop', 'smtp-dev']), JUDGE0_MODE: z.enum(['real', 'stub'])",
      );
      assert.deepEqual(detectSupport(root), { smtpDev: true, execStub: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the worker settings are written: a random signing key, the media bucket, and the origin equal to S3_ENDPOINT', () => {
    const env = parseEnv(readFileSync(join(dir, '.env'), 'utf8'));
    // An origin only (no path), on the address the worker binds (127.0.0.1); #129 reads these three.
    assert.equal(env.WORKER_BASE_URL, 'http://127.0.0.1:8000');
    assert.match(env.WORKER_HMAC_KEY_ID, /^[A-Za-z0-9_-]{1,32}$/);
    assert.equal(
      Buffer.from(env.WORKER_HMAC_KEY, 'base64').toString('base64'),
      env.WORKER_HMAC_KEY,
    );
    assert.equal(env.WORKER_HMAC_KEY_ID, 'local1');
    assert.ok(Buffer.from(env.WORKER_HMAC_KEY, 'base64').length >= 32);
    assert.equal(env.WORKER_OBJECT_STORE_BUCKET, env.S3_MEDIA_BUCKET);
    assert.equal(env.WORKER_OBJECT_STORE_ORIGINS, env.S3_ENDPOINT);
    const example = readFileSync(`${REPO_ROOT}.env.example`, 'utf8');
    assert.notEqual(
      parseEnv(buildLocalEnv(example)).WORKER_HMAC_KEY,
      parseEnv(buildLocalEnv(example)).WORKER_HMAC_KEY,
    );
  });

  it('QUESTION_OPTION_ID_SECRET gets a random value when the example has the placeholder, and is ignored when it does not (ADR 0013 CS-4.6)', () => {
    // Built from the example with the key removed, so this holds before and after the key is in .env.example.
    const base = readFileSync(`${REPO_ROOT}.env.example`, 'utf8').replace(
      /^QUESTION_OPTION_ID_SECRET=.*\n?/gm,
      '',
    );
    const withIt = parseEnv(
      buildLocalEnv(`${base}\nQUESTION_OPTION_ID_SECRET=change-me-random-secret\n`),
    );
    assert.ok(withIt.QUESTION_OPTION_ID_SECRET.length >= 32);
    assert.doesNotMatch(withIt.QUESTION_OPTION_ID_SECRET, /change-me/);
    assert.notEqual(withIt.QUESTION_OPTION_ID_SECRET, withIt.OTP_PEPPER);
    assert.equal(parseEnv(buildLocalEnv(base)).QUESTION_OPTION_ID_SECRET, undefined);
  });

  it('two runs give different secrets', () => {
    const example = readFileSync(`${REPO_ROOT}.env.example`, 'utf8');
    assert.notEqual(
      parseEnv(buildLocalEnv(example)).JWT_ACCESS_SECRET,
      parseEnv(buildLocalEnv(example)).JWT_ACCESS_SECRET,
    );
  });

  it('refuses an example that still has a change-me it has no value for, and bad arguments', () => {
    assert.throws(
      () => buildLocalEnv('NEW_SECRET=change-me\n'),
      /no local value is known for: NEW_SECRET/,
    );
    assert.equal(run('--dir').status, 1);
    assert.equal(run('--wat').status, 1);
    const empty = mkdtempSync(join(tmpdir(), 'local-env-empty-'));
    try {
      const r = run('--dir', empty);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /does not exist/);
      writeFileSync(join(empty, '.env.example'), 'X=1\n');
      assert.equal(run('--dir', empty).status, 0);
      assert.ok(existsSync(join(empty, '.env')));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('local-env --top-up (an .env written before a secret was added)', () => {
  const exampleOf = () => readFileSync(`${REPO_ROOT}.env.example`, 'utf8');
  const withKey = (text) =>
    `${text.replace(/^QUESTION_OPTION_ID_SECRET=.*\n?/gm, '')}\nQUESTION_OPTION_ID_SECRET=change-me-random-secret\n`;

  it('appends the missing independent secret, leaves every existing value alone, and is idempotent', () => {
    const example = withKey(exampleOf());
    const old = buildLocalEnv(exampleOf()).replace(/^QUESTION_OPTION_ID_SECRET=.*\n?/gm, '');
    const r = topUpLocalEnv(example, old);
    assert.deepEqual(r.keys, ['QUESTION_OPTION_ID_SECRET']);
    const merged = old + r.text;
    assert.ok(merged.startsWith(old), 'the old file is a prefix: nothing was changed');
    const env = parseEnv(merged);
    assert.ok(env.QUESTION_OPTION_ID_SECRET.length >= 32);
    assert.doesNotMatch(env.QUESTION_OPTION_ID_SECRET, /change-me/);
    for (const [k, v] of Object.entries(parseEnv(old))) assert.equal(env[k], v, k);
    assert.deepEqual(topUpLocalEnv(example, merged), { keys: [], text: '', unknown: [] });
  });

  it('never appends a coupled value (database or object-store passwords) or a key that is already defined', () => {
    // Every coupled key removed from the old file: none may come back, only the independent one.
    let old = buildLocalEnv(exampleOf());
    for (const k of [...COUPLED, 'QUESTION_OPTION_ID_SECRET'])
      old = old.replace(new RegExp(`^${k}=.*\\n?`, 'gm'), '');
    old = old.replace(/^OTP_PEPPER=.*$/m, 'OTP_PEPPER=');
    const r = topUpLocalEnv(withKey(exampleOf()), old);
    assert.deepEqual(r.keys, ['QUESTION_OPTION_ID_SECRET'], 'an empty OTP_PEPPER is still defined');
    for (const k of [...COUPLED, 'OTP_PEPPER']) assert.doesNotMatch(r.text, new RegExp(k));
  });

  it('a key is defined for `export KEY=`, leading space and spaces around `=`; a commented-out line is not', () => {
    const base = buildLocalEnv(exampleOf());
    const without = base.replace(/^QUESTION_OPTION_ID_SECRET=.*\n?/gm, '');
    const example = withKey(exampleOf());
    for (const line of [
      'export QUESTION_OPTION_ID_SECRET=mine',
      '  QUESTION_OPTION_ID_SECRET=mine',
      'QUESTION_OPTION_ID_SECRET = mine',
    ]) {
      assert.deepEqual(topUpLocalEnv(example, `${without}\n${line}\n`).keys, [], line);
    }
    assert.deepEqual(topUpLocalEnv(example, `${without}\n# QUESTION_OPTION_ID_SECRET=old\n`).keys, [
      'QUESTION_OPTION_ID_SECRET',
    ]);
  });

  it('only the allowlist is ever appended, and a change-me key without a generator is reported, not thrown', () => {
    const example = `${withKey(exampleOf())}\nBRAND_NEW_SECRET=change-me-x\n`;
    const old = buildLocalEnv(exampleOf()).replace(/^QUESTION_OPTION_ID_SECRET=.*\n?/gm, '');
    const r = topUpLocalEnv(example, old);
    assert.deepEqual(r.keys, ['QUESTION_OPTION_ID_SECRET']);
    assert.deepEqual(r.unknown, ['BRAND_NEW_SECRET']);
    assert.ok(r.keys.every((k) => INDEPENDENT.includes(k)));
    assert.equal(INDEPENDENT.filter((k) => COUPLED.has(k)).length, 0);
  });

  it('adds a newline first when the old file did not end with one', () => {
    const old = buildLocalEnv(exampleOf())
      .replace(/^QUESTION_OPTION_ID_SECRET=.*\n?/gm, '')
      .trimEnd();
    const { text } = topUpLocalEnv(withKey(exampleOf()), old);
    assert.ok(text.startsWith('\n'));
    assert.equal(parseEnv(old + text).QUESTION_OPTION_ID_SECRET?.length >= 32, true);
  });

  it('the command appends to the file, keeps mode 0600, prints names and no values, and says nothing is missing next time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-env-topup-'));
    try {
      writeFileSync(join(dir, '.env.example'), withKey(exampleOf()));
      const old = buildLocalEnv(exampleOf()).replace(/^QUESTION_OPTION_ID_SECRET=.*\n?/gm, '');
      writeFileSync(join(dir, '.env'), old, { mode: 0o600 });
      const run = () => spawnSync('node', [SCRIPT, '--dir', dir, '--top-up'], { encoding: 'utf8' });
      const first = run();
      assert.equal(first.status, 0, first.stderr);
      assert.match(
        first.stdout,
        /appended 1 missing secret\(s\) to \.env: QUESTION_OPTION_ID_SECRET/,
      );
      const merged = readFileSync(join(dir, '.env'), 'utf8');
      assert.ok(merged.startsWith(old));
      const value = parseEnv(merged).QUESTION_OPTION_ID_SECRET;
      assert.ok(!first.stdout.includes(value) && !first.stderr.includes(value));
      if (process.platform !== 'win32')
        assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600);
      const second = run();
      assert.equal(second.status, 0);
      assert.match(second.stdout, /nothing appended/);
      assert.equal(readFileSync(join(dir, '.env'), 'utf8'), merged);
      // an .env that is not a development one is not touched
      writeFileSync(join(dir, '.env'), 'APP_ENV=staging\n');
      const notDev = run();
      assert.equal(notDev.status, 1);
      assert.match(notDev.stderr, /APP_ENV=development/);
      assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'APP_ENV=staging\n');
      // the last value wins when a file sets APP_ENV twice (dotenv and parseEnv agree)
      writeFileSync(join(dir, '.env'), 'APP_ENV=development\nAPP_ENV=staging\n');
      assert.equal(run().status, 1);
      // without an .env it refuses instead of writing one
      rmSync(join(dir, '.env'));
      const none = run();
      assert.equal(none.status, 1);
      assert.match(none.stderr, /needs an existing \.env/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
