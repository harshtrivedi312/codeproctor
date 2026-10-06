// TC-010 (FR-201, FR-202, FR-205): create a question as an author through POST /questions. Expected
// result: a draft version 1 exists with every field the author sent. Real Postgres 16 and Redis, the
// API running as app_user (support/harness.ts). The UI form (FE-04) is not part of this file.
import { boot, Harness } from '../support/harness';
import { actor, call } from '../support/be03-helpers';
import { UserRole } from '../../src/generated/prisma/client';
import {
  codingBody,
  createQuestion,
  HIDDEN_IN,
  HIDDEN_OUT,
  idOf,
  Json,
  mcqBody,
  REF_SECRET,
  SAMPLE_IN,
  SAMPLE_OUT,
  shortAnswerBody,
  staff,
  Staff,
  versionOf,
} from '../support/be04-helpers';

describe('TC-010 (FR-201, FR-202): create a coding question gives a draft version 1', () => {
  let h: Harness;
  let s: Staff;
  let orgB: string;

  beforeAll(async () => {
    h = await boot();
    s = await staff(h);
    orgB = (await h.owner.organization.create({ data: { name: 'QA Org B questions' } })).id;
  });
  afterAll(async () => {
    await h?.close();
  });

  it('TC-010: an author saves a question with every FR-201 field and gets 201 with a draft version 1', async () => {
    const res = await call(h, 'POST', '/questions', s.author.token, codingBody());
    expect(res.status).toBe(201);
    const q = res.body as Json;
    expect(q).toMatchObject({
      type: 'CODING',
      isArchived: false,
      tags: ['arrays', 'math'], // normalized to lower case
      published: null, // nothing published yet: tests cannot use it
      latest: { version: 1, isPublished: false, title: 'QA two sum', difficulty: 'MEDIUM' },
      createdNewVersion: false,
    });
    expect(q.slug).toEqual(expect.stringMatching(/^[a-z0-9]+(-[a-z0-9]+)*$/)); // generated from the title
    const v = versionOf(q);
    expect(v).toMatchObject({
      version: 1,
      isPublished: false,
      title: 'QA two sum',
      statementMd: '# Two sum\n\nAdd two numbers.',
      allowedLanguages: ['python', 'javascript'],
      limits: { cpuMs: 1500, wallMs: 4000, memoryKb: 131072 },
      validatedAt: null,
    });
    expect(v.starterCode).toEqual({
      python: 'def solve(a, b):\n    pass\n',
      javascript: 'function solve(a, b) {}\n',
    });
    // The author may see the reference solution of their own question (FR-201).
    expect(v.referenceSolution).toEqual({ python: REF_SECRET, javascript: `${REF_SECRET}-js` });
    const cases = v.testCases as { isHidden: boolean; weight: number; input: string }[];
    expect(cases.map((c) => [c.isHidden, c.weight])).toEqual([
      [false, 1],
      [false, 1],
      [true, 3],
      [true, 5],
    ]);
  });

  it('TC-010: the database holds one question and exactly one draft version 1 with the saved content, nothing published', async () => {
    const q = await createQuestion(h, s.author);
    const id = idOf(q);
    const row = await h.owner.question.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      orgId: h.orgId,
      createdById: s.author.id,
      type: 'CODING',
      currentVersionId: null, // a draft is not the "current" version
      isArchived: false,
      tags: ['arrays', 'math'],
    });
    const versions = await h.owner.questionVersion.findMany({ where: { questionId: id } });
    expect(versions).toHaveLength(1);
    const v = versions[0];
    expect(v).toMatchObject({
      version: 1,
      isPublished: false,
      validatedAt: null,
      title: 'QA two sum',
      statementMd: '# Two sum\n\nAdd two numbers.',
      starterCode: {
        python: 'def solve(a, b):\n    pass\n',
        javascript: 'function solve(a, b) {}\n',
      },
      difficulty: 'MEDIUM',
      allowedLanguages: ['python', 'javascript'],
      answerSpec: null, // CODING carries no answer_spec
    });
    expect(v?.limits).toEqual({ cpu_ms: 1500, wall_ms: 4000, memory_kb: 131072 });
    expect(v?.referenceSolution).toEqual({ python: REF_SECRET, javascript: `${REF_SECRET}-js` });
    const tests = await h.owner.testCase.findMany({
      where: { questionVersionId: v?.id },
      orderBy: { position: 'asc' },
    });
    expect(
      tests.map((t) => [t.input, t.expectedOutput, t.isHidden, Number(t.weight), t.position]),
    ).toEqual([
      [SAMPLE_IN, SAMPLE_OUT, false, 1, 0],
      [`${SAMPLE_IN}-b`, `${SAMPLE_OUT}-b`, false, 1, 1],
      [HIDDEN_IN, HIDDEN_OUT, true, 3, 2],
      ['QA-HIDDEN-INPUT-8', 'QA-HIDDEN-OUTPUT-8', true, 5, 3],
    ]);
    // Creating a question audits it once, ids and counts only, never content.
    const rows = await h.owner.auditLog.findMany({
      where: { action: 'QUESTION_CREATED', entityId: id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: h.orgId, actorId: s.author.id, entityType: 'question' });
    expect(rows[0]?.metadata).toEqual({ type: 'CODING', version: 1, testCases: 4 });
    const text = JSON.stringify(rows[0], (_k, x: unknown) =>
      typeof x === 'bigint' ? String(x) : x,
    );
    expect(text).not.toContain(REF_SECRET);
    expect(text).not.toContain(HIDDEN_OUT);
  });

  it('TC-010: the defaults are safe: a test case with no isHidden is hidden, default limits apply, tests optional on a draft', async () => {
    const q = await createQuestion(
      h,
      s.admin,
      codingBody({ limits: undefined, testCases: [{ input: 'a', expectedOutput: 'b' }] }),
    );
    const v = versionOf(q);
    expect(v.limits).toEqual({ cpuMs: 2000, wallMs: 5000, memoryKb: 262144 });
    expect((v.testCases as { isHidden: boolean }[])[0]?.isHidden).toBe(true);
    // A bare minimum draft (title, statement, difficulty only) is allowed and stays a draft.
    const bare = await createQuestion(h, s.author, {
      title: 'QA bare',
      statementMd: 'x',
      difficulty: 'HARD',
    });
    expect(versionOf(bare)).toMatchObject({ version: 1, isPublished: false, testCases: [] });
  });

  it('TC-010: the new draft is listed for authors and admins, not for recruiters (published versions only), and not for another org; filters work', async () => {
    const q = await createQuestion(
      h,
      s.author,
      codingBody({ tags: ['qa-list-tag'], difficulty: 'HARD' }),
    );
    const id = idOf(q);
    const filter = '/questions?tag=qa-list-tag&difficulty=HARD&type=CODING';
    for (const who of [s.author, s.admin]) {
      const res = await call(h, 'GET', filter, who.token).expect(200);
      expect((res.body as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([id]);
    }
    // Backend A decision: roles without question:update see published versions only.
    const rec = await call(h, 'GET', filter, s.recruiter.token).expect(200);
    expect((rec.body as { items: unknown[]; total: number }).items).toEqual([]);
    await call(h, 'POST', `/questions/${id}/publish`, s.author.token).expect(200);
    const after = await call(h, 'GET', filter, s.recruiter.token).expect(200);
    expect((after.body as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([id]);
    const none = await call(
      h,
      'GET',
      '/questions?tag=qa-list-tag&difficulty=EASY',
      s.author.token,
    ).expect(200);
    expect((none.body as { items: unknown[] }).items).toEqual([]);
    const other = await actor(h, UserRole.AUTHOR, orgB);
    const theirs = await call(h, 'GET', '/questions?tag=qa-list-tag', other.token).expect(200);
    expect((theirs.body as { total: number }).total).toBe(0);
  });

  it('FR-201, TC-010: a SUPER_ADMIN may create too, and the audit row names that admin as the actor', async () => {
    const q = await createQuestion(h, s.admin, codingBody());
    const rows = await h.owner.auditLog.findMany({
      where: { action: 'QUESTION_CREATED', entityId: idOf(q) },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: s.admin.id, orgId: h.orgId });
    expect((await h.owner.question.findUniqueOrThrow({ where: { id: idOf(q) } })).createdById).toBe(
      s.admin.id,
    );
  });

  it('TC-010: MCQ and short-answer questions are created as draft version 1 as well (FR-205); the key is stored, not echoed in the list', async () => {
    const mcq = await createQuestion(h, s.author, mcqBody());
    const short = await createQuestion(h, s.author, shortAnswerBody());
    for (const q of [mcq, short]) {
      expect(versionOf(q)).toMatchObject({
        version: 1,
        isPublished: false,
        testCases: [],
        allowedLanguages: [],
      });
      expect(q.published).toBeNull();
    }
    const stored = await h.owner.questionVersion.findFirstOrThrow({
      where: { questionId: idOf(mcq) },
    });
    expect(stored.answerSpec).toMatchObject({ correctOptionIds: ['QAKEY'], multiple: false });
    const list = await call(h, 'GET', '/questions?type=MCQ', s.author.token).expect(200);
    expect(list.text).not.toContain('correctOptionIds');
    expect(list.text).not.toContain('answerSpec');
  });

  it('TC-010: invalid input is 400 and creates nothing (no question, no version, no test case, no audit row)', async () => {
    const before = {
      q: await h.owner.question.count({ where: { orgId: h.orgId } }),
      v: await h.owner.questionVersion.count(),
      t: await h.owner.testCase.count(),
      a: await h.owner.auditLog.count({ where: { action: 'QUESTION_CREATED' } }),
    };
    const bad: Json[] = [
      codingBody({ title: '' }),
      codingBody({ title: undefined }),
      codingBody({ statementMd: undefined }),
      codingBody({ difficulty: 'IMPOSSIBLE' }),
      codingBody({ allowedLanguages: ['cobol'] }),
      codingBody({ allowedLanguages: ['python', 'python'] }),
      codingBody({ limits: { cpuMs: 1, wallMs: 5000, memoryKb: 262144 } }), // below the minimum
      codingBody({ limits: { cpuMs: 5000, wallMs: 1000, memoryKb: 262144 } }), // wall below cpu
      codingBody({ starterCode: { ruby: 'x' } }),
      codingBody({ answerSpec: { canonical: 'x', acceptedVariants: [] } }), // not on CODING
      codingBody({ testCases: [{ input: 1, expectedOutput: 'x' }] }),
      codingBody({ testCases: [{ input: 'a', expectedOutput: 'b', weight: 0 }] }),
      codingBody({ unexpectedField: true }),
      codingBody({ slug: 'Not A Slug' }),
      { ...mcqBody(), testCases: [{ input: 'a', expectedOutput: 'b' }] },
      mcqBody({
        answerSpec: { options: [{ id: 'a', text: 'x' }], correctOptionIds: ['a'], multiple: false },
      }),
    ];
    for (const body of bad) {
      const res = await call(h, 'POST', '/questions', s.author.token, body);
      expect([JSON.stringify(body).slice(0, 80), res.status]).toEqual([
        JSON.stringify(body).slice(0, 80),
        400,
      ]);
    }
    expect({
      q: await h.owner.question.count({ where: { orgId: h.orgId } }),
      v: await h.owner.questionVersion.count(),
      t: await h.owner.testCase.count(),
      a: await h.owner.auditLog.count({ where: { action: 'QUESTION_CREATED' } }),
    }).toEqual(before);
  });

  it('TC-010: a taken slug is 409 in the same org and leaves no partial question; the same slug is free in another org', async () => {
    const slug = `qa-slug-${Date.now()}`;
    await createQuestion(h, s.author, codingBody({ slug }));
    const countBefore = await h.owner.questionVersion.count();
    await call(h, 'POST', '/questions', s.author.token, codingBody({ slug })).expect(409);
    expect(await h.owner.questionVersion.count()).toBe(countBefore);
    const other = await actor(h, UserRole.AUTHOR, orgB);
    await call(h, 'POST', '/questions', other.token, codingBody({ slug })).expect(201);
  });

  it('TC-010: a recruiter and a reviewer cannot create (403) and nothing is written (FR-103)', async () => {
    const count = await h.owner.question.count();
    await call(h, 'POST', '/questions', s.recruiter.token, codingBody()).expect(403);
    await call(h, 'POST', '/questions', s.reviewer.token, codingBody()).expect(403);
    expect(await h.owner.question.count()).toBe(count);
  });

  it('TC-010: a draft with missing pieces cannot be published (422 with the list) and stays a draft; a complete one publishes as version 1', async () => {
    const incomplete = await createQuestion(
      h,
      s.author,
      codingBody({
        referenceSolution: {},
        testCases: [{ input: 'a', expectedOutput: 'b', isHidden: false }],
      }),
    );
    const res = await call(
      h,
      'POST',
      `/questions/${idOf(incomplete)}/publish`,
      s.author.token,
    ).expect(422);
    expect((res.body as { errors: string[] }).errors).toEqual(
      expect.arrayContaining([
        'referenceSolution: at least one language',
        'testCases: at least one hidden test',
      ]),
    );
    const still = await h.owner.questionVersion.findFirstOrThrow({
      where: { questionId: idOf(incomplete) },
    });
    expect(still.isPublished).toBe(false);
    const good = await createQuestion(h, s.author);
    const pub = await call(h, 'POST', `/questions/${idOf(good)}/publish`, s.author.token).expect(
      200,
    );
    expect(pub.body).toMatchObject({ published: { version: 1, isPublished: true } });
  });
});
