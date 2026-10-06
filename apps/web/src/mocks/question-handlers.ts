import { AI_REFERENCE_LANGUAGES, hasPermission } from '@codeproctor/shared';
import { delay, http, HttpResponse } from 'msw';
import type { Schemas } from '@/lib/api/client';
import { apiBaseUrl } from '@/lib/env';
import { mockRoleFromToken } from './auth-handlers';
import { seedQuestions, type Content, type MockQuestion, type MockVersion } from './question-seed';

/*
 * Mock question bank API (FE-04, FR-201..FR-205). In memory: survives navigation, not a page
 * reload. Authors and Super Admins read and write; a Recruiter only lists (question:read); the
 * detail routes answer 403 to anyone without question:update, because reference solutions, hidden
 * tests and answer keys must never reach other roles (TC-011).
 *
 * The validation "executor" is fake: a test slot fails when its expected output is blank or starts
 * with "TODO" (the seed "Rotate an array" has such a variant, to show TC-012). No code is run.
 */

type Role = Schemas['StaffRole'];
type Detail = Schemas['QuestionDetail'];
type AiReference = Schemas['AiReference'];
type Report = Schemas['ValidationReport'];

const POLICY: Schemas['AiReferencePolicy'] = { refreshDays: 90, minAssistants: 2 };

interface Job {
  questionId: string;
  version: number;
  polls: number;
  report: Report;
}

interface State {
  questions: MockQuestion[];
  jobs: Map<string, Job>;
  seq: number;
}

let state: State = fresh();
function fresh(): State {
  return { questions: seedQuestions(), jobs: new Map(), seq: 1 };
}
export function resetMockQuestionState(): void {
  state = fresh();
}

const problem = (status: number, code: string, message: string) =>
  HttpResponse.json({ code, message }, { status });

function allowed(
  request: Request,
  permission: 'question:read' | 'question:update',
): Role | Response {
  const role = mockRoleFromToken(request.headers.get('authorization'));
  if (!role) return problem(401, 'unauthenticated', 'Sign in again.');
  return hasPermission(role, permission)
    ? role
    : problem(403, 'forbidden', 'Your role does not allow this.');
}

const latest = (q: MockQuestion): MockVersion => q.versions[q.versions.length - 1]!;

function statusOf(q: MockQuestion): Schemas['QuestionStatus'] {
  if (q.archived) return 'ARCHIVED';
  return latest(q).isPublished ? 'PUBLISHED' : 'DRAFT';
}

function content(v: MockVersion): Content {
  return {
    title: v.title,
    statementMd: v.statementMd,
    difficulty: v.difficulty,
    tags: v.tags,
    allowedLanguages: v.allowedLanguages,
    limits: v.limits,
    starterCode: v.starterCode,
    referenceSolution: v.referenceSolution,
    paramSchema: v.paramSchema,
    testCases: v.testCases,
    variants: v.variants,
    answerSpec: v.answerSpec,
  };
}

function detail(q: MockQuestion, v: MockVersion): Detail {
  return {
    id: q.id,
    slug: q.slug,
    type: q.type,
    status: statusOf(q),
    latestVersion: latest(q).version,
    aiReferencePolicy: POLICY,
    current: {
      ...structuredClone(content(v)),
      tags: structuredClone(v.tags),
      version: v.version,
      isPublished: v.isPublished,
      createdAt: v.createdAt,
      validatedAt: v.validatedAt,
      validationReport: v.validationReport,
    },
  };
}

function find(id: string): MockQuestion | undefined {
  return state.questions.find((q) => q.id === id);
}

/** Server-side checks of a save. The web validates first; these are the API's own rules. */
function contentError(c: Content, type: Schemas['QuestionType']): string | null {
  if (c.title.trim() === '') return 'A title is required.';
  if (c.statementMd.trim() === '') return 'A statement is required.';
  if (c.testCases.some((t) => !(t.weight > 0)))
    return 'Every test case weight must be greater than 0.';
  if (type === 'MCQ') {
    if (c.answerSpec?.type !== 'MCQ') return 'A multiple-choice question needs options and a key.';
    if (c.answerSpec.options.length < 2 || c.answerSpec.correctOptionIds.length === 0) {
      return 'Add at least two options and mark the correct one.';
    }
  }
  if (
    type === 'SHORT_ANSWER' &&
    (c.answerSpec?.type !== 'SHORT_ANSWER' || c.answerSpec.canonical.trim() === '')
  ) {
    return 'A short-answer question needs a canonical answer.';
  }
  return null;
}

function render(text: string, params: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

function runValidation(v: MockVersion): Report {
  const results: Report['results'] = [];
  const languages = v.allowedLanguages.filter((l) => (v.referenceSolution[l] ?? '').trim() !== '');
  const finishedAt = new Date().toISOString();
  if (v.answerSpec) return { passed: true, finishedAt, results };
  if (languages.length === 0 || v.testCases.length === 0) {
    return {
      passed: false,
      finishedAt,
      results: [
        {
          variantId: null,
          variantLabel: 'Base statement',
          testCaseId: v.testCases[0]?.id ?? 'none',
          position: 1,
          language: v.allowedLanguages[0] ?? 'python',
          outcome: 'compile_error',
          message:
            languages.length === 0
              ? 'There is no reference solution to run. Add one on the Reference solution tab.'
              : 'There are no test cases. Add at least one on the Test cases tab.',
        },
      ],
    };
  }
  const slots = [
    {
      id: null as string | null,
      label: 'Base statement',
      overrides: [] as Content['variants'][number]['overrides'],
    },
    ...v.variants
      .filter((x) => x.active)
      .map((x) => ({ id: x.id, label: x.label, overrides: x.overrides })),
  ];
  for (const language of languages) {
    for (const slot of slots) {
      v.testCases.forEach((t, i) => {
        const o = slot.overrides.find((x) => x.testCaseId === t.id);
        const expected = o?.expectedOutput ?? t.expectedOutput;
        const bad = expected.trim() === '' || expected.trim().startsWith('TODO');
        results.push({
          variantId: slot.id,
          variantLabel: slot.label,
          testCaseId: t.id,
          position: i + 1,
          language,
          outcome: bad ? 'wrong_answer' : 'pass',
          ...(bad
            ? {
                message:
                  'The reference solution output does not match the expected output of this slot.',
              }
            : {}),
        });
      });
    }
  }
  return { passed: results.every((r) => r.outcome === 'pass'), finishedAt, results };
}

function aiGateMissing(q: MockQuestion, v: MockVersion): string | null {
  if (q.type !== 'CODING' || POLICY.minAssistants === 0) return null;
  for (const language of v.allowedLanguages.filter((l) => AI_REFERENCE_LANGUAGES.includes(l))) {
    const names = new Set(
      q.aiRefs
        .filter((r) => r.language === language && r.supersededAt === null)
        .map((r) => r.assistant.trim().toLowerCase()),
    );
    if (names.size < POLICY.minAssistants) {
      return `${language} needs solutions from ${POLICY.minAssistants} different AI assistants (it has ${names.size}).`;
    }
  }
  return null;
}

export function createQuestionHandlers(options: { latencyMs: number }) {
  const base = `${apiBaseUrl}/v1/questions`;
  const wait = () => (options.latencyMs > 0 ? delay(options.latencyMs) : undefined);

  /** Author routes: role check, then the question. */
  async function author(
    request: Request,
    id: string,
  ): Promise<{ role: Role; q: MockQuestion } | Response> {
    await wait();
    const role = allowed(request, 'question:update');
    if (role instanceof Response) return role;
    const q = find(id);
    return q ? { role, q } : problem(404, 'not_found', 'No such question.');
  }
  const actor = (role: Role) => (role === 'SUPER_ADMIN' ? 'Alex Admin' : 'Avery Author');

  return [
    http.get(base, async ({ request }) => {
      await wait();
      const role = allowed(request, 'question:read');
      if (role instanceof Response) return role;
      const items: Schemas['QuestionSummary'][] = state.questions.map((q) => {
        const v = latest(q);
        return {
          id: q.id,
          slug: q.slug,
          title: v.title,
          type: q.type,
          difficulty: v.difficulty,
          tags: v.tags,
          status: statusOf(q),
          version: v.version,
          updatedAt: v.createdAt,
        };
      });
      return HttpResponse.json({ items });
    }),

    http.post(base, async ({ request }) => {
      await wait();
      const role = allowed(request, 'question:update');
      if (role instanceof Response) return role;
      const body = (await request.json()) as Content & { type: Schemas['QuestionType'] };
      const err = contentError(body, body.type);
      if (err) return problem(400, 'invalid_content', err);
      const { type, ...rest } = body;
      state.seq += 1;
      const slug = `${rest.title
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')}-${state.seq}`;
      const q: MockQuestion = {
        id: `q-new-${state.seq}`,
        slug,
        type,
        archived: false,
        aiRefs: [],
        versions: [
          {
            ...rest,
            version: 1,
            isPublished: false,
            createdAt: new Date().toISOString(),
            createdByName: actor(role),
            validatedAt: null,
            validationReport: null,
          },
        ],
      };
      state.questions.push(q);
      return HttpResponse.json(detail(q, latest(q)), { status: 201 });
    }),

    http.get(`${base}/:id`, async ({ request, params }) => {
      const r = await author(request, String(params.id));
      if (r instanceof Response) return r;
      return HttpResponse.json(detail(r.q, latest(r.q)));
    }),

    http.patch(`${base}/:id`, async ({ request, params }) => {
      const r = await author(request, String(params.id));
      if (r instanceof Response) return r;
      const body = (await request.json()) as Content;
      const err = contentError(body, r.q.type);
      if (err) return problem(400, 'invalid_content', err);
      const current = latest(r.q);
      const fields = { ...body, validatedAt: null, validationReport: null };
      if (current.isPublished) {
        // A published version never changes: the edit becomes the next draft (FR-204).
        r.q.versions.push({
          ...fields,
          version: current.version + 1,
          isPublished: false,
          createdAt: new Date().toISOString(),
          createdByName: actor(r.role),
        });
      } else {
        Object.assign(current, fields, { createdAt: new Date().toISOString() });
      }
      return HttpResponse.json(detail(r.q, latest(r.q)));
    }),

    http.get(`${base}/:id/versions`, async ({ request, params }) => {
      const r = await author(request, String(params.id));
      if (r instanceof Response) return r;
      const items: Schemas['QuestionVersionSummary'][] = [...r.q.versions].reverse().map((v) => ({
        version: v.version,
        isPublished: v.isPublished,
        createdAt: v.createdAt,
        createdByName: v.createdByName,
        validatedAt: v.validatedAt,
      }));
      return HttpResponse.json({ items });
    }),

    http.get(`${base}/:id/versions/:version`, async ({ request, params }) => {
      const r = await author(request, String(params.id));
      if (r instanceof Response) return r;
      const v = r.q.versions.find((x) => x.version === Number(params.version));
      return v ? HttpResponse.json(detail(r.q, v)) : problem(404, 'not_found', 'No such version.');
    }),

    http.post(`${base}/:id/validate`, async ({ request, params }) => {
      const r = await author(request, String(params.id));
      if (r instanceof Response) return r;
      state.seq += 1;
      const jobId = `job-${state.seq}`;
      const v = latest(r.q);
      state.jobs.set(jobId, {
        questionId: r.q.id,
        version: v.version,
        polls: 0,
        report: runValidation(v),
      });
      return HttpResponse.json({ jobId }, { status: 202 });
    }),

    http.get(`${base}/:id/validation/:jobId`, async ({ request, params }) => {
      const r = await author(request, String(params.id));
      if (r instanceof Response) return r;
      const job = state.jobs.get(String(params.jobId));
      if (!job || job.questionId !== r.q.id) return problem(404, 'not_found', 'No such job.');
      job.polls += 1;
      if (job.polls < 2) {
        return HttpResponse.json({
          jobId: String(params.jobId),
          status: job.polls === 1 ? 'queued' : 'running',
        });
      }
      const v = r.q.versions.find((x) => x.version === job.version);
      // Only the still-current saved version takes the result (an edit after Validate clears it).
      if (v && v === latest(r.q) && v.validationReport === null) {
        v.validationReport = job.report;
        v.validatedAt = job.report.passed ? job.report.finishedAt : null;
      }
      return HttpResponse.json({ jobId: String(params.jobId), status: 'done', report: job.report });
    }),

    http.post(`${base}/:id/prefill`, async ({ request, params }) => {
      const r = await author(request, String(params.id));
      if (r instanceof Response) return r;
      const body = (await request.json()) as Schemas['PrefillRequest'];
      if (body.referenceSolution.trim() === '') {
        return problem(400, 'no_reference', 'There is no reference solution for this language.');
      }
      // Fake: the "run" renders the default expected output with this variant's parameters.
      const proposals = body.slots.map((s) => {
        const slot = latest(r.q).testCases.find((t) => t.id === s.testCaseId);
        return slot
          ? { testCaseId: s.testCaseId, expectedOutput: render(slot.expectedOutput, body.params) }
          : { testCaseId: s.testCaseId, error: 'This test slot does not exist yet. Save first.' };
      });
      return HttpResponse.json({ proposals });
    }),

    http.post(`${base}/:id/publish`, async ({ request, params }) => {
      const r = await author(request, String(params.id));
      if (r instanceof Response) return r;
      const v = latest(r.q);
      if (v.isPublished)
        return problem(409, 'already_published', 'This version is already published.');
      if (!v.validatedAt || !v.validationReport?.passed) {
        return problem(
          409,
          'validation_required',
          'Validate the saved version and fix every failing test first.',
        );
      }
      const missing = aiGateMissing(r.q, v);
      if (missing) return problem(409, 'ai_references_missing', missing);
      v.isPublished = true;
      return HttpResponse.json(detail(r.q, v));
    }),

    http.get(`${base}/:id/ai-references`, async ({ request, params }) => {
      const r = await author(request, String(params.id));
      if (r instanceof Response) return r;
      return HttpResponse.json({ items: structuredClone(r.q.aiRefs) });
    }),

    http.post(`${base}/:id/ai-references`, async ({ request, params }) => {
      const r = await author(request, String(params.id));
      if (r instanceof Response) return r;
      const body = (await request.json()) as Schemas['AiReferenceInput'];
      if (!AI_REFERENCE_LANGUAGES.includes(body.language)) {
        return problem(
          400,
          'invalid_language',
          'AI reference solutions exist for Python, JavaScript and Java only.',
        );
      }
      state.seq += 1;
      const row: AiReference = {
        ...body,
        id: `ai-new-${state.seq}`,
        collectedByName: actor(r.role),
        supersededAt: null,
      };
      r.q.aiRefs.push(row);
      return HttpResponse.json(row, { status: 201 });
    }),

    http.post(`${base}/:id/ai-references/:refId/supersede`, async ({ request, params }) => {
      const r = await author(request, String(params.id));
      if (r instanceof Response) return r;
      const old = r.q.aiRefs.find((x) => x.id === String(params.refId));
      if (!old || old.supersededAt !== null)
        return problem(404, 'not_found', 'No such current solution.');
      const body = (await request.json()) as Schemas['AiReferenceInput'];
      if (!AI_REFERENCE_LANGUAGES.includes(body.language)) {
        return problem(
          400,
          'invalid_language',
          'AI reference solutions exist for Python, JavaScript and Java only.',
        );
      }
      state.seq += 1;
      old.supersededAt = new Date().toISOString();
      const row: AiReference = {
        ...body,
        id: `ai-new-${state.seq}`,
        collectedByName: actor(r.role),
        supersededAt: null,
      };
      r.q.aiRefs.push(row);
      return HttpResponse.json(row, { status: 201 });
    }),
  ];
}
