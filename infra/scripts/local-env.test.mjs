// local-env.mjs (docs/local-run.md): the .env it writes is complete, consistent and local.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
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
import { buildLocalEnv } from './local-env.mjs';

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
    assert.equal(
      readFileSync(join(dir, 'apps/web/.env.local'), 'utf8'),
      'NEXT_PUBLIC_API_URL=http://localhost:4000/api\n',
    );
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
