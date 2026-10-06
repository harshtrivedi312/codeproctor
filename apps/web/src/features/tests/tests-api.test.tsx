import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiBaseUrl } from '@/lib/env';
import { server } from '@/mocks/server';
import { resetAuthTestState } from '@/test/auth-test-utils';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

type Role = 'RECRUITER' | 'SUPER_ADMIN' | 'AUTHOR' | 'REVIEWER' | 'NONE';
interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T;
}
async function call<T = Record<string, unknown>>(
  role: Role,
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
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

interface Detail {
  id: string;
  used: boolean;
  passScore: number | null;
  profile: string;
  sectionCount: number;
  questionCount: number;
  sections: {
    title: string;
    position: number;
    timeLimitMin: number | null;
    questions: {
      position: number;
      points: number;
      questionVersionId: string | null;
      title: string | null;
      randomRule: Record<string, unknown> | null;
    }[];
  }[];
}
const section = (title: string, ...questions: object[]) => ({ title, questions });
const fixed = (questionVersionId = 'q-twosum-v1', points?: number) => ({
  questionVersionId,
  ...(points ? { points } : {}),
});
const valid = (extra: object = {}) => ({
  name: 'New test',
  durationMinutes: 60,
  sections: [section('One', fixed())],
  ...extra,
});
const errorsOf = (r: Reply): string[] => (r.body as { errors?: string[] }).errors ?? [];

describe('Tests API mock: who may do what (FR-103, ADR 0010)', () => {
  it('FR-103 TC-004: recruiters and super admins read, create and edit; authors and reviewers get 403; no token is 401', async () => {
    for (const role of ['RECRUITER', 'SUPER_ADMIN'] as const) {
      expect((await call(role, 'GET', '/v1/tests')).status).toBe(200);
      expect((await call(role, 'POST', '/v1/tests', valid())).status).toBe(201);
    }
    for (const role of ['AUTHOR', 'REVIEWER'] as const) {
      expect((await call(role, 'GET', '/v1/tests')).status).toBe(403);
      expect((await call(role, 'POST', '/v1/tests', valid())).status).toBe(403);
      expect((await call(role, 'GET', '/v1/tests/test-frontend')).status).toBe(403);
      expect((await call(role, 'PATCH', '/v1/tests/test-frontend', { name: 'x' })).status).toBe(
        403,
      );
    }
    expect((await call('NONE', 'GET', '/v1/tests')).status).toBe(401);
    const forbidden = await call('AUTHOR', 'GET', '/v1/tests');
    expect(forbidden.body).toMatchObject({ status: 403, title: 'Forbidden' });
    expect(forbidden.body).not.toHaveProperty('code');
  });
});

describe('Tests API mock: create (FR-301, FR-302)', () => {
  it('FR-301: a created test comes back with ordered sections, resolved titles and the counts', async () => {
    const r = await call<Detail>('RECRUITER', 'POST', '/v1/tests', {
      name: '  Spaced  ',
      durationMinutes: 90,
      passScore: 150,
      profile: 'STRICT',
      sections: [
        { title: 'Second', position: 2, questions: [fixed('q-bigo-v1', 50)] },
        {
          title: 'First',
          position: 1,
          timeLimitMin: 60,
          questions: [fixed(), { randomRule: { tags: ['Arrays'] }, points: 25.5 }],
        },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      name: 'Spaced',
      profile: 'STRICT',
      passScore: 150,
      sectionCount: 2,
      questionCount: 3,
      used: false,
    });
    expect(r.body.sections.map((s) => s.title)).toEqual(['First', 'Second']);
    expect(r.body.sections[0]!.questions[0]).toMatchObject({
      position: 1,
      points: 100,
      title: 'Two sum',
    });
    expect(r.body.sections[0]!.questions[1]).toMatchObject({
      position: 2,
      points: 25.5,
      questionVersionId: null,
      randomRule: { tags: ['arrays'] },
    });
    const again = await call<Detail>('RECRUITER', 'GET', `/v1/tests/${r.body.id}`);
    expect(again.body).toEqual(r.body);
  });

  it('FR-302: only STANDARD and STRICT are offered; LOCKDOWN is a 400', async () => {
    const r = await call('RECRUITER', 'POST', '/v1/tests', valid({ profile: 'LOCKDOWN' }));
    expect(r.status).toBe(400);
    expect(errorsOf(r).join(' ')).toMatch(
      /profile must be one of the following values: STANDARD, STRICT/,
    );
    expect(
      (await call('RECRUITER', 'POST', '/v1/tests', valid({ profile: 'STANDARD' }))).status,
    ).toBe(201);
  });

  it('FR-301 ADR 0002: section limits above the duration, a pass score above the points and a random rule with unknown keys are 400', async () => {
    const limits = await call(
      'RECRUITER',
      'POST',
      '/v1/tests',
      valid({
        durationMinutes: 30,
        sections: [
          { ...section('A', fixed()), timeLimitMin: 20 },
          { ...section('B', fixed('q-bigo-v1')), timeLimitMin: 20 },
        ],
      }),
    );
    expect(limits.status).toBe(400);
    expect(errorsOf(limits).join(' ')).toMatch(
      /section time limits add up to 40 minutes, more than the 30 minute duration/,
    );
    const pass = await call('RECRUITER', 'POST', '/v1/tests', valid({ passScore: 100.01 }));
    expect(errorsOf(pass).join(' ')).toMatch(
      /passScore is more than the points of all questions together/,
    );
    const rule = await call(
      'RECRUITER',
      'POST',
      '/v1/tests',
      valid({ sections: [section('A', { randomRule: { tags: ['arrays'], count: 3 } })] }),
    );
    expect(rule.status).toBe(400);
    expect(errorsOf(rule).join(' ')).toMatch(/randomRule\.count: unknown key/);
  });

  it('FR-301: shapes and limits of the body are checked together, before any lookup', async () => {
    const r = await call('RECRUITER', 'POST', '/v1/tests', {
      name: '',
      durationMinutes: 4,
      sections: [],
      isPublished: true,
    });
    expect(r.status).toBe(400);
    const text = errorsOf(r).join(' | ');
    expect(text).toMatch(/property isPublished should not exist/);
    expect(text).toMatch(/name must be 1 to 200 characters/);
    expect(text).toMatch(/durationMinutes must be an integer from 5 to 480/);
    expect(text).toMatch(/sections must contain 1 to 20 items/);
    // A slot with both or neither of a version and a rule, and half-given positions.
    const both = await call(
      'RECRUITER',
      'POST',
      '/v1/tests',
      valid({ sections: [section('A', { questionVersionId: 'q-twosum-v1', randomRule: {} }, {})] }),
    );
    expect(errorsOf(both).join(' ')).toMatch(
      /give exactly one of questionVersionId and randomRule/,
    );
    const pos = await call(
      'RECRUITER',
      'POST',
      '/v1/tests',
      valid({
        sections: [{ ...section('A', fixed()), position: 1 }, section('B', fixed('q-bigo-v1'))],
      }),
    );
    expect(errorsOf(pos).join(' ')).toMatch(/give a position on every section or on none/);
    const gap = await call(
      'RECRUITER',
      'POST',
      '/v1/tests',
      valid({ sections: [{ ...section('A', fixed()), position: 2 }] }),
    );
    expect(errorsOf(gap).join(' ')).toMatch(
      /section positions must be 1, 2, 3, \.\.\. without gaps or repeats/,
    );
  });

  it('FR-301 DL-34: a draft or unknown question version is the same 404; an archived question is 422; a rule that matches too few is 422', async () => {
    const draft = await call(
      'RECRUITER',
      'POST',
      '/v1/tests',
      valid({ sections: [section('A', fixed('q-rotate-v1'))] }),
    );
    const missing = await call(
      'RECRUITER',
      'POST',
      '/v1/tests',
      valid({ sections: [section('A', fixed('q-nope-v1'))] }),
    );
    expect(draft.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(draft.body).toEqual(missing.body); // no oracle for drafts
    const archived = await call(
      'RECRUITER',
      'POST',
      '/v1/tests',
      valid({ sections: [section('A', fixed('q-old-v1'))] }),
    );
    expect(archived.status).toBe(422);
    expect(errorsOf(archived)).toEqual(['sections[0].questions[0]: the question is archived']);
    const few = await call(
      'RECRUITER',
      'POST',
      '/v1/tests',
      valid({
        sections: [
          section(
            'A',
            { randomRule: { tags: ['arrays'], difficulty: 'MEDIUM' } },
            { randomRule: { tags: ['arrays'], difficulty: 'MEDIUM' } },
          ),
        ],
      }),
    );
    expect(few.status).toBe(422);
    expect(errorsOf(few)[0]).toMatch(
      /matches 1 published question\(s\) in your organization; the test needs 2 different ones/,
    );
    const ok = await call(
      'RECRUITER',
      'POST',
      '/v1/tests',
      valid({
        sections: [section('A', { randomRule: { tags: ['arrays'], difficulty: 'MEDIUM' } })],
      }),
    );
    expect(ok.status).toBe(201);
  });
});

describe('Tests API mock: read and list', () => {
  it('FR-301: the list is newest first, filterable, paged and refuses deep pages', async () => {
    const list = await call<{
      items: { id: string; used: boolean; sectionCount: number }[];
      total: number;
      page: number;
    }>('RECRUITER', 'GET', '/v1/tests');
    expect(list.body.total).toBe(3);
    expect(list.body.items.map((t) => t.id)).toEqual([
      'test-random',
      'test-frontend',
      'test-backend',
    ]);
    expect(list.body.items.find((t) => t.id === 'test-backend')).toMatchObject({
      used: true,
      sectionCount: 2,
    });
    expect(
      (await call<{ items: unknown[] }>('RECRUITER', 'GET', '/v1/tests?profile=STRICT')).body.items,
    ).toHaveLength(1);
    expect(
      (await call<{ items: unknown[] }>('RECRUITER', 'GET', '/v1/tests?used=true')).body.items,
    ).toHaveLength(1);
    expect(
      (await call<{ items: unknown[] }>('RECRUITER', 'GET', '/v1/tests?search=ARRAYS')).body.items,
    ).toHaveLength(1);
    expect(
      (
        await call<{ items: unknown[]; pageSize: number }>(
          'RECRUITER',
          'GET',
          '/v1/tests?pageSize=2&page=2',
        )
      ).body.items,
    ).toHaveLength(1);
    expect((await call('RECRUITER', 'GET', '/v1/tests?pageSize=101')).status).toBe(400);
    expect((await call('RECRUITER', 'GET', '/v1/tests?profile=LOCKDOWN')).status).toBe(400);
    expect((await call('RECRUITER', 'GET', '/v1/tests?page=102&pageSize=100')).status).toBe(400);
  });

  it('FR-301: a missing id is 404 and a malformed id is 400', async () => {
    expect((await call('RECRUITER', 'GET', '/v1/tests/test-nope')).status).toBe(404);
    expect((await call('RECRUITER', 'GET', '/v1/tests/Not A Uuid!')).status).toBe(400);
  });
});

describe('Tests API mock: edit (ADR 0002 S-6)', () => {
  it('FR-301: sections replace ALL sections; other fields change alone; there is no revision to send', async () => {
    const r = await call<Detail>('RECRUITER', 'PATCH', '/v1/tests/test-frontend', {
      sections: [section('Only', fixed('q-bigo-v1'), fixed('q-twosum-v1'))],
      passScore: 150,
    });
    expect(r.status).toBe(200);
    expect(r.body.sections.map((s) => s.title)).toEqual(['Only']);
    expect(r.body).toMatchObject({ questionCount: 2, passScore: 150 });
    const name = await call<Detail & { name: string }>(
      'RECRUITER',
      'PATCH',
      '/v1/tests/test-frontend',
      { name: 'Renamed' },
    );
    expect(name.body.name).toBe('Renamed');
    expect(name.body.sections).toHaveLength(1);
  });

  it('FR-301: an empty PATCH is 400, an unknown field is 400, and a pass score above the CURRENT points is refused', async () => {
    expect((await call('RECRUITER', 'PATCH', '/v1/tests/test-frontend', {})).status).toBe(400);
    expect(
      (await call('RECRUITER', 'PATCH', '/v1/tests/test-frontend', { revision: 'x' })).status,
    ).toBe(400);
    const over = await call('RECRUITER', 'PATCH', '/v1/tests/test-frontend', { passScore: 100.5 });
    expect(over.status).toBe(400);
    expect(errorsOf(over).join(' ')).toMatch(/passScore is more than the points/);
    const short = await call('RECRUITER', 'PATCH', '/v1/tests/test-frontend', {
      durationMinutes: 5,
      sections: [{ ...section('A', fixed()), timeLimitMin: 6 }],
    });
    expect(errorsOf(short).join(' ')).toMatch(
      /add up to 6 minutes, more than the 5 minute duration/,
    );
  });

  it('FR-301 ADR 0002 S-6: a test that has invitations or sessions answers 409 and is not changed', async () => {
    const r = await call('RECRUITER', 'PATCH', '/v1/tests/test-backend', { name: 'Changed' });
    expect(r.status).toBe(409);
    expect(r.body).not.toHaveProperty('code');
    expect(
      (await call<{ name: string }>('RECRUITER', 'GET', '/v1/tests/test-backend')).body.name,
    ).toBe('Backend engineer screening');
    expect((await call('RECRUITER', 'PATCH', '/v1/tests/test-nope', { name: 'x' })).status).toBe(
      404,
    );
  });
});
