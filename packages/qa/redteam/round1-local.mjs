// Red-team round 1, local dry run (docs/qa/redteam-round-1-local.md; plan: docs/qa/redteam-plan.md).
//
//   node packages/qa/redteam/round1-local.mjs            staff and forged-token rows (no candidate link needed)
//   RT_CANDIDATE_URL='http://localhost:3000/t/<token>' RT_CANDIDATE_EMAIL='<address>' \
//     node packages/qa/redteam/round1-local.mjs          also the rows that need a real candidate token
//
// Local development stack only: it refuses any API base that is not on this machine and never follows a
// redirect. Synthetic demo data only. It never prints a token, a code, a password, a header or a response
// body: only the route, the HTTP status and the problem `code`. Rate limits: every call goes through
// call(), and the first 429 from any call ends the run. No database access.
//
// The candidate half (RT_CANDIDATE_URL) changes state on the owner's stack: the right-code start raises
// auth_epoch and signs the owner's browser out of that session (ADR 0002 L-2); a failed consent control
// could move the session from OPENED to CONSENTED. It reads the one-time code from Mailpit in memory.
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = process.env.RT_API ?? 'http://localhost:4000/api/v1';
const MAILPIT = process.env.RT_MAILPIT ?? 'http://localhost:8025';
for (const base of [API, MAILPIT]) {
  const host = new URL(base).hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    console.error('round1-local: refusing a base URL that is not on this machine.');
    process.exit(1);
  }
}

// The demo password: RT_STAFF_PASSWORD, else the development constant in the seed guard (local seed only).
let STAFF_PASSWORD = process.env.RT_STAFF_PASSWORD;
if (STAFF_PASSWORD === undefined) {
  const seedGuard = readFileSync(new URL('../../../prisma/seed/guard.ts', import.meta.url), 'utf8');
  STAFF_PASSWORD = /DEMO_PASSWORD\s*=\s*'([^']+)'/.exec(seedGuard)?.[1];
}
if (STAFF_PASSWORD === undefined) {
  console.error('round1-local: set RT_STAFF_PASSWORD (DEMO_PASSWORD not found in the seed guard).');
  process.exit(1);
}

const results = [];
function summary() {
  const diffs = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length} calls, ${results.length - diffs.length} as expected, ${diffs.length} different.`,
  );
}
function record(id, method, expected, r) {
  const ok = expected.includes(r.status);
  results.push({ id, method, status: r.status, code: r.code ?? '-', ok });
  console.log(
    `${ok ? 'SAME ' : 'DIFF '} ${id} | ${method} | ${r.status} ${r.code ?? '-'} | expected ${expected.join('|')}`,
  );
}
function stopOn429(r, label) {
  if (r.status === 429) {
    console.log(`STOP  first 429 at ${label}; ending the run (rules of engagement).`);
    summary();
    process.exit(2);
  }
}

// Every request goes through here. Returns status, problem code, body length, the parsed body (kept in
// memory, never printed) and has(name): whether the body text names a field.
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
  const res = await fetch(`${API}${path}`, {
    method,
    headers: h,
    body: payload,
    redirect: 'error',
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const r = {
    status: res.status,
    code: typeof json?.code === 'string' ? json.code : undefined,
    len: text.length,
    json,
    has: (name) => text.includes(name),
  };
  stopOn429(r, `${method} ${path}`);
  return r;
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function forgedJwt(alg, claims, key) {
  const head = b64({ alg, typ: 'JWT' });
  const payload = b64(claims);
  if (alg === 'none') return `${head}.${payload}.`;
  const sig = createHmac('sha256', key).update(`${head}.${payload}`).digest('base64url');
  return `${head}.${payload}.${sig}`;
}

async function staffLogin(role) {
  const r = await call('POST', '/auth/login', {
    body: { email: `${role}@demo-corp.example`, password: STAFF_PASSWORD },
  });
  record('SETUP', `POST /auth/login ${role} (creates a session)`, [200], r);
  return { token: r.json?.session?.accessToken, status: r.status };
}

const UUID_A = '00000000-0000-4000-8000-000000000001';

// ---- Group 1: forged, malformed tokens on candidate routes (RT-62, RT-60 family, RT-04/05 start) --
const now = Math.floor(Date.now() / 1000);
const claims = { typ: 'candidate', sid: UUID_A, oid: UUID_A, epoch: 1, iat: now, exp: now + 600 };
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
const candidateProbes = [
  ['GET', '/candidate/session'],
  ['POST', '/candidate/session/proctor-key'],
  ['POST', `/candidate/answers/${UUID_A}/submit`],
];
for (const [label, token] of Object.entries(forged)) {
  for (const [method, path] of candidateProbes) {
    const r = await call(method, path, { token, body: method === 'POST' ? {} : undefined });
    record('RT-62/60 forged', `${label}: ${method} ${path.replace(UUID_A, ':id')}`, [401], r);
  }
}
// Events and keystrokes exist on main (BE-10): the token check comes before the signature check.
for (const path of ['/candidate/session/events', '/candidate/session/keystrokes']) {
  for (const label of ['no token', 'HS256 with a random key']) {
    const r = await call('POST', path, { token: forged[label], raw: '{}' });
    record('RT-05 forged token', `${label}: POST ${path} (no signature)`, [401], r);
  }
}

// ---- Group 2: staff tokens and the role matrix (RT-62, RT-63) ---------------------------------
const recruiter = await staffLogin('recruiter');
const reviewer = await staffLogin('reviewer');
const author = await staffLogin('author');
record(
  'RT-68/TC-002 one wrong password',
  'POST /auth/login recruiter (adds to the failed-login count)',
  [401],
  await call('POST', '/auth/login', {
    body: { email: 'recruiter@demo-corp.example', password: 'Wrong-Password-1!' },
  }),
);

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
  const t = recruiter.token;
  record(
    'RT-63 recruiter',
    'GET /review/queue',
    [403],
    await call('GET', '/review/queue', { token: t }),
  );
  record(
    'RT-63 recruiter',
    'POST /questions (author route, empty body)',
    [403],
    await call('POST', '/questions', { token: t, body: {} }),
  );
  record(
    'RT-63 recruiter',
    'PATCH /questions/:id (unknown id)',
    [403],
    await call('PATCH', `/questions/${UUID_A}`, { token: t, body: {} }),
  );
  record(
    'RT-63 recruiter',
    'GET /admin/users',
    [403],
    await call('GET', '/admin/users', { token: t }),
  );
  record(
    'RT-63 recruiter',
    'GET /admin/org-settings',
    [403],
    await call('GET', '/admin/org-settings', { token: t }),
  );
}
if (reviewer.token !== undefined) {
  const t = reviewer.token;
  record('RT-63 reviewer', 'GET /tests', [403], await call('GET', '/tests', { token: t }));
  record(
    'RT-63 reviewer',
    'POST /tests (empty body)',
    [403],
    await call('POST', '/tests', { token: t, body: {} }),
  );
  record(
    'RT-63 reviewer',
    'POST /questions (empty body)',
    [403],
    await call('POST', '/questions', { token: t, body: {} }),
  );
  record(
    'RT-63 reviewer',
    'GET /admin/users',
    [403],
    await call('GET', '/admin/users', { token: t }),
  );
}
if (author.token !== undefined) {
  const t = author.token;
  record(
    'RT-63 author',
    'GET /review/queue',
    [403],
    await call('GET', '/review/queue', { token: t }),
  );
  record(
    'RT-63 author',
    'GET /review/sessions/:id (unknown id)',
    [403],
    await call('GET', `/review/sessions/${UUID_A}`, { token: t }),
  );
  record('RT-63 author', 'GET /tests', [403], await call('GET', '/tests', { token: t }));
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
// Two unknown ids inside the one org. Oracle (own org vs other org) is NOT tested: needs a second org.
if (recruiter.token !== undefined) {
  const t = recruiter.token;
  const a = await call('GET', `/tests/${UUID_A}`, { token: t });
  const b = await call('GET', '/tests/ffffffff-ffff-4fff-8fff-ffffffffffff', { token: t });
  record('RT-64 id probe', 'recruiter GET /tests/<unknown uuid 1>', [404], a);
  record('RT-64 id probe', 'recruiter GET /tests/<unknown uuid 2>', [404], b);
  console.log(
    `      two unknown ids answer alike (status, code, length): ${a.status === b.status && a.code === b.code && a.len === b.len}`,
  );
  record(
    'RT-64 id probe',
    'recruiter GET /tests/not-a-uuid',
    [400, 404],
    await call('GET', '/tests/not-a-uuid', { token: t }),
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
  `      link/otp/start unknown token: same status and code: ${l1.status === l2.status && l2.status === l3.status && l1.code === l3.code}`,
);
const link = (body) => call('POST', '/candidate/session/link', { body });
record(
  'RT-68 input',
  'link: token of 10000 characters',
  [400, 404],
  await link({ invitationToken: 'a'.repeat(10000) }),
);
record('RT-68 input', 'link: token is a number', [400], await link({ invitationToken: 12345 }));
record(
  'RT-68 input',
  'link: extra property',
  [400, 404],
  await link({ invitationToken: fakeLink, status: 'x' }),
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
// UNVERIFIED: this half has not been run. Statuses come from the docs and the DTOs.
async function candidateHalf() {
  const linkToken = /\/t(?:\/|#)([^/?#]+)/.exec(process.env.RT_CANDIDATE_URL)?.[1];
  const email = process.env.RT_CANDIDATE_EMAIL;
  if (linkToken === undefined || email === undefined) {
    console.error('Set RT_CANDIDATE_URL (http://localhost:3000/t/<token>) and RT_CANDIDATE_EMAIL.');
    process.exit(1);
  }
  // A previous run's wrong attempt may still count toward the 30-minute link lock (TC-007).
  const marker = join(tmpdir(), 'rt-round1-wrong-attempt');
  if (existsSync(marker) && Date.now() - statSync(marker).mtimeMs < 30 * 60_000) {
    console.error(
      'A previous run made a wrong-code attempt less than 30 minutes ago: not running.',
    );
    process.exit(1);
  }
  record(
    'RT-68',
    'POST link, open invitation',
    [200],
    await call('POST', '/candidate/session/link', { body: { invitationToken: linkToken } }),
  );
  const sentAt = Date.now();
  record(
    'RT-68',
    'POST otp, open invitation',
    [200],
    await call('POST', '/candidate/session/otp', { body: { invitationToken: linkToken } }),
  );
  // The code in the newest message to that address that arrived after the request; kept in memory only.
  let otp;
  for (let i = 0; i < 10 && otp === undefined; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const list = await (
      await fetch(`${MAILPIT}/api/v1/messages?limit=20`, { redirect: 'error' })
    ).json();
    const m = (list.messages ?? []).find(
      (x) =>
        (x.To ?? []).some((a) => a.Address?.toLowerCase() === email.toLowerCase()) &&
        Date.parse(x.Created) >= sentAt - 2000,
    );
    if (m !== undefined) {
      const full = await (
        await fetch(`${MAILPIT}/api/v1/message/${m.ID}`, { redirect: 'error' })
      ).json();
      otp = /\b(\d{6})\b/.exec(full.Text ?? '')?.[1];
    }
  }
  if (otp === undefined) {
    console.log('STOP  no code mail for that address after the request; nothing submitted.');
    return;
  }
  writeFileSync(marker, new Date().toISOString());
  const wrongOtp = otp === '000000' ? '111111' : '000000';
  record(
    'RT-68',
    'POST start, one wrong code',
    [400],
    await call('POST', '/candidate/session/start', {
      body: { invitationToken: linkToken, otp: wrongOtp },
    }),
  );
  const start = await call('POST', '/candidate/session/start', {
    body: { invitationToken: linkToken, otp },
  });
  record('RT-68', 'POST start, right code (raises auth_epoch)', [200], start);
  const tok = start.json?.sessionToken;
  record(
    'RT-68',
    'POST start again with the used code (replay)',
    [400, 409],
    await call('POST', '/candidate/session/start', { body: { invitationToken: linkToken, otp } }),
  );
  if (tok === undefined) return;
  const post = (path, body) => call('POST', path, { token: tok, body });
  record(
    'RT-69',
    'test/start in OPENED (not signed)',
    [409],
    await post('/candidate/session/test/start', {}),
  );
  record(
    'RT-69',
    'media presign in OPENED',
    [409, 400],
    await post('/candidate/session/media/presign', {}),
  );
  record(
    'RT-69',
    'identity presign in OPENED',
    [409, 400],
    await post('/candidate/session/identity/presign', {}),
  );
  record(
    'RT-69',
    'answers run in OPENED',
    [409, 400],
    await post(`/candidate/answers/${UUID_A}/run`, {}),
  );
  record('RT-60', 'heartbeat before start', [409], await post('/candidate/session/heartbeat', {}));
  record(
    'RT-10',
    'proctor-key before start',
    [409],
    await post('/candidate/session/proctor-key', undefined),
  );
  // C-30: only confirmedAge18 varies. The consent document id comes from GET consent.
  const doc = await call('GET', '/candidate/session/consent', { token: tok });
  record('RT-69', 'GET consent (for consentTextId)', [200], doc);
  const consentTextId = doc.json?.consentTextId;
  if (consentTextId === undefined) return;
  const sign = (extra) =>
    post('/candidate/session/consent/sign', { consentTextId, signedName: 'Avery Stone', ...extra });
  const missing = await sign({});
  record('RT-69', 'consent/sign, confirmedAge18 missing', [400], missing);
  console.log(`      400 names confirmedAge18: ${missing.has('confirmedAge18')}`);
  const falsy = await sign({ confirmedAge18: false });
  record('RT-69', 'consent/sign, confirmedAge18 false', [400], falsy);
  console.log(`      answer names confirmedAge18: ${falsy.has('confirmedAge18')}`);
  // Decline is final for the invitation: only with RT_ALLOW_DECLINE=1.
  if (process.env.RT_ALLOW_DECLINE === '1') {
    record(
      'RT-69',
      'consent/decline',
      [200],
      await post('/candidate/session/consent/decline', undefined),
    );
    record('RT-69', 'consent/sign after decline', [409], await sign({ confirmedAge18: true }));
    record(
      'RT-69',
      'test/start after decline',
      [409],
      await post('/candidate/session/test/start', {}),
    );
  }
}
if (process.env.RT_CANDIDATE_URL === undefined) {
  console.log('SKIP  candidate-token rows: RT_CANDIDATE_URL not set (blocked-by-env).');
} else {
  await candidateHalf();
}

summary();
