import { z } from 'zod';
import type { Schemas } from '@/lib/api/client';

/*
 * The test builder's form model and its rules (FR-301, FR-302), mirroring the API's
 * test-structure.ts and random-rule.ts so a mistake is shown next to the field, not as a 400.
 * Web-local until the shared contract has these schemas ([ARC-02]).
 */

export type Difficulty = Schemas['Difficulty'];
export type QuestionType = Schemas['QuestionType'];
export type Profile = Schemas['TestProfile'];

export const MIN_DURATION = 5;
export const MAX_DURATION = 480;
export const MAX_SECTIONS = 20;
export const MAX_QUESTIONS_PER_SECTION = 50;
export const MAX_QUESTIONS_PER_TEST = 100;
export const MAX_POINTS = 9999.99;
export const DEFAULT_POINTS = 100;
export const MAX_RULE_TAGS = 20;
export const TAG_PATTERN = /^[a-z0-9][a-z0-9 _.+#-]{0,39}$/;

export interface QuestionRow {
  key: string;
  kind: 'fixed' | 'random';
  /** A PUBLISHED version id of a fixed question. */
  versionId: string;
  title: string;
  difficulty: Difficulty | null;
  /** The random rule as the form edits it. */
  tagsText: string;
  ruleDifficulty: '' | Difficulty;
  ruleType: '' | QuestionType;
  points: number;
}

export interface SectionRow {
  key: string;
  title: string;
  /** Minutes as typed; empty means no section limit. */
  timeLimit: string;
  questions: QuestionRow[];
}

export interface TestDraft {
  name: string;
  description: string;
  durationMinutes: number;
  profile: Profile;
  /** Points as typed; empty means no pass score. */
  passScore: string;
  sections: SectionRow[];
}

let counter = 0;
export const newKey = (prefix: string): string =>
  `${prefix}-${(counter += 1)}-${Math.random().toString(36).slice(2, 8)}`;

export function emptyQuestion(kind: QuestionRow['kind']): QuestionRow {
  return {
    key: newKey('q'),
    kind,
    versionId: '',
    title: '',
    difficulty: null,
    tagsText: '',
    ruleDifficulty: '',
    ruleType: '',
    points: DEFAULT_POINTS,
  };
}
export const emptySection = (title = ''): SectionRow => ({
  key: newKey('s'),
  title,
  timeLimit: '',
  questions: [],
});
export const emptyDraft = (): TestDraft => ({
  name: '',
  description: '',
  durationMinutes: 60,
  profile: 'STANDARD',
  passScore: '',
  sections: [emptySection('Section 1')],
});

/** The tags of a rule as the API normalises them: trimmed, lower case, no empties, no repeats. */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(',')) {
    const t = raw.trim().toLowerCase();
    if (t !== '' && !out.includes(t)) out.push(t);
  }
  return out;
}

const cents = (n: number): number => Math.round(n * 100);
export const twoDecimals = (n: number): boolean => Number.isFinite(n) && cents(n) / 100 === n;

export function totalPoints(sections: readonly SectionRow[]): number {
  return (
    sections.reduce((a, s) => a + s.questions.reduce((b, q) => b + cents(q.points), 0), 0) / 100
  );
}
export function limitsTotal(sections: readonly SectionRow[]): number {
  return sections.reduce((a, s) => {
    const n = Number(s.timeLimit);
    return a + (s.timeLimit.trim() !== '' && Number.isInteger(n) ? n : 0);
  }, 0);
}
export const questionCount = (sections: readonly SectionRow[]): number =>
  sections.reduce((a, s) => a + s.questions.length, 0);

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length)
    return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

/** What a random rule can pick, from the published questions the recruiter can read. */
export interface PickableQuestion {
  type: QuestionType;
  tags: string[];
  difficulty: Difficulty;
}

export function ruleOf(q: QuestionRow): {
  tags?: string[];
  difficulty?: Difficulty;
  type?: QuestionType;
} {
  const tags = parseTags(q.tagsText);
  return {
    ...(tags.length > 0 ? { tags } : {}),
    ...(q.ruleDifficulty ? { difficulty: q.ruleDifficulty } : {}),
    ...(q.ruleType ? { type: q.ruleType } : {}),
  };
}
export const ruleKey = (q: QuestionRow): string => {
  const r = ruleOf(q);
  return JSON.stringify([[...(r.tags ?? [])].sort(), r.difficulty ?? null, r.type ?? null]);
};
export function matchesRule(rule: ReturnType<typeof ruleOf>, p: PickableQuestion): boolean {
  return (
    (rule.type === undefined || p.type === rule.type) &&
    (rule.difficulty === undefined || p.difficulty === rule.difficulty) &&
    (rule.tags === undefined || rule.tags.every((t) => p.tags.includes(t)))
  );
}

const questionSchema = z.object({
  key: z.string(),
  kind: z.enum(['fixed', 'random']),
  versionId: z.string(),
  title: z.string(),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).nullable(),
  tagsText: z.string(),
  ruleDifficulty: z.enum(['', 'EASY', 'MEDIUM', 'HARD']),
  ruleType: z.enum(['', 'CODING', 'MCQ', 'SHORT_ANSWER']),
  points: z
    .number({ error: 'Enter the points.' })
    .gt(0, 'Points must be above 0.')
    .max(MAX_POINTS, `Points cannot be more than ${MAX_POINTS}.`)
    .refine(twoDecimals, 'Use at most 2 decimals.'),
});
const sectionSchema = z.object({
  key: z.string(),
  title: z
    .string()
    .trim()
    .min(1, 'Name this section.')
    .max(200, 'Keep the name under 200 characters.'),
  timeLimit: z.string(),
  questions: z.array(questionSchema),
});

/** Builds the schema for a given set of pickable questions (random rules must be satisfiable). */
export function testDraftSchema(pickable: readonly PickableQuestion[] | null) {
  return z
    .object({
      name: z
        .string()
        .trim()
        .min(1, 'Enter a name.')
        .max(200, 'Keep the name under 200 characters.'),
      description: z.string().max(5000, 'Keep the description under 5000 characters.'),
      durationMinutes: z
        .number({ error: 'Enter the duration in minutes.' })
        .int('Use a whole number of minutes.')
        .min(MIN_DURATION, `At least ${MIN_DURATION} minutes.`)
        .max(MAX_DURATION, `At most ${MAX_DURATION} minutes.`),
      profile: z.enum(['STANDARD', 'STRICT']),
      passScore: z.string(),
      sections: z
        .array(sectionSchema)
        .min(1, 'Add at least one section.')
        .max(MAX_SECTIONS, `Use at most ${MAX_SECTIONS} sections.`),
    })
    .superRefine((d, ctx) => {
      const issue = (path: (string | number)[], message: string) =>
        ctx.addIssue({ code: 'custom', path, message });
      let limitSum = 0;
      d.sections.forEach((s, i) => {
        const t = s.timeLimit.trim();
        if (t !== '') {
          const n = Number(t);
          if (!Number.isInteger(n) || n < 1)
            issue(
              ['sections', i, 'timeLimit'],
              'Use a whole number of minutes, at least 1, or leave it empty.',
            );
          else if (n > MAX_DURATION)
            issue(['sections', i, 'timeLimit'], `At most ${MAX_DURATION} minutes.`);
          else limitSum += n;
        }
        if (s.questions.length < 1)
          issue(['sections', i, 'questions'], 'Add at least one question to this section.');
        if (s.questions.length > MAX_QUESTIONS_PER_SECTION) {
          issue(
            ['sections', i, 'questions'],
            `Use at most ${MAX_QUESTIONS_PER_SECTION} questions per section.`,
          );
        }
        s.questions.forEach((q, j) => {
          if (q.kind === 'fixed' && q.versionId === '')
            issue(['sections', i, 'questions', j, 'versionId'], 'Pick a question.');
          if (q.kind === 'random') {
            const tags = parseTags(q.tagsText);
            if (tags.length > MAX_RULE_TAGS)
              issue(
                ['sections', i, 'questions', j, 'tagsText'],
                `Use at most ${MAX_RULE_TAGS} tags.`,
              );
            const bad = tags.find((t) => !TAG_PATTERN.test(t));
            if (bad !== undefined) {
              issue(
                ['sections', i, 'questions', j, 'tagsText'],
                `"${bad}" is not a valid tag. Use letters, digits, spaces and _ . + # -, starting with a letter or digit.`,
              );
            }
          }
        });
      });
      if (questionCount(d.sections) > MAX_QUESTIONS_PER_TEST) {
        issue(['sections'], `A test has at most ${MAX_QUESTIONS_PER_TEST} questions.`);
      }
      if (limitSum > d.durationMinutes) {
        issue(
          ['durationMinutes'],
          `The section time limits add up to ${limitSum} minutes, more than the ${d.durationMinutes} minute duration. Shorten a section or lengthen the test.`,
        );
      }
      const ps = d.passScore.trim();
      if (ps !== '') {
        const n = Number(ps);
        const total = totalPoints(d.sections);
        if (!Number.isFinite(n) || n < 0 || n > MAX_POINTS)
          issue(['passScore'], `Use a number from 0 to ${MAX_POINTS}.`);
        else if (!twoDecimals(n)) issue(['passScore'], 'Use at most 2 decimals.');
        else if (n > total)
          issue(
            ['passScore'],
            `The pass score cannot be more than the ${total} points of all questions together.`,
          );
      }
      // A random slot picks ONE question and never the same one twice: N slots with the same
      // rule need N different matching published questions (random-rule.ts).
      if (pickable) {
        const need = new Map<
          string,
          { n: number; at: [number, number]; rule: ReturnType<typeof ruleOf> }
        >();
        d.sections.forEach((s, i) =>
          s.questions.forEach((q, j) => {
            if (q.kind !== 'random') return;
            const key = ruleKey(q);
            const seen = need.get(key);
            if (seen) seen.n += 1;
            else need.set(key, { n: 1, at: [i, j], rule: ruleOf(q) });
          }),
        );
        for (const { n, at, rule } of need.values()) {
          const matches = pickable.filter((p) => matchesRule(rule, p)).length;
          if (matches < n) {
            issue(
              ['sections', at[0], 'questions', at[1], 'tagsText'],
              `Only ${matches} published question${matches === 1 ? '' : 's'} match this rule, and the test needs ${n} different ones. Change the rule or publish more questions.`,
            );
          }
        }
      }
    });
}

/** The request body of a create or an edit, from a draft that passed `testDraftSchema`. */
export function toBody(d: TestDraft): Schemas['CreateTest'] {
  const ps = d.passScore.trim();
  return {
    name: d.name.trim(),
    ...(d.description.trim() !== '' ? { description: d.description } : {}),
    durationMinutes: d.durationMinutes,
    profile: d.profile,
    ...(ps !== '' ? { passScore: Number(ps) } : {}),
    sections: d.sections.map((s, i) => ({
      title: s.title.trim(),
      position: i + 1,
      ...(s.timeLimit.trim() !== '' ? { timeLimitMin: Number(s.timeLimit) } : {}),
      questions: s.questions.map((q, j) => ({
        position: j + 1,
        points: q.points,
        ...(q.kind === 'fixed' ? { questionVersionId: q.versionId } : { randomRule: ruleOf(q) }),
      })),
    })),
  };
}

export function fromDetail(t: Schemas['TestDetail']): TestDraft {
  return {
    name: t.name,
    description: t.description ?? '',
    durationMinutes: t.durationMinutes,
    profile: t.profile,
    passScore: t.passScore === null ? '' : String(t.passScore),
    sections: [...t.sections]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        key: newKey('s'),
        title: s.title,
        timeLimit: s.timeLimitMin === null ? '' : String(s.timeLimitMin),
        questions: [...s.questions]
          .sort((a, b) => a.position - b.position)
          .map((q) => {
            const rule = (q.randomRule ?? {}) as {
              tags?: string[];
              difficulty?: Difficulty;
              type?: QuestionType;
            };
            return {
              key: newKey('q'),
              kind: q.questionVersionId ? ('fixed' as const) : ('random' as const),
              versionId: q.questionVersionId ?? '',
              title: q.title ?? '',
              difficulty: q.difficulty,
              tagsText: (rule.tags ?? []).join(', '),
              ruleDifficulty: rule.difficulty ?? '',
              ruleType: rule.type ?? '',
              points: q.points,
            };
          }),
      })),
  };
}

/** The part of a test other editors can change under an edit: used to notice it before PATCH. */
export function detailSignature(t: Schemas['TestDetail']): string {
  return JSON.stringify([
    t.name,
    t.description,
    t.durationMinutes,
    t.profile,
    t.passScore,
    t.used,
    [...t.sections]
      .sort((a, b) => a.position - b.position)
      .map((s) => [
        s.title,
        s.timeLimitMin,
        [...s.questions]
          .sort((a, b) => a.position - b.position)
          .map((q) => [q.points, q.questionVersionId, q.randomRule]),
      ]),
  ]);
}
