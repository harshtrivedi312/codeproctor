// FR-301 test builder: organization scoping (TC-008), version pinning (TC-013, FR-204), which questions
// a recruiter may attach (published, non-archived, own org; TC-100 redaction half) and the shape of
// the refusals. TC-004 and TC-006 for the four routes are table-driven in tc-004-rbac.int.test.ts and
// tc-006-audit.int.test.ts. Real Postgres 16 and Redis, the API running as app_user.
import { Actor, actor, call } from '../support/be03-helpers';
import { UserRole } from '../../src/generated/prisma/client';
import {
  codingBody,
  createQuestion,
  HIDDEN_IN,
  HIDDEN_OUT,
  idOf,
  publishQuestion,
  REF_SECRET,
} from '../support/be04-helpers';
import {
  addInvitation,
  builderCounts,
  createTest,
  fixedQ,
  getTest,
  Json,
  newOrg,
  normalized,
  patchTest,
  poolQuestion,
  postTest,
  section,
  testBody06,
} from '../support/be06-helpers';
import { boot, Harness, stableProblem } from '../support/harness';

describe('FR-301: test builder scoping, pinning and attachable questions', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await boot({ env: { THROTTLE_DEFAULT_LIMIT: '100000' } });
  });
  afterAll(async () => {
    await h?.close();
  });

  describe('TC-008: organization scoping of tests', () => {
    it('TC-008 FR-301: a recruiter of org B never sees org A tests: not in the list, not in the total, not by search, not by id', async () => {
      const a = await newOrg(h);
      const b = await newOrg(h);
      const qa = await poolQuestion(h, a.id);
      const qb = await poolQuestion(h, b.id);
      const ta = await createTest(
        h,
        a.recruiter,
        testBody06([section([fixedQ(qa.versionId)])], { name: 'QA-ORG-A-ONLY-TEST' }),
      );
      const tb = await createTest(
        h,
        b.recruiter,
        testBody06([section([fixedQ(qb.versionId)])], { name: 'QA-ORG-B-OWN-TEST' }),
      );
      const list = (await call(h, 'GET', '/tests?pageSize=100', b.recruiter.token)).body as Json;
      expect((list.items as Json[]).map((i) => i.id)).toEqual([tb.id]);
      expect(list.total).toBe(1);
      expect(JSON.stringify(list)).not.toMatch(/QA-ORG-A-ONLY-TEST/);
      for (const qs of ['search=QA-ORG-A', 'used=false', 'profile=STANDARD']) {
        const r = (await call(h, 'GET', `/tests?${qs}`, b.recruiter.token)).body as Json;
        expect((r.items as Json[]).map((i) => i.id)).not.toContain(ta.id);
      }
      const search = (await call(h, 'GET', '/tests?search=QA-ORG-A', b.recruiter.token))
        .body as Json;
      expect([search.total, (search.items as Json[]).length]).toEqual([0, 0]);
      // By id: the same 404 as an id that does not exist.
      const cross = await getTest(h, b.recruiter, ta.id as string);
      const missing = await getTest(h, b.recruiter, '00000000-0000-4000-8000-0000000000cc');
      expect([cross.status, missing.status]).toEqual([404, 404]);
      expect(normalized(cross, [ta.id as string])).toBe(
        normalized(missing, ['00000000-0000-4000-8000-0000000000cc']),
      );
      // A super admin of org B is held to the same scope.
      expect((await getTest(h, b.admin, ta.id as string)).status).toBe(404);
      expect((await patchTest(h, b.admin, ta.id as string, { name: 'x' })).status).toBe(404);
      expect((await h.owner.test.findUniqueOrThrow({ where: { id: ta.id as string } })).name).toBe(
        'QA-ORG-A-ONLY-TEST',
      );
    });

    it('TC-008 FR-301: a test created by org B belongs to org B whatever the caller sends, and org A cannot read it', async () => {
      const a = await newOrg(h);
      const b = await newOrg(h);
      const qb = await poolQuestion(h, b.id);
      const tb = await createTest(h, b.recruiter, testBody06([section([fixedQ(qb.versionId)])]));
      expect((await h.owner.test.findUniqueOrThrow({ where: { id: tb.id as string } })).orgId).toBe(
        b.id,
      );
      expect((await getTest(h, a.recruiter, tb.id as string)).status).toBe(404);
    });

    it('TC-008 FR-301: a fixed question version of another org is the same 404 as a version that does not exist, on create and on PATCH, and nothing is written', async () => {
      const a = await newOrg(h);
      const b = await newOrg(h);
      const theirs = await poolQuestion(h, a.id);
      const mine = await poolQuestion(h, b.id);
      const mineTest = await createTest(
        h,
        b.recruiter,
        testBody06([section([fixedQ(mine.versionId)])]),
      );
      const before = await builderCounts(h, b.id);
      const ghost = '00000000-0000-4000-8000-0000000000dd';
      const crossC = await postTest(
        h,
        b.recruiter,
        testBody06([section([fixedQ(theirs.versionId)])]),
      );
      const missC = await postTest(h, b.recruiter, testBody06([section([fixedQ(ghost)])]));
      expect([crossC.status, missC.status]).toEqual([404, 404]);
      expect(normalized(crossC, [theirs.versionId])).toBe(normalized(missC, [ghost]));
      const crossP = await patchTest(h, b.recruiter, mineTest.id as string, {
        sections: [section([fixedQ(theirs.versionId)])],
      });
      const missP = await patchTest(h, b.recruiter, mineTest.id as string, {
        sections: [section([fixedQ(ghost)])],
      });
      expect([crossP.status, missP.status]).toEqual([404, 404]);
      expect(normalized(crossP, [theirs.versionId])).toBe(normalized(missP, [ghost]));
      for (const res of [crossC, crossP]) {
        const text = JSON.stringify(res.body);
        expect(text).not.toContain(theirs.versionId);
        expect(text).not.toContain(theirs.id);
        expect(text).not.toContain(theirs.title);
        expect(text).not.toContain(a.id);
      }
      expect(await builderCounts(h, b.id)).toEqual(before);
      expect((await getTest(h, b.recruiter, mineTest.id as string)).body).toEqual(mineTest);
    });

    it('TC-008 FR-301: one foreign version among valid ones refuses the whole request (404), nothing is half saved', async () => {
      const a = await newOrg(h);
      const b = await newOrg(h);
      const theirs = await poolQuestion(h, a.id);
      const mine = await poolQuestion(h, b.id);
      const before = await builderCounts(h, b.id);
      const res = await postTest(
        h,
        b.recruiter,
        testBody06([section([fixedQ(mine.versionId), fixedQ(theirs.versionId)])]),
      );
      expect(res.status).toBe(404);
      expect(await builderCounts(h, b.id)).toEqual(before);
    });

    it('TC-008: a cross-org attempt (404) writes no audit row and no row of any kind for the attacker org', async () => {
      const a = await newOrg(h);
      const b = await newOrg(h);
      const ta = await createTest(
        h,
        a.recruiter,
        testBody06([section([fixedQ((await poolQuestion(h, a.id)).versionId)])]),
      );
      const auditsBefore = await h.owner.auditLog.count();
      expect((await patchTest(h, b.recruiter, ta.id as string, { name: 'hijack' })).status).toBe(
        404,
      );
      expect((await getTest(h, b.recruiter, ta.id as string)).status).toBe(404);
      expect(await h.owner.auditLog.count()).toBe(auditsBefore);
    });
  });

  describe('which questions a recruiter can attach (published, not archived, own org)', () => {
    const GHOST = '00000000-0000-4000-8000-0000000000ee';

    it('FR-301 TC-100 (DL-34): a draft version is the same 404 as a missing version (no existence oracle), a published but ARCHIVED question is 422, a published one is 201; nothing is saved on refusal', async () => {
      const org = await newOrg(h);
      const draft = await poolQuestion(h, org.id, { published: false });
      const archived = await poolQuestion(h, org.id, { archived: true });
      const ok = await poolQuestion(h, org.id);
      const before = await builderCounts(h, org.id);
      const missing = await postTest(h, org.recruiter, testBody06([section([fixedQ(GHOST)])]));
      expect(missing.status).toBe(404);
      const asDraft = await postTest(
        h,
        org.recruiter,
        testBody06([section([fixedQ(draft.versionId)])]),
      );
      expect(asDraft.status).toBe(404);
      expect(normalized(asDraft, [draft.versionId])).toBe(normalized(missing, [GHOST]));
      expect(JSON.stringify(asDraft.body)).not.toContain(draft.title);
      const asArchived = await postTest(
        h,
        org.recruiter,
        testBody06([section([fixedQ(archived.versionId)])]),
      );
      expect(asArchived.status).toBe(422);
      expect(JSON.stringify(asArchived.body)).not.toContain(archived.title);
      // A good question next to a draft still refuses the whole test, with the missing-id 404.
      const mixed = await postTest(
        h,
        org.recruiter,
        testBody06([section([fixedQ(ok.versionId), fixedQ(draft.versionId)])]),
      );
      expect(mixed.status).toBe(404);
      expect(normalized(mixed, [draft.versionId])).toBe(normalized(missing, [GHOST]));
      expect(await builderCounts(h, org.id)).toEqual(before);
      expect(
        (await postTest(h, org.recruiter, testBody06([section([fixedQ(ok.versionId)])]))).status,
      ).toBe(201);
    });

    it('FR-301 TC-100 (DL-34): PATCH with a draft version is the missing-id 404, with an archived question 422; the old sections are kept', async () => {
      const org = await newOrg(h);
      const ok = await poolQuestion(h, org.id);
      const draft = await poolQuestion(h, org.id, { published: false });
      const archived = await poolQuestion(h, org.id, { archived: true });
      const t = await createTest(h, org.recruiter, testBody06([section([fixedQ(ok.versionId)])]));
      const before = await builderCounts(h, org.id);
      const patch = (versionId: string) =>
        patchTest(h, org.recruiter, t.id as string, { sections: [section([fixedQ(versionId)])] });
      const missing = await patch(GHOST);
      const asDraft = await patch(draft.versionId);
      expect([missing.status, asDraft.status]).toEqual([404, 404]);
      expect(normalized(asDraft, [draft.versionId])).toBe(normalized(missing, [GHOST]));
      expect((await patch(archived.versionId)).status).toBe(422);
      expect(await builderCounts(h, org.id)).toEqual(before);
      expect((await getTest(h, org.recruiter, t.id as string)).body).toEqual(t);
    });

    it('FR-301 TC-100 (DL-34): the recruiter finds attachable versions through the API itself: the published version id from GET /questions/:id builds a test; a draft-only question is invisible (404) and its version id is the same 404 as a missing id', async () => {
      const org = await newOrg(h);
      const author = await actor(h, UserRole.AUTHOR, org.id);
      const published = idOf(
        await createQuestion(h, author, codingBody({ title: 'QA attachable' })),
      );
      await publishQuestion(h, author, published);
      const draftOnly = await createQuestion(h, author, codingBody({ title: 'QA draft only' }));
      const read = await call(h, 'GET', `/questions/${published}`, org.recruiter.token);
      expect(read.status).toBe(200);
      const versionId = ((read.body as Json).published as Json).id as string;
      expect(versionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(
        (await call(h, 'GET', `/questions/${idOf(draftOnly)}`, org.recruiter.token)).status,
      ).toBe(404);

      const t = await createTest(h, org.recruiter, testBody06([section([fixedQ(versionId)])]));
      const q = (((t.sections as Json[])[0] as Json).questions as Json[])[0] as Json;
      expect([q.questionVersionId, q.title, q.difficulty]).toEqual([
        versionId,
        'QA attachable',
        'MEDIUM',
      ]);

      const draftVersion = (draftOnly.version as Json).id as string;
      const asDraft = await postTest(
        h,
        org.recruiter,
        testBody06([section([fixedQ(draftVersion)])]),
      );
      const missing = await postTest(h, org.recruiter, testBody06([section([fixedQ(GHOST)])]));
      expect([asDraft.status, missing.status]).toEqual([404, 404]);
      expect(normalized(asDraft, [draftVersion])).toBe(normalized(missing, [GHOST]));
    });

    it('FR-301 TC-100: a test answer never contains answer keys, hidden test data or reference solutions of the attached questions', async () => {
      const org = await newOrg(h);
      const author = await actor(h, UserRole.AUTHOR, org.id);
      const qid = idOf(await createQuestion(h, author, codingBody()));
      await publishQuestion(h, author, qid);
      const versionId = (
        ((await call(h, 'GET', `/questions/${qid}`, org.recruiter.token)).body as Json)
          .published as Json
      ).id as string;
      const created = await postTest(h, org.recruiter, testBody06([section([fixedQ(versionId)])]));
      const got = await getTest(h, org.recruiter, (created.body as Json).id as string);
      const list = await call(h, 'GET', '/tests', org.recruiter.token);
      for (const res of [created, got, list]) {
        const text = res.text;
        for (const needle of [
          REF_SECRET,
          HIDDEN_IN,
          HIDDEN_OUT,
          'SAMPLE-IN-1',
          'referenceSolution',
          'testCases',
        ]) {
          expect([needle, text.includes(needle)]).toEqual([needle, false]);
        }
      }
    });
  });

  describe('TC-013 (FR-204, FR-301): a test points at the exact version it was built with', () => {
    it('TC-013: editing a published question afterwards creates a new version; the test still points at version 1 with the old title, before and after version 2 is published', async () => {
      const org = await newOrg(h);
      const author = await actor(h, UserRole.AUTHOR, org.id);
      const qid = idOf(await createQuestion(h, author, codingBody({ title: 'QA pin v1' })));
      await publishQuestion(h, author, qid);
      const v1 = (
        ((await call(h, 'GET', `/questions/${qid}`, org.recruiter.token)).body as Json)
          .published as Json
      ).id as string;
      const t = await createTest(h, org.recruiter, testBody06([section([fixedQ(v1)])]));
      const pinned = (x: Json): Json =>
        (((x.sections as Json[])[0] as Json).questions as Json[])[0] as Json;
      expect(pinned(t)).toMatchObject({ questionVersionId: v1, title: 'QA pin v1' });

      const edit = await call(h, 'PATCH', `/questions/${qid}`, author.token, {
        title: 'QA pin v2 title',
      });
      expect(edit.status).toBe(200);
      expect(await h.owner.questionVersion.count({ where: { questionId: qid } })).toBe(2);
      const afterEdit = (await getTest(h, org.recruiter, t.id as string)).body as Json;
      expect(pinned(afterEdit)).toMatchObject({ questionVersionId: v1, title: 'QA pin v1' });

      await publishQuestion(h, author, qid);
      const afterPublish = (await getTest(h, org.recruiter, t.id as string)).body as Json;
      expect(pinned(afterPublish)).toMatchObject({ questionVersionId: v1, title: 'QA pin v1' });
      expect(afterPublish).toEqual(afterEdit);
      const row = await h.owner.testQuestion.findFirstOrThrow({
        where: { section: { testId: t.id as string } },
      });
      expect(row.questionVersionId).toBe(v1);

      // Renaming the test does not re-pin the question to the new version.
      const renamed = await patchTest(h, org.recruiter, t.id as string, { name: 'QA pin renamed' });
      expect(pinned(renamed.body as Json)).toMatchObject({
        questionVersionId: v1,
        title: 'QA pin v1',
      });
    });

    it('TC-013: a newly published version 2 is a different id; a test built now pins version 2 and the older test keeps version 1', async () => {
      const org = await newOrg(h);
      const author = await actor(h, UserRole.AUTHOR, org.id);
      const qid = idOf(await createQuestion(h, author, codingBody({ title: 'QA pin A' })));
      await publishQuestion(h, author, qid);
      const read = async (): Promise<string> =>
        (
          ((await call(h, 'GET', `/questions/${qid}`, org.recruiter.token)).body as Json)
            .published as Json
        ).id as string;
      const v1 = await read();
      const t1 = await createTest(h, org.recruiter, testBody06([section([fixedQ(v1)])]));
      await call(h, 'PATCH', `/questions/${qid}`, author.token, { title: 'QA pin B' }).expect(200);
      await publishQuestion(h, author, qid);
      const v2 = await read();
      expect(v2).not.toBe(v1);
      const t2 = await createTest(h, org.recruiter, testBody06([section([fixedQ(v2)])]));
      const first = (x: Json): Json =>
        (((x.sections as Json[])[0] as Json).questions as Json[])[0] as Json;
      expect(first(t1)).toMatchObject({ questionVersionId: v1, title: 'QA pin A' });
      expect(first(t2)).toMatchObject({ questionVersionId: v2, title: 'QA pin B' });
      expect(first((await getTest(h, org.recruiter, t1.id as string)).body as Json).title).toBe(
        'QA pin A',
      );
    });

    it('TC-013: archiving the question later does not change a saved test; the test stays readable with its pinned version', async () => {
      const org = await newOrg(h);
      const q = await poolQuestion(h, org.id, { title: 'QA archive later' });
      const t = await createTest(h, org.recruiter, testBody06([section([fixedQ(q.versionId)])]));
      await h.owner.question.update({ where: { id: q.id }, data: { isArchived: true } });
      const got = await getTest(h, org.recruiter, t.id as string);
      expect(got.status).toBe(200);
      expect(got.body).toEqual(t);
    });
  });

  describe('role and token handling on the shape of refusals', () => {
    it('FR-301: author and reviewer get 403 on every /tests route (list, read, create, patch) with a body that leaks nothing', async () => {
      const org = await newOrg(h);
      const q = await poolQuestion(h, org.id);
      const t = await createTest(
        h,
        org.recruiter,
        testBody06([section([fixedQ(q.versionId)])], { name: 'QA-403-LEAK-CHECK' }),
      );
      const who: Actor[] = [
        await actor(h, UserRole.AUTHOR, org.id),
        await actor(h, UserRole.REVIEWER, org.id),
      ];
      for (const a of who) {
        const calls = [
          call(h, 'GET', '/tests', a.token),
          call(h, 'GET', `/tests/${t.id as string}`, a.token),
          call(h, 'POST', '/tests', a.token, testBody06([section([fixedQ(q.versionId)])])),
          call(h, 'PATCH', `/tests/${t.id as string}`, a.token, { name: 'x' }),
        ];
        for (const res of await Promise.all(calls)) {
          expect(res.status).toBe(403);
          expect(res.text).not.toContain('QA-403-LEAK-CHECK');
          // `instance` echoes the caller's own URL; the rest of the body must not name the test.
          expect(JSON.stringify(stableProblem(res))).not.toContain(t.id as string);
        }
      }
    });

    it("FR-301: an invitation on org A's test does not make org B's list show it as used or change counts", async () => {
      const a = await newOrg(h);
      const b = await newOrg(h);
      const q = await poolQuestion(h, a.id);
      const t = await createTest(h, a.recruiter, testBody06([section([fixedQ(q.versionId)])]));
      await addInvitation(h, a.id, t.id as string);
      const list = (await call(h, 'GET', '/tests?used=true', b.recruiter.token)).body as Json;
      expect(list.total).toBe(0);
    });
  });
});
