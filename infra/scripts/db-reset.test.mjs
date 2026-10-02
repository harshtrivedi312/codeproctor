// Safety paths of infra/scripts/db-reset (ADR 0009 section 4.4, D-31, D-37, NFR-04, review S4).
// Every case spawns `sh infra/scripts/db-reset` with an explicitly built environment: nothing is
// inherited from the caller or from the CI runner, and the PATH holds only stand-ins for docker
// and pnpm. No case may reach `prisma migrate reset`; each one asserts the pnpm stand-in was
// never called. The consent variable is never put into any environment here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { REPO_ROOT, createSandbox } from './test-support.mjs';

const CLOSED = 'postgresql://x:y@127.0.0.1:1/none';

// Every marker variable named in ADR 0009 section 4.4 (the list db-reset must refuse on).
const AGENT_MARKERS = [
  'CLAUDECODE',
  'CODEX_THREAD_ID',
  'CODEX_CI',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'GEMINI_CLI',
  'QWEN_CODE',
  'CURSOR_AGENT',
  'COPILOT_CLI',
  'OPENCODE',
  'OPENCODE_CLIENT',
  'CLINE_ACTIVE',
  'CRUSH',
  'AUGMENT_AGENT',
  'ANTIGRAVITY_AGENT',
  'AI_AGENT',
  'AGENT',
];

/** Runs db-reset with stdin closed (no terminal), so a bug can never wait for a human. */
function runDbReset(extraEnv = {}) {
  const sandbox = createSandbox();
  try {
    const result = spawnSync('/bin/sh', ['infra/scripts/db-reset'], {
      cwd: REPO_ROOT,
      env: sandbox.env({
        MIGRATION_DATABASE_URL: CLOSED,
        DATABASE_URL: CLOSED,
        FAKE_COMPOSE_PORT_OUTPUT: '127.0.0.1:1',
        ...extraEnv,
      }),
      encoding: 'utf8',
      input: '',
    });
    return {
      ...result,
      output: `${result.stdout}${result.stderr}`,
      reachedDestructiveCommand: existsSync(sandbox.log),
    };
  } finally {
    sandbox.remove();
  }
}

function assertRefused(result, messagePattern) {
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, messagePattern);
  assert.equal(result.reachedDestructiveCommand, false, 'a docker or pnpm stand-in was called');
}

test('ADR-0009 4.4: CI=1 is refused', () => {
  assertRefused(runDbReset({ CI: '1' }), /db:reset never runs in CI/);
});

test('ADR-0009 4.4 (D-37): every AI-agent marker variable is refused and named', () => {
  for (const name of AGENT_MARKERS) {
    assertRefused(
      runDbReset({ [name]: '1' }),
      new RegExp(`never runs inside an AI agent \\(${name} is set\\)`),
    );
  }
  assertRefused(runDbReset({ OR_APP_NAME: 'Aider' }), /\(OR_APP_NAME is set\)/);
  assertRefused(runDbReset({ REPLIT_SESSION: 'agent-123' }), /\(REPLIT_SESSION is set\)/);
});

test('ADR-0009 4.4 (D-37): conditional markers with other values are not agent markers', () => {
  for (const extra of [{ OR_APP_NAME: 'SomeOtherApp' }, { REPLIT_SESSION: 'user-123' }]) {
    // Not refused as an agent: the run continues to the terminal check.
    assertRefused(runDbReset(extra), /needs a human at a terminal/);
  }
});

test('ADR-0009 4.4: without a terminal it refuses with the "needs a human" message', () => {
  const result = runDbReset();
  assertRefused(result, /db:reset needs a human at a terminal/);
  assert.match(result.stdout, /database URLs point at this machine/, 'the guards ran first');
});

test('NFR-04: a non-local URL is refused, naming the host and never the password', () => {
  for (const name of ['MIGRATION_DATABASE_URL', 'DATABASE_URL']) {
    const result = runDbReset({
      [name]: 'postgresql://owner:secret-pw@db.example.com:5432/codeproctor',
    });
    assertRefused(result, /db\.example\.com/);
    assert.doesNotMatch(result.output, /secret-pw|owner/);
  }
});

test('ADR-0009 4.4 (D-37): a local URL on another port than Compose is refused', () => {
  // For example a tunnel to a shared database that listens on localhost.
  const result = runDbReset({
    MIGRATION_DATABASE_URL: 'postgresql://owner:secret-pw@127.0.0.1:6543/codeproctor',
    DATABASE_URL: 'postgresql://owner:secret-pw@127.0.0.1:6543/codeproctor',
    FAKE_COMPOSE_PORT_OUTPUT: '127.0.0.1:5432',
  });
  assertRefused(result, /uses port 6543, but the local Compose postgres is published on port 5432/);
  assert.doesNotMatch(result.output, /secret-pw|owner/);
});

test('ADR-0009 4.4 (D-37): it is refused when Compose is not running or the command fails', () => {
  assertRefused(runDbReset({ FAKE_COMPOSE_FAIL: '1' }), /did not report a port/);
  assertRefused(runDbReset({ FAKE_COMPOSE_PORT_OUTPUT: '' }), /did not report a port/);
});

test('NFR-04: a libpq redirect variable is refused', () => {
  for (const name of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE']) {
    assertRefused(runDbReset({ [name]: 'x' }), new RegExp(`${name} is set`));
  }
});

test('ADR-0009 4.4: host, hostaddr and service parameters in the URL are refused', () => {
  for (const query of ['host=remote.example.com', 'hostaddr=10.0.0.5', 'service=staging']) {
    const result = runDbReset({
      MIGRATION_DATABASE_URL: `postgresql://x:secret-pw@127.0.0.1:1/none?${query}`,
    });
    assertRefused(result, /host, hostaddr or service query parameter/);
    assert.doesNotMatch(result.output, /secret-pw/);
  }
});
