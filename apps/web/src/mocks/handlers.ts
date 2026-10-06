import { delay, http, HttpResponse } from 'msw';
import { apiBaseUrl } from '@/lib/env';
import type { Schemas } from '@/lib/api/client';
import { createAdminHandlers } from './admin-handlers';
import { createAuthHandlers } from './auth-handlers';
import { mockSession } from './data';

export interface MockOptions {
  /** Simulated Judge0 latency for a run. */
  runLatencyMs: number;
  /** Simulated autosave latency. */
  saveLatencyMs: number;
  /** Simulated latency of staff administration calls. */
  adminLatencyMs: number;
}

/** The mocked server clock runs this far ahead of the browser, so the offset logic is visible. */
export const MOCK_SERVER_CLOCK_AHEAD_MS = 90_000;
/** One "server now" for every mocked response that carries a server time (/v1/time, savedAt...). */
export const mockServerNow = (): Date => new Date(Date.now() + MOCK_SERVER_CLOCK_AHEAD_MS);

const DEFAULTS: MockOptions = { runLatencyMs: 2500, saveLatencyMs: 300, adminLatencyMs: 300 };

/** Fake grading, only to make the demo feel real. Not a judge: it looks for a few keywords. */
export function fakeRun(code: string, tests: Schemas['SampleTest'][]): Schemas['RunResult'] {
  const trimmed = code.trim();
  if (trimmed === '') {
    return {
      outcome: 'compile_error',
      tests: [],
      stdout: '',
      stderr:
        'SyntaxError: no code to run.\nHint: write your solution in the editor, then press Run again.',
    };
  }
  if (/while\s*\(?\s*(true|True|1)\s*\)?/.test(trimmed)) {
    return {
      outcome: 'time_limit_exceeded',
      tests: [],
      stdout: '',
      stderr: 'Time limit exceeded (2 s).\nHint: look for a loop that never ends.',
    };
  }
  const sorts = /sort/.test(trimmed);
  const handlesTouching = sorts && /(<=|>=|max\()/.test(trimmed);
  const results: Schemas['SampleTestResult'][] = tests.map((t, i) => {
    const passes = sorts ? (t.id === 'st-3' ? handlesTouching : true) : false;
    return {
      id: t.id,
      name: t.name,
      status: passes ? 'passed' : 'failed',
      input: t.input,
      expectedOutput: t.expectedOutput,
      actualOutput: passes
        ? t.expectedOutput
        : sorts
          ? '1 3\n3 5'
          : t.input.split('\n').slice(1).join('\n'),
      durationMs: 12 + i * 7,
    };
  });
  return {
    outcome: 'completed',
    tests: results,
    stdout: 'debug: read input\ndebug: finished\n',
    stderr: '',
  };
}

export function createHandlers(options: Partial<MockOptions> = {}) {
  const opts = { ...DEFAULTS, ...options };
  const base = apiBaseUrl;
  const startedAt = Date.now();
  let lastRunAt = 0;

  return [
    ...createAuthHandlers(),
    ...createAdminHandlers({ latencyMs: opts.adminLatencyMs }),
    http.get(`${base}/v1/health`, () => HttpResponse.json({ status: 'ok' as const })),

    http.get(`${base}/v1/time`, () =>
      HttpResponse.json({ serverNow: mockServerNow().toISOString() }),
    ),

    http.get(`${base}/v1/candidate/session`, () => {
      const { testDurationMs, sectionDurationMs, ...rest } = mockSession;
      const serverStart = startedAt + MOCK_SERVER_CLOCK_AHEAD_MS;
      const body: Schemas['CandidateSession'] = {
        ...rest,
        testDeadlineAt: new Date(serverStart + testDurationMs).toISOString(),
        section: {
          ...rest.section,
          deadlineAt: new Date(serverStart + sectionDurationMs).toISOString(),
        },
      };
      return HttpResponse.json(body);
    }),

    http.put(`${base}/v1/candidate/questions/:questionId/draft`, async () => {
      await delay(opts.saveLatencyMs);
      return HttpResponse.json({ savedAt: mockServerNow().toISOString() });
    }),

    http.post(`${base}/v1/candidate/questions/:questionId/run`, async ({ request, params }) => {
      const now = Date.now();
      if (opts.runLatencyMs > 0 && now - lastRunAt < 5000) {
        return HttpResponse.json(
          { retryAfterSeconds: Math.ceil((5000 - (now - lastRunAt)) / 1000) },
          { status: 429 },
        );
      }
      lastRunAt = now;
      const body = (await request.json()) as Schemas['RunRequest'];
      const question = mockSession.questions.find((q) => q.id === params.questionId);
      await delay(opts.runLatencyMs);
      return HttpResponse.json(fakeRun(body.code, question?.sampleTests ?? []));
    }),

    http.post(`${base}/v1/candidate/sections/:sectionId/finish`, async () => {
      await delay(opts.saveLatencyMs);
      return HttpResponse.json({ finishedAt: mockServerNow().toISOString(), nextSectionId: null });
    }),
  ];
}

export const handlers = createHandlers();
