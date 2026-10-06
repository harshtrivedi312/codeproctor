// Helpers for the BE-06 test builder acceptance tests (TC-020 part 1, FR-301, FR-302). Calls go
// through the real HTTP API as signed-in staff; question pools and sessions are owner-role fixtures.
// Each scenario uses its own organization so random-rule pools are exactly what the test creates.
import type request from 'supertest';
import { UserRole } from '../../src/generated/prisma/client';
import { Actor, actor, call } from './be03-helpers';
import { REF_SECRET, HIDDEN_IN, HIDDEN_OUT } from './be03-routes';
import { Harness, stableProblem } from './harness';

export { REF_SECRET, HIDDEN_IN, HIDDEN_OUT };
export type Json = Record<string, unknown>;

let n = 0;
const uniq = (): string => `${Date.now().toString(36)}${++n}`;

/** A new organization with a recruiter and a super admin. */
export interface Org {
  id: string;
  recruiter: Actor;
  admin: Actor;
}
export async function newOrg(h: Harness): Promise<Org> {
  const id = (await h.owner.organization.create({ data: { name: `QA T06 org ${uniq()}` } })).id;
  const recruiter = await actor(h, UserRole.RECRUITER, id);
  const admin = await actor(h, UserRole.SUPER_ADMIN, id);
  return { id, recruiter, admin };
}

export interface PoolOpts {
  tags?: string[];
  difficulty?: 'EASY' | 'MEDIUM' | 'HARD';
  type?: 'CODING' | 'MCQ' | 'SHORT_ANSWER';
  /** Default true: the version is the question's current published version. */
  published?: boolean;
  archived?: boolean;
  title?: string;
}
export interface PoolQuestion {
  id: string;
  versionId: string;
  title: string;
}

/** A question of `orgId` with one version (owner role: needs only the schema). */
export async function poolQuestion(
  h: Harness,
  orgId: string,
  o: PoolOpts = {},
): Promise<PoolQuestion> {
  const t = uniq();
  const published = o.published ?? true;
  const type = o.type ?? 'CODING';
  const title = o.title ?? `QA pool question ${t}`;
  const q = await h.owner.question.create({
    data: {
      orgId,
      slug: `qa-pool-${t}`,
      type,
      tags: o.tags ?? ['arrays'],
      isArchived: o.archived ?? false,
    },
  });
  const v = await h.owner.questionVersion.create({
    data: {
      questionId: q.id,
      version: 1,
      title,
      statementMd: 'Pool question.',
      difficulty: o.difficulty ?? 'MEDIUM',
      allowedLanguages: type === 'CODING' ? ['python'] : [],
      referenceSolution: { python: REF_SECRET },
      isPublished: published,
    },
  });
  if (published) {
    await h.owner.question.update({ where: { id: q.id }, data: { currentVersionId: v.id } });
  }
  return { id: q.id, versionId: v.id, title };
}

export const fixedQ = (versionId: string, points = 100): Json => ({
  questionVersionId: versionId,
  points,
});
export const randomQ = (rule: Json, points = 100): Json => ({ randomRule: rule, points });
export const section = (questions: Json[], over: Json = {}): Json => ({
  title: 'Section',
  questions,
  ...over,
});
export const testBody06 = (sections: Json[], over: Json = {}): Json => ({
  name: `QA T06 test ${uniq()}`,
  durationMinutes: 60,
  sections,
  ...over,
});

export const postTest = (h: Harness, who: Actor, body: unknown): request.Test =>
  call(h, 'POST', '/tests', who.token, body);
export const patchTest = (h: Harness, who: Actor, id: string, body: unknown): request.Test =>
  call(h, 'PATCH', `/tests/${id}`, who.token, body);
export const getTest = (h: Harness, who: Actor, id: string): request.Test =>
  call(h, 'GET', `/tests/${id}`, who.token);

/** POST /tests expecting 201; returns the TestDetail body. */
export async function createTest(h: Harness, who: Actor, body: unknown): Promise<Json> {
  const res = await postTest(h, who, body);
  expect([res.status, res.body]).toEqual([201, expect.anything()]);
  return res.body as Json;
}

/** An invitation (and optionally a session) on a test: owner-role fixtures; no route exists yet. */
export async function addInvitation(
  h: Harness,
  orgId: string,
  testId: string,
  withSession = false,
): Promise<{ invitationId: string; sessionId?: string }> {
  const t = uniq();
  const candidate = await h.owner.candidate.create({
    data: { orgId, email: `qa-t06b-${t}@example.com`, fullName: 'QA T06 Candidate' },
  });
  const invitation = await h.owner.invitation.create({
    data: {
      orgId,
      testId,
      candidateId: candidate.id,
      tokenHash: `qa-t06b-token-hash-${t}`,
      windowStart: new Date(Date.now() - 3_600_000),
      windowEnd: new Date(Date.now() + 3_600_000),
    },
  });
  if (!withSession) return { invitationId: invitation.id };
  const s = await h.owner.session.create({
    data: { orgId, invitationId: invitation.id, status: 'INVITED' },
  });
  return { invitationId: invitation.id, sessionId: s.id };
}

/** The problem body with the given ids replaced, for "identical 404" comparisons. */
export const normalized = (res: request.Response, ids: string[]): string => {
  let text = JSON.stringify(stableProblem(res));
  for (const id of ids) text = text.split(id).join('ID');
  return text;
};

export const keysOf = (o: unknown): string[] => Object.keys(o as object).sort();

export const sortedKeys = (o: unknown): string[] => keysOf(o);

/** Counts of the rows a refused call must not change. */
export async function builderCounts(
  h: Harness,
  orgId: string,
): Promise<{ tests: number; audits: number; sections: number }> {
  return {
    tests: await h.owner.test.count({ where: { orgId } }),
    sections: await h.owner.testSection.count({ where: { test: { orgId } } }),
    audits: await h.owner.auditLog.count({
      where: { orgId, action: { in: ['TEST_CREATED', 'TEST_UPDATED'] } },
    }),
  };
}
