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
  markValidated,
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
  'revision',
];
const ANSWER_KEY_RE = /reference|answer|canonical|variant|correct|validation|aiRef|revision/i;
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
   * A recruiter read of one PUBLISHED question (DL-32 allowlisted DTO, exact key sets): a sample
   * test case has id, position, isHidden, weight, input, expectedOutput; a hidden one has id,
   * position, isHidden, weight ONLY (input and expectedOutput are ABSENT, not null).
   */
  const expectRecruiterDetail = (res: request.Response): void => {
    expectCleanView(res);
    const body = res.body as Json;
    expect(Object.keys(body).sort()).toEqual([...DETAIL_KEYS].sort());
    const v = body.version as Json;
    expect(Object.keys(v).sort()).toEqual([...VERSION_KEYS].sort());
    for (const t of v.testCases as Json[]) {
      const keys = Object.keys(t).sort();
      expect(keys).toEqual(
        t.isHidden === true ? ['id', 'isHidden', 'position', 'weight'] : [...TEST_CASE_KEYS].sort(),
      );
    }
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

  it('TC-100 (FR-202, FR-301, DL-32, DL-34): a recruiter sees samples in full but hidden tests with the input and output keys absent, and no reference solution, answer_spec or validation report', async () => {
    const res = await call(h, 'GET', `/questions/${coding}`, s.recruiter.token);
    expectRecruiterDetail(res);
    const v = versionOf(res.body as Json);
    const cases = v.testCases as { isHidden: boolean; input?: string }[];
    expect(cases).toHaveLength(4);
    expect(cases.filter((x) => x.isHidden)).toHaveLength(2);
    for (const c of cases.filter((x) => x.isHidden)) {
      expect('input' in c).toBe(false); // absent, not null
      expect('expectedOutput' in c).toBe(false);
    }
    for (const c of cases.filter((x) => !x.isHidden))
      expect(c.input).toEqual(expect.stringContaining(SAMPLE_IN));
    // The version selector is covered too (this question has one version; the draft version 2 case is below).
    expectRecruiterDetail(
      await call(h, 'GET', `/questions/${coding}?version=1`, s.recruiter.token),
    );
  });

  it('TC-100 (FR-202, FR-301, DL-32, DL-34): positive control: author and admin do see hidden tests, reference solutions, canonical answers, variants, answer_spec and validationReport (so the scans can fail)', async () => {
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

  it('TC-100 (FR-202, FR-301, DL-32, DL-34): the question list (every role that can read it) carries no test cases, solutions or answers', async () => {
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

  it('TC-100 (FR-202, FR-301, DL-32, DL-34): write responses to a recruiter-level caller never carry data either (403 body) and a draft hidden test stays out of the preview of a published version', async () => {
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

  it('TC-100 (FR-202, FR-301, DL-32, DL-34): a never-published question is a 404 for a recruiter (default and any version), identical to a random id, and absent from their list; author and admin see it', async () => {
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
      expectNoneOf(res, [...HIDDEN_MARKERS, ...ANSWER_MARKERS, 'QA draft only title']);
      expect(JSON.stringify(stableProblem(res))).not.toContain(q); // `instance` echoes the caller's own URL
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

  it('TC-100 (FR-202, FR-301, DL-32, DL-34): the recruiter list shows the published version fields only: a question with published v1 and draft v2 shows v1', async () => {
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

  it('TC-100 (FR-202, FR-301, DL-32, DL-34): unknown versions and other-org callers get a 404 with no question data (FR-202, NFR-04)', async () => {
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

  it('TC-100 (FR-202, FR-301, DL-32, DL-34): a recruiter list, with every filter the endpoint has, pagination, order and totals, never shows, counts or leaks a draft-only question; author and admin see it', async () => {
    const t = Date.now().toString(36);
    const common = `dl34-all-${t}`;
    const draftTag = `dl34-draft-${t}`;
    const draftTitle = `DL34 DRAFT ONLY ${t}`;
    const v2Title = `DL34 MIX V2 DRAFT ${t}`;
    const draftOnly = idOf(
      await createQuestion(
        h,
        s.author,
        codingBody({ title: draftTitle, difficulty: 'HARD', tags: [common, draftTag] }),
      ),
    );
    const pub = idOf(
      await createQuestion(
        h,
        s.author,
        codingBody({ title: `DL34 PUB ${t}`, difficulty: 'MEDIUM', tags: [common] }),
      ),
    );
    await publishQuestion(h, s.author, pub);
    const mix = idOf(
      await createQuestion(
        h,
        s.author,
        codingBody({ title: `DL34 MIX V1 ${t}`, difficulty: 'EASY', tags: [common] }),
      ),
    );
    await publishQuestion(h, s.author, mix);
    await call(h, 'PATCH', `/questions/${mix}`, s.author.token, {
      title: v2Title,
      difficulty: 'HARD',
    }).expect(200);

    const secrets = [draftTitle, draftTag, draftOnly, v2Title];
    type ListBody = {
      items: {
        id: string;
        published: { title: string } | null;
        latest: { title: string; version: number };
      }[];
      total: number;
      page: number;
      pageSize: number;
    };
    const list = async (
      who: { token: string },
      qs: string,
    ): Promise<{ res: request.Response; body: ListBody }> => {
      const res = await call(
        h,
        'GET',
        `/questions?${qs.includes('pageSize') ? '' : 'pageSize=100&'}${qs}`,
        who.token,
      );
      expect([qs, res.status]).toEqual([qs, 200]);
      return { res, body: res.body as ListBody };
    };
    const ids = (b: ListBody): string[] => b.items.map((i) => i.id);

    const filters = [
      `tag=${common}`,
      `tag=${draftTag}`,
      `tag=${common}&difficulty=HARD`,
      `tag=${common}&difficulty=EASY`,
      `tag=${common}&difficulty=MEDIUM`,
      `tag=${common}&type=CODING`,
      `tag=${draftTag}&type=CODING`,
      `tag=${common}&includeArchived=true`,
      `tag=${draftTag}&includeArchived=true`,
    ];
    for (const qs of filters) {
      const { res, body } = await list(s.recruiter, qs);
      expect([qs, ids(body).includes(draftOnly)]).toEqual([qs, false]);
      expectNoneOf(res, secrets);
      // total counts only what is shown: no draft-only question inflates it.
      expect([qs, body.total]).toEqual([qs, body.items.length]);
      // No search or facet fields exist: the body is exactly the page envelope.
      expect(Object.keys(res.body as Json).sort()).toEqual(['items', 'page', 'pageSize', 'total']);
    }
    // Recruiter: draft tag finds nothing; HARD finds nothing (the only HARD versions are drafts).
    expect((await list(s.recruiter, `tag=${draftTag}`)).body.total).toBe(0);
    expect((await list(s.recruiter, `tag=${common}&difficulty=HARD`)).body.total).toBe(0);
    const all = await list(s.recruiter, `tag=${common}`);
    expect(all.body.total).toBe(2);
    expect(ids(all.body)).toEqual([mix, pub]); // newest question first (createdAt desc), no draft-only in between
    const mixItem = all.body.items.find((i) => i.id === mix);
    expect(mixItem?.published?.title).toBe(`DL34 MIX V1 ${t}`);
    expect(mixItem?.latest).toMatchObject({ version: 1, title: `DL34 MIX V1 ${t}` }); // v1 fields, not the draft
    expect(ids((await list(s.recruiter, `tag=${common}&difficulty=EASY`)).body)).toEqual([mix]);
    // Pagination: totals and pages never include the draft-only question.
    const seen: string[] = [];
    for (const page of [1, 2, 3]) {
      const { res, body } = await list(s.recruiter, `tag=${common}&pageSize=1&page=${page}`);
      expect([page, body.total]).toEqual([page, 2]);
      expectNoneOf(res, secrets);
      seen.push(...ids(body));
    }
    expect(seen).toEqual([mix, pub]);
    // A search or status parameter the endpoint does not have must not become a way to find a draft.
    for (const qs of [
      `q=${encodeURIComponent(draftTitle)}`,
      `search=${encodeURIComponent(draftTitle)}`,
      `status=draft&tag=${common}`,
    ]) {
      const res = await call(h, 'GET', `/questions?${qs}`, s.recruiter.token);
      expect([qs, [200, 400].includes(res.status)]).toEqual([qs, true]);
      expectNoneOf(res, secrets);
    }
    // Positive control, same filters: author and admin see the draft-only question and the draft title.
    for (const who of [s.author, s.admin]) {
      const a = await list(who, `tag=${common}`);
      expect(a.body.total).toBe(3);
      expect(ids(a.body)).toEqual([mix, pub, draftOnly]);
      expect(a.body.items.find((i) => i.id === mix)?.latest).toMatchObject({
        version: 2,
        title: v2Title,
      });
      expect(ids((await list(who, `tag=${draftTag}`)).body)).toEqual([draftOnly]);
      expect(ids((await list(who, `tag=${common}&difficulty=HARD`)).body)).toContain(draftOnly);
    }
    // Archiving the draft-only question does not make it visible to a recruiter either.
    await call(h, 'POST', `/questions/${draftOnly}/archive`, s.author.token).expect(200);
    for (const qs of [
      `tag=${draftTag}&includeArchived=true`,
      `tag=${common}&includeArchived=true`,
    ]) {
      const { res, body } = await list(s.recruiter, qs);
      expect(ids(body)).not.toContain(draftOnly);
      expectNoneOf(res, secrets);
    }
  });

  it('TC-100 (FR-202, FR-301, DL-32, DL-34): includeArchived is ignored for a recruiter (archived questions never listed); author and admin do list them', async () => {
    const t = Date.now().toString(36);
    const tag = `arch-${t}`;
    const id = idOf(
      await createQuestion(h, s.author, codingBody({ title: `QA archived ${t}`, tags: [tag] })),
    );
    await publishQuestion(h, s.author, id);
    await call(h, 'POST', `/questions/${id}/archive`, s.author.token).expect(200);
    for (const qs of [`tag=${tag}`, `tag=${tag}&includeArchived=true`]) {
      const rec = await call(h, 'GET', `/questions?${qs}`, s.recruiter.token).expect(200);
      expect((rec.body as { items: unknown[]; total: number }).items).toEqual([]);
      expect((rec.body as { total: number }).total).toBe(0);
    }
    for (const who of [s.author, s.admin]) {
      const a = await call(
        h,
        'GET',
        `/questions?tag=${tag}&includeArchived=true`,
        who.token,
      ).expect(200);
      expect((a.body as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([id]);
      const hidden = await call(h, 'GET', `/questions?tag=${tag}`, who.token).expect(200);
      expect((hidden.body as { total: number }).total).toBe(0);
    }
    // pending hub decision FU-BE-109: today a published ARCHIVED question is still readable by id
    // (200, allowlisted keys only) by a recruiter. Flip these lines if the hub decides on a 404.
    expectRecruiterDetail(await call(h, 'GET', `/questions/${id}`, s.recruiter.token));
    const view = await call(h, 'GET', `/questions/${id}/preview`, s.recruiter.token);
    expectCleanView(view);
    expect(Object.keys(view.body as Json).sort()).toEqual([...CANDIDATE_KEYS].sort());
  });

  it("TC-100 (FR-202, DL-32, DL-34): a recruiter gets the identical 404 for a draft, a missing and another org's id, on detail and preview; list items carry exact keys and no revision", async () => {
    const outsider = await actor(h, UserRole.AUTHOR, orgB);
    const theirs = idOf(await createQuestion(h, outsider, codingBody({ title: 'QA org B only' })));
    await publishQuestion(h, outsider, theirs);
    const draft = idOf(await createQuestion(h, s.author, codingBody({ title: 'QA draft only 2' })));
    const missing = crypto.randomUUID();
    for (const suffix of ['', '/preview']) {
      const bodies: string[] = [];
      for (const id of [draft, missing, theirs]) {
        const res = await call(h, 'GET', `/questions/${id}${suffix}`, s.recruiter.token);
        expect([id, res.status]).toEqual([id, 404]);
        bodies.push(JSON.stringify(stableProblem(res)));
      }
      expect(new Set(bodies).size).toBe(1);
    }
    const list = await call(h, 'GET', '/questions?pageSize=100', s.recruiter.token).expect(200);
    expectNoneOf(list, ['QA org B only', 'QA draft only 2']);
    for (const item of (list.body as { items: Json[] }).items) {
      expect(Object.keys(item).sort()).toEqual([
        'createdAt',
        'id',
        'isArchived',
        'latest',
        'published',
        'slug',
        'tags',
        'type',
      ]);
      expect(Object.keys(item.latest as Json).sort()).toEqual([
        'createdAt',
        'difficulty',
        'id',
        'isPublished',
        'title',
        'validatedAt',
        'version',
      ]);
    }
  });

  it('TC-100 (FR-202, DL-32): a writer gets a 64-hex revision that changes with every edit; a recruiter never gets it', async () => {
    const q = idOf(await createQuestion(h, s.author, codingBody()));
    await publishQuestion(h, s.author, q);
    const rev = async (who: { token: string }, qs = ''): Promise<unknown> =>
      versionOf((await call(h, 'GET', `/questions/${q}${qs}`, who.token).expect(200)).body as Json)
        .revision;
    const r1 = await rev(s.author, '?version=1');
    expect(r1).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(await rev(s.admin, '?version=1')).toBe(r1);
    expect(await rev(s.recruiter)).toBeUndefined();
    const edited = await call(h, 'PATCH', `/questions/${q}`, s.author.token, {
      statementMd: 'new text',
    }).expect(200);
    const r2 = versionOf(edited.body as Json).revision;
    expect(r2).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(r2).not.toBe(r1);
    const again = await call(h, 'PATCH', `/questions/${q}`, s.author.token, {
      statementMd: 'newer text',
    }).expect(200);
    expect(versionOf(again.body as Json).revision).not.toBe(r2);
  });

  it('TC-100 (FR-204, DL-32): expectedRevision on PATCH and publish: current 200, stale 409 with no code, no row change and no audit row', async () => {
    const q = idOf(await createQuestion(h, s.author, codingBody()));
    const state = async (): Promise<string> =>
      JSON.stringify(
        {
          v: await h.owner.questionVersion.findMany({ where: { questionId: q } }),
          t: await h.owner.testCase.findMany({ where: { questionVersion: { questionId: q } } }),
        },
        (_k, x: unknown) => (typeof x === 'bigint' ? String(x) : x),
      );
    const loaded = versionOf((await call(h, 'GET', `/questions/${q}`, s.author.token)).body as Json)
      .revision as string;
    // Another editor saves first: the first loaded revision is now stale.
    await call(h, 'PATCH', `/questions/${q}`, s.admin.token, { statementMd: 'admin edit' }).expect(
      200,
    );
    await markValidated(h, q); // stand-in for the validate job, so only the revision check can refuse
    const before = await state();
    const audits = await h.owner.auditLog.count({ where: { entityId: q } });
    const stale = await call(h, 'PATCH', `/questions/${q}`, s.author.token, {
      title: 'stale edit',
      expectedRevision: loaded,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).not.toHaveProperty('code');
    const stalePublish = await call(h, 'POST', `/questions/${q}/publish`, s.author.token, {
      expectedRevision: loaded,
    });
    expect(stalePublish.status).toBe(409);
    expect(stalePublish.body).not.toHaveProperty('code');
    expect(await state()).toBe(before); // no row changed (the draft stayed a draft)
    expect(await h.owner.auditLog.count({ where: { entityId: q } })).toBe(audits);
    // The current revision is accepted.
    const current = versionOf(
      (await call(h, 'GET', `/questions/${q}`, s.author.token)).body as Json,
    ).revision as string;
    await call(h, 'PATCH', `/questions/${q}`, s.author.token, {
      title: 'fresh edit',
      expectedRevision: current,
    }).expect(200);
    await markValidated(h, q);
    const now = versionOf((await call(h, 'GET', `/questions/${q}`, s.author.token)).body as Json)
      .revision as string;
    await call(h, 'POST', `/questions/${q}/publish`, s.author.token, {
      expectedRevision: now,
    }).expect(200);
  });
});
