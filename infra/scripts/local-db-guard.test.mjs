// Unit tests for the localhost guard checks (ADR 0009 section 4.4, NFR-04, review S4, D-37).
// The consent variable is only ever passed in memory to findProblems; no test puts it into a
// real process environment.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONSENT_VAR,
  LIBPQ_REDIRECT_VARS,
  findPortProblems,
  findProblems,
  parseComposePort,
} from './local-db-guard.mjs';

const LOCAL = 'postgresql://owner:secret-pw@127.0.0.1:5432/codeproctor';

function problemsFor(env, dotenv) {
  return findProblems({ env, dotenv });
}

test('ADR-0009 4.4: accepts localhost, 127.0.0.1 and [::1] for both URLs', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'LOCALHOST']) {
    const url = `postgresql://u:p@${host}:5432/db`;
    assert.deepEqual(problemsFor({ MIGRATION_DATABASE_URL: url, DATABASE_URL: url }), []);
  }
});

test('ADR-0009 4.4: accepts both the postgres:// and postgresql:// schemes', () => {
  for (const scheme of ['postgres', 'postgresql']) {
    assert.deepEqual(problemsFor({ MIGRATION_DATABASE_URL: `${scheme}://u:p@localhost/db` }), []);
  }
});

test('ADR-0009 4.4: refuses other schemes without echoing the URL', () => {
  for (const url of ['mysql://u:secret-pw@localhost:3306/db', 'http://u:secret-pw@localhost/db']) {
    const [problem, ...rest] = problemsFor({ MIGRATION_DATABASE_URL: url });
    assert.equal(rest.length, 0);
    assert.match(problem ?? '', /not a postgres:\/\/ or postgresql:\/\/ URL/);
    assert.doesNotMatch(problem ?? '', /secret-pw/);
  }
});

test('ADR-0009 4.4: DATABASE_URL may be unset, MIGRATION_DATABASE_URL may not', () => {
  assert.deepEqual(problemsFor({ MIGRATION_DATABASE_URL: LOCAL }), []);
  assert.equal(problemsFor({ DATABASE_URL: LOCAL }).length, 1);
});

test('NFR-04: refuses a non-local host and names only the host', () => {
  const url = 'postgresql://owner:secret-pw@db.example.com:5432/codeproctor';
  const [problem, ...rest] = problemsFor({ MIGRATION_DATABASE_URL: url });
  assert.equal(rest.length, 0);
  assert.match(problem ?? '', /db\.example\.com/);
  assert.doesNotMatch(problem ?? '', /secret-pw|owner|codeproctor/);
});

test('ADR-0009 4.4: applies the same check to DATABASE_URL', () => {
  const problems = problemsFor({
    MIGRATION_DATABASE_URL: LOCAL,
    DATABASE_URL: 'postgresql://app_user:secret-pw@rds.example.com:5432/codeproctor',
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /^DATABASE_URL points at host "rds\.example\.com"/);
});

test('ADR-0009 4.4: refuses an empty or missing MIGRATION_DATABASE_URL', () => {
  assert.equal(problemsFor({ MIGRATION_DATABASE_URL: '' }).length, 1);
  assert.equal(problemsFor({ MIGRATION_DATABASE_URL: '   ' }).length, 1);
  assert.equal(problemsFor({}).length, 1);
});

test('ADR-0009 4.4: refuses host, hostaddr and service query parameters in any form', () => {
  for (const query of [
    'host=remote.example.com',
    'hostaddr=10.0.0.5',
    'service=staging',
    'HOST=remote.example.com',
    'Service=staging',
    '%68ost=evil.example.com',
    '%73ervice=staging',
  ]) {
    for (const scheme of ['postgresql', 'postgres']) {
      const url = `${scheme}://u:secret-pw@localhost:5432/db?${query}`;
      const [problem] = problemsFor({ MIGRATION_DATABASE_URL: url });
      assert.match(problem ?? '', /host, hostaddr or service query parameter/, query);
      assert.doesNotMatch(problem ?? '', /secret-pw|remote\.example\.com|10\.0\.0\.5|evil|staging/);
    }
  }
});

test('ADR-0009 4.4: refuses look-alike hosts and unparseable URLs without echoing them', () => {
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

test('ADR-0009 4.4: refuses the Prisma consent variable in the environment or in .env', () => {
  const ok = { MIGRATION_DATABASE_URL: LOCAL };
  assert.equal(problemsFor({ ...ok, [CONSENT_VAR]: 'x' }).length, 1);
  assert.equal(problemsFor({ ...ok, [CONSENT_VAR]: '' }).length, 1);
  assert.equal(problemsFor(ok, { [CONSENT_VAR]: 'x' }).length, 1);
  assert.deepEqual(problemsFor(ok, { OTHER: 'x' }), []);
});

test('NFR-04: refuses PGHOSTADDR, PGSERVICE and PGSERVICEFILE in the environment', () => {
  assert.deepEqual([...LIBPQ_REDIRECT_VARS].sort(), ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE']);
  const ok = { MIGRATION_DATABASE_URL: LOCAL };
  for (const name of LIBPQ_REDIRECT_VARS) {
    const problems = problemsFor({ ...ok, [name]: '10.0.0.5' });
    assert.equal(problems.length, 1, name);
    assert.match(problems[0] ?? '', new RegExp(`^${name} is set`));
    assert.doesNotMatch(problems[0] ?? '', /10\.0\.0\.5/);
    assert.equal(problemsFor({ ...ok, [name]: '' }).length, 1, `${name} empty`);
  }
  // PGHOST is not on the list: the URL always names a host, so it is never used.
  assert.deepEqual(problemsFor({ ...ok, PGHOST: 'remote.example.com' }), []);
});

test('ADR-0009 4.4 (D-37): parses the host port from docker compose port output', () => {
  assert.equal(parseComposePort('127.0.0.1:5432\n'), '5432');
  assert.equal(parseComposePort('0.0.0.0:55432\n'), '55432');
  assert.equal(parseComposePort('[::]:5432\n'), '5432');
  assert.equal(parseComposePort('\n127.0.0.1:6543\n0.0.0.0:6543\n'), '6543');
  for (const bad of ['', '\n', 'service "postgres" is not running', '127.0.0.1:abc']) {
    assert.equal(parseComposePort(bad), null, JSON.stringify(bad));
  }
});

test('ADR-0009 4.4 (D-37): accepts only the Compose port, and a URL without a port means 5432', () => {
  const env = {
    MIGRATION_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
    DATABASE_URL: 'postgresql://u:p@localhost/db',
  };
  assert.deepEqual(findPortProblems({ env, composePort: '5432' }), []);

  const wrong = findPortProblems({ env, composePort: '55432' });
  assert.equal(wrong.length, 2);
  assert.match(wrong[0] ?? '', /^MIGRATION_DATABASE_URL uses port 5432, but .* port 55432/);
  assert.match(wrong[1] ?? '', /^DATABASE_URL uses port 5432/);

  const tunnel = findPortProblems({
    env: { MIGRATION_DATABASE_URL: 'postgresql://owner:secret-pw@127.0.0.1:6543/db' },
    composePort: '5432',
  });
  assert.equal(tunnel.length, 1);
  assert.doesNotMatch(tunnel[0] ?? '', /secret-pw|owner/);
});
