// Tests for the localhost guard (ADR 0009 section 4.4, review S4). Run with `pnpm test`.
// The consent variable is only ever passed in memory to findProblems; no test puts it
// into a real process environment.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONSENT_VAR, findProblems } from './assert-local-db.mjs';

const LOCAL = 'postgresql://owner:secret-pw@127.0.0.1:5432/codeproctor';

function problemsFor(env, dotenv) {
  return findProblems({ env, dotenv });
}

test('accepts localhost, 127.0.0.1 and ::1 for both URLs', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'LOCALHOST']) {
    const url = `postgresql://u:p@${host}:5432/db`;
    assert.deepEqual(problemsFor({ MIGRATION_DATABASE_URL: url, DATABASE_URL: url }), []);
  }
});

test('DATABASE_URL may be unset, MIGRATION_DATABASE_URL may not', () => {
  assert.deepEqual(problemsFor({ MIGRATION_DATABASE_URL: LOCAL }), []);
  assert.equal(problemsFor({ DATABASE_URL: LOCAL }).length, 1);
});

test('refuses a non-local host and names only the host', () => {
  const url = 'postgresql://owner:secret-pw@db.example.com:5432/codeproctor';
  const [problem, ...rest] = problemsFor({ MIGRATION_DATABASE_URL: url });
  assert.equal(rest.length, 0);
  assert.match(problem ?? '', /db\.example\.com/);
  assert.doesNotMatch(problem ?? '', /secret-pw|owner|codeproctor/);
});

test('applies the same check to DATABASE_URL', () => {
  const problems = problemsFor({
    MIGRATION_DATABASE_URL: LOCAL,
    DATABASE_URL: 'postgresql://app_user:secret-pw@rds.example.com:5432/codeproctor',
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /^DATABASE_URL points at host "rds\.example\.com"/);
});

test('refuses an empty or missing MIGRATION_DATABASE_URL', () => {
  assert.equal(problemsFor({ MIGRATION_DATABASE_URL: '' }).length, 1);
  assert.equal(problemsFor({ MIGRATION_DATABASE_URL: '   ' }).length, 1);
  assert.equal(problemsFor({}).length, 1);
});

test('refuses host and hostaddr query parameters, in any letter case', () => {
  for (const query of ['host=remote.example.com', 'hostaddr=10.0.0.5', 'HOST=remote.example.com']) {
    const url = `postgresql://u:secret-pw@localhost:5432/db?${query}`;
    const [problem] = problemsFor({ MIGRATION_DATABASE_URL: url });
    assert.match(problem ?? '', /host or hostaddr query parameter/);
    assert.doesNotMatch(problem ?? '', /secret-pw|remote\.example\.com|10\.0\.0\.5/);
  }
});

test('refuses look-alike hosts and unparseable URLs without echoing them', () => {
  for (const url of [
    'postgresql://localhost:x@evil.example.com:5432/db',
    'postgresql://u:p@localhost.evil.example.com/db',
    'postgresql://u:p@localhost.:5432/db',
    'postgresql://u:p@127.1:5432/db',
    'postgresql://u:p@2130706433:5432/db',
    'postgresql:///db',
    'postgresql://u:secret-pw@localhost:5432,evil.example.com:5432/db',
    'secret-pw is not a url',
  ]) {
    const problems = problemsFor({ MIGRATION_DATABASE_URL: url });
    assert.equal(problems.length, 1, url);
    assert.doesNotMatch(problems[0] ?? '', /secret-pw/);
  }
});

test('refuses Prisma consent variable in the environment or in .env', () => {
  const ok = { MIGRATION_DATABASE_URL: LOCAL };
  assert.equal(problemsFor({ ...ok, [CONSENT_VAR]: 'x' }).length, 1);
  assert.equal(problemsFor({ ...ok, [CONSENT_VAR]: '' }).length, 1);
  assert.equal(problemsFor(ok, { [CONSENT_VAR]: 'x' }).length, 1);
  assert.deepEqual(problemsFor(ok, { OTHER: 'x' }), []);
});

test('command line: refuses a non-local URL with exit 1 and prints only the host', () => {
  const script = fileURLToPath(new URL('./assert-local-db.mjs', import.meta.url));
  const run = (env) =>
    spawnSync(process.execPath, [script], {
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
    });

  const refused = run({
    MIGRATION_DATABASE_URL: 'postgresql://owner:secret-pw@db.example.com:5432/codeproctor',
    DATABASE_URL: 'postgresql://app_user:secret-pw@db.example.com:5432/codeproctor',
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /db\.example\.com/);
  assert.doesNotMatch(refused.stderr + refused.stdout, /secret-pw|owner|app_user/);

  const empty = run({ MIGRATION_DATABASE_URL: '', DATABASE_URL: '' });
  assert.equal(empty.status, 1);

  const accepted = run({
    MIGRATION_DATABASE_URL: 'postgresql://x:y@127.0.0.1:1/none',
    DATABASE_URL: 'postgresql://x:y@127.0.0.1:1/none',
  });
  assert.equal(accepted.status, 0);
});
