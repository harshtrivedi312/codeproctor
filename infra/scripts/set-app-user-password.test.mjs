// Safety paths of infra/scripts/set-app-user-password.mjs (ADR 0006 section 7.4, NFR-04, brief
// DB-03). The script runs with an explicit environment. Where a case must prove that the script
// did not connect, MIGRATION_DATABASE_URL points at a listener on this machine that counts
// connections. For the paths that do connect, the listener is a minimal Postgres stand-in that
// accepts any login, records the one query it receives and answers it or fails it. No real
// database is involved.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { test } from 'node:test';
import { REPO_ROOT, createSandbox } from './test-support.mjs';

const SECRET = 'owner-secret-pw';
const PASSWORD = "app-secret-it's-pw";
const SCRIPT = 'infra/scripts/set-app-user-password.mjs';

const int32 = (value) => {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
};
const message = (type, body) => Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
const cstring = (text) => Buffer.from(`${text}\0`);
const READY = message('Z', Buffer.from('I'));

/**
 * Starts a stand-in Postgres server on 127.0.0.1. It counts connections and records each simple
 * query. `failWith` makes the query fail with that SQLSTATE and a message that echoes `leak`.
 */
async function startFakePostgres({ failWith, leak } = {}) {
  const state = { connections: 0, queries: [] };
  const server = net.createServer((socket) => {
    state.connections += 1;
    let buffer = Buffer.alloc(0);
    let started = false;
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!started) {
          // The startup message has no type byte: length, protocol version, parameters.
          if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return;
          buffer = buffer.subarray(buffer.readInt32BE(0));
          started = true;
          socket.write(Buffer.concat([message('R', int32(0)), READY]));
          continue;
        }
        if (buffer.length < 5 || buffer.length < buffer.readInt32BE(1) + 1) return;
        const type = String.fromCharCode(buffer[0]);
        const end = buffer.readInt32BE(1) + 1;
        const body = buffer.subarray(5, end);
        buffer = buffer.subarray(end);
        if (type === 'Q') {
          state.queries.push(body.toString('utf8').replace(/\0$/, ''));
          const reply =
            failWith === undefined
              ? message('C', cstring('ALTER ROLE'))
              : message(
                  'E',
                  Buffer.concat([
                    Buffer.from('S'),
                    cstring('ERROR'),
                    Buffer.from('C'),
                    cstring(failWith),
                    Buffer.from('M'),
                    cstring(`statement failed near ${leak ?? ''}`),
                    Buffer.from([0]),
                  ]),
                );
          socket.write(Buffer.concat([reply, READY]));
        } else if (type === 'X') {
          socket.end();
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    url: `postgresql://owner:${SECRET}@127.0.0.1:${port}/codeproctor`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Runs the script with stdin closed and an explicit environment. */
function runScript(extraEnv, args = []) {
  const sandbox = createSandbox();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      env: sandbox.env(extraEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => {
      sandbox.remove();
      resolve({ status, stdout, stderr, output: `${stdout}${stderr}` });
    });
  });
}

function assertNoSecrets(result) {
  assert.doesNotMatch(result.output, /owner-secret-pw|app-secret|it's-pw|postgresql:\/\//);
}

test('NFR-04: a non-local URL is refused before connecting, naming the host and no secret', async () => {
  const result = await runScript({
    MIGRATION_DATABASE_URL: `postgresql://owner:${SECRET}@db.example.com:5432/codeproctor`,
    DATABASE_URL: 'postgresql://app_user:x@127.0.0.1:1/none',
    APP_USER_PASSWORD: PASSWORD,
  });
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /MIGRATION_DATABASE_URL points at host "db\.example\.com"/);
  assert.match(result.stderr, /refusing to run/);
  // A refusal by the guard, not a failed connection attempt.
  assert.doesNotMatch(result.output, /could not connect|app_user password set/);
  assertNoSecrets(result);
});

test('NFR-04: a non-local DATABASE_URL is refused too', async () => {
  const result = await runScript({
    MIGRATION_DATABASE_URL: 'postgresql://owner:x@127.0.0.1:1/none',
    DATABASE_URL: `postgresql://app_user:${SECRET}@db.example.com:5432/codeproctor`,
    APP_USER_PASSWORD: PASSWORD,
  });
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /DATABASE_URL points at host "db\.example\.com"/);
  assertNoSecrets(result);
});

test('NFR-04: host overrides are refused before any connection is made', async () => {
  const fake = await startFakePostgres();
  try {
    const cases = [
      // A query parameter that can send the connection elsewhere.
      {
        MIGRATION_DATABASE_URL: `${fake.url}?host=127.0.0.1`,
        pattern: /host, hostaddr or service/,
      },
      // A libpq variable that can do the same.
      { MIGRATION_DATABASE_URL: fake.url, PGHOSTADDR: '127.0.0.1', pattern: /PGHOSTADDR is set/ },
      { MIGRATION_DATABASE_URL: fake.url, PGSERVICE: 'staging', pattern: /PGSERVICE is set/ },
    ];
    for (const { pattern, ...env } of cases) {
      const result = await runScript({
        DATABASE_URL: fake.url,
        APP_USER_PASSWORD: PASSWORD,
        ...env,
      });
      assert.equal(result.status, 1, result.output);
      assert.match(result.stderr, pattern);
      assertNoSecrets(result);
    }
    assert.equal(fake.state.connections, 0, 'the script connected although the guard refused');
    assert.deepEqual(fake.state.queries, []);
  } finally {
    await fake.close();
  }
});

test('ADR-0006 7.4: a missing or empty APP_USER_PASSWORD is refused before connecting', async () => {
  const fake = await startFakePostgres();
  try {
    // An empty value in the shell wins over any value in .env.
    const result = await runScript({
      MIGRATION_DATABASE_URL: fake.url,
      DATABASE_URL: fake.url,
      APP_USER_PASSWORD: '',
    });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /APP_USER_PASSWORD is not set/);
    assert.equal(fake.state.connections, 0);
  } finally {
    await fake.close();
  }
});

test('ADR-0006 7.4: it takes no arguments', async () => {
  const fake = await startFakePostgres();
  try {
    const result = await runScript(
      { MIGRATION_DATABASE_URL: fake.url, DATABASE_URL: fake.url, APP_USER_PASSWORD: PASSWORD },
      ['--password', PASSWORD],
    );
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /takes no arguments/);
    assertNoSecrets(result);
    assert.equal(fake.state.connections, 0);
  } finally {
    await fake.close();
  }
});

test('ADR-0006 7.4: it sets the password with a quoted literal and prints only "app_user password set"', async () => {
  const fake = await startFakePostgres();
  try {
    const result = await runScript({
      MIGRATION_DATABASE_URL: fake.url,
      DATABASE_URL: fake.url,
      APP_USER_PASSWORD: PASSWORD,
    });
    assert.equal(result.status, 0, result.output);
    assert.equal(result.stdout, 'app_user password set\n');
    assert.equal(result.stderr, '');
    // client.escapeLiteral doubles the single quote in the value.
    assert.deepEqual(fake.state.queries, [
      "ALTER ROLE app_user WITH PASSWORD 'app-secret-it''s-pw'",
    ]);
  } finally {
    await fake.close();
  }
});

test('ADR-0006 7.4: it is idempotent: a second run sets the password again', async () => {
  const fake = await startFakePostgres();
  try {
    const env = {
      MIGRATION_DATABASE_URL: fake.url,
      DATABASE_URL: fake.url,
      APP_USER_PASSWORD: PASSWORD,
    };
    assert.equal((await runScript(env)).status, 0);
    assert.equal((await runScript(env)).status, 0);
    assert.equal(fake.state.queries.length, 2);
    assert.equal(fake.state.queries[0], fake.state.queries[1]);
  } finally {
    await fake.close();
  }
});

test('ADR-0006 7.4: when the database refuses, the message is ours and never echoes the password', async () => {
  // The stand-in's own error text contains the password, like a server that echoes a statement.
  const fake = await startFakePostgres({ failWith: '42704', leak: PASSWORD });
  try {
    const result = await runScript({
      MIGRATION_DATABASE_URL: fake.url,
      DATABASE_URL: fake.url,
      APP_USER_PASSWORD: PASSWORD,
    });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /the app_user role does not exist yet\. Run the migrations first/);
    assert.doesNotMatch(result.stdout, /app_user password set/);
    assertNoSecrets(result);
  } finally {
    await fake.close();
  }
});

test('ADR-0006 7.4: when nothing listens on the port, it says so and prints no secret', async () => {
  const fake = await startFakePostgres();
  const { url } = fake;
  await fake.close();
  const result = await runScript({
    MIGRATION_DATABASE_URL: url,
    DATABASE_URL: url,
    APP_USER_PASSWORD: PASSWORD,
  });
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /could not connect to the local database/);
  assertNoSecrets(result);
});
