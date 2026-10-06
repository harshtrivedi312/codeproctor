import { http, HttpResponse } from 'msw';
import { apiBaseUrl } from '@/lib/env';

/**
 * PROVISIONAL mocks for the real test screen (contract not final; see
 * features/candidate-test/adr-wire.ts): session state, test layout, question projection, draft,
 * run, section finish. Remove them when BE-07 and BE-11 are merged and the generated client covers
 * the routes (ADR 0012). Two sections: section 1 has a coding and a multiple-choice question,
 * section 2 has one coding question; finishing section 2 submits the test.
 */
export const MOCK_SECTION_MS = 10 * 60_000;
export const MOCK_TEST_MS = 30 * 60_000;

export interface TestRunState {
  started: boolean;
  startedAt: number;
  /** Section positions (1 based) with their start time; the open one is the highest. */
  sectionStarts: Map<number, number>;
  submitted: boolean;
  /** Pause reasons the server holds (PROCTOR, SCREEN_SHARE_STOPPED, SIDE_CAMERA_LOST). */
  pauseReasons: string[];
  lastRunAt: number;
  drafts: Map<string, unknown>;
  draftCalls: number;
  runCalls: number;
}

const states = new WeakMap<object, TestRunState>();

export function testState(session: object): TestRunState {
  let s = states.get(session);
  if (!s) {
    s = {
      started: false,
      startedAt: 0,
      sectionStarts: new Map(),
      submitted: false,
      pauseReasons: [],
      lastRunAt: 0,
      drafts: new Map(),
      draftCalls: 0,
      runCalls: 0,
    };
    states.set(session, s);
  }
  return s;
}

export function startMockTest(session: object, now = Date.now()): TestRunState {
  const s = testState(session);
  if (!s.started) {
    s.started = true;
    s.startedAt = now;
    s.sectionStarts.set(1, now);
  }
  return s;
}

const iso = (ms: number): string => new Date(ms).toISOString();

const QUESTIONS = {
  q1: { section: 1, position: 1, points: '60.00' },
  q2: { section: 1, position: 2, points: '20.00' },
  q3: { section: 2, position: 1, points: '20.00' },
} as const;
type QuestionId = keyof typeof QUESTIONS;
const isQuestionId = (id: string): id is QuestionId => id in QUESTIONS;

const SECTION_TITLES: Record<number, string> = { 1: 'Warm-up', 2: 'Problem solving' };

export function mockLayout(s: TestRunState) {
  const sections = [1, 2].map((position) => {
    const startedAt = s.sectionStarts.get(position) ?? null;
    return {
      position,
      title: SECTION_TITLES[position] ?? `Section ${position}`,
      timeLimitMs: MOCK_SECTION_MS,
      startedAt: startedAt === null ? null : iso(startedAt),
      deadlineAt: startedAt === null ? null : iso(startedAt + MOCK_SECTION_MS),
      questions: (Object.entries(QUESTIONS) as [QuestionId, (typeof QUESTIONS)[QuestionId]][])
        .filter(([, q]) => q.section === position)
        .map(([id, q]) => ({ sessionQuestionId: id, position: q.position, points: q.points })),
    };
  });
  return {
    status: s.pauseReasons.length > 0 ? 'PAUSED' : 'IN_PROGRESS',
    serverTime: iso(Date.now()),
    startedAt: iso(s.startedAt),
    deadlineAt: iso(s.startedAt + MOCK_TEST_MS),
    sections,
  };
}

function openPosition(s: TestRunState): number {
  return Math.max(...s.sectionStarts.keys());
}

interface Deps {
  /** The candidate session for this request (by bearer token), or null. */
  bearer: (request: Request) => object | null;
  problem: (status: number, code: string, headers?: Record<string, string>) => Response;
}

export function createTestRunHandlers({ bearer, problem }: Deps) {
  const cand = `${apiBaseUrl}/v1/candidate`;
  const live = (request: Request): { session: object; s: TestRunState } | Response => {
    const session = bearer(request);
    if (!session) return problem(401, 'UNAUTHENTICATED');
    const s = testState(session);
    if (!s.started || s.submitted) return problem(409, 'SESSION_NOT_ACTIVE');
    return { session, s };
  };
  const isResponse = (v: unknown): v is Response => v instanceof Response;
  /**
   * The older demo mocks (/t/demo/test, the QA specs) serve the same paths without any credential.
   * A request with no Authorization header is therefore not a candidate request: it falls through
   * to them, so registering these handlers never changes what the demo gets.
   */
  const notCandidate = (request: Request): boolean => !request.headers.has('Authorization');

  return [
    http.get(`${cand}/session`, ({ request }) => {
      if (notCandidate(request)) return undefined;
      const session = bearer(request);
      if (!session) return problem(401, 'UNAUTHENTICATED');
      const s = testState(session);
      const open = s.started ? openPosition(s) : null;
      const sectionStart = open === null ? null : (s.sectionStarts.get(open) ?? null);
      return HttpResponse.json({
        serverTime: iso(Date.now()),
        status: s.submitted
          ? 'SUBMITTED'
          : s.pauseReasons.length > 0
            ? 'PAUSED'
            : s.started
              ? 'IN_PROGRESS'
              : 'VERIFIED',
        startedAt: s.started ? iso(s.startedAt) : null,
        deadlineAt: s.started ? iso(s.startedAt + MOCK_TEST_MS) : null,
        sectionDeadlineAt: sectionStart === null ? null : iso(sectionStart + MOCK_SECTION_MS),
        pauseReasons: s.pauseReasons,
      });
    }),

    http.get(`${cand}/session/test`, ({ request }) => {
      const r = live(request);
      return isResponse(r) ? r : HttpResponse.json(mockLayout(r.s));
    }),

    http.get(`${cand}/questions/:id`, ({ request, params }) => {
      const r = live(request);
      if (isResponse(r)) return r;
      const id = String(params.id);
      if (!isQuestionId(id)) return problem(404, 'NOT_FOUND');
      // The open-section rule: only the open section's questions are served (CS-4.6).
      if (QUESTIONS[id].section !== openPosition(r.s)) return problem(409, 'SECTION_NOT_OPEN');
      if (id === 'q2') {
        return HttpResponse.json({
          sessionQuestionId: id,
          type: 'MCQ',
          title: 'Complexity',
          statementMd: 'What is the time complexity of binary search on a sorted array?',
          mcq: {
            multiple: false,
            options: [
              { id: 'opt_a', text: 'O(n)' },
              { id: 'opt_b', text: 'O(log n)' },
              { id: 'opt_c', text: 'O(n log n)' },
            ],
          },
        });
      }
      return HttpResponse.json({
        sessionQuestionId: id,
        type: 'CODING',
        title: id === 'q1' ? 'Sum of two numbers' : 'Reverse a string',
        statementMd:
          id === 'q1'
            ? 'Read two integers, one per line, and print their sum.'
            : 'Read a line and print it reversed.',
        languages: ['python', 'javascript'],
        starterCode: { python: '# write your solution\n', javascript: '// write your solution\n' },
        samples: [
          { input: id === 'q1' ? '1\n2' : 'abc', expectedOutput: id === 'q1' ? '3' : 'cba' },
        ],
      });
    }),

    http.put(`${cand}/questions/:id/draft`, async ({ request, params }) => {
      if (notCandidate(request)) return undefined;
      const r = live(request);
      if (isResponse(r)) return r;
      const id = String(params.id);
      if (!isQuestionId(id) || QUESTIONS[id].section !== openPosition(r.s))
        return problem(409, 'SECTION_NOT_OPEN');
      if (r.s.pauseReasons.length > 0) return problem(409, 'SESSION_PAUSED');
      r.s.drafts.set(id, await request.json());
      r.s.draftCalls += 1;
      return HttpResponse.json({ savedAt: iso(Date.now()) });
    }),

    http.post(`${cand}/answers/:id/run`, async ({ request, params }) => {
      const r = live(request);
      if (isResponse(r)) return r;
      const id = String(params.id);
      if (!isQuestionId(id) || QUESTIONS[id].section !== openPosition(r.s))
        return problem(409, 'SECTION_NOT_OPEN');
      if (r.s.pauseReasons.length > 0) return problem(409, 'SESSION_PAUSED');
      const now = Date.now();
      if (now - r.s.lastRunAt < 5000) {
        return problem(429, 'RATE_LIMITED', {
          'Retry-After': String(Math.ceil((5000 - (now - r.s.lastRunAt)) / 1000)),
        });
      }
      r.s.lastRunAt = now;
      r.s.runCalls += 1;
      const body = (await request.json()) as { code?: string };
      const passes = /print|console\.log/.test(body.code ?? '');
      return HttpResponse.json({
        outcome: 'completed',
        tests: [
          {
            id: `${id}-s1`,
            name: 'Sample 1',
            status: passes ? 'passed' : 'failed',
            input: '1\n2',
            expectedOutput: '3',
            actualOutput: passes ? '3' : '',
          },
        ],
        stdout: '',
        stderr: '',
      });
    }),

    http.post(`${cand}/sections/:position/finish`, ({ request, params }) => {
      if (notCandidate(request)) return undefined;
      const r = live(request);
      if (isResponse(r)) return r;
      const position = Number(params.position);
      if (position !== openPosition(r.s)) return problem(409, 'SECTION_NOT_OPEN');
      if (r.s.pauseReasons.includes('PROCTOR')) return problem(409, 'SESSION_PAUSED');
      const now = Date.now();
      if (position >= 2) {
        r.s.submitted = true;
        return HttpResponse.json({ finishedAt: iso(now), nextSectionId: null, submitted: true });
      }
      r.s.sectionStarts.set(position + 1, now);
      return HttpResponse.json({
        finishedAt: iso(now),
        nextSectionId: String(position + 1),
        submitted: false,
      });
    }),
  ];
}
