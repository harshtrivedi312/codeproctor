// TC-020 (FR-301): random pick rule. PART 1 ONLY, the CONFIGURATION half: a test with 2 random MEDIUM
// questions tagged arrays is saved, the rule is validated, and it is accepted only when the pool of
// PUBLISHED, non-archived questions of the caller's own organization can satisfy it.
//
// NOT covered here (needs BE-07 start flow and BE-11 sessions): "start 10 sessions; each session gets
// 2 matching questions; distribution varies". There is no start route yet, so the todo below is the
// honest record. Matrix status: Partial.
//
// Real Postgres 16 and Redis, the API running as app_user. Each scenario has its own organization so
// the pool is exactly what the test seeds.
import { UserRole } from '../../src/generated/prisma/client';
import { actor, call } from '../support/be03-helpers';
import {
  builderCounts,
  createTest,
  fixedQ,
  getTest,
  HIDDEN_IN,
  Json,
  newOrg,
  normalized,
  Org,
  patchTest,
  poolQuestion,
  postTest,
  randomQ,
  REF_SECRET,
  section,
  testBody06,
} from '../support/be06-helpers';
import { boot, Harness } from '../support/harness';

const RULE = { tags: ['arrays'], difficulty: 'MEDIUM' };
const twoRandom = (rule: Json = RULE): Json[] => [section([randomQ(rule), randomQ(rule)])];

describe('TC-020 (FR-301) part 1: random pick rule configuration', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await boot();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('TC-020: 2 random MEDIUM questions tagged arrays are accepted when the pool has 3, and the rule is saved exactly', async () => {
    const org = await newOrg(h);
    const pool = [];
    for (let i = 0; i < 3; i++) pool.push(await poolQuestion(h, org.id));
    const body = await createTest(h, org.recruiter, testBody06(twoRandom(), { passScore: 100 }));
    const sections = body.sections as Json[];
    const questions = (sections[0] as Json).questions as Json[];
    expect(questions).toHaveLength(2);
    for (const q of questions) {
      expect(q.randomRule).toEqual({ tags: ['arrays'], difficulty: 'MEDIUM' });
      expect(q.questionVersionId).toBeNull();
      expect([q.title, q.difficulty]).toEqual([null, null]); // nothing is picked at save time
    }
    // The stored rows: no fixed version, rule in test_questions.random_rule.
    const rows = await h.owner.testQuestion.findMany({
      where: { section: { testId: body.id as string } },
      orderBy: { position: 'asc' },
    });
    expect(rows.map((r) => r.questionVersionId)).toEqual([null, null]);
    expect(rows.map((r) => r.randomRule)).toEqual([RULE, RULE]);
    expect(rows.map((r) => r.position)).toEqual([1, 2]);
    // GET returns the same rule.
    const got = await getTest(h, org.recruiter, body.id as string);
    expect(got.status).toBe(200);
    expect(got.body).toEqual(body);
    // The saved test does not reveal which questions are in the pool (no picking before start).
    const text = JSON.stringify(got.body);
    for (const p of pool) {
      expect(text).not.toContain(p.id);
      expect(text).not.toContain(p.versionId);
      expect(text).not.toContain(p.title);
    }
    expect(text).not.toContain(REF_SECRET);
  });

  it('TC-020: exactly as many matching questions as slots is accepted; one fewer is 422 and writes no test, section or audit row', async () => {
    const org = await newOrg(h);
    await poolQuestion(h, org.id);
    const before = await builderCounts(h, org.id);
    const short = await postTest(h, org.recruiter, testBody06(twoRandom()));
    expect(short.status).toBe(422);
    expect(JSON.stringify(short.body)).toMatch(/randomRule/);
    expect(await builderCounts(h, org.id)).toEqual(before);

    await poolQuestion(h, org.id);
    const ok = await postTest(h, org.recruiter, testBody06(twoRandom()));
    expect(ok.status).toBe(201);
    expect((await builderCounts(h, org.id)).tests).toBe(before.tests + 1);
  });

  it('TC-020: a test never picks one question twice, so 3 slots with one rule need 3 different questions', async () => {
    const org = await newOrg(h);
    await poolQuestion(h, org.id);
    await poolQuestion(h, org.id);
    const three = [section([randomQ(RULE), randomQ(RULE), randomQ(RULE)])];
    expect((await postTest(h, org.recruiter, testBody06(three))).status).toBe(422);
    // The same total over two sections is counted together.
    const split = [section([randomQ(RULE), randomQ(RULE)]), section([randomQ(RULE)])];
    expect((await postTest(h, org.recruiter, testBody06(split))).status).toBe(422);
    await poolQuestion(h, org.id);
    expect((await postTest(h, org.recruiter, testBody06(three))).status).toBe(201);
  });

  it('TC-020: only PUBLISHED, non-archived questions of the caller org count (draft-only, archived and other-org questions do not)', async () => {
    const org = await newOrg(h);
    const other = await newOrg(h);
    await poolQuestion(h, org.id); // 1 usable
    await poolQuestion(h, org.id, { published: false }); // draft only
    await poolQuestion(h, org.id, { archived: true }); // published but archived
    await poolQuestion(h, other.id); // another org, published
    await poolQuestion(h, other.id);
    await poolQuestion(h, other.id);
    const before = await builderCounts(h, org.id);
    const two = await postTest(h, org.recruiter, testBody06(twoRandom()));
    expect(two.status).toBe(422);
    expect(await builderCounts(h, org.id)).toEqual(before);
    // A single slot is satisfiable by the one usable question only.
    const one = await postTest(h, org.recruiter, testBody06([section([randomQ(RULE)])]));
    expect(one.status).toBe(201);
    // The message names the number of matches it counted (1), never a question.
    expect(JSON.stringify(two.body)).toMatch(/matches 1 published question/);
  });

  it('TC-020: the rule matches on the CURRENT published version (a draft version 2 does not change the match) and on question tags, difficulty and type', async () => {
    const org = await newOrg(h);
    const easy = await poolQuestion(h, org.id, { difficulty: 'EASY' });
    await poolQuestion(h, org.id, { difficulty: 'HARD' });
    await poolQuestion(h, org.id, { tags: ['graphs'] });
    await poolQuestion(h, org.id, { tags: ['arrays', 'graphs'], difficulty: 'MEDIUM' });
    await poolQuestion(h, org.id, { type: 'MCQ', tags: ['arrays'], difficulty: 'MEDIUM' });
    // A draft version 2 (MEDIUM) on the EASY, arrays-tagged question changes nothing: the published
    // version (EASY) counts. If the draft counted, the rule below would match 3 questions, not 2.
    await h.owner.questionVersion.create({
      data: {
        questionId: easy.id,
        version: 2,
        title: 'draft v2',
        statementMd: 'x',
        difficulty: 'MEDIUM',
        allowedLanguages: ['python'],
        isPublished: false,
      },
    });
    const one = (rule: Json): Promise<number> =>
      postTest(h, org.recruiter, testBody06([section([randomQ(rule)])])).then((r) => r.status);
    const two = (rule: Json): Promise<number> =>
      postTest(h, org.recruiter, testBody06([section([randomQ(rule), randomQ(rule)])])).then(
        (r) => r.status,
      );
    const three = (rule: Json): Promise<number> =>
      postTest(
        h,
        org.recruiter,
        testBody06([section([randomQ(rule), randomQ(rule), randomQ(rule)])]),
      ).then((r) => r.status);
    expect(await two({ difficulty: 'EASY' })).toBe(422); // only 1 EASY (v2 draft is MEDIUM, ignored)
    expect(await one({ difficulty: 'EASY' })).toBe(201);
    expect(await two({ tags: ['arrays'], difficulty: 'MEDIUM' })).toBe(201); // arrays+graphs and MCQ
    expect(await three({ tags: ['arrays'], difficulty: 'MEDIUM' })).toBe(422); // 201 if draft v2 counted
    expect(await two({ tags: ['arrays', 'graphs'] })).toBe(422); // all tags must match: 1 question
    expect(await one({ tags: ['arrays', 'graphs'] })).toBe(201);
    expect(await two({ tags: ['arrays'], type: 'MCQ' })).toBe(422);
    expect(await one({ tags: ['arrays'], type: 'MCQ' })).toBe(201);
    expect(await one({ tags: ['nope'] })).toBe(422);
    expect(await one({ type: 'SHORT_ANSWER' })).toBe(422);
  });

  it('TC-020: tags in the rule are matched case-insensitively and saved in lower case', async () => {
    const org = await newOrg(h);
    await poolQuestion(h, org.id);
    const res = await postTest(
      h,
      org.recruiter,
      testBody06([section([randomQ({ tags: ['ArRaYs'], difficulty: 'MEDIUM' })])]),
    );
    expect(res.status).toBe(201);
    const q = (((res.body as Json).sections as Json[])[0] as Json).questions as Json[];
    expect((q[0] as Json).randomRule).toEqual(RULE);
  });

  it.each([
    ['an unknown key (count)', { tags: ['arrays'], count: 2 }],
    ['an unknown key (random)', { random: true }],
    ['an empty tag list', { tags: [] }],
    ['a tag that is not a string', { tags: [7] }],
    ['a tag with a bad character', { tags: ['ar;rays'] }],
    ['duplicate tags', { tags: ['arrays', 'Arrays'] }],
    ['21 tags', { tags: Array.from({ length: 21 }, (_v, i) => `t${i}`) }],
    ['a difficulty that does not exist', { difficulty: 'IMPOSSIBLE' }],
    ['a lower-case difficulty', { difficulty: 'medium' }],
    ['a type that does not exist', { type: 'ESSAY' }],
    ['a rule that is an array', ['arrays']],
    ['a rule that is a string', 'arrays'],
    ['a rule that is null', null],
  ])('TC-020: a random rule with %s is 400 and nothing is saved', async (_label, rule) => {
    const org = await newOrg(h);
    await poolQuestion(h, org.id);
    const before = await builderCounts(h, org.id);
    const res = await postTest(
      h,
      org.recruiter,
      testBody06([section([{ randomRule: rule, points: 100 }])]),
    );
    expect(res.status).toBe(400);
    expect(await builderCounts(h, org.id)).toEqual(before);
  });

  it('TC-020: a slot with both a fixed version and a random rule, or with neither, is 400', async () => {
    const org = await newOrg(h);
    const q = await poolQuestion(h, org.id);
    for (const slot of [
      { questionVersionId: q.versionId, randomRule: RULE, points: 100 },
      { points: 100 },
    ]) {
      expect((await postTest(h, org.recruiter, testBody06([section([slot])]))).status).toBe(400);
    }
  });

  it('TC-020: PATCH with a rule the pool cannot satisfy is 422 and leaves the test, its sections and the audit trail unchanged; a satisfiable rule replaces the sections', async () => {
    const org = await newOrg(h);
    const a = await poolQuestion(h, org.id);
    await poolQuestion(h, org.id);
    const created = await createTest(
      h,
      org.recruiter,
      testBody06([section([fixedQ(a.versionId)])], { name: 'QA T06 patch rule' }),
    );
    const id = created.id as string;
    const before = await builderCounts(h, org.id);
    const bad = await patchTest(h, org.recruiter, id, {
      name: 'QA T06 renamed in a failed patch',
      sections: twoRandom({ tags: ['arrays'], difficulty: 'HARD' }),
    });
    expect(bad.status).toBe(422);
    expect(await builderCounts(h, org.id)).toEqual(before);
    const still = await getTest(h, org.recruiter, id);
    expect(still.body).toEqual(created); // name too: the failed patch rolled back as a whole

    const good = await patchTest(h, org.recruiter, id, { sections: twoRandom() });
    expect(good.status).toBe(200);
    const qs = (((good.body as Json).sections as Json[])[0] as Json).questions as Json[];
    expect(qs.map((q) => q.randomRule)).toEqual([RULE, RULE]);
    expect(qs.map((q) => q.questionVersionId)).toEqual([null, null]);
  });

  it('TC-020 TC-008: a rule that only another organization could satisfy is 422 for this org, with a body that names no other-org data', async () => {
    const org = await newOrg(h);
    const other = await newOrg(h);
    const theirs = [await poolQuestion(h, other.id), await poolQuestion(h, other.id)];
    const res = await postTest(h, org.recruiter, testBody06(twoRandom()));
    expect(res.status).toBe(422);
    const text = JSON.stringify(res.body);
    for (const q of theirs) {
      expect(text).not.toContain(q.id);
      expect(text).not.toContain(q.versionId);
    }
    expect(text).not.toContain(other.id);
    expect(text).not.toContain(HIDDEN_IN);
  });

  it('TC-020 TC-004: only a recruiter or super admin can save a random rule (author and reviewer 403, nothing saved)', async () => {
    const org = await newOrg(h);
    await poolQuestion(h, org.id);
    await poolQuestion(h, org.id);
    const author = await actor(h, UserRole.AUTHOR, org.id);
    const reviewer = await actor(h, UserRole.REVIEWER, org.id);
    const before = await builderCounts(h, org.id);
    for (const who of [author, reviewer]) {
      expect((await postTest(h, who, testBody06(twoRandom()))).status).toBe(403);
    }
    expect((await call(h, 'POST', '/tests', org.admin.token, testBody06(twoRandom()))).status).toBe(
      201,
    );
    expect((await builderCounts(h, org.id)).tests).toBe(before.tests + 1);
  });

  it('TC-020: the rule checks the same pool in a list-then-create flow: the draft of another recruiter-visible question is not counted (published-only matches what the recruiter can read)', async () => {
    const org: Org = await newOrg(h);
    const draft = await poolQuestion(h, org.id, { published: false });
    const list = await call(h, 'GET', '/questions?page=1&pageSize=50', org.recruiter.token);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(draft.id); // the recruiter cannot see it ...
    const res = await postTest(h, org.recruiter, testBody06([section([randomQ(RULE)])]));
    expect(res.status).toBe(422); // ... and a rule cannot use it
    expect(normalized(res, [])).not.toContain(draft.id);
  });

  it.todo(
    'TC-020: start 10 sessions of a test with 2 random MEDIUM arrays questions; each session gets 2 matching questions and the distribution varies (needs BE-07 start flow and BE-11 sessions)',
  );
});
