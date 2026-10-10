// A stand-in for the BE-07 candidate/staff API and a Mailpit-style mail sink, ONLY to test the
// seeder's behaviour (state order, retries, guards, redaction, cleanup). Link, otp, start, consent
// and test/start follow the REAL controllers and DTOs on main (apps/api/src/candidate). System check
// and the media routes are NOT on main; the mock serves them only so tests can exercise the seeder
// code behind them (tests switch AVAILABLE on). It proves the seeder matches lib/routes.mjs and
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

const CONSENT_ID = '22222222-2222-4222-8222-222222222222';

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
        // Mirrors CreateInvitationDto (whitelist plus forbidNonWhitelisted) and the window rules.
        (st.invites ??= []).push(body); // the parsed bodies, for the tests
        const keys = Object.keys(body).sort().join(',');
        const cKeys = Object.keys(body.candidate ?? {})
          .sort()
          .join(',');
        const t0 = Date.parse(body.windowStart ?? '');
        const t1 = Date.parse(body.windowEnd ?? '');
        // The DTO's own patterns (invitations.dto.ts): ISO_INSTANT, display-safe text, plain local part.
        const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
        // eslint-disable-next-line no-control-regex -- control characters are what this rejects
        const unsafe = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
        const email = body.candidate?.email;
        const name = body.candidate?.name;
        if (
          keys !== 'candidate,windowEnd,windowStart' ||
          cKeys !== 'email,name' ||
          typeof email !== 'string' ||
          email.length > 254 ||
          !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]+$/i.test(email) ||
          unsafe.test(email) ||
          (!email.endsWith('.test') && !email.endsWith('.example.com')) ||
          typeof name !== 'string' ||
          name.trim().length < 1 ||
          name.trim().length > 200 ||
          unsafe.test(name) ||
          typeof body.windowStart !== 'string' ||
          typeof body.windowEnd !== 'string' ||
          !iso.test(body.windowStart) ||
          !iso.test(body.windowEnd) ||
          !(t0 >= Date.now() - 5 * 60_000) ||
          !(t1 > t0) ||
          !(t1 > Date.now()) ||
          t1 - t0 > 7 * 24 * 3600_000
        ) {
          return problem(res, 400, 'VALIDATION_FAILED');
        }
        if (opts.failInviteAt === ++st.inviteCount) return problem(res, 500, 'INTERNAL');
        const s = {
          candidateId: uuid(),
          invitationId: uuid(),
          sessionId: uuid(),
          email: body.candidate.email,
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
          text: `Open https://app.example.test/t#${s.linkToken} to start.`,
        });
        return send(res, 201, {
          id: s.invitationId,
          testId: crypto.randomUUID(),
          candidateId: s.candidateId,
          status: 'INVITED',
          windowStart: body.windowStart,
          windowEnd: body.windowEnd,
          createdAt: new Date().toISOString(),
          mail: opts.mailOutcome ?? 'queued',
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
      if (key === 'POST /candidate/session/link') {
        const s = st.byInvite.get(body.invitationToken);
        if (!s) return problem(res, 404, 'NOT_FOUND');
        return send(res, 200, { state: 'OTP_REQUIRED', orgName: MOCK.org });
      }
      if (key === 'POST /candidate/session/otp') {
        const s = st.byInvite.get(body.invitationToken);
        if (!s) return problem(res, 404, 'NOT_FOUND');
        s.otp = String(crypto.randomInt(100000, 999999));
        st.mail.push({
          id: uuid(),
          to: s.email,
          created: new Date().toISOString(),
          text: `Your one-time code is ${s.otp}.`,
        });
        return send(res, 200, {
          state: 'OTP_SENT',
          maskedEmail: 'k***@example.test',
          expiresInSeconds: 600,
        });
      }
      if (key === 'POST /candidate/session/start') {
        const s = st.byInvite.get(body.invitationToken);
        if (!s) return problem(res, 404, 'NOT_FOUND');
        if (!s.otp || body.otp !== s.otp) return problem(res, 400, 'OTP_INVALID');
        s.token = `cand-${crypto.randomBytes(24).toString('hex')}`;
        s.status = 'OPENED';
        st.sessions.set(s.token, s);
        return send(res, 200, {
          sessionToken: s.token,
          sessionTokenExpiresAt: new Date(Date.now() + 3600e3).toISOString(),
          status: 'OPENED',
          serverTime: new Date().toISOString(),
        });
      }
      if (p.startsWith('/candidate/')) {
        if (!sess) return problem(res, 401, 'UNAUTHENTICATED');
        if (key === 'GET /candidate/session/consent')
          return send(res, 200, {
            consentTextId: CONSENT_ID,
            version: 'placeholder-1',
            bodyMd: 'PLACEHOLDER',
            legalApproved: false,
            signed: sess.status !== 'OPENED',
            signedAt: null,
          });
        if (key === 'POST /candidate/session/consent/sign') {
          if (sess.status !== 'OPENED') return problem(res, 409, 'ALREADY_SIGNED');
          if (body.confirmedAge18 !== true || !body.signedName || body.consentTextId !== CONSENT_ID)
            return problem(res, 400, 'VALIDATION_FAILED');
          sess.status = 'CONSENTED';
          return send(res, 200, { status: 'CONSENTED', signedAt: new Date().toISOString() });
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
            const now = new Date();
            return send(res, 200, {
              status: 'IN_PROGRESS',
              serverTime: now.toISOString(),
              startedAt: now.toISOString(),
              deadlineAt: new Date(now.getTime() + 3600e3).toISOString(),
              sections: [
                {
                  position: 1,
                  title: 'Section 1',
                  timeLimitMs: null,
                  startedAt: now.toISOString(),
                  deadlineAt: null,
                  questions: [{ sessionQuestionId: uuid(), position: 1, points: '10' }],
                },
              ],
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
