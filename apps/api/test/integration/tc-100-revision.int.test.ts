// TC-100 (FR-202, FR-204, DL-32): every question-bank content write answers the new revision of the
// version, computed in the same transaction (BE-04 follow-up "revision in responses"). Value-level:
// the returned revision is 64 hex, equals what a writer GET returns straight after, moves with each
// content write, is unchanged by a refused write, round-trips as expectedRevision (stale is 409),
// the three DELETE routes answer 200 with exactly {revision}, and a recruiter never sees a revision.
import { UserRole } from '../../src/generated/prisma/client';
import { actor, call } from '../support/be03-helpers';
import { boot, Harness } from '../support/harness';
import {
  codingBody,
  createQuestion,
  expectNoneOf,
  HIDDEN_IN,
  HIDDEN_IN_2,
  HIDDEN_OUT,
  HIDDEN_OUT_2,
  idOf,
  Json,
  publishQuestion,
  REF_SECRET,
  staff,
  Staff,
  versionOf,
} from '../support/be04-helpers';

const HEX64 = /^[0-9a-f]{64}$/;
const SECRETS = [HIDDEN_IN, HIDDEN_OUT, HIDDEN_IN_2, HIDDEN_OUT_2, REF_SECRET, `${REF_SECRET}-js`];
const OV_IN = 'QA-REV-OVERRIDE-IN';
const OV_OUT = 'QA-REV-OVERRIDE-OUT';

const templated = (): Json =>
  codingBody({
    statementMd: 'Sum {{a}} and {{b}}.',
    allowedLanguages: ['python'],
    starterCode: { python: 'A = {{a}}' },
    referenceSolution: { python: 'REF-REV-SECRET {{a}}' },
  });

describe('TC-100 (FR-202, FR-204, DL-32): the revision comes back from every content write', () => {
  let h: Harness;
  let s: Staff;

  beforeAll(async () => {
    h = await boot();
    s = await staff(h);
  });
  afterAll(async () => {
    await h.close();
  });

  const live = async (who: { token: string }, q: string, qs = ''): Promise<string> =>
    versionOf((await call(h, 'GET', `/questions/${q}${qs}`, who.token).expect(200)).body as Json)
      .revision as string;
  const base = (q: string, v = 1): string => `/questions/${q}/versions/${v}`;
  const withRev = (path: string, rev: string): string => `${path}?expectedRevision=${rev}`;

  it('TC-100 (FR-202, DL-32): test case POST, PATCH and DELETE return the revision a writer GET returns next, and it moves each time', async () => {
    for (const who of [s.author, s.admin]) {
      const q = idOf(await createQuestion(h, who, codingBody()));
      const r0 = await live(who, q);
      const added = await call(h, 'POST', `${base(q)}/test-cases`, who.token, {
        input: 'QA-REV-IN',
        expectedOutput: 'QA-REV-OUT',
        isHidden: true,
      }).expect(201);
      const body = added.body as Json;
      expect(Object.keys(body).sort()).toEqual(
        ['expectedOutput', 'id', 'input', 'isHidden', 'position', 'revision', 'weight'].sort(),
      );
      expect(body.revision).toMatch(HEX64);
      expect(body.revision).not.toBe(r0);
      expect(await live(who, q)).toBe(body.revision);
      const tc = body.id as string;

      const patched = await call(h, 'PATCH', `${base(q)}/test-cases/${tc}`, who.token, {
        expectedRevision: body.revision,
        expectedOutput: 'QA-REV-OUT-2',
      }).expect(200); // the POST's revision is accepted as expectedRevision on the next write
      const pb = patched.body as Json;
      expect(Object.keys(pb).sort()).toEqual(Object.keys(body).sort());
      expect(pb.expectedOutput).toBe('QA-REV-OUT-2');
      expect(pb.revision).toMatch(HEX64);
      expect(pb.revision).not.toBe(body.revision);
      expect(await live(who, q)).toBe(pb.revision);

      // The PATCH revision is the one accepted next; the superseded one is a stale 409.
      const stale = await call(
        h,
        'DELETE',
        withRev(`${base(q)}/test-cases/${tc}`, body.revision as string),
        who.token,
      );
      expect(stale.status).toBe(409);
      expect(stale.body).not.toHaveProperty('revision');
      expect(await h.owner.testCase.count({ where: { id: tc } })).toBe(1);
      expect(await live(who, q)).toBe(pb.revision); // refused write: unchanged

      const del = await call(
        h,
        'DELETE',
        withRev(`${base(q)}/test-cases/${tc}`, pb.revision as string),
        who.token,
      );
      expect([del.status, Object.keys(del.body as Json)]).toEqual([200, ['revision']]);
      const dr = (del.body as Json).revision;
      expect(dr).toMatch(HEX64);
      expect(dr).not.toBe(pb.revision);
      expect(dr).toBe(r0); // back to the original content, so the original revision
      expect(await live(who, q)).toBe(dr);
      expect(await h.owner.testCase.count({ where: { id: tc } })).toBe(0);
      expect(JSON.stringify(del.body)).toBe(`{"revision":"${dr as string}"}`);
      expectNoneOf(del, [...SECRETS, 'QA-REV-IN', 'QA-REV-OUT']);
    }
  });

  it('TC-100 (FR-203, FR-204, DL-32): variant override PUT and DELETE, and variant DELETE, return the revision; POST and PATCH of a variant still do; DELETE bodies are exactly {revision}', async () => {
    for (const who of [s.author, s.admin]) {
      const created = await createQuestion(h, who, templated());
      const q = idOf(created);
      const slot = (
        (versionOf(created).testCases as Json[]).find((t) => t.isHidden === true) as Json
      ).id as string;
      const vb = `${base(q)}/variants`;
      const r0 = await live(who, q);

      const v = await call(h, 'POST', vb, who.token, { params: { a: 1, b: 2 } }).expect(201);
      const vBody = v.body as Json;
      expect(Object.keys(vBody).sort()).toEqual(['revision', 'variant']); // unchanged shape
      expect(vBody.revision).toMatch(HEX64);
      expect(vBody.revision).not.toBe(r0);
      expect(await live(who, q)).toBe(vBody.revision);
      const vid = (vBody.variant as Json).id as string;

      const patched = await call(h, 'PATCH', `${vb}/${vid}`, who.token, {
        expectedRevision: vBody.revision,
        params: { a: 5, b: 6 },
      }).expect(200);
      const prev = (patched.body as Json).revision as string;
      expect(Object.keys(patched.body as Json).sort()).toEqual(['revision', 'variant']);
      expect(prev).toMatch(HEX64);
      expect(prev).not.toBe(vBody.revision);
      expect(await live(who, q)).toBe(prev);

      const put = await call(h, 'PUT', `${vb}/${vid}/test-cases/${slot}`, who.token, {
        expectedRevision: prev,
        input: OV_IN,
        expectedOutput: OV_OUT,
      }).expect(200);
      const putBody = put.body as Json;
      expect(Object.keys(putBody).sort()).toEqual(
        ['expectedOutput', 'input', 'isHidden', 'position', 'revision', 'testCaseId'].sort(),
      );
      expect([putBody.input, putBody.expectedOutput, putBody.testCaseId]).toEqual([
        OV_IN,
        OV_OUT,
        slot,
      ]);
      expect(putBody.revision).toMatch(HEX64);
      expect(putBody.revision).not.toBe(prev);
      expect(await live(who, q)).toBe(putBody.revision);

      // Stale revision on the override DELETE: 409, nothing removed, revision unchanged.
      const stale = await call(
        h,
        'DELETE',
        withRev(`${vb}/${vid}/test-cases/${slot}`, prev),
        who.token,
      );
      expect(stale.status).toBe(409);
      expect(await h.owner.variantTestCase.count({ where: { variantId: vid } })).toBe(1);
      expect(await live(who, q)).toBe(putBody.revision);

      const delOv = await call(
        h,
        'DELETE',
        withRev(`${vb}/${vid}/test-cases/${slot}`, putBody.revision as string),
        who.token,
      );
      expect([delOv.status, Object.keys(delOv.body as Json)]).toEqual([200, ['revision']]);
      const r3 = (delOv.body as Json).revision as string;
      expect(r3).toMatch(HEX64);
      expect(r3).not.toBe(putBody.revision);
      expect(await live(who, q)).toBe(r3);
      expect(await h.owner.variantTestCase.count({ where: { variantId: vid } })).toBe(0);
      expectNoneOf(delOv, [...SECRETS, OV_IN, OV_OUT, 'REF-REV-SECRET']);

      // The override DELETE revision is accepted next; then the variant DELETE.
      const stale2 = await call(
        h,
        'DELETE',
        withRev(`${vb}/${vid}`, putBody.revision as string),
        who.token,
      );
      expect(stale2.status).toBe(409);
      expect(await h.owner.questionVariant.count({ where: { id: vid } })).toBe(1);
      const delV = await call(h, 'DELETE', withRev(`${vb}/${vid}`, r3), who.token);
      expect([delV.status, Object.keys(delV.body as Json)]).toEqual([200, ['revision']]);
      const r4 = (delV.body as Json).revision as string;
      expect(r4).toMatch(HEX64);
      expect(r4).not.toBe(r3);
      expect(r4).toBe(r0); // no variant left: the original revision again
      expect(await live(who, q)).toBe(r4);
      expect(await h.owner.questionVariant.count({ where: { id: vid } })).toBe(0);
      expectNoneOf(delV, [...SECRETS, 'REF-REV-SECRET', '"params"', '"renderedStatement"']);
    }
  });

  it('TC-100 (FR-202, FR-204, DL-32): content PATCH returns revision at the top level and in version, both equal to the writer GET; a refused PATCH changes nothing; a fork returns the new version revision', async () => {
    const q = idOf(await createQuestion(h, s.author, codingBody()));
    const r0 = await live(s.author, q);
    const edit = await call(h, 'PATCH', `/questions/${q}`, s.author.token, {
      statementMd: 'QA revision edit',
    }).expect(200);
    const b = edit.body as Json;
    expect(b.revision).toMatch(HEX64);
    expect(versionOf(b).revision).toBe(b.revision); // version.revision == top level
    expect(b.revision).not.toBe(r0);
    expect(await live(s.author, q)).toBe(b.revision);
    expect(await live(s.admin, q)).toBe(b.revision);

    // Round trip, then a stale revision is refused and leaves the revision alone.
    const next = await call(h, 'PATCH', `/questions/${q}`, s.author.token, {
      title: 'QA rev title',
      expectedRevision: b.revision,
    }).expect(200);
    const r2 = (next.body as Json).revision as string;
    expect(r2).not.toBe(b.revision);
    const refused = await call(h, 'PATCH', `/questions/${q}`, s.author.token, {
      title: 'QA stale',
      expectedRevision: b.revision,
    });
    expect(refused.status).toBe(409);
    expect(refused.body).not.toHaveProperty('revision');
    expect(await live(s.author, q)).toBe(r2);
    // A tag-only edit changes no version content (tags are not hashed): the revision is unchanged.
    const tags = await call(h, 'PATCH', `/questions/${q}`, s.author.token, {
      tags: ['qa-rev'],
    }).expect(200);
    expect((tags.body as Json).revision).toBe(r2);
    expect(await live(s.author, q)).toBe(r2);

    // Editing a published question forks the next version: the response revision is the draft's.
    await publishQuestion(h, s.author, q);
    const forked = await call(h, 'PATCH', `/questions/${q}`, s.author.token, {
      statementMd: 'QA forked text',
    }).expect(200);
    const fb = forked.body as Json;
    expect([fb.createdNewVersion, versionOf(fb).version]).toEqual([true, 2]);
    expect(fb.revision).toMatch(HEX64);
    expect(versionOf(fb).revision).toBe(fb.revision);
    expect(await live(s.author, q, '?version=2')).toBe(fb.revision);
    expect(await live(s.author, q, '?version=1')).not.toBe(fb.revision);
  });

  it('TC-100 (FR-202, DL-32): a refused write (RBAC 403, published 409, missing 404) never changes the revision and never returns one', async () => {
    const q = idOf(await createQuestion(h, s.author, codingBody()));
    const r0 = await live(s.author, q);
    const tc = ((await call(h, 'GET', `/questions/${q}`, s.author.token)).body as Json)
      .version as Json;
    const slot = ((tc.testCases as Json[])[0] as Json).id as string;
    const attempts: ['PATCH' | 'POST' | 'DELETE', string, unknown][] = [
      ['PATCH', `/questions/${q}`, { title: 'x' }],
      ['POST', `${base(q)}/test-cases`, { input: 'a', expectedOutput: 'b' }],
      ['PATCH', `${base(q)}/test-cases/${slot}`, { expectedOutput: 'b' }],
      ['DELETE', `${base(q)}/test-cases/${slot}`, undefined],
      ['POST', `${base(q)}/variants`, { params: {} }],
    ];
    for (const who of [s.recruiter, s.reviewer]) {
      for (const [method, path, body] of attempts) {
        const res = await call(h, method, path, who.token, body);
        expect([method, path, res.status]).toEqual([method, path, 403]);
        expect(res.text).not.toMatch(/revision/i);
        expectNoneOf(res, SECRETS);
      }
    }
    expect(await live(s.author, q)).toBe(r0);
    expect(await h.owner.testCase.count({ where: { id: slot } })).toBe(1);
    // Missing test case: 404, no revision in the body, state unchanged.
    const missing = await call(
      h,
      'DELETE',
      withRev(`${base(q)}/test-cases/00000000-0000-4000-8000-000000000000`, r0),
      s.author.token,
    );
    expect(missing.status).toBe(404);
    expect(missing.body).not.toHaveProperty('revision');
    expect(await live(s.author, q)).toBe(r0);
    // A published version refuses test case writes (409) and the revision stays put.
    await publishQuestion(h, s.author, q);
    const r1 = await live(s.author, q, '?version=1');
    const blocked = await call(h, 'DELETE', `${base(q)}/test-cases/${slot}`, s.author.token);
    expect(blocked.status).toBe(409);
    expect(blocked.body).not.toHaveProperty('revision');
    expect(await live(s.author, q, '?version=1')).toBe(r1);
  });

  it('TC-100 (FR-202, DL-32, DL-34): a recruiter never sees a revision: list, detail, preview, version selector and every body they can fetch', async () => {
    const q = idOf(await createQuestion(h, s.author, templated()));
    const created = await call(h, 'GET', `/questions/${q}`, s.author.token).expect(200);
    const slot = (
      (versionOf(created.body as Json).testCases as Json[]).find((t) => t.isHidden === true) as Json
    ).id as string;
    const wr = await call(h, 'POST', `${base(q)}/variants`, s.author.token, {
      params: { a: 1, b: 2 },
    }).expect(201);
    await call(
      h,
      'PUT',
      `${base(q)}/variants/${(wr.body as Json & { variant: Json }).variant.id as string}/test-cases/${slot}`,
      s.author.token,
      {
        input: OV_IN,
        expectedOutput: OV_OUT,
      },
    ).expect(200);
    const edit = await call(h, 'PATCH', `/questions/${q}`, s.author.token, {
      tags: ['qa-rec'],
    }).expect(200);
    const writerRevision = (edit.body as Json).revision as string;
    await publishQuestion(h, s.author, q);
    const published = await live(s.author, q);
    const rec = s.recruiter.token;
    for (const path of [
      '/questions',
      `/questions/${q}`,
      `/questions/${q}?version=1`,
      `/questions/${q}/preview`,
      `/questions/${q}/preview?version=1`,
    ]) {
      const res = await call(h, 'GET', path, rec).expect(200);
      expect([path, res.text.includes('revision')]).toEqual([path, false]);
      expect([path, res.text.includes(writerRevision)]).toEqual([path, false]);
      expect([path, res.text.includes(published)]).toEqual([path, false]);
      expectNoneOf(res, [...SECRETS, OV_IN, OV_OUT]);
    }
    // Positive control: the same GET for a writer does carry it.
    expect(await live(s.author, q)).toMatch(HEX64);
    // The variant list is writer-only (exactly 403 for a recruiter); the variant preview is a
    // candidate-level rendering and carries no revision, override or reference data.
    const variantId = (wr.body as { variant: Json }).variant.id as string;
    const list = await call(h, 'GET', `${base(q)}/variants`, rec);
    expect(list.status).toBe(403);
    expect(list.text).not.toMatch(/revision/i);
    const prev = await call(h, 'GET', `${base(q)}/variants/${variantId}/preview`, rec).expect(200);
    expect(prev.text).toContain('Sum 1 and 2.'); // positive control: the rendered variant
    expect(prev.text).not.toMatch(/revision/i);
    expectNoneOf(prev, [...SECRETS, 'REF-REV-SECRET', writerRevision, published]);
  });

  it('TC-100 (FR-202, NFR-04): another organization gets 404 and no revision on every revision-returning write', async () => {
    const orgB = (await h.owner.organization.create({ data: { name: 'QA Org B tc-100-rev' } })).id;
    const outsider = await actor(h, UserRole.AUTHOR, orgB);
    const q = idOf(await createQuestion(h, s.author, codingBody()));
    const slot = (
      (
        versionOf((await call(h, 'GET', `/questions/${q}`, s.author.token)).body as Json)
          .testCases as Json[]
      )[0] as Json
    ).id as string;
    const vq = await createQuestion(h, s.author, templated());
    const vqId = idOf(vq);
    const vslot = (versionOf(vq).testCases as Json[])[0] as Json;
    const made = await call(h, 'POST', `${base(vqId)}/variants`, s.author.token, {
      params: { a: 1, b: 2 },
    }).expect(201);
    const vid = (made.body as { variant: Json }).variant.id as string;
    await call(
      h,
      'PUT',
      `${base(vqId)}/variants/${vid}/test-cases/${vslot.id as string}`,
      s.author.token,
      {
        input: OV_IN,
        expectedOutput: OV_OUT,
      },
    ).expect(200);
    const r0 = await live(s.author, q);
    const v0 = await live(s.author, vqId);
    const vb = `${base(vqId)}/variants`;
    const sweep: ['PATCH' | 'POST' | 'PUT' | 'DELETE', string, unknown][] = [
      ['PATCH', `/questions/${q}`, { title: 'x' }],
      ['POST', `${base(q)}/test-cases`, { input: 'a', expectedOutput: 'b' }],
      ['DELETE', `${base(q)}/test-cases/${slot}`, undefined],
      ['POST', vb, { params: { a: 3, b: 4 } }],
      ['PUT', `${vb}/${vid}/test-cases/${vslot.id as string}`, { input: 'x', expectedOutput: 'y' }],
      ['DELETE', `${vb}/${vid}/test-cases/${vslot.id as string}`, undefined],
      ['DELETE', `${vb}/${vid}`, undefined],
    ];
    for (const [method, path, body] of sweep) {
      const res = await call(h, method, path, outsider.token, body);
      expect([method, path, res.status]).toEqual([method, path, 404]);
      expect(res.text).not.toMatch(/revision/i);
    }
    expect(await h.owner.questionVariant.count({ where: { id: vid } })).toBe(1);
    expect(await h.owner.variantTestCase.count({ where: { variantId: vid } })).toBe(1);
    expect(await live(s.author, vqId)).toBe(v0);
    expect(await live(s.author, q)).toBe(r0);
  });
});
