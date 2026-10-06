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
import { boot, Harness, stableProblem } from '../support/harness';
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
  MCQ_KEY_ID,
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
const ANSWER_KEY_RE = /reference|answer|canonical|variant|correct|validation|aiRef/i;
const DETAIL_KEYS = [
  'id',
  'slug',
  'type',
  'tags',
  'isArchived',
  'createdAt',
  'published',
  'latest',
  'versions',
  'version',
  'createdNewVersion',
];
const VERSION_KEYS = [
  'id',
  'version',
  'isPublished',
  'title',
  'difficulty',
  'validatedAt',
  'createdAt',
  'statementMd',
  'allowedLanguages',
  'limits',
  'starterCode',
  'testCases',
];
const TEST_CASE_KEYS = ['id', 'position', 'isHidden', 'weight', 'input', 'expectedOutput'];
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
  let mcqMulti: string;

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
    mcqMulti = idOf(
      await createQuestion(
        h,
        s.author,
        mcqBody({
          title: 'QA multi',
          answerSpec: {
            options: [
              { id: 'MA', text: 'One' },
              { id: 'MB', text: 'Two' },
              { id: 'MC', text: 'Three' },
            ],
            correctOptionIds: ['MA', 'MC'],
            multiple: true,
          },
        }),
      ),
    );
    await publishQuestion(h, s.author, mcqMulti);
  });
  afterAll(async () => {
    await h?.close();
  });

  const expectCleanView = (res: request.Response): void => {
    expect(res.status).toBe(200);
    expectNoneOf(res, [...HIDDEN_MARKERS, ...ANSWER_MARKERS]);
    const keys = allKeys(res.body);
    for (const k of ANSWER_KEYS) expect([k, keys.includes(k)]).toEqual([k, false]);
    // Any key that smells like an answer is a leak, whatever its exact name.
    expect(keys.filter((k) => ANSWER_KEY_RE.test(k))).toEqual([]);
  };

  /**
   * A recruiter read of one PUBLISHED question: only allowlisted keys, so a new field must be
   * reviewed. The allowlist is ASSUMED from the current DTO (DL-32's allowlisted DTO is not on
   * backend/step-4 @23b3caf); replace it with the DL-32 list when that lands.
   */
  const expectRecruiterDetail = (res: request.Response): void => {
    expectCleanView(res);
    const body = res.body as Json;
    expect(Object.keys(body).sort()).toEqual([...DETAIL_KEYS].sort());
    const v = body.version as Json;
    expect(Object.keys(v).sort()).toEqual([...VERSION_KEYS].sort());
    for (const t of v.testCases as Json[])
      expect(Object.keys(t).sort()).toEqual([...TEST_CASE_KEYS].sort());
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
    expectRecruiterDetail(res);
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
    // The version selector is covered too (this question has one version; the draft version 2 case is below).
    expectRecruiterDetail(
      await call(h, 'GET', `/questions/${coding}?version=1`, s.recruiter.token),
    );
  });

  it('TC-011: positive control: author and admin do see hidden tests, reference solutions, canonical answers, variants, answer_spec and validationReport (so the scans can fail)', async () => {
    for (const who of [s.author, s.admin]) {
      const res = await call(h, 'GET', `/questions/${coding}`, who.token).expect(200);
      expect(res.text).toContain(HIDDEN_IN);
      expect(res.text).toContain(HIDDEN_OUT_2);
      expect(res.text).toContain(REF_SECRET);
      expect(allKeys(res.body)).toEqual(
        expect.arrayContaining(['referenceSolution', 'validationReport']),
      );
      const m = await call(h, 'GET', `/questions/${mcq}`, who.token).expect(200);
      expect(m.text).toContain('correctOptionIds');
      expect(allKeys(m.body)).toContain('answerSpec');
      const sh = await call(h, 'GET', `/questions/${short}`, who.token).expect(200);
      expect(sh.text).toContain(SHORT_CANONICAL);
      expect(sh.text).toContain(SHORT_VARIANT);
      expect(allKeys(sh.body)).toEqual(
        expect.arrayContaining(['answerSpec', 'canonical', 'acceptedVariants']),
      );
    }
  });

  it('TC-011: the question list (every role that can read it) carries no test cases, solutions or answers', async () => {
    for (const who of [s.author, s.recruiter, s.admin]) {
      const res = await call(h, 'GET', '/questions?includeArchived=true&pageSize=100', who.token);
      expectCleanView(res);
      expect(allKeys(res.body)).not.toContain('testCases');
    }
  });

  it('TC-011: an MCQ candidate view (single and multiple choice) has exactly the contracted keys, option ids and texts and the multiple flag, never which option is correct', async () => {
    const res = await call(h, 'GET', `/questions/${mcq}/preview`, s.recruiter.token);
    expectCleanView(res);
    const view = res.body as Json;
    expect(Object.keys(view).sort()).toEqual([...CANDIDATE_KEYS, 'mcq'].sort());
    expect(view.mcq).toEqual({
      multiple: false,
      options: [
        { id: 'OTHER', text: 'Red' },
        { id: MCQ_KEY_ID, text: 'Blue' },
      ],
    });
    expect(view.samples).toEqual([]);
    // Two correct options: the view shows the flag and all options, with no marker on any of them.
    const multi = await call(h, 'GET', `/questions/${mcqMulti}/preview`, s.recruiter.token);
    expectCleanView(multi);
    const mv = multi.body as Json;
    expect(Object.keys(mv).sort()).toEqual([...CANDIDATE_KEYS, 'mcq'].sort());
    expect(mv.mcq).toEqual({
      multiple: true,
      options: [
        { id: 'MA', text: 'One' },
        { id: 'MB', text: 'Two' },
        { id: 'MC', text: 'Three' },
      ],
    });
    // The staff read by a recruiter drops the whole answer_spec.
    expectRecruiterDetail(await call(h, 'GET', `/questions/${mcq}`, s.recruiter.token));
    expectRecruiterDetail(await call(h, 'GET', `/questions/${mcqMulti}`, s.recruiter.token));
  });

  it('TC-011: a short-answer candidate view and recruiter view hide the canonical answer and accepted variants', async () => {
    const view = await call(h, 'GET', `/questions/${short}/preview`, s.author.token);
    expectCleanView(view);
    expect(Object.keys(view.body as Json).sort()).toEqual([...CANDIDATE_KEYS].sort());
    expectRecruiterDetail(await call(h, 'GET', `/questions/${short}`, s.recruiter.token));
  });

  it('TC-011: a hidden test cannot become visible by accident: a test case added without isHidden is hidden, and flipping the flag moves it in and out of the view', async () => {
    const q = idOf(await createQuestion(h, s.author, codingBody()));
    const added = await call(h, 'POST', `/questions/${q}/versions/1/test-cases`, s.author.token, {
      input: 'QA-DEFAULT-HIDDEN-IN',
      expectedOutput: 'QA-DEFAULT-HIDDEN-OUT',
    }).expect(201);
    expect((added.body as Json).isHidden).toBe(true); // safe default
    const previewText = async (): Promise<request.Response> =>
      call(h, 'GET', `/questions/${q}/preview?version=1`, s.author.token).expect(200);
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
    const v2Markers = ['QA-V2-HIDDEN-IN', 'QA-V2-HIDDEN-OUT', 'QA two sum v2'];
    // Default preview: the latest published version (1), candidate-shaped with exact top-level keys.
    const def = await call(h, 'GET', `/questions/${coding}/preview`, s.recruiter.token);
    expectCleanView(def);
    expectNoneOf(def, v2Markers);
    expect(Object.keys(def.body as Json).sort()).toEqual([...CANDIDATE_KEYS].sort());
    expect(def.body).toMatchObject({ title: 'QA two sum' });
    // Backend A: a recruiter's draft preview is the IDENTICAL 404 as a missing version or random id.
    const randomPreview = await call(
      h,
      'GET',
      `/questions/${crypto.randomUUID()}/preview`,
      s.recruiter.token,
    );
    const draftPreview = await call(
      h,
      'GET',
      `/questions/${coding}/preview?version=2`,
      s.recruiter.token,
    );
    const missingPreview = await call(
      h,
      'GET',
      `/questions/${coding}/preview?version=99`,
      s.recruiter.token,
    );
    expect([draftPreview.status, missingPreview.status, randomPreview.status]).toEqual([
      404, 404, 404,
    ]);
    expect(stableProblem(draftPreview)).toEqual(stableProblem(missingPreview));
    expect(stableProblem(draftPreview)).toEqual(stableProblem(randomPreview));
    expectNoneOf(draftPreview, [...v2Markers, ...HIDDEN_MARKERS, ...ANSWER_MARKERS]);
    // Positive control: author and admin DO get the draft preview (a candidate-shaped view, no hidden test).
    for (const who of [s.author, s.admin]) {
      const d = await call(h, 'GET', `/questions/${coding}/preview?version=2`, who.token);
      expect(d.status).toBe(200);
      expect(d.body).toMatchObject({ title: 'QA two sum v2' });
      expect(Object.keys(d.body as Json).sort()).toEqual([...CANDIDATE_KEYS].sort());
      expectNoneOf(d, ['QA-V2-HIDDEN-IN', 'QA-V2-HIDDEN-OUT', ...HIDDEN_MARKERS]);
    }
    // DL-34: a role without question:update reads published versions only. A draft is a 404, the
    // same body as a version that does not exist (not 403: a draft must not be revealed).
    const draft = await call(h, 'GET', `/questions/${coding}?version=2`, s.recruiter.token);
    const missing = await call(h, 'GET', `/questions/${coding}?version=99`, s.recruiter.token);
    expect([draft.status, missing.status]).toEqual([404, 404]);
    expect(stableProblem(draft)).toEqual(stableProblem(missing));
    expectNoneOf(draft, v2Markers);
    // The recruiter's default version is the latest PUBLISHED one (version 1), not the draft.
    const rec = await call(h, 'GET', `/questions/${coding}`, s.recruiter.token);
    expectRecruiterDetail(rec);
    expect(versionOf(rec.body as Json)).toMatchObject({
      version: 1,
      isPublished: true,
      title: 'QA two sum',
    });
    expectNoneOf(rec, v2Markers);
    // Positive control: authors and admins DO see the draft and its hidden test.
    for (const who of [s.author, s.admin]) {
      const d = await call(h, 'GET', `/questions/${coding}?version=2`, who.token).expect(200);
      expect(d.text).toContain('QA-V2-HIDDEN-IN');
      expect(versionOf(d.body as Json)).toMatchObject({ version: 2, isPublished: false });
    }
  });

  it('TC-011 TC-008: a never-published question is a 404 for a recruiter (default and any version), identical to a random id, and absent from their list; author and admin see it', async () => {
    const q = idOf(await createQuestion(h, s.author, codingBody({ title: 'QA draft only title' })));
    const random = await call(h, 'GET', `/questions/${crypto.randomUUID()}`, s.recruiter.token);
    expect(random.status).toBe(404);
    for (const path of [
      `/questions/${q}`,
      `/questions/${q}?version=1`,
      `/questions/${q}/preview`,
      `/questions/${q}/preview?version=1`,
    ]) {
      const res = await call(h, 'GET', path, s.recruiter.token);
      expect([path, res.status]).toEqual([path, 404]);
      expect(stableProblem(res)).toEqual(stableProblem(random));
      expectNoneOf(res, [...HIDDEN_MARKERS, ...ANSWER_MARKERS, 'QA draft only title', q]);
    }
    const list = await call(
      h,
      'GET',
      '/questions?pageSize=100&includeArchived=true',
      s.recruiter.token,
    ).expect(200);
    expectNoneOf(list, [q, 'QA draft only title']);
    for (const who of [s.author, s.admin]) {
      await call(h, 'GET', `/questions/${q}`, who.token).expect(200);
      const l = await call(h, 'GET', '/questions?pageSize=100', who.token).expect(200);
      expect((l.body as { items: { id: string }[] }).items.map((i) => i.id)).toContain(q);
    }
  });

  it('TC-011: the recruiter list shows the published version fields only: a question with published v1 and draft v2 shows v1', async () => {
    const q = idOf(await createQuestion(h, s.author, codingBody({ title: 'QA list v1 title' })));
    await publishQuestion(h, s.author, q);
    await call(h, 'PATCH', `/questions/${q}`, s.author.token, {
      title: 'QA list v2 secret draft title',
    }).expect(200);
    const rec = await call(h, 'GET', '/questions?pageSize=100', s.recruiter.token).expect(200);
    const item = (rec.body as { items: Json[] }).items.find((i) => i.id === q);
    expect(item).toMatchObject({
      published: { version: 1, title: 'QA list v1 title' },
      latest: { version: 1, title: 'QA list v1 title' },
    });
    expect(Object.keys(item as Json).sort()).toEqual([
      'createdAt',
      'id',
      'isArchived',
      'latest',
      'published',
      'slug',
      'tags',
      'type',
    ]);
    expectNoneOf(rec, ['QA list v2 secret draft title']);
    const author = await call(h, 'GET', '/questions?pageSize=100', s.author.token).expect(200);
    const mine = (author.body as { items: Json[] }).items.find((i) => i.id === q);
    expect(mine).toMatchObject({
      published: { version: 1 },
      latest: { version: 2, isPublished: false },
    });
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
