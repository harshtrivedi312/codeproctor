// Runs assert-local-db.mjs the way the root scripts do: working directory at the repository
// root, relative path. Fail-closed check (review SF3): the guard must always run, so a
// non-local URL exits 1 and a local one prints its success line. ADR 0009 section 4.4, NFR-04.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { REPO_ROOT, createSandbox } from './test-support.mjs';

const CLOSED = 'postgresql://x:y@127.0.0.1:1/none';

function runGuard(extraEnv, args = []) {
  const sandbox = createSandbox();
  try {
    const result = spawnSync(process.execPath, ['infra/scripts/assert-local-db.mjs', ...args], {
      cwd: REPO_ROOT,
      env: sandbox.env(extraEnv),
      encoding: 'utf8',
      input: '',
    });
    return { ...result, output: `${result.stdout}${result.stderr}` };
  } finally {
    sandbox.remove();
  }
}

test('ADR-0009 4.4: runs from the repo root by relative path and accepts local URLs', () => {
  const result = runGuard({ MIGRATION_DATABASE_URL: CLOSED, DATABASE_URL: CLOSED });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /database URLs point at this machine/);
});

test('NFR-04: refuses a non-local URL with exit 1, printing only the host', () => {
  const result = runGuard({
    MIGRATION_DATABASE_URL: 'postgresql://owner:secret-pw@db.example.com:5432/codeproctor',
    DATABASE_URL: 'postgresql://app_user:secret-pw@db.example.com:5432/codeproctor',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /db\.example\.com/);
  assert.doesNotMatch(result.output, /secret-pw|owner|app_user/);
});

test('ADR-0009 4.4: refuses empty URLs with exit 1', () => {
  assert.equal(runGuard({ MIGRATION_DATABASE_URL: '', DATABASE_URL: '' }).status, 1);
});

test('NFR-04: refuses a libpq redirect variable in the environment', () => {
  const result = runGuard({
    MIGRATION_DATABASE_URL: CLOSED,
    DATABASE_URL: CLOSED,
    PGSERVICE: 'staging',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PGSERVICE is set/);
});

test('ADR-0009 4.4: refuses an unknown argument, so a typo cannot skip a check', () => {
  const result = runGuard({ MIGRATION_DATABASE_URL: CLOSED, DATABASE_URL: CLOSED }, [
    '--compose-prot',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown argument/);
});

test('ADR-0009 4.4 (D-37): --compose-port refuses when Compose is not running', () => {
  const result = runGuard(
    { MIGRATION_DATABASE_URL: CLOSED, DATABASE_URL: CLOSED, FAKE_COMPOSE_FAIL: '1' },
    ['--compose-port'],
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not report a port/);
});

test('ADR-0009 4.4 (D-37): --compose-port passes only when the URL port is the Compose port', () => {
  const ok = runGuard(
    {
      MIGRATION_DATABASE_URL: CLOSED,
      DATABASE_URL: CLOSED,
      FAKE_COMPOSE_PORT_OUTPUT: '127.0.0.1:1',
    },
    ['--compose-port'],
  );
  assert.equal(ok.status, 0);

  const mismatch = runGuard(
    {
      MIGRATION_DATABASE_URL: CLOSED,
      DATABASE_URL: CLOSED,
      FAKE_COMPOSE_PORT_OUTPUT: '127.0.0.1:5432',
    },
    ['--compose-port'],
  );
  assert.equal(mismatch.status, 1);
  assert.match(
    mismatch.stderr,
    /uses port 1, but the local Compose postgres is published on port 5432/,
  );
});
