import { AI_REFERENCE_LANGUAGES, hasPermission } from '@codeproctor/shared';
import { delay, http, HttpResponse } from 'msw';
import type { Schemas } from '@/lib/api/client';
import { apiBaseUrl } from '@/lib/env';
import { mockRoleFromToken } from './auth-handlers';
import { paramsProblems, renderContent, type ParamValue } from './question-template';
import {
  revisionOf,
  toFullDetail,
  toReadDetail,
  toSummary,
  toTestCase,
  toVariantDto,
  visibleVersions,
} from './question-redaction';
import {
  seedQuestions,
  type AnswerSpec,
  type MockQuestion,
  type MockTestCase,
  type MockVariant,
  type MockVersion,
} from './question-seed';

/*
 * Mock question bank API (FE-04, FR-201..FR-205), shaped EXACTLY like the real BE-04a and BE-04b
 * (apps/api/src/questions): routes, DTOs, who may call what, and the error rules. In memory: it
 * survives navigation, not a page reload.
 *
 *  - Readers (question:read): list and detail. A caller without question:update gets published
 *    versions only (a draft, a never-published, a missing question and an unknown version are the
 *    same 404), never archived questions in the list, and the allowlisted read view with no
 *    revision, reference solution, answer spec or validation report and hidden test cases without
 *    input and output (question-redaction.ts). A published but archived question stays readable.
 *  - Writers (question:update): PATCH, publish, archive, test-case routes. PATCH takes optional
 *    fields (no test cases), edits a draft in place or forks the next draft of a published version.
 *    `revision` is an opaque content digest; a stale expectedRevision is 409.
 *  - Variants (BE-04b, question:update except the candidate-shaped preview): list, create, change,
 *    remove and per-slot override routes under /versions/:version/variants. A variant has params,
 *    isActive and a rendered statement, NO label; every ACTIVE variant must render (the mock
 *    renderer in question-template.ts), a content PATCH re-checks that, a fork copies variants with
 *    new ids and re-points overrides at the new slots, and the revision covers variants.
 *  - Every request body is checked like the real ValidationPipe (forbidNonWhitelisted): a field no
 *    DTO declares is a 400.
 *  - Errors are RFC 7807 bodies. 409 and 422 carry detail and errors[] only, no code.
 *  - Publish: a CODING question fails closed with 422 (no validate job in the real API yet, slice
 *    BE-04c). The mock scenario `validationJob` lets the web-only placeholder job unlock it.
 *
 * WEB-ONLY placeholders (no counterpart in the API yet): prefill (BE-04b did not add it), the
 * validate job [BE-04c] and AI reference solutions [BE-04c]. The fake executor fails a test slot
 * whose expected output is blank or starts with "TODO" (the seed "Rotate an array" shows TC-012).
 */

type Role = Schemas['StaffRole'];
type AiReference = Schemas['AiReference'];
type Report = Schemas['ValidationReport'];
type Permission = 'question:read' | 'question:create' | 'question:update';

const POLICY: Schemas['AiReferencePolicy'] = { refreshDays: 90, minAssistants: 2 };
const NOT_FOUND = 'Not found.';
const MAX_TEST_CASES = 100;

export interface QuestionScenario {
  /** The web-only validate job unlocks publishing of CODING questions (the real API cannot yet). */
  validationJob: boolean;
}

interface Job {
  questionId: string;
  version: number;
  revision: string;
  polls: number;
  report: Report;
}

interface State {
  questions: MockQuestion[];
  jobs: Map<string, Job>;
  seq: number;
  scenario: QuestionScenario;
}

let state: State = fresh();
function fresh(): State {
  return {
    questions: seedQuestions(),
    jobs: new Map(),
    seq: 1,
    scenario: { validationJob: false },
  };
}
export function resetMockQuestionState(): void {
  state = fresh();
}
/** Tests and demos: choose how the mock behaves where the real API is not built yet. */
export function setMockQuestionScenario(scenario: Partial<QuestionScenario>): void {
  state.scenario = { ...state.scenario, ...scenario };
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
};

/** RFC 7807 problem body. 409 and 422 carry detail and errors[] only: no machine code. */
const problem = (status: number, detail: string, errors?: string[]) =>
  HttpResponse.json(
    {
      type: 'about:blank',
      title: TITLES[status] ?? 'Error',
      status,
      // Like the real filter: an array message becomes errors[] under a fixed detail.
      detail: errors ? 'Request validation failed' : detail,
      instance: '/mock',
      traceId: 'mock-trace',
      ...(errors ? { errors } : {}),
    },
    { status },
  );

function allowed(request: Request, permission: Permission): Role | Response {
  const role = mockRoleFromToken(request.headers.get('authorization'));
  if (!role) return problem(401, 'Sign in again.');
  return hasPermission(role, permission) ? role : problem(403, 'Your role does not allow this.');
}

const latest = (q: MockQuestion): MockVersion => q.versions[q.versions.length - 1]!;

/** The API's ValidationPipe has forbidNonWhitelisted: a body field no DTO declares is a 400. */
function unknownFields(body: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(body)
    .filter((k) => !allowed.includes(k))
    .map((k) => `property ${k} should not exist`);
}
const CREATE_FIELDS = [
  'type',
  'slug',
  'title',
  'statementMd',
  'difficulty',
  'tags',
  'allowedLanguages',
  'limits',
  'starterCode',
  'referenceSolution',
  'answerSpec',
  'testCases',
] as const;
const UPDATE_FIELDS = [
  'title',
  'statementMd',
  'difficulty',
  'tags',
  'allowedLanguages',
  'limits',
  'starterCode',
  'referenceSolution',
  'answerSpec',
  'expectedRevision',
] as const;
const MAX_VARIANTS = 50;
const REVISION = /^[0-9a-f]{64}$/;
const revisionProblems = (v: unknown): string[] =>
  v === undefined || (typeof v === 'string' && REVISION.test(v))
    ? []
    : ['expectedRevision must match /^[0-9a-f]{64}$/ regular expression'];

/** Every ACTIVE variant must render against the content (renderVariant), or the problems say why. */
function renderProblems(
  content: {
    statementMd: string;
    starterCode: Record<string, string>;
    referenceSolution: Record<string, string>;
  },
  variants: readonly MockVariant[],
): { problems: string[]; rendered: Map<string, string> } {
  const problems: string[] = [];
  const rendered = new Map<string, string>();
  for (const x of variants) {
    if (!x.isActive) continue;
    const r = renderContent(content, x.params);
    if (r.ok) rendered.set(x.id, r.content.statementMd);
    else problems.push(...r.errors.map((e) => `variants[${x.id}].${e}`));
  }
  return { problems, rendered };
}

/** Server-side shape rules (question-content.ts, answer-spec.ts in the API); a draft may be incomplete. */
const OPTION_ID = /^[A-Za-z0-9_-]{1,32}$/;
const TAG = /^[a-z0-9][a-z0-9 _.+#-]{0,39}$/;
const norm = (t: string) => t.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();

function answerSpecProblems(type: Schemas['QuestionType'], spec: unknown): string[] {
  const out: string[] = [];
  const rec = spec && typeof spec === 'object' ? (spec as Record<string, unknown>) : null;
  if (!rec) return ['answerSpec: must be an object'];
  if (type === 'MCQ') {
    const options = Array.isArray(rec.options)
      ? (rec.options as { id?: unknown; text?: unknown }[])
      : [];
    const correct = Array.isArray(rec.correctOptionIds) ? (rec.correctOptionIds as unknown[]) : [];
    if (options.length < 2 || options.length > 10) out.push('answerSpec.options: 2 to 10 options');
    const ids = options.map((o) => String(o.id));
    if (ids.some((id) => !OPTION_ID.test(id))) out.push('answerSpec.options: invalid option id');
    if (new Set(ids).size !== ids.length) out.push('answerSpec: option ids must be unique');
    if (
      options.some((o) => typeof o.text !== 'string' || o.text.length < 1 || o.text.length > 1000)
    ) {
      out.push('answerSpec.options: text must be 1 to 1000 characters');
    }
    if (correct.length < 1) out.push('answerSpec.correctOptionIds: at least one');
    if (!correct.every((c) => ids.includes(String(c)))) {
      out.push('answerSpec: correctOptionIds must name existing options');
    }
    if (typeof rec.multiple !== 'boolean') out.push('answerSpec.multiple: required');
    else if (!rec.multiple && correct.length !== 1) {
      out.push('answerSpec: a single-choice question has exactly one correct option');
    }
    return out;
  }
  const canonical = typeof rec.canonical === 'string' ? rec.canonical : '';
  const variants = Array.isArray(rec.acceptedVariants) ? (rec.acceptedVariants as unknown[]) : [];
  if (canonical.length < 1 || canonical.length > 500)
    out.push('answerSpec.canonical: 1 to 500 characters');
  else if (norm(canonical) === '')
    out.push('answerSpec: canonical answer is empty after normalization');
  if (variants.length > 20) out.push('answerSpec.acceptedVariants: at most 20');
  if (variants.some((v) => typeof v !== 'string' || norm(v) === '')) {
    out.push('answerSpec: an accepted variant is empty after normalization');
  }
  return out;
}

function shapeProblems(
  type: Schemas['QuestionType'],
  c: {
    allowedLanguages: string[];
    starterCode: Record<string, string>;
    referenceSolution: Record<string, string>;
    answerSpec: unknown;
  },
): string[] {
  const out: string[] = [];
  const langs = ['python', 'javascript', 'java'];
  for (const [name, map] of [
    ['starterCode', c.starterCode],
    ['referenceSolution', c.referenceSolution],
  ] as const) {
    if (Object.keys(map).some((k) => !langs.includes(k)))
      out.push(`${name}: keys must be one of ${langs.join(', ')}`);
  }
  if (new Set(c.allowedLanguages).size !== c.allowedLanguages.length)
    out.push('allowedLanguages: must be unique');
  if (type === 'CODING') {
    if (c.answerSpec !== null && c.answerSpec !== undefined)
      out.push('answerSpec: not allowed on a CODING question');
    return out;
  }
  if (c.allowedLanguages.length > 0)
    out.push(`allowedLanguages: must be empty on a ${type} question`);
  if (Object.keys(c.starterCode).length > 0)
    out.push(`starterCode: must be empty on a ${type} question`);
  if (Object.keys(c.referenceSolution).length > 0)
    out.push(`referenceSolution: must be empty on a ${type} question`);
  if (c.answerSpec !== null && c.answerSpec !== undefined)
    out.push(...answerSpecProblems(type, c.answerSpec));
  return out;
}

function limitsProblems(l: Schemas['Limits']): string[] {
  const out: string[] = [];
  const int = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);
  if (!int(l.cpuMs) || l.cpuMs < 100 || l.cpuMs > 10_000) out.push('limits.cpuMs: 100 to 10000');
  if (!int(l.wallMs) || l.wallMs < 100 || l.wallMs > 20_000)
    out.push('limits.wallMs: 100 to 20000');
  if (!int(l.memoryKb) || l.memoryKb < 16_384 || l.memoryKb > 524_288)
    out.push('limits.memoryKb: 16384 to 524288');
  if (l.wallMs < l.cpuMs) out.push('limits: wallMs must not be below cpuMs');
  return out;
}

/** The completeness rules of publish (question-content.ts publishProblems). */
function publishProblems(q: MockQuestion, v: MockVersion): string[] {
  const out = shapeProblems(q.type, v);
  if (v.title.trim() === '') out.push('title: required');
  if (v.statementMd.trim() === '') out.push('statementMd: required');
  if (q.type !== 'CODING') {
    if (!v.answerSpec) out.push('answerSpec: required to publish');
    if (v.testCases.length > 0) out.push(`testCases: not allowed on a ${q.type} question`);
    return out;
  }
  out.push(...limitsProblems(v.limits));
  if (v.allowedLanguages.length === 0) out.push('allowedLanguages: at least one language');
  const refKeys = Object.keys(v.referenceSolution).filter(
    (k) => (v.referenceSolution[k] ?? '').trim() !== '',
  );
  if (refKeys.length === 0) out.push('referenceSolution: at least one language');
  for (const l of v.allowedLanguages) {
    if (!refKeys.includes(l)) out.push(`referenceSolution.${l}: required for an allowed language`);
  }
  // Fail closed (TC-012): the real API has no validate job yet, so a coding question cannot be
  // published. Scenario `validationJob`: the web-only job's report must pass on this very revision.
  const report = v.validationReport;
  const passing =
    state.scenario.validationJob &&
    v.validatedAt !== null &&
    report?.passed === true &&
    report.revision === revisionOf(v);
  if (!passing) out.push('validation: a passing validation run of the current content is required');
  if (state.scenario.validationJob) {
    const gap = aiGateMissing(q, v);
    if (gap) out.push(`aiReferences: ${gap}`);
  }
  // Every active variant renders cleanly (ADR 0007 V-2); an override on a foreign slot cannot exist here.
  out.push(...renderProblems(v, v.variants).problems);
  if (v.testCases.length === 0) out.push('testCases: at least one');
  if (!v.testCases.some((t) => !t.isHidden))
    out.push('testCases: at least one sample (not hidden)');
  if (!v.testCases.some((t) => t.isHidden)) out.push('testCases: at least one hidden test');
  return out;
}

function render(text: string, params: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

/** The editable content only: a whitelist, so a client cannot set isPublished, version or the like. */
function pickInput(b: Schemas['AiReferenceInput']): Schemas['AiReferenceInput'] {
  return {
    assistant: b.assistant,
    modelLabel: b.modelLabel,
    language: b.language,
    solutionCode: b.solutionCode,
    collectedAt: b.collectedAt,
    ...(b.promptText !== undefined ? { promptText: b.promptText } : {}),
    variantId: b.variantId ?? null,
  };
}

function runValidation(q: MockQuestion, v: MockVersion): Report {
  const revision = revisionOf(v);
  const finishedAt = new Date().toISOString();
  const results: NonNullable<Report['results']> = [];
  if (q.type !== 'CODING') return { passed: true, revision, finishedAt, results };
  const languages = v.allowedLanguages.filter((l) => (v.referenceSolution[l] ?? '').trim() !== '');
  if (languages.length === 0 || v.testCases.length === 0) {
    return {
      passed: false,
      revision,
      finishedAt,
      results: [
        {
          variantId: null,
          variantLabel: 'Base statement',
          testCaseId: v.testCases[0]?.id ?? 'none',
          position: 0,
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
      overrides: [] as Schemas['VariantOverride'][],
    },
    ...[...v.variants]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .flatMap((x, i) =>
        x.isActive ? [{ id: x.id, label: `Variant ${i + 1}`, overrides: x.overrides }] : [],
      ),
  ];
  for (const language of languages) {
    for (const slot of slots) {
      for (const t of v.testCases) {
        const o = slot.overrides.find((x) => x.testCaseId === t.id);
        const expected = o?.expectedOutput ?? t.expectedOutput;
        const bad = expected.trim() === '' || expected.trim().startsWith('TODO');
        results.push({
          variantId: slot.id,
          variantLabel: slot.label,
          testCaseId: t.id,
          position: t.position,
          language,
          outcome: bad ? 'wrong_answer' : 'pass',
          ...(bad
            ? {
                message:
                  'The reference solution output does not match the expected output of this slot.',
              }
            : {}),
        });
      }
    }
  }
  return { passed: results.every((r) => r.outcome === 'pass'), revision, finishedAt, results };
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

/** Any change of content or test cases clears the recorded validation (it was about the old content). */
function clearValidation(v: MockVersion): void {
  v.validatedAt = null;
  v.validationReport = null;
}

interface TestCaseBody {
  input?: unknown;
  expectedOutput?: unknown;
  isHidden?: unknown;
  weight?: unknown;
  position?: unknown;
}
function testCaseProblems(b: TestCaseBody, requireIo: boolean): string[] {
  const out: string[] = unknownFields(b as Record<string, unknown>, [
    'input',
    'expectedOutput',
    'isHidden',
    'weight',
    'position',
  ]);
  for (const k of ['input', 'expectedOutput'] as const) {
    const v = b[k];
    if (v === undefined) {
      if (requireIo) out.push(`${k}: required`);
    } else if (typeof v !== 'string' || v.length > 100_000)
      out.push(`${k}: a string of at most 100000 characters`);
  }
  if (b.isHidden !== undefined && typeof b.isHidden !== 'boolean')
    out.push('isHidden: must be a boolean');
  if (b.weight !== undefined) {
    const w = b.weight;
    if (typeof w !== 'number' || !(w >= 0.01) || w > 9999.99 || Math.round(w * 100) / 100 !== w) {
      out.push('weight: a number from 0.01 to 9999.99 with at most 2 decimals');
    }
  }
  if (b.position !== undefined) {
    const p = b.position;
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p > 10_000)
      out.push('position: an integer from 0 to 10000');
  }
  return out;
}

export function createQuestionHandlers(options: { latencyMs: number }) {
  const base = `${apiBaseUrl}/v1/questions`;
  const wait = () => (options.latencyMs > 0 ? delay(options.latencyMs) : undefined);
  const find = (id: string) => state.questions.find((q) => q.id === id);
  const actor = (role: Role) => (role === 'SUPER_ADMIN' ? 'Alex Admin' : 'Avery Author');
  const newId = (prefix: string) => {
    state.seq += 1;
    return `${prefix}-${state.seq}`;
  };

  /** Any reader: the question, or 404. */
  async function reader(
    request: Request,
    id: string,
  ): Promise<{ role: Role; q: MockQuestion; full: boolean } | Response> {
    await wait();
    const role = allowed(request, 'question:read');
    if (role instanceof Response) return role;
    const q = find(id);
    return q ? { role, q, full: hasPermission(role, 'question:update') } : problem(404, NOT_FOUND);
  }
  /** Writers only (question:update). */
  async function writer(
    request: Request,
    id: string,
  ): Promise<{ role: Role; q: MockQuestion } | Response> {
    await wait();
    const role = allowed(request, 'question:update');
    if (role instanceof Response) return role;
    const q = find(id);
    return q ? { role, q } : problem(404, NOT_FOUND);
  }
  /** A writable question: not archived. */
  const archivedCheck = (q: MockQuestion): Response | null =>
    q.isArchived ? problem(409, 'The question is archived.') : null;

  /**
   * lockDraft + checkRevision of the real variant routes, in the real order: 403/404 question,
   * 409 archived, 404 version, 422 not coding, 409 published, 409 stale revision.
   */
  async function draftOf(
    request: Request,
    id: string,
    version: number,
    expectedRevision: unknown,
  ): Promise<{ r: { role: Role; q: MockQuestion }; v: MockVersion } | Response> {
    const r = await writer(request, id);
    if (r instanceof Response) return r;
    const closed = archivedCheck(r.q);
    if (closed) return closed;
    const v = r.q.versions.find((x) => x.version === version);
    if (!v) return problem(404, NOT_FOUND);
    if (r.q.type !== 'CODING') return problem(422, 'Only coding questions have variants.');
    if (v.isPublished) {
      return problem(
        409,
        'A published version is immutable; edit the question to create a new version.',
      );
    }
    if (typeof expectedRevision === 'string' && expectedRevision !== revisionOf(v)) {
      return problem(
        409,
        'The question changed since you loaded it; reload it and apply your edit again.',
      );
    }
    return { r, v };
  }
  const byId = (a: { id: string }, b: { id: string }): number =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

  return [
    http.get(base, async ({ request }) => {
      await wait();
      const role = allowed(request, 'question:read');
      if (role instanceof Response) return role;
      const full = hasPermission(role, 'question:update');
      const url = new URL(request.url);
      const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
      const pageSize = Math.min(
        100,
        Math.max(1, Number(url.searchParams.get('pageSize') ?? 20) || 20),
      );
      const tag = url.searchParams.get('tag');
      const difficulty = url.searchParams.get('difficulty');
      const type = url.searchParams.get('type');
      const includeArchived = url.searchParams.get('includeArchived') === 'true' && full;
      const rows = state.questions
        .filter((q) => includeArchived || !q.isArchived)
        .filter((q) => full || q.versions.some((v) => v.isPublished))
        .filter((q) => !type || q.type === type)
        .filter((q) => !tag || q.tags.includes(tag))
        .filter((q) => {
          if (!difficulty) return true;
          const published = [...q.versions].reverse().find((v) => v.isPublished);
          return (published ?? latest(q)).difficulty === difficulty;
        })
        .sort((a, b) =>
          a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : 1,
        );
      const items = rows
        .slice((page - 1) * pageSize, page * pageSize)
        .map((q) => toSummary(q, visibleVersions(q, full)));
      return HttpResponse.json({ items, page, pageSize, total: rows.length });
    }),

    http.post(base, async ({ request }) => {
      await wait();
      const role = allowed(request, 'question:create');
      if (role instanceof Response) return role;
      const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      // Field by field: nothing but the documented fields is read.
      const type = (b.type as Schemas['QuestionType'] | undefined) ?? 'CODING';
      const title = typeof b.title === 'string' ? b.title.trim() : '';
      const statementMd = typeof b.statementMd === 'string' ? b.statementMd : '';
      const difficulty = b.difficulty as Schemas['Difficulty'] | undefined;
      const problems: string[] = unknownFields(b, CREATE_FIELDS);
      if (!['CODING', 'MCQ', 'SHORT_ANSWER'].includes(type)) problems.push('type: invalid');
      if (title.length < 1 || title.length > 200) problems.push('title: 1 to 200 characters');
      if (statementMd.length < 1 || statementMd.length > 50_000)
        problems.push('statementMd: 1 to 50000 characters');
      if (!difficulty || !['EASY', 'MEDIUM', 'HARD'].includes(difficulty))
        problems.push('difficulty: invalid');
      const tags = Array.isArray(b.tags)
        ? (b.tags as unknown[]).map((t) => String(t).trim().toLowerCase())
        : [];
      if (tags.length > 20 || tags.some((t) => !TAG.test(t))) problems.push('tags: invalid tag');
      const limits = (b.limits as Schemas['Limits'] | undefined) ?? {
        cpuMs: 2000,
        wallMs: 5000,
        memoryKb: 262_144,
      };
      const content = {
        allowedLanguages: (b.allowedLanguages as Schemas['Language'][] | undefined) ?? [],
        starterCode: (b.starterCode as Record<string, string> | undefined) ?? {},
        referenceSolution: (b.referenceSolution as Record<string, string> | undefined) ?? {},
        answerSpec: (b.answerSpec as AnswerSpec | undefined) ?? null,
      };
      const rawCases = Array.isArray(b.testCases) ? (b.testCases as TestCaseBody[]) : [];
      problems.push(...shapeProblems(type, content), ...limitsProblems(limits));
      if (type !== 'CODING' && rawCases.length > 0)
        problems.push(`testCases: not allowed on a ${type} question`);
      if (rawCases.length > MAX_TEST_CASES) problems.push(`testCases: at most ${MAX_TEST_CASES}`);
      rawCases.forEach((t, i) =>
        problems.push(...testCaseProblems(t, true).map((p) => `testCases.${i}.${p}`)),
      );
      if (problems.length > 0) return problem(400, 'Validation failed', problems);
      const slug =
        (typeof b.slug === 'string' && b.slug) ||
        `${
          title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') || 'question'
        }-${state.seq + 1}`;
      if (state.questions.some((q) => q.slug === slug)) {
        return problem(409, 'A question with this slug already exists.');
      }
      const id = newId('q-new');
      const q: MockQuestion = {
        id,
        slug,
        type,
        tags: [...new Set(tags)],
        isArchived: false,
        createdAt: new Date().toISOString(),
        aiRefs: [],
        versions: [
          {
            id: `${id}-v1`,
            version: 1,
            isPublished: false,
            title,
            difficulty: difficulty!,
            validatedAt: null,
            createdAt: new Date().toISOString(),
            createdByName: actor(role),
            statementMd,
            allowedLanguages: content.allowedLanguages,
            limits: { cpuMs: limits.cpuMs, wallMs: limits.wallMs, memoryKb: limits.memoryKb },
            starterCode: { ...content.starterCode },
            referenceSolution: { ...content.referenceSolution },
            answerSpec: content.answerSpec,
            validationReport: null,
            testCases: rawCases.map((t, i) => ({
              id: newId('tc'),
              position: typeof t.position === 'number' ? t.position : i,
              isHidden: typeof t.isHidden === 'boolean' ? t.isHidden : true,
              weight: typeof t.weight === 'number' ? t.weight : 1,
              input: String(t.input),
              expectedOutput: String(t.expectedOutput),
            })),
            variants: [],
          },
        ],
      };
      state.questions.push(q);
      return HttpResponse.json(toFullDetail(q, latest(q), q.versions, false), { status: 201 });
    }),

    http.get(`${base}/:id`, async ({ request, params }) => {
      const r = await reader(request, String(params.id));
      if (r instanceof Response) return r;
      const versions = visibleVersions(r.q, r.full);
      const wanted = new URL(request.url).searchParams.get('version');
      const chosen =
        wanted === null
          ? versions[versions.length - 1]
          : versions.find((v) => v.version === Number(wanted));
      // Identical 404 for a draft, a never-published question and an unknown version (readers).
      if (!chosen) return problem(404, NOT_FOUND);
      return HttpResponse.json(
        r.full ? toFullDetail(r.q, chosen, versions, false) : toReadDetail(r.q, chosen, versions),
      );
    }),

    http.patch(`${base}/:id`, async ({ request, params }) => {
      const r = await writer(request, String(params.id));
      if (r instanceof Response) return r;
      const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const fields = [
        'title',
        'statementMd',
        'difficulty',
        'allowedLanguages',
        'limits',
        'starterCode',
        'referenceSolution',
        'answerSpec',
      ] as const;
      const touched = fields.filter((k) => b[k] !== undefined);
      // DTO validation comes first, as in the real pipe: unknown fields and a malformed revision.
      const dtoProblems = [
        ...unknownFields(b, UPDATE_FIELDS),
        ...revisionProblems(b.expectedRevision),
      ];
      if (dtoProblems.length > 0) return problem(400, 'Validation failed', dtoProblems);
      if (b.tags === undefined && touched.length === 0) {
        return problem(400, 'Send at least one field to change.');
      }
      const closed = archivedCheck(r.q);
      if (closed) return closed;
      const head = latest(r.q);
      if (b.expectedRevision !== undefined && b.expectedRevision !== revisionOf(head)) {
        return problem(409, 'This question changed since you opened it.');
      }
      const merged = {
        title: typeof b.title === 'string' ? b.title.trim() : head.title,
        statementMd: typeof b.statementMd === 'string' ? b.statementMd : head.statementMd,
        difficulty: (b.difficulty as Schemas['Difficulty'] | undefined) ?? head.difficulty,
        allowedLanguages:
          (b.allowedLanguages as Schemas['Language'][] | undefined) ?? head.allowedLanguages,
        limits: (b.limits as Schemas['Limits'] | undefined) ?? head.limits,
        starterCode: (b.starterCode as Record<string, string> | undefined) ?? head.starterCode,
        referenceSolution:
          (b.referenceSolution as Record<string, string> | undefined) ?? head.referenceSolution,
        answerSpec: b.answerSpec !== undefined ? (b.answerSpec as AnswerSpec) : head.answerSpec,
      };
      const problems = [
        ...shapeProblems(r.q.type, merged),
        ...(b.limits ? limitsProblems(merged.limits) : []),
      ];
      // Variants (FR-203): an edited statement, starter code or reference solution must still
      // render for every ACTIVE variant, so a draft never holds an unrenderable active variant.
      const rendered = new Map<string, string>();
      if (
        r.q.type === 'CODING' &&
        (b.statementMd !== undefined ||
          b.starterCode !== undefined ||
          b.referenceSolution !== undefined)
      ) {
        const rp = renderProblems(merged, head.variants);
        problems.push(...rp.problems);
        for (const [id, text] of rp.rendered) rendered.set(id, text);
      }
      if (merged.title.length < 1 || merged.title.length > 200)
        problems.push('title: 1 to 200 characters');
      if (merged.statementMd.length < 1) problems.push('statementMd: required');
      let tags = r.q.tags;
      if (b.tags !== undefined) {
        const list = Array.isArray(b.tags)
          ? (b.tags as unknown[]).map((t) => String(t).trim().toLowerCase())
          : [];
        if (list.length > 20 || list.some((t) => !TAG.test(t))) problems.push('tags: invalid tag');
        tags = [...new Set(list)];
      }
      if (problems.length > 0) return problem(400, 'Validation failed', problems);
      r.q.tags = tags;
      let createdNewVersion = false;
      if (touched.length > 0) {
        if (!head.isPublished) {
          Object.assign(head, merged, { limits: { ...merged.limits } });
          for (const x of head.variants) {
            const text = rendered.get(x.id);
            if (text !== undefined) x.renderedStatement = text;
          }
          clearValidation(head);
        } else {
          // A published version never changes: the edit becomes the next draft (FR-204).
          createdNewVersion = true;
          const number = head.version + 1;
          const slotIds = new Map(head.testCases.map((t) => [t.id, newId('tc')]));
          r.q.versions.push({
            ...merged,
            id: `${r.q.id}-v${number}`,
            version: number,
            isPublished: false,
            validatedAt: null,
            validationReport: null,
            createdAt: new Date().toISOString(),
            createdByName: actor(r.role),
            // The test cases are copied with NEW ids; the variants too (a copy of every variant,
            // new id), and their overrides are re-pointed at the new slots, as the API does. The
            // new variant ids keep the old order only because the mock derives them from the old.
            testCases: head.testCases.map((t) => ({ ...t, id: slotIds.get(t.id)! })),
            variants: head.variants.map((x) => ({
              id: `${x.id}-f${number}`,
              isActive: x.isActive,
              params: { ...x.params },
              renderedStatement: rendered.get(x.id) ?? x.renderedStatement,
              overrides: x.overrides.flatMap((o) => {
                const testCaseId = slotIds.get(o.testCaseId);
                return testCaseId ? [{ ...o, testCaseId }] : [];
              }),
            })),
          });
        }
      }
      const versions = visibleVersions(r.q, true);
      return HttpResponse.json(toFullDetail(r.q, latest(r.q), versions, createdNewVersion));
    }),

    http.post(`${base}/:id/publish`, async ({ request, params }) => {
      const r = await writer(request, String(params.id));
      if (r instanceof Response) return r;
      const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const dtoProblems = [
        ...unknownFields(b, ['expectedRevision']),
        ...revisionProblems(b.expectedRevision),
      ];
      if (dtoProblems.length > 0) return problem(400, 'Validation failed', dtoProblems);
      const closed = archivedCheck(r.q);
      if (closed) return closed;
      const head = latest(r.q);
      if (b.expectedRevision !== undefined && b.expectedRevision !== revisionOf(head)) {
        return problem(409, 'This question changed since it was validated.');
      }
      if (head.isPublished)
        return problem(409, 'There is no draft to publish; edit the question first.');
      const problems = publishProblems(r.q, head);
      if (problems.length > 0) return problem(422, 'The draft cannot be published yet.', problems);
      // The stored rendered statements are refreshed from the very content being published.
      for (const x of head.variants) {
        const text = renderProblems(head, [x]).rendered.get(x.id);
        if (text !== undefined) x.renderedStatement = text;
      }
      head.isPublished = true;
      return HttpResponse.json(toFullDetail(r.q, head, visibleVersions(r.q, true), false));
    }),

    http.post(`${base}/:id/archive`, async ({ request, params }) => {
      const r = await writer(request, String(params.id));
      if (r instanceof Response) return r;
      r.q.isArchived = true;
      return HttpResponse.json(toSummary(r.q, visibleVersions(r.q, true)));
    }),
    http.post(`${base}/:id/unarchive`, async ({ request, params }) => {
      const r = await writer(request, String(params.id));
      if (r instanceof Response) return r;
      r.q.isArchived = false;
      return HttpResponse.json(toSummary(r.q, visibleVersions(r.q, true)));
    }),

    // ---- test cases (REAL, BE-04a) -------------------------------------------------------------
    http.post(`${base}/:id/versions/:version/test-cases`, async ({ request, params }) => {
      const r = await writer(request, String(params.id));
      if (r instanceof Response) return r;
      const v = r.q.versions.find((x) => x.version === Number(params.version));
      if (!v) return problem(404, NOT_FOUND);
      if (v.isPublished) return problem(409, 'The version is published and cannot change.');
      const closed = archivedCheck(r.q);
      if (closed) return closed;
      if (r.q.type !== 'CODING') return problem(422, 'Only coding questions have test cases.');
      if (v.testCases.length >= MAX_TEST_CASES)
        return problem(422, `At most ${MAX_TEST_CASES} test cases.`);
      const b = (await request.json().catch(() => ({}))) as TestCaseBody;
      const problems = testCaseProblems(b, true);
      if (problems.length > 0) return problem(400, 'Validation failed', problems);
      const t: MockTestCase = {
        id: newId('tc'),
        position:
          typeof b.position === 'number'
            ? b.position
            : Math.max(-1, ...v.testCases.map((x) => x.position)) + 1,
        isHidden: typeof b.isHidden === 'boolean' ? b.isHidden : true,
        weight: typeof b.weight === 'number' ? b.weight : 1,
        input: String(b.input),
        expectedOutput: String(b.expectedOutput),
      };
      v.testCases.push(t);
      clearValidation(v);
      return HttpResponse.json(toTestCase(t, true), { status: 201 });
    }),

    http.patch(`${base}/:id/versions/:version/test-cases/:caseId`, async ({ request, params }) => {
      const r = await writer(request, String(params.id));
      if (r instanceof Response) return r;
      const v = r.q.versions.find((x) => x.version === Number(params.version));
      const t = v?.testCases.find((x) => x.id === String(params.caseId));
      if (!v || !t) return problem(404, 'Test case not found.');
      if (v.isPublished) return problem(409, 'The version is published and cannot change.');
      const closed = archivedCheck(r.q);
      if (closed) return closed;
      const b = (await request.json().catch(() => ({}))) as TestCaseBody;
      const keys = ['input', 'expectedOutput', 'isHidden', 'weight', 'position'] as const;
      if (keys.every((k) => b[k] === undefined))
        return problem(400, 'Send at least one field to change.');
      const problems = testCaseProblems(b, false);
      if (problems.length > 0) return problem(400, 'Validation failed', problems);
      if (typeof b.input === 'string') t.input = b.input;
      if (typeof b.expectedOutput === 'string') t.expectedOutput = b.expectedOutput;
      if (typeof b.isHidden === 'boolean') t.isHidden = b.isHidden;
      if (typeof b.weight === 'number') t.weight = b.weight;
      if (typeof b.position === 'number') t.position = b.position;
      clearValidation(v);
      return HttpResponse.json(toTestCase(t, true));
    }),

    http.delete(`${base}/:id/versions/:version/test-cases/:caseId`, async ({ request, params }) => {
      const r = await writer(request, String(params.id));
      if (r instanceof Response) return r;
      const v = r.q.versions.find((x) => x.version === Number(params.version));
      const t = v?.testCases.find((x) => x.id === String(params.caseId));
      if (!v || !t) return problem(404, 'Test case not found.');
      if (v.isPublished) return problem(409, 'The version is published and cannot change.');
      const closed = archivedCheck(r.q);
      if (closed) return closed;
      v.testCases = v.testCases.filter((x) => x.id !== t.id);
      v.variants = v.variants.map((x) => ({
        ...x,
        overrides: x.overrides.filter((o) => o.testCaseId !== t.id),
      }));
      clearValidation(v);
      return new HttpResponse(null, { status: 204 });
    }),

    // ---- variants (REAL, BE-04b) ---------------------------------------------------------------
    http.get(`${base}/:id/versions/:version/variants`, async ({ request, params }) => {
      const r = await writer(request, String(params.id));
      if (r instanceof Response) return r;
      const v = r.q.versions.find((x) => x.version === Number(params.version));
      if (!v) return problem(404, NOT_FOUND);
      return HttpResponse.json({
        items: [...v.variants].sort(byId).map((x) => toVariantDto(x, v.testCases)),
        revision: revisionOf(v),
      });
    }),

    http.post(`${base}/:id/versions/:version/variants`, async ({ request, params }) => {
      const gate = allowed(request, 'question:update');
      if (gate instanceof Response) return gate;
      const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const dto = [
        ...unknownFields(b, ['params', 'isActive', 'expectedRevision']),
        ...(b.params === undefined
          ? ['params must be an object']
          : paramsProblems(b.params).map((p) => `params: ${p}`)),
        ...(b.isActive !== undefined && typeof b.isActive !== 'boolean'
          ? ['isActive must be a boolean value']
          : []),
        ...revisionProblems(b.expectedRevision),
      ];
      if (dto.length > 0) return problem(400, 'Validation failed', dto);
      const d = await draftOf(
        request,
        String(params.id),
        Number(params.version),
        b.expectedRevision,
      );
      if (d instanceof Response) return d;
      if (d.v.variants.length >= MAX_VARIANTS)
        return problem(422, `A version has at most ${MAX_VARIANTS} variants.`);
      const isActive = b.isActive === undefined ? true : b.isActive === true;
      const id = newId('var');
      const variant: MockVariant = {
        id,
        isActive,
        params: { ...(b.params as Record<string, ParamValue>) },
        renderedStatement: '',
        overrides: [],
      };
      if (isActive) {
        const rp = renderProblems(d.v, [{ ...variant, id: 'new' }]);
        if (rp.problems.length > 0) return problem(400, 'Validation failed', rp.problems);
        variant.renderedStatement = rp.rendered.get('new') ?? '';
      }
      d.v.variants.push(variant);
      clearValidation(d.v);
      return HttpResponse.json(
        { variant: toVariantDto(variant, d.v.testCases), revision: revisionOf(d.v) },
        { status: 201 },
      );
    }),

    http.get(
      `${base}/:id/versions/:version/variants/:variantId/preview`,
      async ({ request, params }) => {
        const r = await reader(request, String(params.id));
        if (r instanceof Response) return r;
        const v = r.q.versions.find(
          (x) => x.version === Number(params.version) && (r.full || x.isPublished),
        );
        if (!v) return problem(404, NOT_FOUND);
        const x = v.variants.find(
          (y) => y.id === String(params.variantId) && (r.full || y.isActive),
        );
        if (!x) return problem(404, 'Variant not found.');
        const rendered = renderContent(v, x.params);
        if (!rendered.ok) {
          return r.full
            ? problem(422, 'This variant cannot be shown.', rendered.errors)
            : problem(422, 'This variant cannot be shown.');
        }
        const merged = v.testCases.map((t) => {
          const o = x.overrides.find((y) => y.testCaseId === t.id);
          return {
            isHidden: t.isHidden,
            position: t.position,
            input: o ? o.input : t.input,
            expectedOutput: o ? o.expectedOutput : t.expectedOutput,
          };
        });
        const languages = v.allowedLanguages.filter((l) =>
          ['python', 'javascript', 'java'].includes(l),
        );
        // Built field by field, like the real candidate view: no params, hidden cases, reference or key.
        return HttpResponse.json({
          type: r.q.type,
          title: v.title,
          statementMd: rendered.content.statementMd,
          languages,
          limits: { ...v.limits },
          starterCode: Object.fromEntries(
            languages.flatMap((l) =>
              rendered.content.starterCode[l] !== undefined
                ? [[l, rendered.content.starterCode[l]]]
                : [],
            ),
          ),
          samples: merged
            .filter((m) => !m.isHidden)
            .sort((a, c) => a.position - c.position)
            .map((m) => ({ input: m.input, expectedOutput: m.expectedOutput })),
        });
      },
    ),

    http.patch(`${base}/:id/versions/:version/variants/:variantId`, async ({ request, params }) => {
      const gate = allowed(request, 'question:update');
      if (gate instanceof Response) return gate;
      const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const dto = [
        ...unknownFields(b, ['params', 'isActive', 'expectedRevision']),
        ...(b.params === undefined ? [] : paramsProblems(b.params).map((p) => `params: ${p}`)),
        ...(b.isActive !== undefined && typeof b.isActive !== 'boolean'
          ? ['isActive must be a boolean value']
          : []),
        ...revisionProblems(b.expectedRevision),
      ];
      if (dto.length > 0) return problem(400, 'Validation failed', dto);
      if (b.params === undefined && b.isActive === undefined)
        return problem(400, 'Send at least one field to change.');
      const d = await draftOf(
        request,
        String(params.id),
        Number(params.version),
        b.expectedRevision,
      );
      if (d instanceof Response) return d;
      const x = d.v.variants.find((y) => y.id === String(params.variantId));
      if (!x) return problem(404, 'Variant not found.');
      const next: MockVariant = {
        ...x,
        params: b.params === undefined ? x.params : { ...(b.params as Record<string, ParamValue>) },
        isActive: b.isActive === undefined ? x.isActive : b.isActive === true,
      };
      if (next.isActive) {
        const rp = renderProblems(d.v, [next]);
        if (rp.problems.length > 0) return problem(400, 'Validation failed', rp.problems);
        next.renderedStatement = rp.rendered.get(next.id) ?? next.renderedStatement;
      }
      Object.assign(x, next);
      clearValidation(d.v);
      return HttpResponse.json({
        variant: toVariantDto(x, d.v.testCases),
        revision: revisionOf(d.v),
      });
    }),

    http.delete(
      `${base}/:id/versions/:version/variants/:variantId`,
      async ({ request, params }) => {
        const gate = allowed(request, 'question:update');
        if (gate instanceof Response) return gate;
        const expected = new URL(request.url).searchParams.get('expectedRevision') ?? undefined;
        const dto = revisionProblems(expected);
        if (dto.length > 0) return problem(400, 'Validation failed', dto);
        const d = await draftOf(request, String(params.id), Number(params.version), expected);
        if (d instanceof Response) return d;
        if (!d.v.variants.some((y) => y.id === String(params.variantId)))
          return problem(404, 'Variant not found.');
        d.v.variants = d.v.variants.filter((y) => y.id !== String(params.variantId));
        clearValidation(d.v);
        return new HttpResponse(null, { status: 204 });
      },
    ),

    http.put(
      `${base}/:id/versions/:version/variants/:variantId/test-cases/:testCaseId`,
      async ({ request, params }) => {
        const gate = allowed(request, 'question:update');
        if (gate instanceof Response) return gate;
        const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const dto = [
          ...unknownFields(b, ['input', 'expectedOutput', 'expectedRevision']),
          ...(['input', 'expectedOutput'] as const).flatMap((k) => {
            const val = b[k];
            return typeof val === 'string' && val.length <= 100_000
              ? []
              : [`${k} must be a string of at most 100000 characters`];
          }),
          ...revisionProblems(b.expectedRevision),
        ];
        if (dto.length > 0) return problem(400, 'Validation failed', dto);
        const d = await draftOf(
          request,
          String(params.id),
          Number(params.version),
          b.expectedRevision,
        );
        if (d instanceof Response) return d;
        const x = d.v.variants.find((y) => y.id === String(params.variantId));
        if (!x) return problem(404, 'Variant not found.');
        const slot = d.v.testCases.find((t) => t.id === String(params.testCaseId));
        if (!slot) return problem(404, 'Test case not found.');
        const existing = x.overrides.find((o) => o.testCaseId === slot.id);
        if (existing) {
          existing.input = String(b.input);
          existing.expectedOutput = String(b.expectedOutput);
        } else {
          x.overrides.push({
            testCaseId: slot.id,
            input: String(b.input),
            expectedOutput: String(b.expectedOutput),
          });
        }
        clearValidation(d.v);
        // The override only, not a revision (the client reads the revision back).
        return HttpResponse.json({
          testCaseId: slot.id,
          isHidden: slot.isHidden,
          position: slot.position,
          input: String(b.input),
          expectedOutput: String(b.expectedOutput),
        });
      },
    ),

    http.delete(
      `${base}/:id/versions/:version/variants/:variantId/test-cases/:testCaseId`,
      async ({ request, params }) => {
        const gate = allowed(request, 'question:update');
        if (gate instanceof Response) return gate;
        const expected = new URL(request.url).searchParams.get('expectedRevision') ?? undefined;
        const dto = revisionProblems(expected);
        if (dto.length > 0) return problem(400, 'Validation failed', dto);
        const d = await draftOf(request, String(params.id), Number(params.version), expected);
        if (d instanceof Response) return d;
        const x = d.v.variants.find((y) => y.id === String(params.variantId));
        if (!x) return problem(404, 'Variant not found.');
        if (!x.overrides.some((o) => o.testCaseId === String(params.testCaseId)))
          return problem(404, 'Override not found.');
        x.overrides = x.overrides.filter((o) => o.testCaseId !== String(params.testCaseId));
        clearValidation(d.v);
        return new HttpResponse(null, { status: 204 });
      },
    ),

    // ---- WEB-ONLY placeholders: no counterpart in the API yet ---------------------------------
    // Prefill: BE-04b did not add a prefill route (ADR 0007 helper); the UI keeps it as a proposal.
    http.post(`${base}/:id/prefill`, async ({ request, params }) => {
      const r = await writer(request, String(params.id));
      if (r instanceof Response) return r;
      const body = (await request.json()) as Schemas['PrefillRequest'];
      if (body.referenceSolution.trim() === '') {
        return problem(400, 'There is no reference solution for this language.');
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

    // Validate job [BE-04c]: binds to the revision it validated.
    http.post(`${base}/:id/validate`, async ({ request, params }) => {
      const r = await writer(request, String(params.id));
      if (r instanceof Response) return r;
      const jobId = newId('job');
      const v = latest(r.q);
      state.jobs.set(jobId, {
        questionId: r.q.id,
        version: v.version,
        revision: revisionOf(v),
        polls: 0,
        report: runValidation(r.q, v),
      });
      return HttpResponse.json({ jobId, revision: revisionOf(v) }, { status: 202 });
    }),
    http.get(`${base}/:id/validation/:jobId`, async ({ request, params }) => {
      const r = await writer(request, String(params.id));
      if (r instanceof Response) return r;
      const job = state.jobs.get(String(params.jobId));
      if (!job || job.questionId !== r.q.id) return problem(404, NOT_FOUND);
      job.polls += 1;
      if (job.polls < 2) {
        return HttpResponse.json({
          jobId: String(params.jobId),
          revision: job.revision,
          status: job.polls === 1 ? 'queued' : 'running',
        });
      }
      const v = r.q.versions.find((x) => x.version === job.version);
      // Only the still-current content takes the result (an edit after Validate changes the revision).
      if (v && v === latest(r.q) && revisionOf(v) === job.revision && v.validationReport === null) {
        v.validationReport = job.report;
        v.validatedAt = job.report.passed
          ? (job.report.finishedAt ?? new Date().toISOString())
          : null;
      }
      return HttpResponse.json({
        jobId: String(params.jobId),
        revision: job.revision,
        status: 'done',
        report: job.report,
      });
    }),

    // AI reference solutions [BE-04c].
    http.get(`${base}/:id/ai-references`, async ({ request, params }) => {
      const r = await writer(request, String(params.id));
      if (r instanceof Response) return r;
      return HttpResponse.json({ items: structuredClone(r.q.aiRefs), policy: POLICY });
    }),
    http.post(`${base}/:id/ai-references`, async ({ request, params }) => {
      const r = await writer(request, String(params.id));
      if (r instanceof Response) return r;
      const body = (await request.json()) as Schemas['AiReferenceInput'];
      if (!AI_REFERENCE_LANGUAGES.includes(body.language)) {
        return problem(400, 'AI reference solutions exist for Python, JavaScript and Java only.');
      }
      const row: AiReference = {
        ...pickInput(body),
        id: newId('ai-new'),
        collectedByName: actor(r.role),
        supersededAt: null,
      };
      r.q.aiRefs.push(row);
      return HttpResponse.json(row, { status: 201 });
    }),
    http.post(`${base}/:id/ai-references/:refId/supersede`, async ({ request, params }) => {
      const r = await writer(request, String(params.id));
      if (r instanceof Response) return r;
      const old = r.q.aiRefs.find((x) => x.id === String(params.refId));
      if (!old || old.supersededAt !== null) return problem(404, NOT_FOUND);
      const body = (await request.json()) as Schemas['AiReferenceInput'];
      if (!AI_REFERENCE_LANGUAGES.includes(body.language)) {
        return problem(400, 'AI reference solutions exist for Python, JavaScript and Java only.');
      }
      old.supersededAt = new Date().toISOString();
      const row: AiReference = {
        ...pickInput(body),
        id: newId('ai-new'),
        collectedByName: actor(r.role),
        supersededAt: null,
      };
      r.q.aiRefs.push(row);
      return HttpResponse.json(row, { status: 201 });
    }),
  ];
}
