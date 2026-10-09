import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiBaseUrl } from '@/lib/env';
import { setInvitationScenario } from '@/mocks/invitation-handlers';
import { server } from '@/mocks/server';
import { resetAuthTestState } from '@/test/auth-test-utils';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}
async function call<T = Record<string, unknown>>(
  role: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Reply<T>> {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: {
      ...(role === 'NONE' ? {} : { authorization: `Bearer mock-access-${role}-direct` }),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T, headers: res.headers };
}

const day = 86_400_000;
const win = (endDays = 7) => ({
  windowStart: new Date(Date.now() - 1000).toISOString(),
  windowEnd: new Date(Date.now() + endDays * day).toISOString(),
});
const one = (extra: object = {}) => ({
  candidate: { email: 'new.person@example.test', name: 'New Person' },
  ...win(),
  ...extra,
});
const errorsOf = (r: Reply): string[] => (r.body as { errors?: string[] }).errors ?? [];
const path = '/v1/tests/test-backend/invitations';

describe('Invitations mock [BE-06b, WEB-ONLY]: access (FR-103, FR-303)', () => {
  it('FR-103 TC-004: recruiters and super admins invite; authors and reviewers get 403; no token is 401', async () => {
    expect((await call('RECRUITER', 'POST', path, one())).status).toBe(201);
    expect(
      (
        await call(
          'SUPER_ADMIN',
          'POST',
          path,
          one({ candidate: { email: 'b@example.test', name: 'B' } }),
        )
      ).status,
    ).toBe(201);
    for (const role of ['AUTHOR', 'REVIEWER']) {
      expect((await call(role, 'POST', path, one())).status).toBe(403);
      expect((await call(role, 'GET', '/v1/admin/candidates/cand-1/invitations')).status).toBe(403);
    }
    expect((await call('NONE', 'POST', path, one())).status).toBe(401);
  });
});

describe('Invitations mock: single invitation, in the order the API checks (FR-303)', () => {
  it('TC-023: creates an INVITED invitation and the candidate list shows it', async () => {
    const r = await call<{ id: string; status: string; candidateId: string }>(
      'RECRUITER',
      'POST',
      path,
      one(),
    );
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('INVITED');
    const list = await call<{
      items: { id: string; latestStatus: string | null; invitationCount: number }[];
    }>('SUPER_ADMIN', 'GET', '/v1/admin/candidates');
    const mine = list.body.items.find((c) => c.id === r.body.candidateId);
    expect(mine).toMatchObject({ latestStatus: 'INVITED', invitationCount: 1 });
  });

  it('400 comes first: unknown fields, bad email, window order, accommodations', async () => {
    const bad = await call('RECRUITER', 'POST', '/v1/tests/does-not-exist/invitations', {
      candidate: { email: 'x', name: '' },
      windowStart: win().windowEnd,
      windowEnd: win().windowStart,
      extra: 1,
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ detail: 'Request validation failed' });
    const text = errorsOf(bad).join(' | ');
    expect(text).toMatch(/property extra should not exist/);
    expect(text).toMatch(/candidate.email must be an email/);
    expect(text).toMatch(/windowEnd must be after windowStart/);
    // The email the caller sent is not echoed back.
    expect(JSON.stringify(bad.body)).not.toContain('"x"');
  });

  it('FR-303: a windowStart more than 5 minutes in the past is a 400, like the real API; a minute old is accepted', async () => {
    const old = await call('RECRUITER', 'POST', '/v1/tests/test-backend/invitations', {
      candidate: { email: 'late.start@example.test', name: 'Late Start' },
      windowStart: new Date(Date.now() - 6 * 60_000).toISOString(),
      windowEnd: win().windowEnd,
    });
    expect(old.status).toBe(400);
    expect(errorsOf(old).join(' ')).toMatch(/windowStart may be at most 5 minutes in the past/);
    const recent = await call('RECRUITER', 'POST', '/v1/tests/test-backend/invitations', {
      candidate: { email: 'ok.start@example.test', name: 'Ok Start' },
      windowStart: new Date(Date.now() - 60_000).toISOString(),
      windowEnd: win().windowEnd,
    });
    expect(recent.status).toBe(201);
  });

  it('404 for an unknown test and 400 (not 422) for a window that has closed, as the API answers', async () => {
    expect((await call('RECRUITER', 'POST', '/v1/tests/nope/invitations', one())).status).toBe(404);
    const closed = await call('RECRUITER', 'POST', path, {
      candidate: { email: 'late@example.test', name: 'Late' },
      // The start may be at most 5 minutes old (else 400), so the closed window is a short one.
      windowStart: new Date(Date.now() - 60_000).toISOString(),
      windowEnd: new Date(Date.now() - 30_000).toISOString(),
    });
    expect(closed.status).toBe(400);
    expect(errorsOf(closed).join(' ')).toMatch(/windowEnd must be in the future/);
  });

  it('FR-303: 201 carries the mail outcome; failed and disabled are reported as such', async () => {
    const queued = await call<{ mail: string }>('RECRUITER', 'POST', path, one());
    expect([queued.status, queued.body.mail]).toEqual([201, 'queued']);
    for (const mail of ['failed', 'disabled'] as const) {
      setInvitationScenario({ mail });
      const r = await call<{ mail: string }>(
        'RECRUITER',
        'POST',
        path,
        one({ candidate: { email: `${mail}@example.test`, name: 'M' } }),
      );
      expect([r.status, r.body.mail]).toEqual([201, mail]);
    }
  });

  it('FR-303: an unsatisfiable test is 422 with errors[] naming the slots, not a closed window', async () => {
    setInvitationScenario({ testUnsatisfiable: true });
    const r = await call('RECRUITER', 'POST', path, one());
    expect(r.status).toBe(422);
    expect(errorsOf(r).join(' ')).toMatch(/randomRule matches 0/);
    expect(JSON.stringify(r.body)).not.toMatch(/closed/);
  });

  it('409 when the candidate already has an open invitation to the test', async () => {
    const r = await call('RECRUITER', 'POST', path, {
      candidate: { email: 'tim.berners.lee@candidates.example.test', name: 'Tim' },
      ...win(),
    });
    expect(r.status).toBe(409);
  });

  it('a candidate whose earlier invitation ended can be invited again', async () => {
    // Frances Allen's seeded invitation is EXPIRED.
    const r = await call('RECRUITER', 'POST', path, {
      candidate: { email: 'frances.allen@candidates.example.test', name: 'Frances Allen' },
      ...win(),
    });
    expect(r.status).toBe(201);
  });
});

describe('Invitations mock: the real DTO has no accommodations (D-84)', () => {
  it('FR-303: accommodations and candidate.externalRef are 400, as forbidNonWhitelisted answers', async () => {
    const acc = await call(
      'RECRUITER',
      'POST',
      path,
      one({ accommodations: { extraTimePct: 10 } }),
    );
    expect(acc.status).toBe(400);
    expect(errorsOf(acc).join(' ')).toMatch(/property accommodations should not exist/);
    const ext = await call(
      'RECRUITER',
      'POST',
      path,
      one({ candidate: { email: 'x@example.test', name: 'X', externalRef: 'r1' } }),
    );
    expect(ext.status).toBe(400);
    expect(errorsOf(ext).join(' ')).toMatch(/externalRef should not exist/);
    const tz = await call('RECRUITER', 'POST', path, one({ timeZone: 'Europe/Berlin' }));
    expect(tz.status).toBe(400);
  });

  it('FR-303: the two 409s carry their own words and no code', async () => {
    const active = await call<{ detail: string; code?: string }>('RECRUITER', 'POST', path, {
      candidate: { email: 'tim.berners.lee@candidates.example.test', name: 'Tim' },
      ...win(),
    });
    expect([active.status, active.body.detail, active.body.code]).toEqual([
      409,
      'This candidate already has an active invitation for this test.',
      undefined,
    ]);
    setInvitationScenario({ candidateErased: true });
    const erased = await call<{ detail: string }>('RECRUITER', 'POST', path, one());
    expect([erased.status, erased.body.detail]).toEqual([409, 'This candidate cannot be invited.']);
  });
});

describe('Invitations mock: accommodations and the identity waiver (ADR 0015, C-19)', () => {
  beforeEach(() => setInvitationScenario({ acceptsAccommodations: true }));
  const waiver = (w: object) => one({ accommodations: { identityCheckWaiver: w } });
  it('C-19: a waiver needs a valid reason code; OTHER needs a note; a note is only for OTHER', async () => {
    const none = await call('RECRUITER', 'POST', path, waiver({}));
    expect(none.status).toBe(400);
    expect(errorsOf(none).join(' ')).toMatch(/reasonCode must be one of/);
    const other = await call('RECRUITER', 'POST', path, waiver({ reasonCode: 'OTHER' }));
    expect(errorsOf(other).join(' ')).toMatch(/reasonNote is required for OTHER/);
    const extra = await call(
      'RECRUITER',
      'POST',
      path,
      waiver({ reasonCode: 'CANNOT_COMPLETE_ID_CHECK', reasonNote: 'x' }),
    );
    expect(errorsOf(extra).join(' ')).toMatch(/allowed only with OTHER/);
    expect(
      (
        await call(
          'RECRUITER',
          'POST',
          path,
          waiver({ reasonCode: 'OTHER', reasonNote: 'Court order' }),
        )
      ).status,
    ).toBe(201);
  });

  it('checks the accommodation limits', async () => {
    const r = await call(
      'RECRUITER',
      'POST',
      path,
      one({
        accommodations: {
          extraTimePct: 250,
          disabledDetectors: ['FACE', 'FACE', 'NOPE'],
          allowedAssistiveTools: Array.from({ length: 11 }, () => 't'),
          notes: 'n'.repeat(1001),
        },
      }),
    );
    expect(r.status).toBe(400);
    expect(errorsOf(r)).toHaveLength(4);
  });

  it('REASON_NOT_ENABLED: 422 with a code when the biometric-refusal reason is switched off', async () => {
    setInvitationScenario({ biometricRefusalEnabled: false });
    const r = await call(
      'RECRUITER',
      'POST',
      path,
      waiver({ reasonCode: 'REFUSED_BIOMETRIC_PROCESSING' }),
    );
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'REASON_NOT_ENABLED' });
    expect(
      (await call('RECRUITER', 'POST', path, waiver({ reasonCode: 'CANNOT_COMPLETE_ID_CHECK' })))
        .status,
    ).toBe(201);
  });
});

describe('Invitations mock: rate limit (429)', () => {
  it('answers 429 with Retry-After once the hourly limit is used', async () => {
    setInvitationScenario({ limitPerHour: 1 });
    expect((await call('RECRUITER', 'POST', path, one())).status).toBe(201);
    const r = await call(
      'RECRUITER',
      'POST',
      path,
      one({ candidate: { email: 'second@example.test', name: 'Second' } }),
    );
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('Invitations mock: no bulk route (D-84)', () => {
  it('FR-304: the API has no bulk route; the CSV upload sends single invitations', async () => {
    const r = await call('RECRUITER', 'POST', `${path}/bulk`, { ...win(), rows: [] });
    expect(r.status).not.toBe(200);
  });
});

describe('Invitations mock: candidate timeline (FR-303, ADR 0002, C-28)', () => {
  it('returns the stage and its history, and never a score, flag or verdict', async () => {
    const r = await call<{ items: { status: string; history: { status: string }[] }[] }>(
      'RECRUITER',
      'GET',
      '/v1/admin/candidates/cand-1/invitations',
    );
    expect(r.status).toBe(200);
    expect(r.body.items[0]?.status).toBe('COMPLETED');
    expect(JSON.stringify(r.body)).not.toMatch(/score|flag|verdict|integrity/i);
  });

  it('404 for an unknown candidate', async () => {
    expect((await call('RECRUITER', 'GET', '/v1/admin/candidates/nobody/invitations')).status).toBe(
      404,
    );
  });
});
