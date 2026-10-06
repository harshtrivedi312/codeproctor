// One synthetic candidate, brought through the public API to the state the k6 TC-090/TC-091
// scripts need: IN_PROGRESS, bearer token in hand, proctor-key NOT yet called (it answers 409
// KEY_ALREADY_ISSUED on reuse, ADR 0013 section 4, so the k6 script must make the one and only call).
//
//   invite (INVITED) -> link token + OTP from the mail sink -> start (OPENED) -> consent/sign
//   (CONSENTED) -> system-check -> identity waived by the invitation (C-25, ADR 0015) -> room scan
//   (presign, PUT, confirm) -> start-test, polled until the verify-session job has moved the
//   session to VERIFIED -> IN_PROGRESS.
import { ROUTES, inviteBody, consentBody, systemCheckBody } from './routes.mjs';
import { candidateFor, placeholderChunk } from './synthetic.mjs';
import { checkStorageUrl } from './config.mjs';
import { SeedError } from './redact.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v, what) => {
  if (typeof v !== 'string' || !UUID_RE.test(v)) {
    throw new SeedError(`unexpected response: ${what} is not a UUID.`, { step: what });
  }
  return v;
};

export async function seedOne({
  index,
  cfg,
  runId,
  staff,
  candidateClient,
  mail,
  secrets,
  record,
  log,
  sleep,
}) {
  const cand = candidateFor(runId, index, cfg.domain);
  const tag = `#${String(index + 1).padStart(3, '0')}`;
  const since = Date.now();

  // 1. Invitation (creates the candidate, the invitation and the session in INVITED). The planned
  // email goes into the manifest first: if the POST times out after the server created the rows,
  // --cleanup can still find them by email.
  const item = { index, email: cand.email, state: 'PENDING' };
  record(item);
  const inv = await staff.call('POST', ROUTES.invite(cfg.testId), {
    step: 'invite',
    idempotent: false,
    body: inviteBody({ name: cand.name, email: cand.email, runId }),
  });
  const body = Array.isArray(inv.json) ? inv.json[0] : (inv.json?.invitations?.[0] ?? inv.json);
  Object.assign(item, {
    invitationId: id(body?.id ?? body?.invitationId, 'invitation id'),
    candidateId: id(body?.candidateId, 'candidate id'),
    sessionId: body?.sessionId ? id(body.sessionId, 'session id') : null,
    state: 'INVITED',
  });
  record(item);
  log(`${tag} invited`);

  // 2. Link token and OTP (mail sink), then start: INVITED -> OPENED.
  const linkToken = await mail.getInviteToken(cand.email, since);
  secrets.push(linkToken);
  const otpAt = Date.now();
  await candidateClient.request('POST', ROUTES.otpRequest, {
    step: 'otp request',
    idempotent: false,
    body: { token: linkToken },
  });
  const otp = await mail.getOtp(cand.email, otpAt);
  secrets.push(otp);
  const started = await candidateClient.request('POST', ROUTES.start, {
    step: 'session start',
    idempotent: false,
    body: { token: linkToken, otp },
  });
  let token = started.json?.sessionToken;
  if (typeof token !== 'string' || token === '') {
    throw new SeedError('session start: no session token in the response.', { step: 'start' });
  }
  secrets.push(token);
  let tokenExpiresAt = started.json?.sessionTokenExpiresAt;
  item.state = 'OPENED';
  log(`${tag} opened`);

  // 3. Consent (FR-401, C-07, C-30): a fresh signature for this session, typed synthetic name.
  const doc = await candidateClient.request('GET', ROUTES.consent, { token, step: 'consent read' });
  await candidateClient.request('POST', ROUTES.consentSign, {
    token,
    step: 'consent sign',
    idempotent: false,
    body: consentBody({ name: cand.name, version: doc.json?.version ?? doc.json?.documentVersion }),
  });
  item.state = 'CONSENTED';
  log(`${tag} consented`);

  // 4. System check (ADR 0013 5.4). A blocking finding is a seeding failure, not something to skip.
  const sc = await candidateClient.request('POST', ROUTES.systemCheck, {
    token,
    step: 'system check',
    idempotent: false,
    retry503: true, // ADR 0013: 503 + Retry-After, not processed
    body: systemCheckBody(),
  });
  if (sc.json?.passed !== true) {
    const blocking = (sc.json?.blocking ?? []).filter((b) => /^[A-Z_]{3,40}$/.test(b));
    throw new SeedError(`system check blocked: ${blocking.join(',') || 'unknown'}.`, {
      step: 'system check',
    });
  }

  // 5. Identity: waived by the invitation (nothing to upload; no face, no ID image, ADR 0015).
  // 6. Room scan: one tiny labeled placeholder chunk through presign, PUT and confirm.
  const chunk = placeholderChunk(cfg.roomScanBytes);
  const scan = { stream: 'ROOM_SCAN', segment: 0, seq: 0 };
  const pre = await candidateClient.request('POST', ROUTES.presign, {
    token,
    step: 'room scan presign',
    idempotent: false,
    body: {
      ...scan,
      bytes: chunk.length,
      contentType: 'video/webm',
      startedAt: new Date().toISOString(),
      durationMs: 1000,
    },
  });
  if (!pre.json?.alreadyUploaded) {
    const url = pre.json?.url;
    if (typeof url !== 'string') {
      throw new SeedError('room scan presign: no upload URL in the response.', { step: 'presign' });
    }
    secrets.push(url);
    try {
      checkStorageUrl(url, cfg.storageAllowed, cfg.apiIsLocal);
    } catch {
      throw new SeedError(
        'room scan presign: upload host is not allowed (set STORAGE_ALLOWED_HOSTS); not uploaded.',
        { step: 'presign' },
      );
    }
    const headers = {};
    for (const [k, v] of Object.entries(pre.json.headers ?? {})) {
      if (/^(content-type|if-none-match)$/i.test(k) && typeof v === 'string') headers[k] = v;
    }
    await candidateClient.request('PUT', '', {
      absolute: url,
      step: 'room scan upload',
      raw: chunk,
      headers,
      expect: [200, 201, 204, 412], // 412 = already stored (If-None-Match), ADR 0013 5.5
    });
  }
  await candidateClient.request('POST', ROUTES.confirm, {
    token,
    step: 'room scan confirm',
    idempotent: false,
    body: scan,
  });
  log(`${tag} room scan stored`);

  // 7. Start the test. verify-session runs as a job (debounced about 2 s), so VERIFIED arrives
  // shortly after the checks; poll the start call while it answers 409.
  const deadline = Date.now() + cfg.verifyTimeoutMs;
  let started2;
  for (;;) {
    try {
      started2 = await candidateClient.request('POST', ROUTES.startTest, {
        token,
        step: 'start test',
        idempotent: false,
        retry503: true, // start-session is idempotent; 503 + Retry-After (ADR 0013)
        body: {},
        expect: [200, 201],
      });
      break;
    } catch (e) {
      const fatal = e.code === 'SYSTEM_CHECK_BLOCKED' || e.code === 'SESSION_NOT_ACTIVE';
      if (e instanceof SeedError && e.status === 409 && !fatal && Date.now() < deadline) {
        await sleep(1000);
        continue;
      }
      throw e;
    }
  }
  if (typeof started2.json?.sessionToken === 'string') {
    token = started2.json.sessionToken;
    secrets.push(token);
  }
  tokenExpiresAt = started2.json?.sessionTokenExpiresAt ?? tokenExpiresAt;
  const sqs = started2.json?.sessionQuestions;
  const coding = Array.isArray(sqs)
    ? sqs.find((q) => !q.type || /^CODING$/i.test(q.type))
    : undefined;
  if (!coding) {
    throw new SeedError('start test: no coding session question in the response.', {
      step: 'start test',
    });
  }
  item.state = 'IN_PROGRESS';
  log(`${tag} in progress`);

  // Deliberately NOT calling proctor-key: k6 makes the single call for this epoch.
  const entry = {
    token,
    sessionQuestionId: id(coding.id ?? coding.sessionQuestionId, 'session question id'),
    questionId: id(coding.questionId, 'question id'),
    seedRunId: runId,
  };
  if (typeof tokenExpiresAt === 'string') entry.tokenExpiresAt = tokenExpiresAt;
  return entry;
}
