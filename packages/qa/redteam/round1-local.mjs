// Red-team round 1, local dry run (docs/qa/redteam-round-1-local.md; plan: docs/qa/redteam-plan.md).
//
//   node packages/qa/redteam/round1-local.mjs            staff and forged-token rows (no candidate link needed)
//   RT_CANDIDATE_URL='<link printed by demo-invite.mjs>' node packages/qa/redteam/round1-local.mjs
//                                                          also the rows that need a real candidate token
//
// Local development stack only: it refuses any API base that is not on this machine. Synthetic demo
// data only. It never prints a token, a code, a password, a header or a response body: only the route,
// the HTTP status and the problem `code`. Rate limits: it stops a group at the first 429.
// The candidate rows need the one-time code from Mailpit (local, http://localhost:8025); it is read in
// memory and never printed. No database access.
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const API = process.env.RT_API ?? 'http://localhost:4000/api/v1';
const MAILPIT = process.env.RT_MAILPIT ?? 'http://localhost:8025';
for (const base of [API, MAILPIT]) {
  const host = new URL(base).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    console.error('round1-local: refusing a base URL that is not on this machine.');
    process.exit(1);
  }
}

const seedGuard = readFileSync(new URL('../../../prisma/seed/guard.ts', import.meta.url), 'utf8');
const DEMO_PASSWORD = /DEMO_PASSWORD\s*=\s*'([^']+)'/.exec(seedGuard)?.[1];
if (DEMO_PASSWORD === undefined) {
  console.error('round1-local: DEMO_PASSWORD not found in prisma/seed/guard.ts.');
  process.exit(1);
}

const results = [];
function record(id, method, expected, r) {
  const ok = expected.includes(r.status);
  results.push({
    id,
    method,
    status: r.status,
    code: r.code ?? '-',
    expected: expected.join('|'),
    ok,
  });
  console.log(
    `${ok ? 'SAME ' : 'DIFF '} ${id} | ${method} | ${r.status} ${r.code ?? '-'} | expected ${expected.join('|')}`,
  );
}

async function call(
  method,
  path,
  { token, body, raw, contentType = 'application/json', headers = {} } = {},
) {
  const h = { ...headers };
  if (token !== undefined) h.authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) {
    payload = raw;
    h['content-type'] = contentType;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    h['content-type'] = contentType;
  }
  const res = await fetch(`${API}${path}`, { method, headers: h, body: payload });
  const text = await res.text();
  let code;
  try {
    const j = JSON.parse(text);
    code = typeof j.code === 'string' ? j.code : undefined;
  } catch {
    code = undefined;
  }
  return { status: res.status, code, len: text.length };
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function forgedJwt(alg, claims, key) {
  const head = b64({ alg, typ: 'JWT' });
  const payload = b64(claims);
  if (alg === 'none') return `${head}.${payload}.`;
  const sig = createHmac('sha256', key).update(`${head}.${payload}`).digest('base64url');
  return `${head}.${payload}.${sig}`;
}

async function staffLogin(email) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: DEMO_PASSWORD }),
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, token: j.session?.accessToken, challenge: j.status };
}

const ULID_A = '00000000-0000-4000-8000-000000000001';

// ---- Group 1: forged, malformed and staff tokens on candidate routes (RT-62, RT-60 family) --------
const candidateRoutes = [
  ['GET', '/candidate/session'],
  ['POST', '/candidate/session/heartbeat'],
  ['POST', '/candidate/session/proctor-key'],
  ['POST', '/candidate/session/consent/sign'],
  ['POST', `/candidate/answers/${ULID_A}/submit`],
  ['POST', '/candidate/session/media/presign'],
];
const now = Math.floor(Date.now() / 1000);
const claims = { typ: 'candidate', sid: ULID_A, oid: ULID_A, epoch: 1, iat: now, exp: now + 600 };
const forgeKey = randomBytes(32);
const forged = {
  'no token': undefined,
  'garbage token': 'not-a-jwt',
  'alg none': forgedJwt('none', claims),
  'HS256 with a random key': forgedJwt('HS256', claims, forgeKey),
  'HS256 random key, expired': forgedJwt(
    'HS256',
    { ...claims, iat: now - 7200, exp: now - 3600 },
    forgeKey,
  ),
};
let stop = false;
for (const [label, token] of Object.entries(forged)) {
  for (const [method, path] of [candidateRoutes[0], candidateRoutes[2], candidateRoutes[4]]) {
    if (stop) break;
    const r = await call(method, path, { token, body: method === 'POST' ? {} : undefined });
    if (r.status === 429) stop = true;
    record('RT-62/60 forged', `${label}: ${method} ${path.replace(ULID_A, ':id')}`, [401], r);
  }
}

// ---- Group 2: staff tokens and the role matrix (RT-62, RT-63) ---------------------------------
const recruiter = await staffLogin('recruiter@demo-corp.example');
const reviewer = await staffLogin('reviewer@demo-corp.example');
const author = await staffLogin('author@demo-corp.example');
for (const [who, l] of [
  ['recruiter', recruiter],
  ['reviewer', reviewer],
  ['author', author],
]) {
  if (l.token === undefined)
    console.log(`NOTE  ${who} login gave status ${l.status} ${l.challenge ?? ''}`);
}
const wrong = await call('POST', '/auth/login', {
  body: { email: 'recruiter@demo-corp.example', password: 'Wrong-Password-1!' },
});
record('RT-68/TC-002 one wrong password', 'POST /auth/login', [401], wrong);

if (recruiter.token !== undefined) {
  for (const [m, p] of [
    ['GET', '/candidate/session'],
    ['POST', '/candidate/session/heartbeat'],
    ['POST', '/candidate/session/proctor-key'],
  ]) {
    record(
      'RT-62 staff token on candidate',
      `recruiter token: ${m} ${p}`,
      [401, 403],
      await call(m, p, { token: recruiter.token, body: m === 'POST' ? {} : undefined }),
    );
  }
  record(
    'RT-63 recruiter',
    'GET /review/queue',
    [403],
    await call('GET', '/review/queue', { token: recruiter.token }),
  );
  record(
    'RT-63 recruiter',
    'POST /questions (author route, empty body)',
    [403],
    await call('POST', '/questions', { token: recruiter.token, body: {} }),
  );
  record(
    'RT-63 recruiter',
    `PATCH /questions/:id (unknown id)`,
    [403],
    await call('PATCH', `/questions/${ULID_A}`, { token: recruiter.token, body: {} }),
  );
  record(
    'RT-63 recruiter',
    'GET /admin/users',
    [403],
    await call('GET', '/admin/users', { token: recruiter.token }),
  );
  record(
    'RT-63 recruiter',
    'GET /admin/org-settings',
    [403],
    await call('GET', '/admin/org-settings', { token: recruiter.token }),
  );
}
if (reviewer.token !== undefined) {
  record(
    'RT-63 reviewer',
    'GET /tests',
    [403],
    await call('GET', '/tests', { token: reviewer.token }),
  );
  record(
    'RT-63 reviewer',
    'POST /tests (empty body)',
    [403],
    await call('POST', '/tests', { token: reviewer.token, body: {} }),
  );
  record(
    'RT-63 reviewer',
    'POST /questions (empty body)',
    [403],
    await call('POST', '/questions', { token: reviewer.token, body: {} }),
  );
  record(
    'RT-63 reviewer',
    'GET /admin/users',
    [403],
    await call('GET', '/admin/users', { token: reviewer.token }),
  );
}
if (author.token !== undefined) {
  record(
    'RT-63 author',
    'GET /review/queue',
    [403],
    await call('GET', '/review/queue', { token: author.token }),
  );
  record(
    'RT-63 author',
    `GET /review/sessions/:id (unknown id)`,
    [403],
    await call('GET', `/review/sessions/${ULID_A}`, { token: author.token }),
  );
  record('RT-63 author', 'GET /tests', [403], await call('GET', '/tests', { token: author.token }));
}
// Forged tokens on staff routes (the other direction of RT-62).
for (const [label, token] of Object.entries({
  'candidate-shaped HS256 forged': forged['HS256 with a random key'],
  'alg none': forged['alg none'],
})) {
  for (const p of ['/review/queue', '/questions', '/tests']) {
    record('RT-62 forged on staff', `${label}: GET ${p}`, [401], await call('GET', p, { token }));
  }
}
// IDOR on ids within the one org: an unknown id and a malformed id answer alike (no oracle inside org).
if (recruiter.token !== undefined) {
  const a = await call('GET', `/tests/${ULID_A}`, { token: recruiter.token });
  const b = await call('GET', `/tests/${'ffffffff-ffff-4fff-8fff-ffffffffffff'}`, {
    token: recruiter.token,
  });
  record('RT-64 id probe', 'recruiter GET /tests/:unknown-uuid', [404], a);
  console.log(
    `      two unknown ids answer alike: ${a.status === b.status && a.code === b.code && a.len === b.len}`,
  );
  record(
    'RT-64 id probe',
    'recruiter GET /tests/not-a-uuid',
    [400, 404],
    await call('GET', '/tests/not-a-uuid', { token: recruiter.token }),
  );
}

// ---- Group 3: candidate link entry (RT-68, input limits) --------------------------------------
const fakeLink = randomBytes(32).toString('base64url');
const l1 = await call('POST', '/candidate/session/link', { body: { invitationToken: fakeLink } });
record('RT-68 unknown link', 'POST /candidate/session/link random token', [404], l1);
const l2 = await call('POST', '/candidate/session/otp', { body: { invitationToken: fakeLink } });
record('RT-68 unknown link', 'POST /candidate/session/otp random token', [404], l2);
const l3 = await call('POST', '/candidate/session/start', {
  body: { invitationToken: fakeLink, otp: '000000' },
});
record('RT-68 unknown link', 'POST /candidate/session/start random token, wrong code', [404], l3);
console.log(
  `      link/otp/start answer alike for an unknown token: ${l1.status === l2.status && l2.status === l3.status}`,
);
record(
  'RT-68 input',
  'link: token of 10000 characters',
  [400, 404],
  await call('POST', '/candidate/session/link', { body: { invitationToken: 'a'.repeat(10000) } }),
);
record(
  'RT-68 input',
  'link: token is a number',
  [400],
  await call('POST', '/candidate/session/link', { body: { invitationToken: 12345 } }),
);
record(
  'RT-68 input',
  'link: extra property',
  [400, 404],
  await call('POST', '/candidate/session/link', {
    body: { invitationToken: fakeLink, status: 'x' },
  }),
);
record(
  'RT-08 input',
  'link: 300 KiB body',
  [400, 413],
  await call('POST', '/candidate/session/link', {
    raw: JSON.stringify({ invitationToken: 'a'.repeat(300 * 1024) }),
  }),
);
record(
  'RT-08 input',
  'link: Content-Type text/plain',
  [400, 415],
  await call('POST', '/candidate/session/link', { raw: 'x', contentType: 'text/plain' }),
);
record(
  'RT-08 input',
  'link: invalid JSON',
  [400],
  await call('POST', '/candidate/session/link', { raw: '{"invitationToken":' }),
);

// ---- Group 4: rows that need a real candidate token (only with RT_CANDIDATE_URL) --------------
if (process.env.RT_CANDIDATE_URL === undefined) {
  console.log('SKIP  candidate-token rows: RT_CANDIDATE_URL not set (blocked-by-env).');
} else {
  const linkToken = process.env.RT_CANDIDATE_URL.split('/t/')[1]?.split(/[?#]/)[0];
  if (linkToken === undefined) {
    console.error('RT_CANDIDATE_URL must look like http://localhost:3000/t/<token>');
    process.exit(1);
  }
  record(
    'RT-68',
    'POST link, open invitation',
    [200],
    await call('POST', '/candidate/session/link', { body: { invitationToken: linkToken } }),
  );
  record(
    'RT-68',
    'POST otp, open invitation',
    [200],
    await call('POST', '/candidate/session/otp', { body: { invitationToken: linkToken } }),
  );
  // Newest Mailpit message to the demo candidate; the six digits stay in memory.
  const list = await (await fetch(`${MAILPIT}/api/v1/messages?limit=1`)).json();
  const id = list.messages?.[0]?.ID;
  const msg = id === undefined ? {} : await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json();
  const otp = /\b(\d{6})\b/.exec(`${msg.Text ?? ''}`)?.[1];
  if (otp === undefined) {
    console.log(
      'NOTE  no six-digit code found in the newest Mailpit message; stopping the candidate rows.',
    );
  } else {
    const wrongOtp = otp === '000000' ? '111111' : '000000';
    record(
      'RT-68',
      'POST start, one wrong code',
      [400],
      await call('POST', '/candidate/session/start', {
        body: { invitationToken: linkToken, otp: wrongOtp },
      }),
    );
    const res = await fetch(`${API}/candidate/session/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invitationToken: linkToken, otp }),
    });
    const j = await res.json().catch(() => ({}));
    const tok = j.sessionToken;
    results.push({
      id: 'RT-68',
      method: 'POST start, right code',
      status: res.status,
      code: j.code ?? '-',
      expected: '200',
      ok: res.status === 200,
    });
    console.log(
      `${res.status === 200 ? 'SAME ' : 'DIFF '} RT-68 | POST start, right code | ${res.status} ${j.code ?? '-'}`,
    );
    record(
      'RT-68',
      'POST start again with the used code (replay)',
      [400, 409],
      await call('POST', '/candidate/session/start', { body: { invitationToken: linkToken, otp } }),
    );
    if (tok !== undefined) {
      record(
        'RT-69',
        'test/start in OPENED (not signed)',
        [409],
        await call('POST', '/candidate/session/test/start', { token: tok, body: {} }),
      );
      record(
        'RT-69',
        'media presign in OPENED',
        [409, 400],
        await call('POST', '/candidate/session/media/presign', { token: tok, body: {} }),
      );
      record(
        'RT-69',
        'identity presign in OPENED',
        [409, 400],
        await call('POST', '/candidate/session/identity/presign', { token: tok, body: {} }),
      );
      record(
        'RT-69',
        'answers run in OPENED',
        [409, 400],
        await call('POST', `/candidate/answers/${ULID_A}/run`, { token: tok, body: {} }),
      );
      record(
        'RT-69',
        'consent/sign without the 18+ confirmation',
        [400],
        await call('POST', '/candidate/session/consent/sign', {
          token: tok,
          body: { typedName: 'Avery Stone' },
        }),
      );
      record(
        'RT-69',
        'consent/sign with the 18+ flag false',
        [400],
        await call('POST', '/candidate/session/consent/sign', {
          token: tok,
          body: { typedName: 'Avery Stone', confirmedAge18: false },
        }),
      );
      record(
        'RT-60',
        'heartbeat before start',
        [409],
        await call('POST', '/candidate/session/heartbeat', { token: tok, body: {} }),
      );
      record(
        'RT-10',
        'proctor-key before start',
        [409],
        await call('POST', '/candidate/session/proctor-key', { token: tok }),
      );
      // Decline is final for the invitation (it ruins the demo link): only with RT_ALLOW_DECLINE=1.
      if (process.env.RT_ALLOW_DECLINE === '1') {
        record(
          'RT-69',
          'consent/decline then consent/sign',
          [200],
          await call('POST', '/candidate/session/consent/decline', { token: tok }),
        );
        record(
          'RT-69',
          'sign after decline',
          [409],
          await call('POST', '/candidate/session/consent/sign', {
            token: tok,
            body: { typedName: 'Avery Stone', confirmedAge18: true },
          }),
        );
        record(
          'RT-69',
          'test/start after decline',
          [409],
          await call('POST', '/candidate/session/test/start', { token: tok, body: {} }),
        );
      }
    }
  }
}

const diffs = results.filter((r) => !r.ok);
console.log(
  `\n${results.length} attempts, ${results.length - diffs.length} as expected, ${diffs.length} different.`,
);
