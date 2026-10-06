import type { Schemas } from '@/lib/api/client';
import { mockRevision } from './question-revision';
import type { MockQuestion, MockTestCase, MockVariant, MockVersion } from './question-seed';

/*
 * The two views of a question the mock API serves, built FIELD BY FIELD like the real API's
 * staff-view.ts (toFullVersion and toStaffReadVersion): never a spread of the stored row, so a
 * field added to the mock question or version later is not exposed by accident. A caller without
 * question:update (a Recruiter) gets the read view: no revision, reference solution, answer spec or
 * validation report, and a hidden test case as id, position, isHidden and weight only (the input
 * and expectedOutput keys are ABSENT, not null). The choice is made once, by the handler.
 */

type VersionRef = Schemas['QuestionVersionRef'];
type TestCase = Schemas['TestCase'];

export const READ_VERSION_FIELDS = [
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
] as const;

export const READ_DETAIL_FIELDS = [
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
] as const;

export function toVersionRef(v: MockVersion): VersionRef {
  return {
    id: v.id,
    version: v.version,
    isPublished: v.isPublished,
    title: v.title,
    difficulty: v.difficulty,
    validatedAt: v.validatedAt,
    createdAt: v.createdAt,
  };
}

/** A test case. Without `full` a hidden case has no input and no expected output. */
export function toTestCase(t: MockTestCase, full: boolean): TestCase {
  const dto: TestCase = {
    id: t.id,
    position: t.position,
    isHidden: t.isHidden,
    weight: t.weight,
  };
  if (full || !t.isHidden) {
    dto.input = t.input;
    dto.expectedOutput = t.expectedOutput;
  }
  return dto;
}

const sortedCases = (cases: readonly MockTestCase[]): MockTestCase[] =>
  [...cases].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));

export function revisionOf(v: MockVersion): string {
  return mockRevision({
    ...v,
    variants: v.variants.map((x) => ({
      id: x.id,
      params: x.params,
      isActive: x.isActive,
      overrides: x.overrides,
    })),
  });
}

/** A variant as the writer sees it; each override carries the slot's isHidden and position (staff-view toVariantDto). */
export function toVariantDto(x: MockVariant, cases: readonly MockTestCase[]): Schemas['Variant'] {
  const slot = new Map(cases.map((c) => [c.id, c]));
  return {
    id: x.id,
    isActive: x.isActive,
    params: { ...x.params },
    renderedStatement: x.renderedStatement,
    testCaseOverrides: x.overrides.flatMap((o) => {
      const c = slot.get(o.testCaseId);
      return c
        ? [
            {
              testCaseId: o.testCaseId,
              isHidden: c.isHidden,
              position: c.position,
              input: o.input,
              expectedOutput: o.expectedOutput,
            },
          ]
        : [];
    }),
  };
}

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function toFullVersion(v: MockVersion): Schemas['QuestionVersion'] {
  return {
    ...toVersionRef(v),
    statementMd: v.statementMd,
    allowedLanguages: [...v.allowedLanguages],
    limits: { ...v.limits },
    starterCode: { ...v.starterCode },
    referenceSolution: { ...v.referenceSolution },
    answerSpec: v.answerSpec ? structuredClone(v.answerSpec) : null,
    validationReport: v.validationReport ? structuredClone(v.validationReport) : null,
    revision: revisionOf(v),
    testCases: sortedCases(v.testCases).map((t) => toTestCase(t, true)),
    variants: [...v.variants].sort(byId).map((x) => toVariantDto(x, v.testCases)),
  };
}

export function toReadVersion(v: MockVersion): Schemas['QuestionVersionRead'] {
  return {
    id: v.id,
    version: v.version,
    isPublished: v.isPublished,
    title: v.title,
    difficulty: v.difficulty,
    validatedAt: v.validatedAt,
    createdAt: v.createdAt,
    statementMd: v.statementMd,
    allowedLanguages: [...v.allowedLanguages],
    limits: { ...v.limits },
    starterCode: { ...v.starterCode },
    testCases: sortedCases(v.testCases).map((t) => toTestCase(t, false)),
  };
}

/** The visible versions of a question for this caller: writers see all, readers the published ones. */
export function visibleVersions(q: MockQuestion, full: boolean): MockVersion[] {
  return q.versions.filter((v) => full || v.isPublished);
}

export function toSummary(
  q: MockQuestion,
  versions: readonly MockVersion[],
): Schemas['QuestionSummary'] {
  const latest = versions[versions.length - 1]!;
  const published = [...versions].reverse().find((v) => v.isPublished);
  return {
    id: q.id,
    slug: q.slug,
    type: q.type,
    tags: [...q.tags],
    isArchived: q.isArchived,
    createdAt: q.createdAt,
    published: published ? toVersionRef(published) : null,
    latest: toVersionRef(latest),
  };
}

export function toFullDetail(
  q: MockQuestion,
  chosen: MockVersion,
  versions: readonly MockVersion[],
  createdNewVersion: boolean,
): Schemas['QuestionDetail'] {
  return {
    ...toSummary(q, versions),
    versions: versions.map(toVersionRef),
    version: toFullVersion(chosen),
    createdNewVersion,
  };
}

/** The Recruiter's detail: explicit keys only (QuestionDetailRedacted, additionalProperties false). */
export function toReadDetail(
  q: MockQuestion,
  chosen: MockVersion,
  versions: readonly MockVersion[],
): Schemas['QuestionDetailRedacted'] {
  const summary = toSummary(q, versions);
  return {
    id: summary.id,
    slug: summary.slug,
    type: summary.type,
    tags: summary.tags,
    isArchived: summary.isArchived,
    createdAt: summary.createdAt,
    published: summary.published,
    latest: summary.latest,
    versions: versions.map(toVersionRef),
    version: toReadVersion(chosen),
    createdNewVersion: false,
  };
}
