import { delay, http, HttpResponse } from 'msw';
import type { Schemas } from '@/lib/api/client';
import { apiBaseUrl } from '@/lib/env';
import { mockRoleFromToken } from './auth-handlers';
import { hasPermission } from '@codeproctor/shared';
import { questionCatalogue } from './question-handlers';

/*
 * Mock tests module (FR-301, FR-302), shaped like the REAL BE-06a (apps/api/src/tests): routes,
 * DTO limits, the order of checks (guard 403, body 400, lookup 404, used 409, references 404/422)
 * and the error rules. Roles: SUPER_ADMIN and RECRUITER only (test:read, test:create,
 * test:update). There is no revision: PATCH is last-write-wins, like the API. In memory.
 */

type Role = Schemas['StaffRole'];
type Detail = Schemas['TestDetail'];
type Section = Schemas['TestSection'];

const MIN_DURATION = 5;
const MAX_DURATION = 480;
const MAX_SECTIONS = 20;
const MAX_QUESTIONS_PER_SECTION = 50;
const MAX_QUESTIONS_PER_TEST = 100;
const MAX_POINTS = 9999.99;
const DEFAULT_POINTS = 100;
const MAX_LIST_OFFSET = 10_000;
const TAG = /^[a-z0-9][a-z0-9 _.+#-]{0,39}$/;
const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'];
const TYPES = ['CODING', 'MCQ', 'SHORT_ANSWER'];
const MOCK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;

interface MockTest {
  detail: Detail;
  /** Seeded as already invited: the invitations mock adds to this (phase 2). */
  usedSeed: boolean;
}
interface State {
  tests: MockTest[];
  seq: number;
  /** The invitations mock tells which tests have an invitation. */
  invited: Set<string>;
}

const iso = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

function q(
  id: string,
  position: number,
  points: number,
  versionId: string | null,
  title: string | null,
  difficulty: Schemas['TestQuestion']['difficulty'],
  randomRule: Record<string, unknown> | null,
): Schemas['TestQuestion'] {
  return { id, position, points, questionVersionId: versionId, title, difficulty, randomRule };
}

function seed(): State {
  const counts = (sections: Section[]) => ({
    sectionCount: sections.length,
    questionCount: sections.reduce((n, s) => n + s.questions.length, 0),
  });
  const mk = (
    id: string,
    name: string,
    description: string | null,
    durationMinutes: number,
    profile: Schemas['TestProfile'],
    passScore: number | null,
    daysAgo: number,
    sections: Section[],
    used: boolean,
  ): MockTest => ({
    usedSeed: used,
    detail: {
      id,
      name,
      description,
      durationMinutes,
      profile,
      passScore,
      createdById: 'user-recruiter',
      createdAt: iso(daysAgo),
      ...counts(sections),
      used,
      sections,
    },
  });
  return {
    seq: 1,
    invited: new Set(),
    tests: [
      mk(
        'test-backend',
        'Backend engineer screening',
        'Two coding questions and a short concepts section.',
        90,
        'STANDARD',
        120,
        21,
        [
          {
            id: 'tsec-1',
            title: 'Algorithms',
            position: 1,
            timeLimitMin: 60,
            questions: [
              q('tq-1', 1, 100, 'q-merge-v2', 'Merge intervals', 'MEDIUM', null),
              q('tq-2', 2, 50, 'q-twosum-v1', 'Two sum', 'EASY', null),
            ],
          },
          {
            id: 'tsec-2',
            title: 'Concepts',
            position: 2,
            timeLimitMin: 20,
            questions: [q('tq-3', 1, 30, 'q-bigo-v1', 'Cost of binary search', 'MEDIUM', null)],
          },
        ],
        true,
      ),
      mk(
        'test-frontend',
        'Frontend and algorithms (strict)',
        null,
        120,
        'STRICT',
        null,
        7,
        [
          {
            id: 'tsec-3',
            title: 'Warm-up',
            position: 1,
            timeLimitMin: null,
            questions: [q('tq-4', 1, 100, 'q-twosum-v1', 'Two sum', 'EASY', null)],
          },
        ],
        false,
      ),
      mk(
        'test-random',
        'Random arrays round',
        'Two different medium array questions drawn at random.',
        45,
        'STANDARD',
        100,
        2,
        [
          {
            id: 'tsec-4',
            title: 'Arrays',
            position: 1,
            timeLimitMin: 45,
            questions: [
              q('tq-5', 1, 100, null, null, null, { tags: ['arrays'], difficulty: 'MEDIUM' }),
            ],
          },
        ],
        false,
      ),
    ],
  };
}

let state: State = seed();
export function resetMockTestState(): void {
  state = seed();
}
/** Phase 2 hook: invitations make a test "used" (it can no longer be edited, ADR 0002 S-6). */
export function markTestInvited(testId: string): void {
  state.invited.add(testId);
}
export function mockTestExists(testId: string): boolean {
  return state.tests.some((t) => t.detail.id === testId);
}
export function mockTestName(testId: string): string | null {
  return state.tests.find((t) => t.detail.id === testId)?.detail.name ?? null;
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
};
/** RFC 7807 body; an array message becomes errors[] under the fixed detail, like the real filter. */
const problem = (status: number, detail: string, errors?: string[]) =>
  HttpResponse.json(
    {
      type: 'about:blank',
      title: TITLES[status] ?? 'Error',
      status,
      detail: errors ? 'Request validation failed' : detail,
      instance: '/mock',
      traceId: 'mock-trace',
      ...(errors ? { errors } : {}),
    },
    { status },
  );

type Permission = 'test:read' | 'test:create' | 'test:update';
function allowed(request: Request, permission: Permission): Role | Response {
  const role = mockRoleFromToken(request.headers.get('authorization'));
  if (!role) return problem(401, 'Sign in again.');
  return hasPermission(role, permission) ? role : problem(403, 'Your role does not allow this.');
}

const isUsed = (t: MockTest): boolean => t.usedSeed || state.invited.has(t.detail.id);
const cents = (n: number): number => Math.round(n * 100);
const twoDecimals = (n: number): boolean => Number.isFinite(n) && cents(n) / 100 === n;
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function unknownKeys(
  body: Record<string, unknown>,
  allowedKeys: readonly string[],
  at = '',
): string[] {
  return Object.keys(body)
    .filter((k) => !allowedKeys.includes(k))
    .map((k) => `property ${at}${k} should not exist`);
}

interface Slot {
  position: number;
  points: number;
  versionId: string | null;
  rule: { tags?: string[]; difficulty?: string; type?: string } | null;
}
interface ResolvedSection {
  title: string;
  position: number;
  timeLimitMin: number | null;
  questions: Slot[];
}

/** parseRandomRule: exactly { tags?, difficulty?, type? }, strict, tags lower-cased. */
function parseRule(raw: unknown, at: string): { rule: Slot['rule']; problems: string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { rule: null, problems: [`${at}.randomRule: must be an object`] };
  }
  const r = raw as Record<string, unknown>;
  const problems = Object.keys(r)
    .filter((k) => !['tags', 'difficulty', 'type'].includes(k))
    .map((k) => `${at}.randomRule.${k}: unknown key`);
  const rule: NonNullable<Slot['rule']> = {};
  if (r.tags !== undefined) {
    const tags = Array.isArray(r.tags)
      ? (r.tags as unknown[]).map((t) => String(t).trim().toLowerCase())
      : null;
    if (!tags || tags.length < 1 || tags.length > 20)
      problems.push(`${at}.randomRule.tags: 1 to 20 tags`);
    else if (tags.some((t) => !TAG.test(t)))
      problems.push(`${at}.randomRule.tags: not a valid tag`);
    else if (new Set(tags).size !== tags.length)
      problems.push(`${at}.randomRule.tags: tags must be unique`);
    else rule.tags = tags;
  }
  if (r.difficulty !== undefined) {
    if (!DIFFICULTIES.includes(str(r.difficulty)))
      problems.push(`${at}.randomRule.difficulty: invalid`);
    else rule.difficulty = str(r.difficulty);
  }
  if (r.type !== undefined) {
    if (!TYPES.includes(str(r.type))) problems.push(`${at}.randomRule.type: invalid`);
    else rule.type = str(r.type);
  }
  return { rule: problems.length ? null : rule, problems };
}

/** The DTO layer (ValidationPipe): shapes, limits and unknown fields. Every problem, no lookups. */
function sectionDtoProblems(raw: unknown, at: string): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return [`${at} must be an object`];
  const s = raw as Record<string, unknown>;
  const out = unknownKeys(s, ['title', 'position', 'timeLimitMin', 'questions'], `${at}.`);
  if (typeof s.title !== 'string' || s.title.trim().length < 1 || s.title.trim().length > 200) {
    out.push(`${at}.title must be 1 to 200 characters`);
  }
  if (
    s.position !== undefined &&
    (!isInt(s.position) || s.position < 1 || s.position > MAX_SECTIONS)
  ) {
    out.push(`${at}.position must be an integer from 1 to ${MAX_SECTIONS}`);
  }
  if (
    s.timeLimitMin !== undefined &&
    (!isInt(s.timeLimitMin) || s.timeLimitMin < 1 || s.timeLimitMin > MAX_DURATION)
  ) {
    out.push(`${at}.timeLimitMin must be an integer from 1 to ${MAX_DURATION}`);
  }
  if (
    !Array.isArray(s.questions) ||
    s.questions.length < 1 ||
    s.questions.length > MAX_QUESTIONS_PER_SECTION
  ) {
    out.push(`${at}.questions must contain 1 to ${MAX_QUESTIONS_PER_SECTION} items`);
  } else {
    (s.questions as unknown[]).forEach((qq, j) => {
      const qat = `${at}.questions.${j}`;
      if (typeof qq !== 'object' || qq === null) return void out.push(`${qat} must be an object`);
      const o = qq as Record<string, unknown>;
      out.push(
        ...unknownKeys(o, ['questionVersionId', 'randomRule', 'points', 'position'], `${qat}.`),
      );
      if (
        o.questionVersionId !== undefined &&
        (typeof o.questionVersionId !== 'string' || !MOCK_ID.test(o.questionVersionId))
      ) {
        out.push(`${qat}.questionVersionId must be a UUID`);
      }
      if (
        o.randomRule !== undefined &&
        (typeof o.randomRule !== 'object' || o.randomRule === null)
      ) {
        out.push(`${qat}.randomRule must be an object`);
      }
      if (
        o.points !== undefined &&
        (typeof o.points !== 'number' ||
          !twoDecimals(o.points) ||
          o.points < 0.01 ||
          o.points > MAX_POINTS)
      ) {
        out.push(
          `${qat}.points must be a number from 0.01 to ${MAX_POINTS} with at most 2 decimals`,
        );
      }
      if (
        o.position !== undefined &&
        (!isInt(o.position) || o.position < 1 || o.position > MAX_QUESTIONS_PER_SECTION)
      ) {
        out.push(`${qat}.position must be an integer from 1 to ${MAX_QUESTIONS_PER_SECTION}`);
      }
    });
  }
  return out;
}

function commonDtoProblems(b: Record<string, unknown>, required: boolean): string[] {
  const out: string[] = [];
  if (
    b.name === undefined
      ? required
      : typeof b.name !== 'string' || b.name.trim().length < 1 || b.name.trim().length > 200
  ) {
    out.push('name must be 1 to 200 characters');
  }
  if (
    b.description !== undefined &&
    (typeof b.description !== 'string' || b.description.length > 5000)
  ) {
    out.push('description must be at most 5000 characters');
  }
  if (
    b.durationMinutes === undefined
      ? required
      : !isInt(b.durationMinutes) ||
        b.durationMinutes < MIN_DURATION ||
        b.durationMinutes > MAX_DURATION
  ) {
    out.push(`durationMinutes must be an integer from ${MIN_DURATION} to ${MAX_DURATION}`);
  }
  if (b.profile !== undefined && !['STANDARD', 'STRICT'].includes(str(b.profile))) {
    out.push('profile must be one of the following values: STANDARD, STRICT');
  }
  if (
    b.passScore !== undefined &&
    (typeof b.passScore !== 'number' ||
      !twoDecimals(b.passScore) ||
      b.passScore < 0 ||
      b.passScore > MAX_POINTS)
  ) {
    out.push(`passScore must be a number from 0 to ${MAX_POINTS} with at most 2 decimals`);
  }
  if (b.sections === undefined) {
    if (required) out.push('sections must contain 1 to 20 items');
  } else if (
    !Array.isArray(b.sections) ||
    b.sections.length < 1 ||
    b.sections.length > MAX_SECTIONS
  ) {
    out.push(`sections must contain 1 to ${MAX_SECTIONS} items`);
  } else {
    (b.sections as unknown[]).forEach((s, i) =>
      out.push(...sectionDtoProblems(s, `sections.${i}`)),
    );
  }
  return out;
}

/** resolveSections: positions all-or-none, exactly one of version and rule, strict rules. */
function resolveSections(
  input: Record<string, unknown>[],
): { sections: ResolvedSection[]; problems: string[] } | 'positions' {
  const order = <T extends { position?: unknown }>(
    items: T[],
  ): { item: T; position: number }[] | null => {
    const given = items.filter((i) => i.position !== undefined).length;
    if (given !== 0 && given !== items.length) return null;
    return items
      .map((item, i) => ({ item, position: (item.position as number | undefined) ?? i + 1 }))
      .sort((a, b) => a.position - b.position);
  };
  const ordered = order(input);
  if (!ordered) return 'positions';
  const problems: string[] = [];
  const sections = ordered.map(({ item: s, position }, i) => {
    const qs = order(s.questions as Record<string, unknown>[]);
    if (!qs) problems.push(`sections[${i}]: give a position on every question or on none`);
    const questions: Slot[] = (qs ?? []).map(({ item: qq, position: qp }, j) => {
      const at = `sections[${i}].questions[${j}]`;
      const fixed = qq.questionVersionId !== undefined;
      const random = qq.randomRule !== undefined;
      if (fixed === random)
        problems.push(`${at}: give exactly one of questionVersionId and randomRule`);
      let rule: Slot['rule'] = null;
      if (random) {
        const parsed = parseRule(qq.randomRule, at);
        problems.push(...parsed.problems);
        rule = parsed.rule;
      }
      return {
        position: qp,
        points: (qq.points as number | undefined) ?? DEFAULT_POINTS,
        versionId:
          typeof qq.questionVersionId === 'string' ? qq.questionVersionId.toLowerCase() : null,
        rule,
      };
    });
    return {
      title: String(s.title).trim(),
      position,
      timeLimitMin: (s.timeLimitMin as number | undefined) ?? null,
      questions,
    };
  });
  return { sections, problems };
}

const contiguous = (positions: number[]): boolean =>
  [...positions].sort((a, b) => a - b).every((p, i) => p === i + 1);

/** planProblems (test-structure.ts), same words. */
function planProblems(
  durationMinutes: number,
  passScore: number | null,
  sections: ResolvedSection[],
): string[] {
  const out: string[] = [];
  if (!contiguous(sections.map((s) => s.position))) {
    out.push('section positions must be 1, 2, 3, ... without gaps or repeats');
  }
  let limitSum = 0;
  let count = 0;
  let total = 0;
  sections.forEach((s, i) => {
    const at = `sections[${i}]`;
    if (s.timeLimitMin !== null) limitSum += s.timeLimitMin;
    if (!contiguous(s.questions.map((x) => x.position))) {
      out.push(`${at} question positions must be 1, 2, 3, ... without gaps or repeats`);
    }
    count += s.questions.length;
    for (const x of s.questions) total += cents(x.points);
  });
  if (count > MAX_QUESTIONS_PER_TEST)
    out.push(`a test has at most ${MAX_QUESTIONS_PER_TEST} questions`);
  if (limitSum > durationMinutes) {
    out.push(
      `the section time limits add up to ${limitSum} minutes, more than the ${durationMinutes} minute duration`,
    );
  }
  if (passScore !== null && cents(passScore) > total) {
    out.push('passScore is more than the points of all questions together');
  }
  return out;
}

/** checkReferences: draft or unknown version 404, archived 422, random rules need enough matches. */
function referenceResponse(sections: ResolvedSection[]): Response | null {
  const catalogue = questionCatalogue();
  const slots = sections.flatMap((s, i) =>
    s.questions.map((x, j) => ({ ...x, at: `sections[${i}].questions[${j}]` })),
  );
  const versions = [...new Set(slots.flatMap((s) => (s.versionId ? [s.versionId] : [])))];
  const found = versions.map((v) => catalogue.version(v));
  if (found.some((v) => v === null || !v.isPublished)) {
    return problem(404, 'A question version was not found.');
  }
  const archived = slots.filter((s) => s.versionId && catalogue.version(s.versionId)?.isArchived);
  if (archived.length)
    return problem(
      422,
      'x',
      archived.map((s) => `${s.at}: the question is archived`),
    );
  const need = new Map<string, { rule: NonNullable<Slot['rule']>; need: number; at: string }>();
  for (const s of slots) {
    if (!s.rule) continue;
    const key = JSON.stringify([
      [...(s.rule.tags ?? [])].sort(),
      s.rule.difficulty ?? null,
      s.rule.type ?? null,
    ]);
    const seen = need.get(key);
    if (seen) seen.need += 1;
    else need.set(key, { rule: s.rule, need: 1, at: s.at });
  }
  const problems: string[] = [];
  for (const { rule, need: n, at } of need.values()) {
    const matches = catalogue
      .pickable()
      .filter(
        (c) =>
          (rule.type === undefined || c.type === rule.type) &&
          (rule.difficulty === undefined || c.difficulty === rule.difficulty) &&
          (rule.tags === undefined || rule.tags.every((t) => c.tags.includes(t))),
      ).length;
    if (matches < n) {
      problems.push(
        `${at}.randomRule matches ${matches} published question(s) in your organization; the test needs ${n} different ones`,
      );
    }
  }
  return problems.length ? problem(422, 'x', problems) : null;
}

function build(sections: ResolvedSection[]): Section[] {
  const catalogue = questionCatalogue();
  return sections.map((s, i) => ({
    id: `tsec-${state.seq}-${i}`,
    title: s.title,
    position: s.position,
    timeLimitMin: s.timeLimitMin,
    questions: s.questions.map((x, j) => {
      const v = x.versionId ? catalogue.version(x.versionId) : null;
      return {
        id: `tq-${state.seq}-${i}-${j}`,
        position: x.position,
        points: x.points,
        questionVersionId: x.versionId,
        title: v?.title ?? null,
        difficulty: (v?.difficulty as Schemas['TestQuestion']['difficulty']) ?? null,
        randomRule: x.rule,
      };
    }),
  }));
}

const toSummary = (t: MockTest): Schemas['TestSummary'] => {
  const { sections: _sections, ...rest } = t.detail;
  void _sections;
  return { ...rest, used: isUsed(t) };
};
const toDetail = (t: MockTest): Detail => structuredClone({ ...t.detail, used: isUsed(t) });

export function createTestHandlers(options: { latencyMs: number }) {
  const base = `${apiBaseUrl}/v1/tests`;
  const wait = () => (options.latencyMs > 0 ? delay(options.latencyMs) : undefined);
  const newId = () => {
    state.seq += 1;
    return `test-${state.seq}`;
  };

  return [
    http.get(base, async ({ request }) => {
      const gate = allowed(request, 'test:read');
      if (gate instanceof Response) return gate;
      const url = new URL(request.url);
      const page = url.searchParams.has('page') ? Number(url.searchParams.get('page')) : 1;
      const pageSize = url.searchParams.has('pageSize')
        ? Number(url.searchParams.get('pageSize'))
        : 20;
      const profile = url.searchParams.get('profile');
      const used = url.searchParams.get('used');
      const search = url.searchParams.get('search');
      const bad: string[] = [];
      if (!isInt(page) || page < 1 || page > 100_000)
        bad.push('page must be an integer from 1 to 100000');
      if (!isInt(pageSize) || pageSize < 1 || pageSize > 100)
        bad.push('pageSize must be an integer from 1 to 100');
      if (profile !== null && !['STANDARD', 'STRICT'].includes(profile))
        bad.push('profile must be one of the following values: STANDARD, STRICT');
      if (used !== null && used !== 'true' && used !== 'false')
        bad.push('used must be a boolean value');
      if (search !== null && (search.trim().length < 1 || search.length > 100))
        bad.push('search must be 1 to 100 characters');
      if (bad.length) return problem(400, 'x', bad);
      if ((page - 1) * pageSize > MAX_LIST_OFFSET)
        return problem(400, 'The page is too deep; narrow the filters instead.');
      await wait();
      const rows = state.tests
        .filter((t) =>
          search ? t.detail.name.toLowerCase().includes(search.trim().toLowerCase()) : true,
        )
        .filter((t) => (profile ? t.detail.profile === profile : true))
        .filter((t) => (used === null ? true : isUsed(t) === (used === 'true')))
        .sort((a, b) =>
          a.detail.createdAt < b.detail.createdAt
            ? 1
            : a.detail.createdAt > b.detail.createdAt
              ? -1
              : a.detail.id < b.detail.id
                ? -1
                : 1,
        );
      return HttpResponse.json({
        items: rows.slice((page - 1) * pageSize, page * pageSize).map(toSummary),
        page,
        pageSize,
        total: rows.length,
      });
    }),

    http.post(base, async ({ request }) => {
      const role = allowed(request, 'test:create');
      if (role instanceof Response) return role;
      const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const dto = [
        ...unknownKeys(b, [
          'name',
          'description',
          'durationMinutes',
          'profile',
          'passScore',
          'sections',
        ]),
        ...commonDtoProblems(b, true),
      ];
      if (dto.length) return problem(400, 'x', dto);
      await wait();
      const resolved = resolveSections(b.sections as Record<string, unknown>[]);
      if (resolved === 'positions')
        return problem(400, 'x', ['give a position on every section or on none']);
      if (resolved.problems.length) return problem(400, 'x', resolved.problems);
      const plan = planProblems(
        b.durationMinutes as number,
        (b.passScore as number | undefined) ?? null,
        resolved.sections,
      );
      if (plan.length) return problem(400, 'x', plan);
      const refs = referenceResponse(resolved.sections);
      if (refs) return refs;
      const id = newId();
      const sections = build(resolved.sections);
      state.tests.push({
        usedSeed: false,
        detail: {
          id,
          name: str(b.name).trim(),
          description: typeof b.description === 'string' ? b.description : null,
          durationMinutes: b.durationMinutes as number,
          profile: ((b.profile as string | undefined) ?? 'STANDARD') as Schemas['TestProfile'],
          passScore: (b.passScore as number | undefined) ?? null,
          createdById: role === 'SUPER_ADMIN' ? 'user-super_admin' : 'user-recruiter',
          createdAt: new Date().toISOString(),
          sectionCount: sections.length,
          questionCount: sections.reduce((n, s) => n + s.questions.length, 0),
          used: false,
          sections,
        },
      });
      return HttpResponse.json(toDetail(state.tests[state.tests.length - 1]!), { status: 201 });
    }),

    http.get(`${base}/:id`, async ({ request, params }) => {
      const gate = allowed(request, 'test:read');
      if (gate instanceof Response) return gate;
      const id = String(params.id);
      if (!MOCK_ID.test(id)) return problem(400, 'Validation failed (uuid is expected)');
      await wait();
      const t = state.tests.find((x) => x.detail.id === id);
      return t ? HttpResponse.json(toDetail(t)) : problem(404, 'Test not found.');
    }),

    http.patch(`${base}/:id`, async ({ request, params }) => {
      const gate = allowed(request, 'test:update');
      if (gate instanceof Response) return gate;
      const id = String(params.id);
      const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const dto = [
        ...(MOCK_ID.test(id) ? [] : ['id must be a UUID']),
        ...unknownKeys(b, [
          'name',
          'description',
          'durationMinutes',
          'profile',
          'passScore',
          'sections',
        ]),
        ...commonDtoProblems(b, false),
      ];
      if (dto.length) return problem(400, 'x', dto);
      const fields = [
        'name',
        'description',
        'durationMinutes',
        'profile',
        'passScore',
        'sections',
      ].filter((f) => b[f] !== undefined);
      if (fields.length === 0) return problem(400, 'Send at least one field to change.');
      let replacement: ResolvedSection[] | undefined;
      if (b.sections !== undefined) {
        const resolved = resolveSections(b.sections as Record<string, unknown>[]);
        if (resolved === 'positions')
          return problem(400, 'x', ['give a position on every section or on none']);
        if (resolved.problems.length) return problem(400, 'x', resolved.problems);
        replacement = resolved.sections;
      }
      await wait();
      const t = state.tests.find((x) => x.detail.id === id);
      if (!t) return problem(404, 'Test not found.');
      if (isUsed(t)) {
        return problem(
          409,
          'This test already has invitations or sessions and cannot be edited; create a new test instead.',
        );
      }
      const current: ResolvedSection[] = t.detail.sections.map((s) => ({
        title: s.title,
        position: s.position,
        timeLimitMin: s.timeLimitMin,
        questions: s.questions.map((x) => ({
          position: x.position,
          points: x.points,
          versionId: x.questionVersionId,
          rule: null,
        })),
      }));
      const sections = replacement ?? current;
      const duration = (b.durationMinutes as number | undefined) ?? t.detail.durationMinutes;
      const passScore = (b.passScore as number | undefined) ?? t.detail.passScore;
      const plan = planProblems(duration, passScore, sections);
      if (plan.length) return problem(400, 'x', plan);
      if (replacement) {
        const refs = referenceResponse(replacement);
        if (refs) return refs;
      }
      if (b.name !== undefined) t.detail.name = str(b.name).trim();
      if (b.description !== undefined) t.detail.description = str(b.description);
      if (b.durationMinutes !== undefined) t.detail.durationMinutes = b.durationMinutes as number;
      if (b.profile !== undefined) t.detail.profile = b.profile as Schemas['TestProfile'];
      if (b.passScore !== undefined) t.detail.passScore = b.passScore as number;
      if (replacement) {
        state.seq += 1;
        t.detail.sections = build(replacement);
        t.detail.sectionCount = t.detail.sections.length;
        t.detail.questionCount = t.detail.sections.reduce((n, s) => n + s.questions.length, 0);
      }
      return HttpResponse.json(toDetail(t));
    }),
  ];
}
