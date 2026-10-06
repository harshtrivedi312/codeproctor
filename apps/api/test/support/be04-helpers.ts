// Helpers for the BE-04 question bank acceptance tests (TC-010, TC-011, TC-013). Calls go through
// the real HTTP API as signed-in staff (support/harness.ts); fixtures that need no route use the
// owner role. Test data carries unmistakable markers so a leak is found by a plain text search.
import type request from 'supertest';
import { UserRole } from '../../src/generated/prisma/client';
import { actor, Actor, call } from './be03-helpers';
import { HIDDEN_IN, HIDDEN_OUT, REF_SECRET } from './be03-routes';
import { Harness } from './harness';

export type Json = Record<string, unknown>;

export const SAMPLE_IN = 'SAMPLE-IN-1 2';
export const SAMPLE_OUT = 'SAMPLE-OUT-3';
export const HIDDEN_IN_2 = 'QA-HIDDEN-INPUT-8';
export const HIDDEN_OUT_2 = 'QA-HIDDEN-OUTPUT-8';
export const MCQ_KEY_ID = 'QAKEY';
export const SHORT_CANONICAL = 'QA-SHORT-CANONICAL-ANSWER';
export const SHORT_VARIANT = 'QA-SHORT-ACCEPTED-VARIANT';

export { HIDDEN_IN, HIDDEN_OUT, REF_SECRET };

/** A complete coding question: two samples, two hidden tests, python and javascript. */
export function codingBody(over: Json = {}): Json {
  return {
    title: 'QA two sum',
    statementMd: '# Two sum\n\nAdd two numbers.',
    difficulty: 'MEDIUM',
    tags: ['Arrays', 'math'],
    allowedLanguages: ['python', 'javascript'],
    limits: { cpuMs: 1500, wallMs: 4000, memoryKb: 131072 },
    starterCode: {
      python: 'def solve(a, b):\n    pass\n',
      javascript: 'function solve(a, b) {}\n',
    },
    referenceSolution: { python: REF_SECRET, javascript: `${REF_SECRET}-js` },
    testCases: [
      { input: SAMPLE_IN, expectedOutput: SAMPLE_OUT, isHidden: false, weight: 1, position: 0 },
      {
        input: `${SAMPLE_IN}-b`,
        expectedOutput: `${SAMPLE_OUT}-b`,
        isHidden: false,
        weight: 1,
        position: 1,
      },
      { input: HIDDEN_IN, expectedOutput: HIDDEN_OUT, isHidden: true, weight: 3, position: 2 },
      { input: HIDDEN_IN_2, expectedOutput: HIDDEN_OUT_2, isHidden: true, weight: 5, position: 3 },
    ],
    ...over,
  };
}

export const mcqBody = (over: Json = {}): Json => ({
  type: 'MCQ',
  title: 'QA colour',
  statementMd: 'Pick the sky colour.',
  difficulty: 'EASY',
  answerSpec: {
    options: [
      { id: 'OTHER', text: 'Red' },
      { id: MCQ_KEY_ID, text: 'Blue' },
    ],
    correctOptionIds: [MCQ_KEY_ID],
    multiple: false,
  },
  ...over,
});

export const shortAnswerBody = (over: Json = {}): Json => ({
  type: 'SHORT_ANSWER',
  title: 'QA capital',
  statementMd: 'Name the capital of France.',
  difficulty: 'EASY',
  answerSpec: { canonical: SHORT_CANONICAL, acceptedVariants: [SHORT_VARIANT] },
  ...over,
});

export interface Staff {
  admin: Actor;
  author: Actor;
  recruiter: Actor;
  reviewer: Actor;
}

export async function staff(h: Harness, orgId = h.orgId): Promise<Staff> {
  return {
    admin: await actor(h, UserRole.SUPER_ADMIN, orgId),
    author: await actor(h, UserRole.AUTHOR, orgId),
    recruiter: await actor(h, UserRole.RECRUITER, orgId),
    reviewer: await actor(h, UserRole.REVIEWER, orgId),
  };
}

/** POST /questions as `who`, expecting 201; returns the response body. */
export async function createQuestion(
  h: Harness,
  who: Actor,
  body: Json = codingBody(),
): Promise<Json> {
  const res = await call(h, 'POST', '/questions', who.token, body);
  expect([res.status, res.body]).toEqual([201, expect.anything()]);
  return res.body as Json;
}

export async function publishQuestion(h: Harness, who: Actor, id: string): Promise<Json> {
  const res = await call(h, 'POST', `/questions/${id}/publish`, who.token);
  expect([res.status, res.body]).toEqual([200, expect.anything()]);
  return res.body as Json;
}

const jsonText = (res: request.Response): string => JSON.stringify(res.body);

/** None of `needles` may appear anywhere in the response body text. */
export function expectNoneOf(res: request.Response, needles: string[]): void {
  const text = res.text || jsonText(res);
  for (const n of needles) expect([n, text.includes(n)]).toEqual([n, false]);
}

/** Every key anywhere in a JSON value. */
export function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [k, ...allKeys(v)]);
  }
  return [];
}

export const idOf = (q: Json): string => q.id as string;
export const versionOf = (q: Json): Json => q.version as Json;
