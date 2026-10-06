// TC-013 (FR-204): versioning. Editing a published question creates a new version and never changes
// past attempts. Real Postgres 16 and Redis, the API running as app_user. A past session is built
// with the owner role (test, section, invitation, session, session_question that points at version 1
// of the question). No route reads a session's question yet (BE-07, BE-11, BE-13), so "the past
// session still shows the old version" is checked at the data level: the version row the session
// points at, and everything reachable from it, is unchanged after the edit and after the next
// version is published. The session-level screen is not covered.
import { UserRole } from '../../src/generated/prisma/client';
import { actor, call } from '../support/be03-helpers';
import { boot, Harness, stableProblem } from '../support/harness';
import {
  createQuestion,
  HIDDEN_IN,
  idOf,
  Json,
  mcqBody,
  publishQuestion,
  staff,
  Staff,
  versionOf,
} from '../support/be04-helpers';

let n = 0;

/** A session that ran `versionId`: owner-role fixtures only. Returns the session_question id. */
async function pastSession(h: Harness, versionId: string): Promise<{ sessionQuestionId: string }> {
  const t = `${Date.now().toString(36)}${++n}`;
  const test = await h.owner.test.create({
    data: { orgId: h.orgId, name: `QA t13 ${t}`, durationMinutes: 60 },
  });
  const section = await h.owner.testSection.create({
    data: { testId: test.id, title: 'Coding', position: 0 },
  });
  const tq = await h.owner.testQuestion.create({
    data: { sectionId: section.id, questionVersionId: versionId, points: 100, position: 0 },
  });
  const candidate = await h.owner.candidate.create({
    data: { orgId: h.orgId, email: `qa-t13-${t}@example.com`, fullName: 'QA Past Candidate' },
  });
  const invitation = await h.owner.invitation.create({
    data: {
      orgId: h.orgId,
      testId: test.id,
      candidateId: candidate.id,
      tokenHash: `qa-t13-token-hash-${t}`,
      windowStart: new Date(Date.now() - 7_200_000),
      windowEnd: new Date(Date.now() - 3_600_000),
    },
  });
  const session = await h.owner.session.create({
    data: { orgId: h.orgId, invitationId: invitation.id, status: 'SUBMITTED' },
  });
  const sq = await h.owner.sessionQuestion.create({
    data: {
      sessionId: session.id,
      testQuestionId: tq.id,
      questionVersionId: versionId,
      position: 0,
      points: 100,
      finalCode: 'print(1)',
      finalLanguage: 'python',
    },
  });
  return { sessionQuestionId: sq.id };
}

/** Everything a past session can show of a version, read straight from the database. */
async function snapshot(h: Harness, versionId: string): Promise<unknown> {
  const v = await h.owner.questionVersion.findUniqueOrThrow({ where: { id: versionId } });
  const tests = await h.owner.testCase.findMany({
    where: { questionVersionId: versionId },
    orderBy: { position: 'asc' },
  });
  return JSON.parse(
    JSON.stringify({ v, tests }, (_k, x: unknown) => (typeof x === 'bigint' ? String(x) : x)),
  );
}

describe('TC-013 (FR-204): editing a published question creates a new version; past attempts keep the old one', () => {
  let h: Harness;
  let s: Staff;

  beforeAll(async () => {
    h = await boot();
    s = await staff(h);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('TC-013: PATCH on a published question creates version 2 as a draft, copies the tests, and leaves version 1 and the session untouched', async () => {
    const q = await createQuestion(h, s.author);
    const id = idOf(q);
    const published = await publishQuestion(h, s.author, id);
    const v1Id = (published.published as Json).id as string;
    const past = await pastSession(h, v1Id);
    const before = await snapshot(h, v1Id);

    const res = await call(h, 'PATCH', `/questions/${id}`, s.author.token, {
      title: 'QA two sum, edited',
      statementMd: 'A different statement.',
      difficulty: 'HARD',
      limits: { cpuMs: 3000, wallMs: 6000, memoryKb: 65536 },
    });
    expect(res.status).toBe(200);
    const edited = res.body as Json;
    expect(edited.createdNewVersion).toBe(true);
    expect(versionOf(edited)).toMatchObject({
      version: 2,
      isPublished: false,
      title: 'QA two sum, edited',
      statementMd: 'A different statement.',
      difficulty: 'HARD',
      limits: { cpuMs: 3000, wallMs: 6000, memoryKb: 65536 },
    });
    expect((edited.versions as Json[]).map((v) => [v.version, v.isPublished])).toEqual([
      [1, true],
      [2, false],
    ]);
    // Tests still use version 1 (the published one) until version 2 is published.
    expect(edited.published).toMatchObject({ version: 1, isPublished: true, title: 'QA two sum' });

    // Version 1: byte-for-byte what it was (row and test cases), including the published flag.
    expect(await snapshot(h, v1Id)).toEqual(before);
    // The past session still points at version 1 and nothing it reaches changed.
    const sq = await h.owner.sessionQuestion.findUniqueOrThrow({
      where: { id: past.sessionQuestionId },
    });
    expect(sq.questionVersionId).toBe(v1Id);
    const shown = await h.owner.questionVersion.findUniqueOrThrow({
      where: { id: sq.questionVersionId },
    });
    expect([shown.version, shown.title, shown.statementMd, shown.difficulty]).toEqual([
      1,
      'QA two sum',
      '# Two sum\n\nAdd two numbers.',
      'MEDIUM',
    ]);
    expect((await h.owner.question.findUniqueOrThrow({ where: { id } })).currentVersionId).toBe(
      v1Id,
    );

    // Version 2 got its own copies of the four test cases (new rows, same content).
    const v2Row = await h.owner.questionVersion.findFirstOrThrow({
      where: { questionId: id, version: 2 },
    });
    const v1Tests = await h.owner.testCase.findMany({
      where: { questionVersionId: v1Id },
      orderBy: { position: 'asc' },
    });
    const v2Tests = await h.owner.testCase.findMany({
      where: { questionVersionId: v2Row.id },
      orderBy: { position: 'asc' },
    });
    expect(
      v2Tests.map((t) => [t.input, t.expectedOutput, t.isHidden, Number(t.weight), t.position]),
    ).toEqual(
      v1Tests.map((t) => [t.input, t.expectedOutput, t.isHidden, Number(t.weight), t.position]),
    );
    expect(v2Tests.map((t) => t.id).filter((x) => v1Tests.some((t) => t.id === x))).toEqual([]);

    // Exactly one VERSION_CREATED row, no UPDATED row for it, and no content in the metadata.
    const rows = await h.owner.auditLog.findMany({
      where: { entityId: id, action: 'QUESTION_VERSION_CREATED' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toEqual({
      version: 2,
      fromVersion: 1,
      fields: expect.arrayContaining(['title', 'statementMd', 'difficulty', 'limits']) as string[],
    });
    expect(
      await h.owner.auditLog.count({ where: { entityId: id, action: 'QUESTION_UPDATED' } }),
    ).toBe(0);
  });

  it('TC-013: each version is readable by number; the default view and the candidate preview stay on the published version until version 2 is published', async () => {
    const q = await createQuestion(h, s.author);
    const id = idOf(q);
    await publishQuestion(h, s.author, id);
    await call(h, 'PATCH', `/questions/${id}`, s.author.token, { title: 'QA v2 title' }).expect(
      200,
    );

    const old = await call(h, 'GET', `/questions/${id}?version=1`, s.author.token).expect(200);
    expect(versionOf(old.body as Json)).toMatchObject({
      version: 1,
      title: 'QA two sum',
      isPublished: true,
    });
    const draft = await call(h, 'GET', `/questions/${id}?version=2`, s.author.token).expect(200);
    expect(versionOf(draft.body as Json)).toMatchObject({
      version: 2,
      title: 'QA v2 title',
      isPublished: false,
    });
    // Default GET is the latest (the draft); the candidate preview is the published version.
    expect(
      versionOf((await call(h, 'GET', `/questions/${id}`, s.author.token)).body as Json).version,
    ).toBe(2);
    const prev = await call(h, 'GET', `/questions/${id}/preview`, s.recruiter.token).expect(200);
    expect((prev.body as Json).title).toBe('QA two sum');
    // Tests built on this question keep resolving to the published version: the list says so.
    const list = await call(h, 'GET', '/questions?pageSize=100', s.author.token).expect(200);
    const item = (list.body as { items: Json[] }).items.find((i) => i.id === id);
    expect(item).toMatchObject({
      published: { version: 1 },
      latest: { version: 2, isPublished: false },
    });
    // DL-34: a recruiter sees published versions only, so version 1 is also their "latest".
    const recList = await call(h, 'GET', '/questions?pageSize=100', s.recruiter.token).expect(200);
    const recItem = (recList.body as { items: Json[] }).items.find((i) => i.id === id);
    expect(recItem).toMatchObject({
      published: { version: 1 },
      latest: { version: 1, isPublished: true },
    });

    // Publishing version 2 moves "current" forward; version 1 stays published and readable.
    await publishQuestion(h, s.author, id);
    const prev2 = await call(h, 'GET', `/questions/${id}/preview`, s.recruiter.token).expect(200);
    expect((prev2.body as Json).title).toBe('QA v2 title');
    const still = await call(h, 'GET', `/questions/${id}?version=1`, s.author.token).expect(200);
    expect(versionOf(still.body as Json)).toMatchObject({
      version: 1,
      title: 'QA two sum',
      isPublished: true,
    });
  });

  it('TC-013: a past session keeps pointing at version 1 after version 2 is published and a third version is started', async () => {
    const q = await createQuestion(h, s.author);
    const id = idOf(q);
    const v1Id = ((await publishQuestion(h, s.author, id)).published as Json).id as string;
    const past = await pastSession(h, v1Id);
    const before = await snapshot(h, v1Id);
    await call(h, 'PATCH', `/questions/${id}`, s.author.token, { title: 'QA second' }).expect(200);
    await publishQuestion(h, s.author, id);
    await call(h, 'PATCH', `/questions/${id}`, s.author.token, {
      statementMd: 'third statement',
    }).expect(200);
    const versions = await h.owner.questionVersion.findMany({
      where: { questionId: id },
      orderBy: { version: 'asc' },
    });
    expect(versions.map((v) => [v.version, v.isPublished])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
    expect(await snapshot(h, v1Id)).toEqual(before);
    const sq = await h.owner.sessionQuestion.findUniqueOrThrow({
      where: { id: past.sessionQuestionId },
    });
    expect(sq.questionVersionId).toBe(v1Id);
    expect(sq.finalCode).toBe('print(1)');
  });

  it('TC-013: a second edit while the new version is still a draft changes that draft in place (no version 3), and never touches version 1', async () => {
    const q = await createQuestion(h, s.author);
    const id = idOf(q);
    const v1Id = ((await publishQuestion(h, s.author, id)).published as Json).id as string;
    const before = await snapshot(h, v1Id);
    await call(h, 'PATCH', `/questions/${id}`, s.author.token, { title: 'draft one' }).expect(200);
    const again = await call(h, 'PATCH', `/questions/${id}`, s.author.token, {
      title: 'draft two',
    }).expect(200);
    expect((again.body as Json).createdNewVersion).toBe(false);
    expect(versionOf(again.body as Json)).toMatchObject({ version: 2, title: 'draft two' });
    expect(await h.owner.questionVersion.count({ where: { questionId: id } })).toBe(2);
    expect(await snapshot(h, v1Id)).toEqual(before);
    // Tags live on the question, not on a version: changing them creates no version.
    await call(h, 'PATCH', `/questions/${id}`, s.author.token, { tags: ['tag-only'] }).expect(200);
    expect(await h.owner.questionVersion.count({ where: { questionId: id } })).toBe(2);
    const tagRows = (
      await h.owner.auditLog.findMany({ where: { entityId: id, action: 'QUESTION_UPDATED' } })
    ).filter((r) => JSON.stringify(r.metadata) === JSON.stringify({ fields: ['tags'] }));
    expect(tagRows).toHaveLength(1); // QUESTION_UPDATED {fields:['tags']}, no version key
  });

  it('TC-013: archive and unarchive that change nothing write no audit row (200, idempotent)', async () => {
    const id = idOf(await createQuestion(h, s.author));
    const count = (action: string): Promise<number> =>
      h.owner.auditLog.count({ where: { entityId: id, action } });
    await call(h, 'POST', `/questions/${id}/unarchive`, s.author.token).expect(200); // not archived: no-op
    expect(await count('QUESTION_UNARCHIVED')).toBe(0);
    await call(h, 'POST', `/questions/${id}/archive`, s.author.token).expect(200);
    await call(h, 'POST', `/questions/${id}/archive`, s.author.token).expect(200); // already archived: no-op
    expect(await count('QUESTION_ARCHIVED')).toBe(1);
    await call(h, 'POST', `/questions/${id}/unarchive`, s.author.token).expect(200);
    expect(await count('QUESTION_UNARCHIVED')).toBe(1);
  });

  it("TC-008 TC-013: a test case id of another org on the caller's own question is the same 404 as a random test case id, and the other org's row is unchanged", async () => {
    const orgB = (await h.owner.organization.create({ data: { name: 'QA Org B tc-013' } })).id;
    const bAuthor = await actor(h, UserRole.AUTHOR, orgB);
    const own = idOf(await createQuestion(h, bAuthor));
    const foreign = await h.owner.testCase.findFirstOrThrow({
      where: { questionVersion: { question: { orgId: h.orgId } }, isHidden: true },
    });
    const before = JSON.stringify(foreign, (_k, x: unknown) =>
      typeof x === 'bigint' ? String(x) : x,
    );
    const random = crypto.randomUUID();
    const path = (tc: string): string => `/questions/${own}/versions/1/test-cases/${tc}`;
    const norm = (res: Awaited<ReturnType<typeof call>>, tc: string): string =>
      JSON.stringify(stableProblem(res)).split(tc).join('ID');
    const patch = (tc: string) =>
      call(h, 'PATCH', path(tc), bAuthor.token, { expectedOutput: 'x' });
    const del = (tc: string) => call(h, 'DELETE', path(tc), bAuthor.token);
    const [pf, pr, df, dr] = [
      await patch(foreign.id),
      await patch(random),
      await del(foreign.id),
      await del(random),
    ];
    expect([pf.status, pr.status, df.status, dr.status]).toEqual([404, 404, 404, 404]);
    expect(norm(pf, foreign.id)).toBe(norm(pr, random));
    expect(norm(df, foreign.id)).toBe(norm(dr, random));
    const after = await h.owner.testCase.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(JSON.stringify(after, (_k, x: unknown) => (typeof x === 'bigint' ? String(x) : x))).toBe(
      before,
    );
  });

  it('TC-013: a published version is immutable: test case add, change and remove on version 1 are 409 and change nothing', async () => {
    const q = await createQuestion(h, s.author);
    const id = idOf(q);
    const v1Id = ((await publishQuestion(h, s.author, id)).published as Json).id as string;
    const before = await snapshot(h, v1Id);
    const hidden = (
      await h.owner.testCase.findFirstOrThrow({
        where: { questionVersionId: v1Id, input: HIDDEN_IN },
      })
    ).id;
    const auditBefore = await h.owner.auditLog.count({ where: { entityId: id } });
    await call(h, 'POST', `/questions/${id}/versions/1/test-cases`, s.author.token, {
      input: 'a',
      expectedOutput: 'b',
    }).expect(409);
    await call(h, 'PATCH', `/questions/${id}/versions/1/test-cases/${hidden}`, s.author.token, {
      expectedOutput: 'changed',
    }).expect(409);
    await call(
      h,
      'DELETE',
      `/questions/${id}/versions/1/test-cases/${hidden}`,
      s.author.token,
    ).expect(409);
    expect(await snapshot(h, v1Id)).toEqual(before);
    expect(await h.owner.auditLog.count({ where: { entityId: id } })).toBe(auditBefore);
  });

  it('TC-013: publish needs a draft: publishing an already published latest version is 409 and changes nothing', async () => {
    const q = await createQuestion(h, s.author);
    const id = idOf(q);
    const v1Id = ((await publishQuestion(h, s.author, id)).published as Json).id as string;
    const before = await snapshot(h, v1Id);
    await call(h, 'POST', `/questions/${id}/publish`, s.author.token).expect(409);
    expect(await snapshot(h, v1Id)).toEqual(before);
  });

  it('TC-013: two parallel edits of a published question never corrupt the history (no 500, versions numbered 1..n without gaps, version 1 unchanged)', async () => {
    const q = await createQuestion(h, s.author);
    const id = idOf(q);
    const v1Id = ((await publishQuestion(h, s.author, id)).published as Json).id as string;
    const before = await snapshot(h, v1Id);
    const other = await actor(h, UserRole.AUTHOR);
    const results = await Promise.all([
      call(h, 'PATCH', `/questions/${id}`, s.author.token, { title: 'race A' }),
      call(h, 'PATCH', `/questions/${id}`, other.token, { title: 'race B' }),
    ]);
    for (const r of results) expect([200, 409]).toContain(r.status);
    expect(results.some((r) => r.status === 200)).toBe(true);
    const versions = await h.owner.questionVersion.findMany({
      where: { questionId: id },
      orderBy: { version: 'asc' },
    });
    expect(versions.map((v) => v.version)).toEqual(versions.map((_v, i) => i + 1));
    expect(versions.length).toBeLessThanOrEqual(2); // both edits target the one new draft
    expect(await snapshot(h, v1Id)).toEqual(before);
  });

  it('TC-013: archived questions cannot be edited (409) and a recruiter cannot edit (403); version history is unchanged', async () => {
    const q = await createQuestion(h, s.author);
    const id = idOf(q);
    await publishQuestion(h, s.author, id);
    await call(h, 'PATCH', `/questions/${id}`, s.recruiter.token, { title: 'nope' }).expect(403);
    await call(h, 'POST', `/questions/${id}/archive`, s.author.token).expect(200);
    await call(h, 'PATCH', `/questions/${id}`, s.author.token, { title: 'nope' }).expect(409);
    expect(await h.owner.questionVersion.count({ where: { questionId: id } })).toBe(1);
    await call(h, 'POST', `/questions/${id}/unarchive`, s.author.token).expect(200);
    await call(h, 'PATCH', `/questions/${id}`, s.author.token, { title: 'now fine' }).expect(200);
    expect(await h.owner.questionVersion.count({ where: { questionId: id } })).toBe(2);
  });

  it('TC-008 TC-013: a test case id of another question (same org) or another version is 404, not a way to change it; test case routes on an MCQ question are 422', async () => {
    const a = idOf(await createQuestion(h, s.author));
    const b = idOf(await createQuestion(h, s.author));
    const bTest = await h.owner.testCase.findFirstOrThrow({
      where: { questionVersion: { questionId: b }, isHidden: true },
    });
    const bBefore = JSON.stringify(bTest, (_k, x: unknown) =>
      typeof x === 'bigint' ? String(x) : x,
    );
    await call(h, 'PATCH', `/questions/${a}/versions/1/test-cases/${bTest.id}`, s.author.token, {
      expectedOutput: 'x',
    }).expect(404);
    await call(
      h,
      'DELETE',
      `/questions/${a}/versions/1/test-cases/${bTest.id}`,
      s.author.token,
    ).expect(404);
    await call(h, 'PATCH', `/questions/${a}/versions/7/test-cases/${bTest.id}`, s.author.token, {
      expectedOutput: 'x',
    }).expect(404);
    const bAfter = await h.owner.testCase.findUniqueOrThrow({ where: { id: bTest.id } });
    expect(
      JSON.stringify(bAfter, (_k, x: unknown) => (typeof x === 'bigint' ? String(x) : x)),
    ).toBe(bBefore);
    const m = idOf(await createQuestion(h, s.author, mcqBody()));
    await call(h, 'POST', `/questions/${m}/versions/1/test-cases`, s.author.token, {
      input: 'a',
      expectedOutput: 'b',
    }).expect(422);
    expect(await h.owner.testCase.count({ where: { questionVersion: { questionId: m } } })).toBe(0);
  });
});
