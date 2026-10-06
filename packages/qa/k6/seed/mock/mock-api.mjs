// A stand-in for the BE-07 candidate/staff API and a Mailpit-style mail sink, ONLY to test the
// seeder's behaviour (state order, retries, guards, redaction, cleanup). It implements the routes
// and bodies marked ASSUMED in lib/routes.mjs, so it proves the seeder matches that table and
// nothing about the real product. Synthetic data only; everything lives in memory.
import http from 'node:http';
import crypto from 'node:crypto';
import { totp } from '../lib/totp.mjs';

export const MOCK = {
  email: 'staff@example.test',
  password: 'pw-correct-horse-battery',
  org: 'SYNTHETIC QA Org',
  testId: '11111111-1111-4111-8111-111111111111',
  totpSecret: 'JBSWY3DPEHPK3PXP',
};

export async function startMock(opts = {}) {
  const st = {
    sessions: new Map(), // candidate session token -> session
    byInvite: new Map(), // link token -> session
    byCandidate: new Map(),
    mail: [],
    staffTokens: new Set(),
    erased: [],
    requests: [],
    faults: structuredClone(opts.faults ?? {}), // "METHOD path" -> ['429', '503', '500', ...]
    inviteCount: 0,
    verifyPolls: opts.verifyPolls ?? 2,
    storageHost: opts.storageHost, // a presigned URL pointing at another host (guard test)
  };
  const uuid = () => crypto.randomUUID();
  let base = '';

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const problem = (res, status, code, headers) => send(res, status, { code }, headers);

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const p = url.pathname.replace(/^\/api\/v1/, '');
      const key = `${req.method} ${p}`;
      st.requests.push({ key, auth: req.headers.authorization, bodyLength: raw.length });

      const fault = st.faults[key]?.shift();
      if (fault) {
        return problem(res, Number(fault), 'INJECTED_FAULT', { 'Retry-After': '0' });
      }
      let body = {};
      if (raw.length && req.headers['content-type']?.includes('json')) {
        try {
          body = JSON.parse(raw.toString());
        } catch {
          return problem(res, 400, 'BAD_JSON');
        }
      }
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const staffOk = st.staffTokens.has(bearer);
      const sess = st.sessions.get(bearer);

      // ---- mail sink (Mailpit-compatible subset) ----
      if (req.url.startsWith('/mail/api/v1/search')) {
        const q = decodeURIComponent(url.searchParams.get('query') ?? '').replace(/^to:/, '');
        return send(res, 200, {
          messages: st.mail
            .filter((m) => m.to === q)
            .map((m) => ({ ID: m.id, Created: m.created })),
        });
      }
      const mm = /^\/mail\/api\/v1\/message\/(.+)$/.exec(url.pathname);
      if (mm) {
        const m = st.mail.find((x) => x.id === mm[1]);
        return m ? send(res, 200, { Text: m.text }) : problem(res, 404, 'NOT_FOUND');
      }

      // ---- staff ----
      if (key === 'POST /auth/login') {
        if (body.email !== MOCK.email || body.password !== MOCK.password) {
          return problem(res, 401, 'INVALID_CREDENTIALS');
        }
        if (opts.twoFactor) {
          return send(res, 200, {
            status: 'two_factor_required',
            challengeToken: `chal-${uuid()}${uuid()}`,
          });
        }
        const t = `acc-${crypto.randomBytes(24).toString('hex')}`;
        st.staffTokens.add(t);
        return send(res, 200, {
          status: 'authenticated',
          session: {
            accessToken: t,
            user: { orgName: opts.orgName ?? MOCK.org, role: 'SUPER_ADMIN' },
          },
        });
      }
      if (key === 'POST /auth/2fa/verify') {
        if (body.code !== totp(MOCK.totpSecret)) return problem(res, 400, 'INVALID_CODE');
        const t = `acc-${crypto.randomBytes(24).toString('hex')}`;
        st.staffTokens.add(t);
        return send(res, 200, { accessToken: t, user: { orgName: opts.orgName ?? MOCK.org } });
      }
      if (/^POST \/tests\/[^/]+\/invitations$/.test(key)) {
        if (!staffOk) return problem(res, 401, 'UNAUTHENTICATED');
        if (
          !body.candidateEmail?.endsWith('@example.test') ||
          !body.accommodations?.identityCheckWaiver
        ) {
          return problem(res, 400, 'VALIDATION_FAILED');
        }
        if (opts.failInviteAt === ++st.inviteCount) return problem(res, 500, 'INTERNAL');
        const s = {
          candidateId: uuid(),
          invitationId: uuid(),
          sessionId: uuid(),
          email: body.candidateEmail,
          linkToken: crypto.randomBytes(32).toString('base64url'),
          status: 'INVITED',
          polls: 0,
        };
        st.byInvite.set(s.linkToken, s);
        st.byCandidate.set(s.candidateId, s);
        st.mail.push({
          id: uuid(),
          to: s.email,
          created: new Date().toISOString(),
          text: `Open https://app.example.test/invite/${s.linkToken} to start.`,
        });
        return send(res, 201, {
          id: s.invitationId,
          candidateId: s.candidateId,
          sessionId: s.sessionId,
        });
      }
      const er = /^POST \/candidates\/([^/]+)\/erasure$/.exec(key);
      if (er) {
        if (!staffOk) return problem(res, 401, 'UNAUTHENTICATED');
        const s = st.byCandidate.get(er[1]);
        if (!s || s.erased) return problem(res, 404, 'NOT_FOUND');
        s.erased = true;
        st.erased.push(er[1]);
        return send(res, 202, {});
      }

      // ---- candidate ----
      if (key === 'POST /candidate/session/otp') {
        const s = st.byInvite.get(body.token);
        if (!s) return problem(res, 404, 'LINK_INVALID');
        s.otp = String(crypto.randomInt(100000, 999999));
        st.mail.push({
          id: uuid(),
          to: s.email,
          created: new Date().toISOString(),
          text: `Your one-time code is ${s.otp}.`,
        });
        return send(res, 202, {});
      }
      if (key === 'POST /candidate/session/start') {
        const s = st.byInvite.get(body.token);
        if (!s || !s.otp || body.otp !== s.otp) return problem(res, 401, 'OTP_INVALID');
        s.token = `cand-${crypto.randomBytes(24).toString('hex')}`;
        s.status = 'OPENED';
        st.sessions.set(s.token, s);
        return send(res, 200, {
          sessionToken: s.token,
          sessionTokenExpiresAt: new Date(Date.now() + 3600e3).toISOString(),
        });
      }
      if (p.startsWith('/candidate/')) {
        if (!sess) return problem(res, 401, 'UNAUTHENTICATED');
        if (key === 'GET /candidate/session/consent')
          return send(res, 200, { version: 'placeholder-1', text: 'PLACEHOLDER' });
        if (key === 'POST /candidate/session/consent/sign') {
          if (sess.status !== 'OPENED') return problem(res, 409, 'INVALID_STATE');
          if (body.ageConfirmed !== true || !body.fullName)
            return problem(res, 400, 'VALIDATION_FAILED');
          sess.status = 'CONSENTED';
          return send(res, 200, {});
        }
        if (key === 'POST /candidate/session/system-check') {
          if (!['CONSENTED', 'VERIFIED'].includes(sess.status))
            return problem(res, 409, 'SESSION_NOT_ACTIVE');
          sess.sysCheck = true;
          return send(res, 200, { passed: true, blocking: [] });
        }
        if (key === 'POST /candidate/session/media/presign') {
          if (sess.status !== 'CONSENTED' || body.stream !== 'ROOM_SCAN')
            return problem(res, 409, 'SESSION_NOT_ACTIVE');
          sess.expectBytes = body.bytes;
          const host = st.storageHost ?? new URL(base).host;
          return send(res, 200, {
            url: `http://${host}/storage/${sess.sessionId}?X-Amz-Signature=${crypto.randomBytes(16).toString('hex')}`,
            method: 'PUT',
            headers: { 'Content-Type': 'video/webm', 'If-None-Match': '*' },
            expiresAt: new Date(Date.now() + 60e3).toISOString(),
          });
        }
        if (key === 'POST /candidate/session/media/confirm') {
          if (!sess.uploaded) return problem(res, 404, 'CHUNK_NOT_PRESIGNED');
          sess.roomScan = true;
          return send(res, 200, { uploaded: true, sizeBytes: sess.uploaded });
        }
        if (key === 'POST /candidate/session/test/start') {
          if (sess.status === 'CONSENTED') {
            if (!(sess.sysCheck && sess.roomScan)) return problem(res, 409, 'SESSION_NOT_VERIFIED');
            if (++sess.polls <= st.verifyPolls) return problem(res, 409, 'SESSION_NOT_VERIFIED');
            sess.status = 'IN_PROGRESS';
            return send(res, 200, {
              sessionQuestions: [{ id: uuid(), questionId: uuid(), type: 'CODING' }],
            });
          }
          return problem(res, 409, 'SESSION_NOT_ACTIVE');
        }
        if (key === 'POST /candidate/session/proctor-key') {
          if (sess.status !== 'IN_PROGRESS') return problem(res, 409, 'SESSION_NOT_ACTIVE');
          if (sess.keyIssued) return problem(res, 409, 'KEY_ALREADY_ISSUED');
          sess.keyIssued = true;
          return send(res, 200, {
            alg: 'HMAC-SHA256',
            key: crypto.randomBytes(32).toString('base64'),
            keyEpoch: 1,
            counters: {},
          });
        }
      }
      if (req.method === 'PUT' && p.startsWith('/storage/')) {
        const s = [...st.sessions.values()].find((x) => `/storage/${x.sessionId}` === p);
        if (!s) return problem(res, 403, 'NOT_PRESIGNED');
        if (raw.length !== s.expectBytes) return problem(res, 400, 'SIZE_MISMATCH');
        s.uploaded = raw.length;
        return send(res, 200, {});
      }
      return problem(res, 404, 'NOT_FOUND');
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    st,
    url: `${base}/api/v1`,
    mailUrl: `${base}/mail`,
    close: () => new Promise((r) => server.close(r)),
  };
}
