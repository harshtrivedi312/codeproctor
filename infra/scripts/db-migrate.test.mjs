// Safety paths of infra/scripts/db-migrate, the script behind `pnpm db:migrate` (ADR 0009
// section 4.4, ADR 0006 section 7.4, NFR-04, brief DB-03). Same method as db-reset.test.mjs:
// `sh infra/scripts/db-migrate` runs with an explicit environment, and the PATH holds only
// stand-ins for docker and pnpm. Nothing reaches Prisma or a database. The node stand-in logs a
// call to set-app-user-password.mjs instead of running it and runs the real node for the guard.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { REPO_ROOT, createSandbox } from './test-support.mjs';

const CLOSED = 'postgresql://x:y@127.0.0.1:1/none';
const PASSWORD_SCRIPT_CALL = 'node infra/scripts/set-app-user-password.mjs --if-role-exists';

/** Runs db-migrate with stdin closed. `log` holds every call the stand-ins received. */
function runDbMigrate(args = [], extraEnv = {}) {
  const sandbox = createSandbox({ stubPasswordScript: true });
  try {
    const result = spawnSync('/bin/sh', ['infra/scripts/db-migrate', ...args], {
      cwd: REPO_ROOT,
      env: sandbox.env({
        MIGRATION_DATABASE_URL: CLOSED,
        DATABASE_URL: CLOSED,
        ...extraEnv,
      }),
      encoding: 'utf8',
      input: '',
    });
    const log = existsSync(sandbox.log)
      ? readFileSync(sandbox.log, 'utf8').split('\n').filter(Boolean)
      : [];
    return { ...result, output: `${result.stdout}${result.stderr}`, log };
  } finally {
    sandbox.remove();
  }
}

function assertRefused(result, messagePattern) {
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, messagePattern);
  assert.deepEqual(result.log, [], 'pnpm or the password script was called');
}

test('ADR-0009 5 (P17): --config and --url are refused in both forms, before the guard runs', () => {
  const forms = [
    ['--config', 'other.config.ts'],
    ['--config=other.config.ts'],
    ['--url', 'postgresql://owner:secret-pw@db.example.com:5432/codeproctor'],
    ['--url=postgresql://owner:secret-pw@db.example.com:5432/codeproctor'],
    // After other arguments, and after a `--` that pnpm may pass on.
    ['--create-only', '--name', 'x', '--url=postgresql://owner:secret-pw@db.example.com/x'],
    ['--', '--config', 'other.config.ts'],
  ];
  for (const args of forms) {
    const result = runDbMigrate(args);
    assertRefused(result, /does not accept --config or --url/);
    // The guard prints its success line when it runs, so its absence shows the order.
    assert.doesNotMatch(result.stdout, /database URLs point at this machine/);
    assert.doesNotMatch(result.output, /secret-pw|owner|db\.example\.com/);
  }
});

test('ADR-0009 5 (P17): similar flags are not mistaken for --config or --url', () => {
  const result = runDbMigrate(['--name', 'config', '--create-only'], { FAKE_PNPM_EXIT: '0' });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.log, [
    'pnpm exec prisma migrate dev --name config --create-only',
    PASSWORD_SCRIPT_CALL,
  ]);
});

test('NFR-04: a non-local URL is refused before pnpm is called, naming the host and no secret', () => {
  for (const name of ['MIGRATION_DATABASE_URL', 'DATABASE_URL']) {
    const result = runDbMigrate([], {
      [name]: 'postgresql://owner:secret-pw@db.example.com:5432/codeproctor',
    });
    assertRefused(result, /db\.example\.com/);
    assert.doesNotMatch(result.output, /secret-pw|owner/);
  }
});

test('NFR-04: a libpq redirect variable and a host override in the URL are refused before pnpm', () => {
  assertRefused(runDbMigrate([], { PGSERVICE: 'staging' }), /PGSERVICE is set/);
  assertRefused(
    runDbMigrate([], { MIGRATION_DATABASE_URL: `${CLOSED}?host=remote.example.com` }),
    /host, hostaddr or service query parameter/,
  );
});

test('FU-DB-26: with --create-only, in any spelling, the password step still runs after migrate dev', () => {
  // Prisma applies pending migrations before it creates the new one, so app_user can exist by then.
  // The step runs for every argument list and skips quietly while the role does not exist.
  for (const args of [
    ['--create-only', '--name', 'audit_append_only'],
    ['--create-only=true', '--name', 'x'],
    ['--name', 'x', '--create-only', '--skip-seed'],
  ]) {
    const result = runDbMigrate(args, { FAKE_PNPM_EXIT: '0' });
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /database URLs point at this machine/, 'the guard ran first');
    assert.deepEqual(result.log, [
      `pnpm exec prisma migrate dev ${args.join(' ')}`,
      PASSWORD_SCRIPT_CALL,
    ]);
  }
});

test('ADR-0006 7.4: without --create-only the password script runs once, after migrate dev', () => {
  const result = runDbMigrate([], { FAKE_PNPM_EXIT: '0' });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.log, ['pnpm exec prisma migrate dev', PASSWORD_SCRIPT_CALL]);
});

test('ADR-0006 7.4: a failing migrate dev stops the script before the password step', () => {
  const result = runDbMigrate([], { FAKE_PNPM_EXIT: '1' });
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(result.log, ['pnpm exec prisma migrate dev']);
});

test('ADR-0006 7.4: a failing password script fails the run', () => {
  const result = runDbMigrate([], { FAKE_PNPM_EXIT: '0', FAKE_PASSWORD_SCRIPT_EXIT: '1' });
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(result.log, ['pnpm exec prisma migrate dev', PASSWORD_SCRIPT_CALL]);
});

test('ADR-0009 4.4: pnpm db:migrate is wired to the wrapper, and db:reset runs the password script last', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['db:migrate'], 'sh infra/scripts/db-migrate');

  // db-reset step 4 (ADR 0009 section 4.4): an uncommented call, after `migrate reset`.
  const lines = readFileSync(new URL('./db-reset', import.meta.url), 'utf8').split('\n');
  const resetAt = lines.findIndex((line) => /^\S.*prisma migrate reset --force$/.test(line));
  const passwordAt = lines.findIndex(
    (line) => line === 'node infra/scripts/set-app-user-password.mjs',
  );
  assert.ok(resetAt >= 0, 'the migrate reset line was not found');
  assert.ok(passwordAt > resetAt, 'the password script must run after migrate reset');
});
