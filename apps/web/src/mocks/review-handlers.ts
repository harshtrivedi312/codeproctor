import { hasPermission } from '@codeproctor/shared';
import { delay, http, HttpResponse } from 'msw';
import type { Schemas } from '@/lib/api/client';
import { apiBaseUrl } from '@/lib/env';
import { mockRoleFromToken } from './auth-handlers';

/*
 * Mock review workspace (FR-901, FR-902). PROVISIONAL queue, bundle and playback shapes (see the
 * openapi ReviewQueue / ReviewSession / ReviewPlayback). The scoring route follows
 * docs/api-contract.md section 7 (binary score, 409 ANSWER_NOT_MANUAL / SESSION_NOT_UNDER_REVIEW /
 * VERDICT_ALREADY_SET). Fake people only; in memory; a page reload resets the demo. The playback
 * url is a tiny generated WAV data url: video elements play its sound with a black picture.
 */

type Bundle = Schemas['ReviewSession'];
type Answer = Schemas['ReviewAnswer'];
type Event = Schemas['ReviewEvent'];

const MIN = 60_000;
const T0 = Date.parse('2026-10-05T09:00:00.000Z');
const at = (min: number): string => new Date(T0 + min * MIN).toISOString();

const SORT_CODE = `def merge(intervals):
    intervals.sort(key=lambda x: x[0])
    out = []
    for lo, hi in intervals:
        if out and lo <= out[-1][1]:
            out[-1][1] = max(out[-1][1], hi)
        else:
            out.append([lo, hi])
    return out
`;

function answers(pendingShort: boolean): Answer[] {
  return [
    {
      sessionQuestionId: 'sq-1',
      type: 'CODING',
      title: 'Merge intervals',
      statement: 'Merge all overlapping intervals and return the result sorted by start.',
      points: 100,
      score: 80,
      scoring: 'AUTO',
      scoringNote: null,
      answer: { language: 'python', code: SORT_CODE },
      runResults: [
        {
          at: at(20),
          passed: 2,
          total: 4,
          tests: [
            { name: 'Sample 1', status: 'passed' },
            { name: 'Sample 2', status: 'passed' },
            { name: 'Touching intervals', status: 'failed' },
            { name: 'Empty input', status: 'failed' },
          ],
        },
        {
          at: at(34),
          passed: 4,
          total: 4,
          tests: [
            { name: 'Sample 1', status: 'passed' },
            { name: 'Sample 2', status: 'passed' },
            { name: 'Touching intervals', status: 'passed' },
            { name: 'Empty input', status: 'passed' },
          ],
        },
      ],
    },
    {
      sessionQuestionId: 'sq-2',
      type: 'MCQ',
      title: 'Cost of binary search',
      statement: 'What is the worst-case time of binary search on a sorted array?',
      points: 20,
      score: 20,
      scoring: 'AUTO',
      scoringNote: null,
      answer: { selectedOptionIds: ['o-2'] },
      options: [
        { id: 'o-1', text: 'O(n)' },
        { id: 'o-2', text: 'O(log n)' },
        { id: 'o-3', text: 'O(n log n)' },
      ],
    },
    {
      sessionQuestionId: 'sq-3',
      type: 'SHORT_ANSWER',
      title: 'Explain idempotency',
      statement: 'In one sentence, what does it mean for an HTTP method to be idempotent?',
      points: 30,
      score: pendingShort ? null : 30,
      scoring: pendingShort ? 'MANUAL_PENDING' : 'AUTO',
      scoringNote: null,
      answer: 'Calling it many times has the same effect on the server as calling it once.',
    },
  ];
}

function ev(
  id: string,
  min: number,
  type: string,
  severity: Event['severity'],
  detail: string | null,
): Event {
  return { id, at: at(min), type, severity, detail, flagId: null };
}

const EVENTS_RICH: Event[] = [
  ev('e1', 6, 'FULLSCREEN_EXIT', 'MEDIUM', 'Left fullscreen for 8 seconds'),
  ev('e2', 14, 'TAB_SWITCH', 'MEDIUM', 'Another tab was focused for 12 seconds'),
  ev('e3', 21, 'PASTE_BLOCKED', 'HIGH', 'Paste of 420 characters was blocked'),
  ev('e4', 27, 'NO_FACE', 'MEDIUM', 'No face in view for 15 seconds'),
  ev('e5', 33, 'MULTIPLE_FACES', 'HIGH', 'A second face appeared for 6 seconds'),
  ev('e6', 40, 'RECONNECTED', null, null),
];

function bundle(
  id: string,
  name: string,
  test: string,
  status: Bundle['session']['status'],
  risk: number | null,
  events: Event[],
  pendingShort: boolean,
): Bundle {
  return {
    session: {
      id,
      status,
      startedAt: at(0),
      submittedAt: at(55 + Number(id.slice(3))),
      totalScore: null,
      riskScore: risk,
    },
    candidate: { name, email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.test` },
    test: { title: test },
    answers: answers(pendingShort),
    events,
    recordings: [
      { id: 'SCREEN-0', kind: 'SCREEN', startedAt: at(0), durationMs: 55 * MIN },
      { id: 'AUDIO-0', kind: 'AUDIO', startedAt: at(0), durationMs: 55 * MIN },
    ],
    verdict: { verdict: null, notes: null, completedAt: null },
  };
}

function seed(): Bundle[] {
  const list = [
    bundle(
      'rs-1',
      'Priya Nair',
      'Backend engineer screening',
      'UNDER_REVIEW',
      72,
      EVENTS_RICH,
      true,
    ),
    bundle(
      'rs-2',
      'Marco Silva',
      'Backend engineer screening',
      'UNDER_REVIEW',
      41,
      EVENTS_RICH.slice(0, 2),
      false,
    ),
    bundle('rs-3', 'Lena Fischer', 'Frontend and algorithms', 'UNDER_REVIEW', null, [], false),
    bundle('rs-4', 'Tom Okafor', 'Frontend and algorithms', 'UNDER_REVIEW', 88, EVENTS_RICH, true),
    bundle(
      'rs-5',
      'Aisha Khan',
      'Backend engineer screening',
      'GRADED',
      12,
      EVENTS_RICH.slice(5),
      false,
    ),
  ];
  for (const b of list) recompute(b);
  return list;
}

function recompute(b: Bundle): void {
  b.session.totalScore = b.answers.some((a) => a.scoring === 'MANUAL_PENDING')
    ? null
    : b.answers.reduce((sum, a) => sum + (a.score ?? 0), 0);
}

let state = seed();
export function resetMockReviewState(): void {
  state = seed();
}

const TITLES: Record<number, string> = {
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  503: 'Service Unavailable',
};
const problem = (status: number, detail: string, code?: string) =>
  HttpResponse.json(
    {
      type: 'about:blank',
      title: TITLES[status] ?? 'Error',
      status,
      detail,
      instance: '/mock',
      traceId: 'mock-trace',
      ...(code ? { code } : {}),
    },
    { status },
  );

type Permission = 'review_queue:read' | 'review_session:read' | 'review_verdict:set';
function allowed(request: Request, permission: Permission): Response | null {
  const role = mockRoleFromToken(request.headers.get('authorization'));
  if (!role) return problem(401, 'Sign in again.');
  return hasPermission(role, permission) ? null : problem(403, 'Your role does not allow this.');
}

/** A 1-second quiet tone as a WAV data url, small and offline. */
function sampleMedia(): string {
  const rate = 8000;
  const n = rate;
  const bytes = new Uint8Array(44 + n);
  const view = new DataView(bytes.buffer);
  const tag = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i += 1) bytes[o + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + n, true);
  tag(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  tag(36, 'data');
  view.setUint32(40, n, true);
  for (let i = 0; i < n; i += 1)
    bytes[44 + i] = 128 + Math.round(10 * Math.sin((i / rate) * 2 * Math.PI * 440));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:audio/wav;base64,${btoa(bin)}`;
}

export function createReviewHandlers(options: { latencyMs: number }) {
  const base = `${apiBaseUrl}/v1/review`;
  const find = (id: unknown): Bundle | undefined => state.find((b) => b.session.id === id);
  return [
    http.get(`${base}/queue`, async ({ request }) => {
      const denied = allowed(request, 'review_queue:read');
      if (denied) return denied;
      await delay(options.latencyMs);
      const status = new URL(request.url).searchParams.get('status');
      const items = state
        .filter((b) =>
          status
            ? b.session.status === status
            : ['GRADED', 'UNDER_REVIEW'].includes(b.session.status),
        )
        .sort(
          (a, b) =>
            Date.parse(a.session.submittedAt ?? '') - Date.parse(b.session.submittedAt ?? ''),
        )
        .map((b) => ({
          sessionId: b.session.id,
          candidateName: b.candidate.name,
          candidateEmail: b.candidate.email,
          testTitle: b.test.title,
          status: b.session.status,
          submittedAt: b.session.submittedAt,
          riskScore: b.session.riskScore,
          flagCount: b.events.filter((e) => e.severity === 'MEDIUM' || e.severity === 'HIGH')
            .length,
          pendingManualCount: b.answers.filter((a) => a.scoring === 'MANUAL_PENDING').length,
        }));
      return HttpResponse.json({ items, nextCursor: null });
    }),

    http.get(`${base}/sessions/:sessionId`, async ({ request, params }) => {
      const denied = allowed(request, 'review_session:read');
      if (denied) return denied;
      await delay(options.latencyMs);
      const b = find(params.sessionId);
      return b ? HttpResponse.json(b) : problem(404, 'Not found.');
    }),

    http.get(
      `${base}/sessions/:sessionId/recordings/:recordingId/playback`,
      ({ request, params }) => {
        const denied = allowed(request, 'review_session:read');
        if (denied) return denied;
        const b = find(params.sessionId);
        if (!b || !b.recordings.some((r) => r.id === params.recordingId)) {
          return problem(404, 'Not found.');
        }
        const url = sampleMedia();
        return HttpResponse.json({
          url,
          parts: [0, 1, 2].map((seq) => ({ url, seq, durationMs: 1000 })),
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          contentType: 'audio/wav',
        });
      },
    ),

    http.patch(
      `${base}/sessions/:sessionId/answers/:sessionQuestionId`,
      async ({ request, params }) => {
        const denied = allowed(request, 'review_verdict:set');
        if (denied) return denied;
        await delay(options.latencyMs);
        const b = find(params.sessionId);
        const a = b?.answers.find((x) => x.sessionQuestionId === params.sessionQuestionId);
        if (!b || !a) return problem(404, 'Not found.');
        const body = (await request.json().catch(() => null)) as {
          correct?: unknown;
          note?: unknown;
        } | null;
        if (!body || typeof body.correct !== 'boolean')
          return problem(400, 'correct must be a boolean');
        if (b.verdict?.verdict)
          return problem(409, 'A verdict is already set.', 'VERDICT_ALREADY_SET');
        if (b.session.status !== 'UNDER_REVIEW') {
          return problem(409, 'The session is not under review.', 'SESSION_NOT_UNDER_REVIEW');
        }
        if (a.type !== 'SHORT_ANSWER' || a.scoring === 'AUTO') {
          return problem(409, 'This answer is not scored by hand.', 'ANSWER_NOT_MANUAL');
        }
        a.scoring = 'MANUAL';
        a.score = body.correct ? a.points : 0;
        if (typeof body.note === 'string' && body.note !== '') a.scoringNote = body.note;
        recompute(b);
        return HttpResponse.json({
          sessionQuestionId: a.sessionQuestionId,
          correct: body.correct,
          score: a.score,
        });
      },
    ),

    http.post(`${base}/sessions/:sessionId/verdict`, async ({ request, params }) => {
      const denied = allowed(request, 'review_verdict:set');
      if (denied) return denied;
      await delay(options.latencyMs);
      const b = find(params.sessionId);
      if (!b) return problem(404, 'Not found.');
      const body = (await request.json().catch(() => null)) as {
        verdict?: unknown;
        note?: unknown;
      } | null;
      const v = body?.verdict;
      if (v !== 'CLEAN' && v !== 'SUSPICIOUS' && v !== 'VIOLATION') {
        return problem(400, 'verdict must be CLEAN, SUSPICIOUS or VIOLATION');
      }
      if (b.verdict?.verdict)
        return problem(409, 'A verdict is already set.', 'VERDICT_ALREADY_SET');
      if (b.answers.some((a) => a.scoring === 'MANUAL_PENDING')) {
        return problem(409, 'Short answers are still waiting for a decision.', 'MANUAL_PENDING');
      }
      b.verdict = {
        verdict: v,
        notes: typeof body?.note === 'string' && body.note !== '' ? body.note : null,
        completedAt: new Date().toISOString(),
      };
      b.session.status = 'COMPLETED';
      return HttpResponse.json(b.verdict);
    }),
  ];
}
