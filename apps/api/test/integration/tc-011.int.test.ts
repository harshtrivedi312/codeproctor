// TC-011 (FR-202): hidden tests stay hidden. Expected result: the response has sample cases only;
// hidden inputs and outputs are absent. The candidate-facing question route does not exist yet
// (BE-07, BE-11); what exists is the candidate view endpoint GET /questions/:id/preview (the same
// toCandidateQuestion rendering the candidate route will use) and the recruiter read of GET
// /questions/:id, which must hide answers from a role without question:update. Both are tested here
// at the HTTP level with the response text scanned for every hidden marker, reference solution,
// answer_spec and MCQ key. Real Postgres 16 and Redis, the API running as app_user.
import type request from 'supertest';
import { UserRole } from '../../src/generated/prisma/client';
import { actor, call } from '../support/be03-helpers';
import { boot, Harness } from '../support/harness';
import {
  allKeys,
  codingBody,
  createQuestion,
  expectNoneOf,
  HIDDEN_IN,
  HIDDEN_IN_2,
  HIDDEN_OUT,
  HIDDEN_OUT_2,
  idOf,
  Json,
  mcqBody,
  publishQuestion,
  REF_SECRET,
  SAMPLE_IN,
  SAMPLE_OUT,
  SHORT_CANONICAL,
  SHORT_VARIANT,
  shortAnswerBody,
  staff,
  Staff,
  versionOf,
} from '../support/be04-helpers';

const HIDDEN_MARKERS = [HIDDEN_IN, HIDDEN_OUT, HIDDEN_IN_2, HIDDEN_OUT_2];
const ANSWER_MARKERS = [REF_SECRET, `${REF_SECRET}-js`, SHORT_CANONICAL, SHORT_VARIANT];
const ANSWER_KEYS = [
  'referenceSolution',
  'reference_solution',
  'answerSpec',
  'answer_spec',
  'correctOptionIds',
  'acceptedVariants',
  'canonical',
  'validationReport',
  'aiReference',
];
// The candidate view builds its output from an allowlist (candidate-view.ts); so does this test.
const CANDIDATE_KEYS = [
  'type',
  'title',
  'statementMd',
  'languages',
  'limits',
  'starterCode',
  'samples',
];

describe('TC-011 (FR-202): hidden tests, reference solutions and answer keys are never in a candidate or recruiter view', () => {
  let h: Harness;
  let s: Staff;
  let orgB: string;
  let coding: string;
  let mcq: string;
  let short: string;

  beforeAll(async () => {
    h = await boot();
    s = await staff(h);
    orgB = (await h.owner.organization.create({ data: { name: 'QA Org B tc-011' } })).id;
    coding = idOf(await createQuestion(h, s.author, codingBody()));
    await publishQuestion(h, s.author, coding);
    mcq = idOf(await createQuestion(h, s.author, mcqBody()));
    await publishQuestion(h, s.author, mcq);
    short = idOf(await createQuestion(h, s.author, shortAnswerBody()));
    await publishQuestion(h, s.author, short);
  });
  afterAll(async () => {
    await h?.close();
  });

  const expectCleanView = (res: request.Response): void => {
    expect(res.status).toBe(200);
    expectNoneOf(res, [...HIDDEN_MARKERS, ...ANSWER_MARKERS]);
    const keys = allKeys(res.body);
    for (const k of ANSWER_KEYS) expect([k, keys.includes(k)]).toEqual([k, false]);
  };

  it('TC-011: the candidate view of a coding question has exactly the contracted keys and the sample cases only', async () => {
    for (const who of [s.author, s.recruiter, s.admin]) {
      const res = await call(h, 'GET', `/questions/${coding}/preview`, who.token);
      expectCleanView(res);
      const view = res.body as Json;
      expect(Object.keys(view).sort()).toEqual([...CANDIDATE_KEYS].sort());
      expect(view.samples).toEqual([
        { input: SAMPLE_IN, expectedOutput: SAMPLE_OUT },
        { input: `${SAMPLE_IN}-b`, expectedOutput: `${SAMPLE_OUT}-b` },
      ]);
      expect(view).toMatchObject({
        type: 'CODING',
        title: 'QA two sum',
        languages: ['python', 'javascript'],
      });
      // Samples carry no weight, id, position or flag: only input and expected output.
      for (const sample of view.samples as Json[])
        expect(Object.keys(sample).sort()).toEqual(['expectedOutput', 'input']);
    }
  });

  it('TC-011: a recruiter sees samples in full but hidden tests with null input and output, and no reference solution, answer_spec or validation report', async () => {
    const res = await call(h, 'GET', `/questions/${coding}`, s.recruiter.token);
    expectCleanView(res);
    const v = versionOf(res.body as Json);
    const cases = v.testCases as {
      isHidden: boolean;
      input: string | null;
      expectedOutput: string | null;
    }[];
    expect(cases).toHaveLength(4);
    for (const c of cases.filter((x) => x.isHidden))
      expect([c.input, c.expectedOutput]).toEqual([null, null]);
    for (const c of cases.filter((x) => !x.isHidden))
      expect(c.input).toEqual(expect.stringContaining(SAMPLE_IN));
    // Every version of the history is covered too, not only the latest.
    const v1 = await call(h, 'GET', `/questions/${coding}?version=1`, s.recruiter.token);
    expectCleanView(v1);
  });

  it('TC-011: positive control: the author and admin do see the hidden tests, the reference solution and the answer_spec (so the scans above can fail)', async () => {
    for (const who of [s.author, s.admin]) {
      const res = await call(h, 'GET', `/questions/${coding}`, who.token).expect(200);
      expect(res.text).toContain(HIDDEN_IN);
      expect(res.text).toContain(HIDDEN_OUT_2);
      expect(res.text).toContain(REF_SECRET);
    }
    const m = await call(h, 'GET', `/questions/${mcq}`, s.author.token).expect(200);
    expect(m.text).toContain('correctOptionIds');
  });

  it('TC-011: the question list (every role that can read it) carries no test cases, solutions or answers', async () => {
    for (const who of [s.author, s.recruiter, s.admin]) {
      const res = await call(h, 'GET', '/questions?includeArchived=true&pageSize=100', who.token);
      expectCleanView(res);
      expect(allKeys(res.body)).not.toContain('testCases');
    }
  });

  it('TC-011: an MCQ candidate view shows option ids, texts and the single or multiple flag, never which option is correct', async () => {
    const res = await call(h, 'GET', `/questions/${mcq}/preview`, s.recruiter.token);
    expectCleanView(res);
    const view = res.body as Json;
    expect(view.mcq).toEqual({
      multiple: false,
      options: [
        { id: 'OTHER', text: 'Red' },
        { id: 'QAKEY', text: 'Blue' },
      ],
    });
    expect(view.samples).toEqual([]);
    // The staff read by a recruiter drops the whole answer_spec.
    const detail = await call(h, 'GET', `/questions/${mcq}`, s.recruiter.token);
    expectCleanView(detail);
  });

  it('TC-011: a short-answer candidate view and recruiter view hide the canonical answer and accepted variants', async () => {
    const view = await call(h, 'GET', `/questions/${short}/preview`, s.author.token);
    expectCleanView(view);
    expect(Object.keys(view.body as Json).sort()).toEqual([...CANDIDATE_KEYS].sort());
    expectCleanView(await call(h, 'GET', `/questions/${short}`, s.recruiter.token));
  });

  it('TC-011: a hidden test cannot become visible by accident: a test case added without isHidden is hidden, and flipping the flag moves it in and out of the view', async () => {
    const q = idOf(await createQuestion(h, s.author, codingBody()));
    const added = await call(h, 'POST', `/questions/${q}/versions/1/test-cases`, s.author.token, {
      input: 'QA-DEFAULT-HIDDEN-IN',
      expectedOutput: 'QA-DEFAULT-HIDDEN-OUT',
    }).expect(201);
    expect((added.body as Json).isHidden).toBe(true); // safe default
    const previewText = async (): Promise<request.Response> =>
      call(h, 'GET', `/questions/${q}/preview?version=1`, s.recruiter.token).expect(200);
    expectNoneOf(await previewText(), ['QA-DEFAULT-HIDDEN-IN', 'QA-DEFAULT-HIDDEN-OUT']);
    const tcId = (added.body as Json).id as string;
    await call(h, 'PATCH', `/questions/${q}/versions/1/test-cases/${tcId}`, s.author.token, {
      isHidden: false,
    }).expect(200);
    expect((await previewText()).text).toContain('QA-DEFAULT-HIDDEN-IN'); // now a sample, shown on purpose
    await call(h, 'PATCH', `/questions/${q}/versions/1/test-cases/${tcId}`, s.author.token, {
      isHidden: true,
    }).expect(200);
    expectNoneOf(await previewText(), ['QA-DEFAULT-HIDDEN-IN', 'QA-DEFAULT-HIDDEN-OUT']);
  });

  it('TC-011: write responses to a recruiter-level caller never carry data either (403 body) and a draft hidden test stays out of the preview of a published version', async () => {
    // 403 bodies: no question data.
    for (const [method, path, body] of [
      ['PATCH', `/questions/${coding}`, { title: 'x' }],
      ['POST', `/questions/${coding}/versions/1/test-cases`, { input: 'a', expectedOutput: 'b' }],
      ['POST', `/questions/${coding}/publish`, undefined],
    ] as const) {
      const res = await call(h, method, path, s.recruiter.token, body);
      expect(res.status).toBe(403);
      expectNoneOf(res, [...HIDDEN_MARKERS, ...ANSWER_MARKERS]);
    }
    // A new draft (version 2) with a new hidden test: the default preview is the published version 1.
    const edit = await call(h, 'PATCH', `/questions/${coding}`, s.author.token, {
      title: 'QA two sum v2',
    }).expect(200);
    expect((edit.body as Json).createdNewVersion).toBe(true);
    await call(h, 'POST', `/questions/${coding}/versions/2/test-cases`, s.author.token, {
      input: 'QA-V2-HIDDEN-IN',
      expectedOutput: 'QA-V2-HIDDEN-OUT',
      isHidden: true,
    }).expect(201);
    for (const path of [`/questions/${coding}/preview`, `/questions/${coding}/preview?version=2`]) {
      const res = await call(h, 'GET', path, s.recruiter.token);
      expectCleanView(res);
      expectNoneOf(res, ['QA-V2-HIDDEN-IN', 'QA-V2-HIDDEN-OUT']);
    }
    expectNoneOf(
      await call(h, 'GET', `/questions/${coding}?version=2`, s.recruiter.token).expect(200),
      ['QA-V2-HIDDEN-IN', 'QA-V2-HIDDEN-OUT'],
    );
  });

  it('TC-011: unknown versions and other-org callers get a 404 with no question data (FR-202, NFR-04)', async () => {
    const outsider = await actor(h, UserRole.AUTHOR, orgB);
    for (const path of [`/questions/${coding}`, `/questions/${coding}/preview`]) {
      const res = await call(h, 'GET', path, outsider.token);
      expect(res.status).toBe(404);
      expectNoneOf(res, [...HIDDEN_MARKERS, ...ANSWER_MARKERS, 'QA two sum']);
    }
    for (const path of [
      `/questions/${coding}?version=99`,
      `/questions/${coding}/preview?version=99`,
    ]) {
      const res = await call(h, 'GET', path, s.recruiter.token);
      expect(res.status).toBe(404);
      expectNoneOf(res, [...HIDDEN_MARKERS, ...ANSWER_MARKERS]);
    }
  });
});
