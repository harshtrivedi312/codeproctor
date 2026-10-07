// Run with: node --test packages/qa/k6/seed/test/seed.test.mjs
// Tests the seeder against mock/mock-api.mjs (which mirrors the real candidate routes; the staff invitation body and erasure are still ASSUMED). No staging,
// no k6, no network beyond 127.0.0.1. Names carry the TC IDs the seeded sessions serve.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { main } from '../seed.mjs';
import { createClient } from '../lib/http.mjs';
import { startMock, MOCK } from '../mock/mock-api.mjs';
import { totp } from '../lib/totp.mjs';
import { redact } from '../lib/redact.mjs';
import { assertSafeOutPath, checkStorageUrl, loadConfig } from '../lib/config.mjs';
import { assertSyntheticDomain } from '../lib/synthetic.mjs';
import { AVAILABLE } from '../lib/routes.mjs';

// System check and the room scan routes are not on main; the mock serves them so the tests can
// cover the seeder code behind them. The "not available" test switches them off again.
AVAILABLE.systemCheck = true;
AVAILABLE.roomScan = true;

const sink = () => {
  const chunks = [];
  const w = new Writable({ write: (c, _e, cb) => (chunks.push(c.toString()), cb()) });
  w.text = () => chunks.join('');
  return w;
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'k6seed-test-'));
const fast = { sleep: async () => {} };

function envFor(m, dir, extra = {}) {
  return {
    API_BASE_URL: m.url,
    ALLOWED_HOSTS: '',
    SEED_STAFF_EMAIL: MOCK.email,
    SEED_STAFF_PASSWORD: MOCK.password,
    SEED_ORG_NAME: MOCK.org,
    SEED_TEST_ID: MOCK.testId,
    SEED_MAIL_URL: m.mailUrl,
    SEED_OUT: path.join(dir, 'sessions.json'),
    SEED_RPS: '50',
    ...extra,
  };
}
async function run(argv, env, extra = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await main(argv, env, { ...fast, stdout, stderr, ...extra });
  return { code, out: stdout.text(), err: stderr.text(), all: stdout.text() + stderr.text() };
}

test('TC-090 seed: happy path writes k6 sessions (0600) and leaves proctor-key uncalled', async () => {
  const m = await startMock();
  const dir = tmp();
  try {
    const env = envFor(m, dir);
    const r = await run(['--count', '3'], env);
    assert.equal(r.code, 0, r.all);
    const file = env.SEED_OUT;
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(list.length, 3);
    assert.equal(new Set(list.map((e) => e.token)).size, 3);
    for (const e of list) {
      assert.match(e.sessionQuestionId, /^[0-9a-f-]{36}$/);
      // main's test/start response carries no question id (sessionQuestionId only)
      assert.ok(!('questionId' in e));
      assert.ok(!('keyB64' in e), 'key must not be fetched by the seeder');
    }
    // TC-091 / ADR 0013 section 4: every session is IN_PROGRESS and its key is still unissued,
    // so the k6 script's single proctor-key call succeeds and a second one answers 409.
    for (const s of m.st.sessions.values()) {
      assert.equal(s.status, 'IN_PROGRESS');
      assert.ok(!s.keyIssued);
    }
    assert.ok(!m.st.requests.some((q) => q.key.endsWith('/proctor-key')));
    const first = m.st.sessions.get(list[0].token);
    const call = (t) =>
      fetch(`${m.url}/candidate/session/proctor-key`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${t}` },
      });
    assert.equal((await call(list[0].token)).status, 200);
    assert.equal((await call(list[0].token)).status, 409);
    assert.ok(first.keyIssued);
    // synthetic data only
    for (const s of m.st.byCandidate.values()) assert.match(s.email, /^k6seed-.*@example\.test$/);
    // manifest: ids only, mode 0600, no tokens
    const mf = fs.readFileSync(`${file}.manifest.json`, 'utf8');
    assert.equal(fs.statSync(`${file}.manifest.json`).mode & 0o777, 0o600);
    for (const e of list) assert.ok(!mf.includes(e.token));
    assert.equal(JSON.parse(mf).items.length, 3);
  } finally {
    await m.close();
  }
});

test('TC-090 seed: waiver, consent age confirmation and state order are sent', async () => {
  const m = await startMock();
  const dir = tmp();
  try {
    const r = await run(['--count', '1'], envFor(m, dir));
    assert.equal(r.code, 0, r.all);
    const order = m.st.requests.map((q) => q.key).filter((k) => !k.includes('/mail/'));
    const idx = (k) => order.findIndex((x) => x.includes(k));
    const steps = [
      '/invitations',
      '/session/link',
      '/session/otp',
      '/session/start',
      '/consent/sign',
      '/system-check',
      '/media/presign',
      'PUT /storage',
      '/media/confirm',
      '/test/start',
    ];
    const at = steps.map(idx);
    assert.ok(
      at.every((n) => n >= 0),
      `missing step in ${JSON.stringify(order)}`,
    );
    assert.deepEqual(
      [...at].sort((a, b) => a - b),
      at,
    );
  } finally {
    await m.close();
  }
});

test('TC-090 seed: candidate calls use the real bodies and fields of candidate.dto.ts (FR-106, FR-401, C-30)', async () => {
  const m = await startMock();
  const dir = tmp();
  const seen = [];
  const realFetch = fetch;
  try {
    const r = await run(['--count', '1'], envFor(m, dir), {
      fetchImpl: async (u, init) => {
        if (/\/candidate\/session\//.test(String(u)) && typeof init?.body === 'string') {
          seen.push([
            new URL(String(u)).pathname.replace(/^.*\/session\//, ''),
            Object.keys(JSON.parse(init.body)).sort(),
          ]);
        }
        return realFetch(u, init);
      },
    });
    assert.equal(r.code, 0, r.all);
    const keys = Object.fromEntries(seen);
    assert.deepEqual(keys.link, ['invitationToken']);
    assert.deepEqual(keys.otp, ['invitationToken']);
    assert.deepEqual(keys.start, ['invitationToken', 'otp']);
    assert.deepEqual(keys['consent/sign'], ['confirmedAge18', 'consentTextId', 'signedName']);
    const list = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'));
    assert.match(list[0].sessionQuestionId, /^[0-9a-f-]{36}$/);
  } finally {
    await m.close();
  }
});

test('TC-090 seed: system check and room scan not on main stop the seed with a named error', async () => {
  const m = await startMock();
  const dir = tmp();
  AVAILABLE.systemCheck = false;
  try {
    const r = await run(['--count', '1'], envFor(m, dir));
    assert.equal(r.code, 1);
    assert.match(r.err, /system check: not available on main yet/);
    assert.ok(!m.st.requests.some((q) => q.key.endsWith('/system-check')));
    assert.ok(!fs.existsSync(path.join(dir, 'sessions.json')));
    AVAILABLE.systemCheck = true;
    AVAILABLE.roomScan = false;
    // --force: the first run left an uncleaned manifest in this directory
    const r2 = await run(['--count', '1', '--force'], envFor(m, dir));
    assert.equal(r2.code, 1);
    assert.match(r2.err, /room scan upload: not available on main yet/);
    assert.ok(!m.st.requests.some((q) => q.key.endsWith('/media/presign')));
  } finally {
    AVAILABLE.systemCheck = true;
    AVAILABLE.roomScan = true;
    await m.close();
  }
});

test('TC-090 seed: secrets, tokens, OTPs and presigned URLs never reach output', async () => {
  const m = await startMock();
  const dir = tmp();
  try {
    const env = envFor(m, dir, { SEED_STAFF_TOTP_SECRET: MOCK.totpSecret });
    const r = await run(['--count', '2'], env);
    assert.equal(r.code, 0, r.all);
    const list = JSON.parse(fs.readFileSync(env.SEED_OUT, 'utf8'));
    for (const secret of [MOCK.password, MOCK.totpSecret, ...list.map((e) => e.token)]) {
      assert.ok(!r.all.includes(secret));
    }
    for (const s of m.st.byCandidate.values()) {
      assert.ok(!r.all.includes(s.linkToken));
      assert.ok(!r.all.includes(s.otp));
    }
    assert.ok(!/X-Amz-Signature|\/storage\//.test(r.all));
    assert.ok(!r.all.includes(env.SEED_OUT) || r.out.includes('mode 0600'));
  } finally {
    await m.close();
  }
});

test('TC-090 seed: failure messages carry no response body, URL or secret', async () => {
  const m = await startMock({ storageHost: 'evil.example.net' });
  const dir = tmp();
  try {
    const r = await run(['--count', '1'], envFor(m, dir));
    assert.equal(r.code, 1);
    assert.ok(/upload host is not allowed/.test(r.err));
    assert.ok(!/evil\.example\.net|X-Amz|Signature/.test(r.all), r.all);
    assert.ok(!fs.existsSync(path.join(dir, 'sessions.json')), 'no sessions file on failure');
    assert.ok(
      fs.existsSync(path.join(dir, 'sessions.json.manifest.json')),
      'manifest kept for cleanup',
    );
  } finally {
    await m.close();
  }
});

test('TC-090 seed: login with TOTP when the staff account has 2FA (FR-102)', async () => {
  const m = await startMock({ twoFactor: true });
  const dir = tmp();
  try {
    const noSecret = await run(['--count', '1'], envFor(m, dir));
    assert.equal(noSecret.code, 1);
    assert.match(noSecret.err, /SEED_STAFF_TOTP_SECRET/);
    const r = await run(
      ['--count', '1'],
      envFor(m, dir, { SEED_STAFF_TOTP_SECRET: MOCK.totpSecret }),
    );
    assert.equal(r.code, 0, r.all);
  } finally {
    await m.close();
  }
});

test('TC-090 seed: refuses a staff account outside the named synthetic organisation', async () => {
  const m = await startMock({ orgName: 'Acme Corp' });
  const dir = tmp();
  try {
    const r = await run(['--count', '1'], envFor(m, dir));
    assert.equal(r.code, 1);
    assert.match(r.err, /does not belong to SEED_ORG_NAME/);
    assert.ok(!m.st.requests.some((q) => q.key.includes('/invitations')));
    const r2 = await run(['--count', '1'], envFor(m, dir, { SEED_ORG_NAME: 'Acme Corp' }));
    assert.equal(r2.code, 2);
    assert.match(r2.err, /SYNTHETIC/);
  } finally {
    await m.close();
  }
});

test('TC-090 seed: host guard refuses unlisted, prod, pilot and tricky URLs before any request', async () => {
  const dir = tmp();
  const base = {
    SEED_STAFF_EMAIL: 'a@example.test',
    SEED_STAFF_PASSWORD: 'x'.repeat(12),
    SEED_ORG_NAME: 'SYNTHETIC',
    SEED_TEST_ID: MOCK.testId,
    SEED_MAIL_URL: 'http://localhost:1/mail',
    SEED_OUT: path.join(dir, 's.json'),
  };
  const cases = [
    ['https://staging.example.com/api/v1', ''], // not allow-listed
    ['https://api.prod.example.com/api/v1', 'api.prod.example.com'], // deny-list wins
    ['https://pilot.example.com/api/v1', 'pilot.example.com'],
    ['https://staging.example.com@api.prod.example.com/api/v1', 'staging.example.com'],
    ['https://api.prod.example.com?@staging.example.com/api/v1', 'staging.example.com'],
  ];
  let fetched = 0;
  for (const [url, allowed] of cases) {
    const r = await run(
      [],
      { ...base, API_BASE_URL: url, ALLOWED_HOSTS: allowed },
      {
        fetchImpl: async () => (fetched++, new Response('{}')),
      },
    );
    assert.equal(r.code, 2, url);
    assert.match(r.err, /Refused/);
  }
  assert.equal(fetched, 0);
  // a listed staging host passes the guard (dry run: still no request)
  const ok = await run(['--dry-run'], {
    ...base,
    API_BASE_URL: 'https://staging.example.com/api/v1',
    ALLOWED_HOSTS: 'staging.example.com',
  });
  assert.equal(ok.code, 0, ok.all);
});

test('TC-090 seed: --dry-run prints the plan and sends no request, secrets not printed', async () => {
  const env = {
    API_BASE_URL: 'http://localhost:4000/api/v1',
    SEED_STAFF_EMAIL: 'staff@example.test',
    SEED_STAFF_PASSWORD: 'super-secret-password',
    SEED_STAFF_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
    SEED_ORG_NAME: 'SYNTHETIC QA',
    SEED_TEST_ID: MOCK.testId,
    SEED_MAIL_URL: 'http://localhost:8025',
  };
  const r = await run(['--dry-run', '--count', '5'], env, {
    fetchImpl: async () => assert.fail('dry run must not send a request'),
  });
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /candidates\s+5 on @example\.test/);
  assert.match(r.out, /Nothing was sent/);
  assert.ok(!r.all.includes('super-secret-password') && !r.all.includes('JBSWY3DPEHPK3PXP'));
  // incomplete config is reported, not guessed
  const bad = await run(['--dry-run'], { API_BASE_URL: 'http://localhost:4000/api/v1' });
  assert.equal(bad.code, 2);
  assert.match(bad.out, /MISSING/);
});

test('TC-090 seed: retries 429 and 503 with Retry-After, then succeeds', async () => {
  const m = await startMock({
    faults: {
      'POST /candidate/session/start': ['429', '503'],
      [`POST /tests/${MOCK.testId}/invitations`]: ['429'],
    },
  });
  const dir = tmp();
  try {
    const r = await run(['--count', '1'], envFor(m, dir));
    assert.equal(r.code, 0, r.all);
    const starts = m.st.requests.filter((q) => q.key === 'POST /candidate/session/start');
    assert.equal(starts.length, 3);
  } finally {
    await m.close();
  }
});

test('TC-090 seed: a 500 on a non-repeatable call is not retried', async () => {
  const m = await startMock({ faults: { 'POST /candidate/session/consent/sign': ['500'] } });
  const dir = tmp();
  try {
    const r = await run(['--count', '1'], envFor(m, dir));
    assert.equal(r.code, 1);
    assert.equal(m.st.requests.filter((q) => q.key.endsWith('/consent/sign')).length, 1);
  } finally {
    await m.close();
  }
});

test('TC-090 seed: request starts are spaced to stay under the rate limit', async () => {
  let clock = 1_000_000;
  const starts = [];
  const client = createClient({
    baseUrl: 'http://127.0.0.1:1',
    rps: 5,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    fetchImpl: async () => (starts.push(clock), new Response('{}', { status: 200 })),
  });
  for (let i = 0; i < 12; i++) await client.request('GET', '/x');
  assert.equal(starts.length, 12);
  for (let i = 1; i < starts.length; i++)
    assert.ok(starts[i] - starts[i - 1] >= 200, starts.join());
});

test('TC-090 seed: a redirect is refused and never followed', async () => {
  let calls = 0;
  const client = createClient({
    baseUrl: 'http://127.0.0.1:1',
    rps: 50,
    sleep: async () => {},
    fetchImpl: async (_u, init) => {
      calls++;
      assert.equal(init.redirect, 'manual');
      return new Response('', { status: 302, headers: { Location: 'https://evil.example.net/x' } });
    },
  });
  await assert.rejects(
    client.request('POST', '/x', { body: {} }),
    (e) => /redirect refused/.test(e.message) && !/evil/.test(e.message),
  );
  assert.equal(calls, 1);
});

test('TC-094 seed: --cleanup erases exactly what the run created, removes the file, is idempotent', async () => {
  const m = await startMock();
  const dir = tmp();
  try {
    const env = envFor(m, dir);
    const r = await run(['--count', '3'], env);
    assert.equal(r.code, 0, r.all);
    const runId = /run id: (k6seed-\S+)/.exec(r.out)[1];
    const created = [...m.st.byCandidate.keys()].sort();

    const wrong = await run(['--cleanup', '--run-id', 'k6seed-20200101000000-abcdef'], env);
    assert.equal(wrong.code, 1);
    assert.deepEqual(m.st.erased, []);

    const c = await run(['--cleanup', '--run-id', runId], env);
    assert.equal(c.code, 0, c.all);
    assert.deepEqual([...m.st.erased].sort(), created);
    assert.ok(!fs.existsSync(env.SEED_OUT), 'sessions file removed');
    const again = await run(['--cleanup', '--run-id', runId], env);
    assert.equal(again.code, 0, again.all);
    assert.equal(m.st.erased.length, 3);
  } finally {
    await m.close();
  }
});

test('TC-094 seed: a partial run keeps a manifest so --cleanup can remove it', async () => {
  const m = await startMock({ failInviteAt: 2 });
  const dir = tmp();
  try {
    const env = envFor(m, dir);
    const r = await run(['--count', '3'], env);
    assert.equal(r.code, 1);
    assert.ok(!fs.existsSync(env.SEED_OUT));
    const runId = /run id: (k6seed-\S+)/.exec(r.out)[1];
    const c = await run(['--cleanup', '--run-id', runId], env);
    assert.equal(c.code, 0, c.all);
    assert.equal(m.st.erased.length, 2);
    // --allow-partial writes what worked
    const m2 = await startMock({ failInviteAt: 2 });
    try {
      const env2 = envFor(m2, dir, { SEED_OUT: path.join(dir, 'partial.json') });
      const p = await run(['--count', '3', '--allow-partial'], env2);
      assert.equal(p.code, 1);
      assert.equal(JSON.parse(fs.readFileSync(env2.SEED_OUT, 'utf8')).length, 2);
    } finally {
      await m2.close();
    }
  } finally {
    await m.close();
  }
});

test('TC-090 seed: refuses to overwrite an existing sessions file without --force', async () => {
  const m = await startMock();
  const dir = tmp();
  try {
    const env = envFor(m, dir);
    fs.writeFileSync(env.SEED_OUT, '[]');
    const r = await run(['--count', '1'], env);
    assert.equal(r.code, 1);
    assert.equal(m.st.requests.length, 0);
    assert.equal((await run(['--count', '1', '--force'], env)).code, 0);
  } finally {
    await m.close();
  }
});

test('TC-090 seed: output path rules (outside the repo, or git-ignored under k6)', () => {
  const root = path.resolve(import.meta.dirname, '../../../../..');
  assert.throws(() => assertSafeOutPath('relative.json'), /absolute/);
  assert.throws(() => assertSafeOutPath(path.join(root, 'sessions.json')), /inside the repository/);
  assert.throws(
    () => assertSafeOutPath(path.join(root, 'packages/qa/k6/seed/out.json')),
    /inside the repository/,
  );
  assert.throws(
    () => assertSafeOutPath(path.join(root, 'packages/qa/k6/../x/sessions.json')),
    /inside the repository/,
  );
  assert.doesNotThrow(() => assertSafeOutPath(path.join(root, 'packages/qa/k6/sessions-a.json')));
  assert.doesNotThrow(() => assertSafeOutPath(path.join(root, 'packages/qa/k6/.local/a.json')));
  assert.doesNotThrow(() => assertSafeOutPath('/var/tmp/sessions.json'));
});

test('TC-090 seed: arguments cannot carry secrets or unknown flags; no echo of the value', () => {
  assert.throws(
    () => loadConfig(['--password', 'hunter2-hunter2'], {}),
    (e) => !/hunter2/.test(e.message),
  );
  assert.throws(() => loadConfig(['--count', '0'], {}));
  assert.throws(() => loadConfig(['--count'], {}), /needs a value/);
});

test('TC-090 seed: storage URL guard allows only listed https hosts (or local when the API is local)', () => {
  assert.throws(() => checkStorageUrl('https://bucket.r2.example.com/k?X=1', '', false));
  assert.equal(
    checkStorageUrl('https://bucket.r2.example.com/k?X=1', 'bucket.r2.example.com', false),
    'bucket.r2.example.com',
  );
  assert.throws(() =>
    checkStorageUrl('http://bucket.r2.example.com/k', 'bucket.r2.example.com', false),
  );
  assert.throws(() => checkStorageUrl('https://x.prod.example.com/k', 'x.prod.example.com', false));
  assert.throws(() =>
    checkStorageUrl('https://a.example.com\\@b.example.com/k', 'a.example.com', false),
  );
  assert.throws(() =>
    checkStorageUrl('https://a.example.com@evil.example.net/k', 'a.example.com', false),
  );
  assert.doesNotThrow(() => checkStorageUrl('http://127.0.0.1:9/k?X=1', '', true));
  assert.throws(() => checkStorageUrl('http://127.0.0.1:9/k', '', false));
});

test('TC-090 seed: synthetic email domain must be reserved', () => {
  for (const d of ['example.test', 'qa.example.test', 'x.invalid', 'example.com'])
    assert.doesNotThrow(() => assertSyntheticDomain(d));
  for (const d of ['gmail.com', 'company.io', 'example.test.evil.com', 'notexample.com'])
    assert.throws(() => assertSyntheticDomain(d));
});

test('TC-090 seed: TOTP matches the RFC 6238 SHA-1 test vectors', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // ASCII "12345678901234567890"
  assert.equal(totp(secret, 59_000, 8), '94287082');
  assert.equal(totp(secret, 1111111109_000, 8), '07081804');
  assert.equal(totp(secret, 20000000000_000, 8), '65353130');
});

test('TC-090 seed: redact removes URLs, tokens, JWTs, bearer headers, OTPs and known secrets', () => {
  const text =
    'GET https://s3.example.com/rec/abc/key.webm?X-Amz-Signature=deadbeef failed; Bearer abc.def; ' +
    'otp 123456; jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJl; key QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=; pw hunter22; run k6seed-20261005120000-abc123';
  const out = redact(text, ['hunter22']);
  for (const leak of [
    's3.example.com',
    'deadbeef',
    'abc.def',
    '123456',
    'eyJ',
    'QUJDREY',
    'hunter22',
  ]) {
    assert.ok(!out.includes(leak), `${leak} leaked: ${out}`);
  }
  assert.ok(out.includes('k6seed-20261005120000-abc123'), 'run id stays readable');
});

test('TC-105 seed: --stop-at CONSENTED ends after consent, so a capacity run can start the later steps itself', async () => {
  const m = await startMock();
  const dir = tmp();
  try {
    const env = envFor(m, dir);
    const r = await run(['--count', '2', '--stop-at', 'CONSENTED'], env);
    assert.equal(r.code, 0, r.all);
    const list = JSON.parse(fs.readFileSync(env.SEED_OUT, 'utf8'));
    assert.equal(list.length, 2);
    for (const e of list) {
      assert.equal(e.state, 'CONSENTED');
      assert.ok(typeof e.token === 'string' && e.token !== '');
      assert.ok(!('sessionQuestionId' in e));
    }
    for (const s of m.st.sessions.values()) assert.equal(s.status, 'CONSENTED');
    for (const tail of ['/system-check', '/media/presign', '/test/start', '/proctor-key']) {
      assert.ok(!m.st.requests.some((q) => q.key.endsWith(tail)), tail);
    }
    assert.ok(!r.all.includes(list[0].token));
  } finally {
    await m.close();
  }
});

test('TC-105 seed: --stop-at takes a known state only, and --identity needs the full flow', () => {
  const env = { API_BASE_URL: 'http://127.0.0.1:9', ALLOWED_HOSTS: '' };
  assert.throws(() => loadConfig(['--stop-at', 'VERIFIED'], env), /--stop-at must be one of/);
  assert.throws(() => loadConfig(['--stop-at'], env), /needs a value/);
  assert.throws(
    () => loadConfig(['--identity', '--stop-at', 'CONSENTED'], env),
    /--identity needs/,
  );
  assert.equal(loadConfig(['--dry-run'], env).stopAt, 'IN_PROGRESS');
});

test('TC-090 seed: --identity stops with a named error while the identity route is not on main', async () => {
  const m = await startMock();
  const dir = tmp();
  try {
    assert.equal(AVAILABLE.identity, false);
    const r = await run(['--count', '1', '--identity'], envFor(m, dir));
    assert.equal(r.code, 1);
    assert.match(r.err, /identity step: not available on main yet/);
    assert.ok(!fs.existsSync(path.join(dir, 'sessions.json')));
  } finally {
    await m.close();
  }
});

test('TC-090 seed: a non-local host must use https for the API and the mail sink (credentials, OTPs, tokens)', () => {
  const base = {
    ALLOWED_HOSTS: 'staging.example.com',
    SEED_STAFF_EMAIL: 'a@example.test',
    SEED_STAFF_PASSWORD: 'x',
    SEED_ORG_NAME: 'Synthetic Org',
    SEED_TEST_ID: '11111111-1111-4111-8111-111111111111',
    SEED_MAIL_URL: 'https://staging.example.com',
    SEED_OUT: '/var/tmp/s.json',
  };
  assert.throws(
    () => loadConfig([], { ...base, API_BASE_URL: 'http://staging.example.com/api/v1' }),
    /API_BASE_URL must use https/,
  );
  assert.throws(
    () =>
      loadConfig([], {
        ...base,
        API_BASE_URL: 'https://staging.example.com/api/v1',
        SEED_MAIL_URL: 'http://staging.example.com',
      }),
    /SEED_MAIL_URL must use https/,
  );
  assert.doesNotThrow(() =>
    loadConfig([], { ...base, API_BASE_URL: 'https://staging.example.com/api/v1' }),
  );
});

test('TC-090 seed: an invalid SEED_INVITE_LINK_REGEX is caught by the configuration, not mid-run', () => {
  const env = {
    API_BASE_URL: 'http://127.0.0.1:9',
    ALLOWED_HOSTS: '',
    SEED_INVITE_LINK_REGEX: '(',
  };
  assert.throws(() => loadConfig(['--dry-run'], env), /not a valid regular expression/);
});

test('TC-094 seed: a new run will not overwrite the manifest of an earlier run that was not cleaned up', async () => {
  const m = await startMock();
  const dir = tmp();
  try {
    const env = envFor(m, dir);
    const first = await run(['--count', '1'], env);
    assert.equal(first.code, 0, first.all);
    fs.rmSync(env.SEED_OUT); // the sessions file is gone, the manifest (and its candidates) remain
    const before = fs.readFileSync(`${env.SEED_OUT}.manifest.json`, 'utf8');
    const again = await run(['--count', '1'], env);
    assert.equal(again.code, 1);
    assert.match(again.err, /manifest from an earlier run exists/);
    assert.equal(fs.readFileSync(`${env.SEED_OUT}.manifest.json`, 'utf8'), before);
    const forced = await run(['--count', '1', '--force'], env);
    assert.equal(forced.code, 0, forced.all);
  } finally {
    await m.close();
  }
});

test('TC-105 seed: --stop-at OPENED never calls consent and records the OPENED state', async () => {
  const m = await startMock();
  const dir = tmp();
  try {
    const env = envFor(m, dir);
    const r = await run(['--count', '1', '--stop-at', 'OPENED'], env);
    assert.equal(r.code, 0, r.all);
    const [e] = JSON.parse(fs.readFileSync(env.SEED_OUT, 'utf8'));
    assert.equal(e.state, 'OPENED');
    assert.ok(!m.st.requests.some((q) => q.key.includes('/consent')));
  } finally {
    await m.close();
  }
});

test('TC-094 seed: --cleanup refuses an unsafe sessions-file path from the manifest before erasing anything', async () => {
  const m = await startMock();
  const dir = tmp();
  try {
    const env = envFor(m, dir);
    const first = await run(['--count', '1'], env);
    assert.equal(first.code, 0, first.all);
    const mfFile = `${env.SEED_OUT}.manifest.json`;
    const mf = JSON.parse(fs.readFileSync(mfFile, 'utf8'));
    mf.sessionsFile = '/etc/hosts'; // a hand-edited manifest must never make cleanup remove this
    fs.writeFileSync(mfFile, JSON.stringify(mf));
    const before = m.st.requests.length;
    const r = await run(['--cleanup', '--run-id', mf.runId], env);
    assert.equal(r.code, 1);
    assert.match(r.err, /Failed:/);
    assert.ok(!m.st.requests.slice(before).some((q) => q.key.includes('erasure')));
    assert.ok(fs.existsSync('/etc/hosts'));
  } finally {
    await m.close();
  }
});

test('TC-094 seed: --cleanup with only --manifest removes the sessions file named like the manifest, nothing else', async () => {
  const m = await startMock();
  const dir = tmp();
  try {
    const env = envFor(m, dir);
    const first = await run(['--count', '1'], env);
    assert.equal(first.code, 0, first.all);
    const mfFile = `${env.SEED_OUT}.manifest.json`;
    const noOut = { ...env };
    delete noOut.SEED_OUT;
    // a hand-edited manifest naming another file outside the repo is refused before any erasure
    const mf = JSON.parse(fs.readFileSync(mfFile, 'utf8'));
    const victim = path.join(dir, 'other.json');
    fs.writeFileSync(victim, '{}');
    fs.writeFileSync(mfFile, JSON.stringify({ ...mf, sessionsFile: victim }));
    const before = m.st.requests.length;
    const bad = await run(['--cleanup', '--run-id', mf.runId, '--manifest', mfFile], noOut);
    assert.equal(bad.code, 1);
    assert.ok(fs.existsSync(victim));
    assert.ok(!m.st.requests.slice(before).some((q) => q.key.includes('erasure')));
    // the genuine manifest cleans up and removes its own sessions file
    fs.writeFileSync(mfFile, JSON.stringify(mf));
    const ok = await run(['--cleanup', '--run-id', mf.runId, '--manifest', mfFile], noOut);
    assert.equal(ok.code, 0, ok.all);
    assert.ok(!fs.existsSync(env.SEED_OUT));
  } finally {
    await m.close();
  }
});

test('TC-094 seed: a malformed manifest is refused with a fixed message', async () => {
  const m = await startMock();
  const dir = tmp();
  try {
    const env = envFor(m, dir);
    const first = await run(['--count', '1'], env);
    assert.equal(first.code, 0, first.all);
    const mfFile = `${env.SEED_OUT}.manifest.json`;
    const mf = JSON.parse(fs.readFileSync(mfFile, 'utf8'));
    fs.writeFileSync(mfFile, JSON.stringify({ ...mf, sessionsFile: 12345 }));
    const r = await run(['--cleanup', '--run-id', mf.runId], env);
    assert.equal(r.code, 1);
    assert.match(r.err, /manifest file is malformed/);
    assert.ok(!r.all.includes('12345'));
  } finally {
    await m.close();
  }
});

test('TC-094 seed: a manifest item with a path-like candidate id is refused before any request', async () => {
  const m = await startMock();
  const dir = tmp();
  try {
    const env = envFor(m, dir);
    const first = await run(['--count', '1'], env);
    assert.equal(first.code, 0, first.all);
    const mfFile = `${env.SEED_OUT}.manifest.json`;
    const mf = JSON.parse(fs.readFileSync(mfFile, 'utf8'));
    mf.items[0].candidateId = '../users/x/role?';
    fs.writeFileSync(mfFile, JSON.stringify(mf));
    const before = m.st.requests.length;
    const r = await run(['--cleanup', '--run-id', mf.runId], env);
    assert.equal(r.code, 1);
    assert.match(r.err, /manifest file is malformed/);
    assert.equal(m.st.requests.length, before);
    fs.writeFileSync(mfFile, 'null');
    const n = await run(['--cleanup', '--run-id', mf.runId], env);
    assert.equal(n.code, 1);
    assert.match(n.err, /malformed/);
  } finally {
    await m.close();
  }
});

test('TC-094 seed: a custom --manifest name needs SEED_OUT to clean up, and says so', async () => {
  const m = await startMock();
  const dir = tmp();
  try {
    const env = envFor(m, dir);
    const custom = path.join(dir, 'custom.json');
    const first = await run(['--count', '1', '--manifest', custom], env);
    assert.equal(first.code, 0, first.all);
    const runId = JSON.parse(fs.readFileSync(custom, 'utf8')).runId;
    const noOut = { ...env };
    delete noOut.SEED_OUT;
    const before = m.st.requests.length;
    const bad = await run(['--cleanup', '--run-id', runId, '--manifest', custom], noOut);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /Set SEED_OUT/);
    assert.equal(m.st.requests.length, before);
    assert.ok(fs.existsSync(env.SEED_OUT));
    const ok = await run(['--cleanup', '--run-id', runId, '--manifest', custom], env);
    assert.equal(ok.code, 0, ok.all);
    assert.ok(!fs.existsSync(env.SEED_OUT));
  } finally {
    await m.close();
  }
});
