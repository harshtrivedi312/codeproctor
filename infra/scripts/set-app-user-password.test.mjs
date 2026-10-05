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
// One int4 column named "x", and one row holding 1: the answer to the pg_roles lookup.
const ROW_DESCRIPTION = message(
  'T',
  Buffer.concat([
    Buffer.from([0, 1]),
    cstring('x'),
    int32(0),
    Buffer.from([0, 0]),
    int32(23),
    Buffer.from([0, 4]),
    int32(-1),
    Buffer.from([0, 0]),
  ]),
);
const DATA_ROW = message('D', Buffer.concat([Buffer.from([0, 1]), int32(1), Buffer.from('1')]));
const LOOKUP_QUERY = "SELECT 1 FROM pg_roles WHERE rolname = 'app_user'";

/**
 * Starts a stand-in Postgres server on 127.0.0.1. It counts connections and records each simple
 * query. A SELECT (the pg_roles lookup) finds one row, or none when `roleExists` is false. `failWith`
 * makes the ALTER ROLE fail with that SQLSTATE and a message that echoes `leak`.
 */
async function startFakePostgres({ failWith, leak, roleExists = true } = {}) {
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
          const text = body.toString('utf8').replace(/\0$/, '');
          state.queries.push(text);
          const isLookup = /^SELECT/i.test(text);
          const reply = isLookup
            ? roleExists
              ? Buffer.concat([ROW_DESCRIPTION, DATA_ROW, message('C', cstring('SELECT 1'))])
              : message('C', cstring('SELECT 0'))
            : failWith === undefined
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
function runScript(extraEnv, args = [], nodeArgs = []) {
  const sandbox = createSandbox();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, SCRIPT, ...args], {
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

// Runs the script with the localhost guard replaced by one that finds no problem, so a test can
// reach the checks that come after it. A module hook swaps the exports of local-db-guard.mjs in
// the child process only; nothing in the repository changes.
const GUARD_BYPASS_HOOKS = `
export async function load(url, context, nextLoad) {
  if (url.endsWith('/infra/scripts/local-db-guard.mjs')) {
    return { format: 'module', shortCircuit: true, source: 'export const findProblems = () => [];' };
  }
  return nextLoad(url, context);
}`;
const GUARD_BYPASS_PRELOAD = `
import { register } from 'node:module';
register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(GUARD_BYPASS_HOOKS)}`)});`;
const GUARD_BYPASS_NODE_ARGS = [
  '--import',
  `data:text/javascript,${encodeURIComponent(GUARD_BYPASS_PRELOAD)}`,
];
const runScriptWithoutGuard = (extraEnv) => runScript(extraEnv, [], GUARD_BYPASS_NODE_ARGS);

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

test('ADR-0006 7.4: it takes no arguments except --if-role-exists', async () => {
  const fake = await startFakePostgres();
  try {
    const env = {
      MIGRATION_DATABASE_URL: fake.url,
      DATABASE_URL: fake.url,
      APP_USER_PASSWORD: PASSWORD,
    };
    for (const args of [
      ['--password', PASSWORD],
      ['--if-role-exists', '--password', PASSWORD],
      ['--if-role-exists=true'],
    ]) {
      const result = await runScript(env, args);
      assert.equal(result.status, 1, result.output);
      assert.match(result.stderr, /takes no arguments except --if-role-exists/);
      assertNoSecrets(result);
    }
    assert.equal(fake.state.connections, 0);
  } finally {
    await fake.close();
  }
});

test('FU-DB-26: a missing role is an error, and the password statement is never sent', async () => {
  const fake = await startFakePostgres({ roleExists: false });
  try {
    const result = await runScript({
      MIGRATION_DATABASE_URL: fake.url,
      DATABASE_URL: fake.url,
      APP_USER_PASSWORD: PASSWORD,
    });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /the app_user role does not exist yet\. Run the migrations first/);
    assert.doesNotMatch(result.stdout, /password set/);
    assertNoSecrets(result);
    // Only the lookup reached the server, so a failed ALTER ROLE cannot put the cleartext in its log.
    assert.deepEqual(fake.state.queries, [LOOKUP_QUERY]);
  } finally {
    await fake.close();
  }
});

test('FU-DB-26: with --if-role-exists a missing role is skipped with exit 0, and an existing role gets its password', async () => {
  const missing = await startFakePostgres({ roleExists: false });
  const present = await startFakePostgres();
  try {
    for (const [fake, expected] of [
      [missing, 'app_user does not exist yet, so no password was set\n'],
      [present, 'app_user password set\n'],
    ]) {
      const result = await runScript(
        { MIGRATION_DATABASE_URL: fake.url, DATABASE_URL: fake.url, APP_USER_PASSWORD: PASSWORD },
        ['--if-role-exists'],
      );
      assert.equal(result.status, 0, result.output);
      assert.equal(result.stdout, expected);
      assertNoSecrets(result);
    }
    assert.deepEqual(missing.state.queries, [LOOKUP_QUERY]);
    assert.equal(present.state.queries.length, 2);
    assert.match(present.state.queries[1], /^ALTER ROLE app_user WITH PASSWORD /);
  } finally {
    await missing.close();
    await present.close();
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
      LOOKUP_QUERY,
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
    // Each run looks the role up, then sets the password.
    assert.equal(fake.state.queries.length, 4);
    assert.deepEqual(fake.state.queries.slice(0, 2), fake.state.queries.slice(2));
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

test('NFR-04 (FU-DB-23): a URL with leading or trailing whitespace is refused before connecting', async () => {
  const fake = await startFakePostgres();
  try {
    // trim() removes all of these, so the guard accepts them. pg-connection-string would resolve
    // a leading one against a dummy host and send the whole URL as the database name.
    const values = {
      'a leading space': ` ${fake.url}`,
      'a leading NBSP': `\u00a0${fake.url}`,
      'a leading BOM': `\ufeff${fake.url}`,
      'a trailing space': `${fake.url} `,
      'a trailing newline': `${fake.url}\n`,
    };
    for (const [label, value] of Object.entries(values)) {
      const result = await runScript({
        MIGRATION_DATABASE_URL: value,
        DATABASE_URL: fake.url,
        APP_USER_PASSWORD: PASSWORD,
      });
      assert.equal(result.status, 1, `${label}: ${result.output}`);
      assert.match(
        result.stderr,
        /MIGRATION_DATABASE_URL has leading or trailing whitespace/,
        label,
      );
      assertNoSecrets(result);
    }
    assert.equal(fake.state.connections, 0, 'the script connected with an untrimmed URL');
    assert.deepEqual(fake.state.queries, []);
  } finally {
    await fake.close();
  }
});

test('NFR-04 (FU-DB-23): the resolved client host must be this machine, even if the guard is bypassed', async () => {
  const fake = await startFakePostgres();
  try {
    const env = { DATABASE_URL: fake.url, APP_USER_PASSWORD: PASSWORD };
    // Control: with the guard replaced, a loopback URL still works, so the cases below are
    // refused by the host check and not by the harness.
    const control = await runScriptWithoutGuard({ ...env, MIGRATION_DATABASE_URL: fake.url });
    assert.equal(control.status, 0, control.output);
    assert.equal(fake.state.connections, 1);

    // 0.0.0.0 would reach the listener on this machine if the script dialled it.
    const refused = [
      `postgresql://owner:${SECRET}@0.0.0.0:${fake.port}/codeproctor`,
      `postgresql://owner:${SECRET}@db.example.com:${fake.port}/codeproctor`,
    ];
    for (const url of refused) {
      const result = await runScriptWithoutGuard({ ...env, MIGRATION_DATABASE_URL: url });
      assert.equal(result.status, 1, result.output);
      assert.match(result.stderr, /to a host other than this machine\. Refusing to connect\./);
      assert.doesNotMatch(result.output, /could not connect|failed \(|db\.example\.com|0\.0\.0\.0/);
      assertNoSecrets(result);
    }
    assert.equal(fake.state.connections, 1, 'the script dialled a host that is not loopback');

    // The check is not case sensitive, like the guard. A closed port keeps it independent of
    // how localhost resolves; what matters is that the host check does not refuse it.
    const upper = await runScriptWithoutGuard({
      ...env,
      MIGRATION_DATABASE_URL: `postgresql://owner:${SECRET}@LOCALHOST:1/codeproctor`,
    });
    assert.doesNotMatch(upper.stderr, /host other than this machine/);
  } finally {
    await fake.close();
  }
});

test('NFR-04 (FU-DB-24): a URL that pg cannot parse gives our own message, no stack trace and no secret', async () => {
  const fake = await startFakePostgres();
  try {
    const cases = {
      // %C0%80 is not valid UTF-8, so decoding the password throws a URIError inside pg.
      'a malformed %-sequence': {
        url: `postgresql://owner:%C0%80${SECRET}@127.0.0.1:${fake.port}/codeproctor`,
        message: /MIGRATION_DATABASE_URL could not be parsed/,
      },
      // pg reads the file while it parses the URL, and fails with the path in its message.
      'a missing sslrootcert file': {
        url: `${fake.url}?sslrootcert=/nonexistent/codeproctor-ca.pem`,
        message: /a file named in MIGRATION_DATABASE_URL .* was not found/,
      },
    };
    for (const [label, { url, message }] of Object.entries(cases)) {
      const result = await runScript({
        MIGRATION_DATABASE_URL: url,
        DATABASE_URL: fake.url,
        APP_USER_PASSWORD: PASSWORD,
      });
      assert.equal(result.status, 1, `${label}: ${result.output}`);
      assert.match(result.stderr, message, label);
      assert.equal(result.stdout, '', label);
      assert.doesNotMatch(
        result.output,
        /URIError|Error:|\n\s+at |node:internal|\.mjs|nonexistent/,
      );
      assertNoSecrets(result);
    }
    assert.equal(fake.state.connections, 0);
  } finally {
    await fake.close();
  }
});
