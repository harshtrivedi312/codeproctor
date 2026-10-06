import { CODE_LANGUAGES, type CodeLanguage } from '@codeproctor/shared';
import { z } from 'zod';
import type { Schemas } from '@/lib/api/client';
import { checkParams, missingPlaceholders, parseParams } from './params';
import { hasUnsupportedSyntax, placeholdersOf } from './template';

/*
 * Web-local schemas and conversions for the question editor (FR-201..FR-205). [ARC-02] The content
 * shape and the limits belong in packages/shared once the API contract is pinned; see
 * docs/followups/frontend.md.
 */

export type QuestionType = Schemas['QuestionType'];
export type Difficulty = Schemas['Difficulty'];
export type QuestionContent = Schemas['QuestionContent'];
export type QuestionDetail = Schemas['QuestionDetail'];
export type TestCase = Schemas['TestCase'];

export const LANGUAGE_LABELS: Record<CodeLanguage, string> = {
  python: 'Python',
  javascript: 'JavaScript',
  java: 'Java',
};

export const MAX_TITLE = 200;
export const MAX_STATEMENT = 50_000;
export const MAX_TEST_TEXT = 100_000;
export const MAX_WEIGHT = 1000;

export interface VariantValues {
  id: string;
  label: string;
  /** The JSON text the author edits; parsed and checked on save. */
  paramsText: string;
  active: boolean;
  overrides: { testCaseId: string; input: string; expectedOutput: string }[];
}

export interface DraftValues {
  type: QuestionType;
  title: string;
  statementMd: string;
  difficulty: Difficulty;
  tagsText: string;
  allowedLanguages: CodeLanguage[];
  limits: { cpuMs: number; wallMs: number; memoryKb: number };
  starterCode: Record<string, string>;
  referenceSolution: Record<string, string>;
  testCases: TestCase[];
  variants: VariantValues[];
  mcq: { options: { id: string; text: string }[]; correctOptionIds: string[]; multiple: boolean };
  short: { canonical: string; acceptedVariants: { key: string; value: string }[] };
}

export const DEFAULT_LIMITS = { cpuMs: 2000, wallMs: 5000, memoryKb: 262_144 };

/** Unicode NFKC, trim, collapse inner whitespace, lower-case (D-23). The API normalises the same way. */
export function normalizeShortAnswer(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function newId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}-${random}`;
}

export function emptyDraft(type: QuestionType): DraftValues {
  return {
    type,
    title: '',
    statementMd: '',
    difficulty: 'EASY',
    tagsText: '',
    allowedLanguages: type === 'CODING' ? ['python'] : [],
    limits: { ...DEFAULT_LIMITS },
    starterCode: {},
    referenceSolution: {},
    testCases: [],
    variants: [],
    mcq: {
      options: [
        { id: newId('opt'), text: '' },
        { id: newId('opt'), text: '' },
      ],
      correctOptionIds: [],
      multiple: false,
    },
    short: { canonical: '', acceptedVariants: [] },
  };
}

export function parseTags(text: string): string[] {
  const tags: string[] = [];
  for (const raw of text.split(',')) {
    const tag = raw.trim().toLowerCase();
    if (tag !== '' && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/** Server version to form values. */
export function toDraft(
  type: QuestionType,
  tags: readonly string[],
  v: QuestionContent,
): DraftValues {
  const mcq = v.answerSpec?.type === 'MCQ' ? v.answerSpec : null;
  const short = v.answerSpec?.type === 'SHORT_ANSWER' ? v.answerSpec : null;
  const base = emptyDraft(type);
  return {
    ...base,
    title: v.title,
    statementMd: v.statementMd,
    difficulty: v.difficulty,
    tagsText: tags.join(', '),
    allowedLanguages: v.allowedLanguages,
    limits: { ...v.limits },
    starterCode: { ...v.starterCode },
    referenceSolution: { ...v.referenceSolution },
    testCases: v.testCases.map((t) => ({ ...t })),
    variants: v.variants.map((x) => ({
      id: x.id,
      label: x.label,
      paramsText: JSON.stringify(x.params, null, 2),
      active: x.active,
      overrides: x.overrides.map((o) => ({ ...o })),
    })),
    mcq: mcq
      ? {
          options: mcq.options.map((o) => ({ ...o })),
          correctOptionIds: [...mcq.correctOptionIds],
          multiple: mcq.multiple,
        }
      : base.mcq,
    short: short
      ? {
          canonical: short.canonical,
          acceptedVariants: short.acceptedVariants.map((value) => ({ key: newId('sv'), value })),
        }
      : base.short,
  };
}

/** Keeps the string and number values (the check on save has already rejected anything else). */
function scalarsOf(value: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' || typeof v === 'number') out[k] = v;
  }
  return out;
}

/** Form values to the content sent on save. Call only with values that passed `draftSchema`. */
export function toContent(d: DraftValues): QuestionContent {
  const coding = d.type === 'CODING';
  const languages = coding ? d.allowedLanguages : [];
  const keep = (map: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(map).filter(([lang]) => languages.includes(lang as CodeLanguage)),
    );
  const slotIds = new Set(d.testCases.map((t) => t.id));
  let answerSpec: QuestionContent['answerSpec'] = null;
  if (d.type === 'MCQ') {
    answerSpec = {
      type: 'MCQ',
      options: d.mcq.options.map((o) => ({ id: o.id, text: o.text.trim() })),
      correctOptionIds: d.mcq.correctOptionIds,
      multiple: d.mcq.multiple,
    };
  } else if (d.type === 'SHORT_ANSWER') {
    answerSpec = {
      type: 'SHORT_ANSWER',
      canonical: d.short.canonical.trim(),
      acceptedVariants: d.short.acceptedVariants.map((a) => a.value.trim()),
    };
  }
  return {
    title: d.title.trim(),
    statementMd: d.statementMd,
    difficulty: d.difficulty,
    tags: parseTags(d.tagsText),
    allowedLanguages: languages,
    limits: d.limits,
    starterCode: keep(d.starterCode),
    referenceSolution: keep(d.referenceSolution),
    testCases: coding ? d.testCases : [],
    variants: coding
      ? d.variants.map((v) => {
          const parsed = parseParams(v.paramsText);
          return {
            id: v.id,
            label: v.label.trim(),
            params: parsed.ok ? scalarsOf(parsed.value) : {},
            active: v.active,
            overrides: v.overrides.filter((o) => slotIds.has(o.testCaseId)),
          };
        })
      : [],
    answerSpec,
  };
}

const weight = z
  .number({ error: 'Enter a weight.' })
  .gt(0, 'The weight must be greater than 0.')
  .max(MAX_WEIGHT, `The weight cannot be more than ${MAX_WEIGHT}.`);

const testCaseSchema = z.object({
  id: z.string().min(1),
  input: z.string().max(MAX_TEST_TEXT, 'This input is too long.'),
  expectedOutput: z.string().max(MAX_TEST_TEXT, 'This output is too long.'),
  isHidden: z.boolean(),
  weight,
});

const limitsSchema = z.object({
  cpuMs: z
    .number({ error: 'Enter the CPU time in milliseconds.' })
    .int('Use a whole number.')
    .min(100, 'At least 100 ms.')
    .max(60_000, 'At most 60 000 ms.'),
  wallMs: z
    .number({ error: 'Enter the wall time in milliseconds.' })
    .int('Use a whole number.')
    .min(100, 'At least 100 ms.')
    .max(120_000, 'At most 120 000 ms.'),
  memoryKb: z
    .number({ error: 'Enter the memory in kilobytes.' })
    .int('Use a whole number.')
    .min(16_384, 'At least 16 384 KB.')
    .max(2_097_152, 'At most 2 097 152 KB.'),
});

export const draftSchema = z
  .object({
    type: z.enum(['CODING', 'MCQ', 'SHORT_ANSWER']),
    title: z
      .string()
      .trim()
      .min(1, 'Enter a title.')
      .max(MAX_TITLE, `Keep the title under ${MAX_TITLE} characters.`),
    statementMd: z
      .string()
      .trim()
      .min(1, 'Write the statement.')
      .max(MAX_STATEMENT, 'The statement is too long.'),
    difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']),
    tagsText: z.string().max(500, 'Too many tags.'),
    allowedLanguages: z.array(z.enum(CODE_LANGUAGES)),
    limits: limitsSchema,
    starterCode: z.record(z.string(), z.string().max(MAX_TEST_TEXT)),
    referenceSolution: z.record(z.string(), z.string().max(MAX_TEST_TEXT)),
    testCases: z.array(testCaseSchema),
    variants: z.array(
      z.object({
        id: z.string().min(1),
        label: z.string().trim().min(1, 'Name this variant.'),
        paramsText: z.string(),
        active: z.boolean(),
        overrides: z.array(
          z.object({
            testCaseId: z.string(),
            input: z.string().max(MAX_TEST_TEXT),
            expectedOutput: z.string().max(MAX_TEST_TEXT),
          }),
        ),
      }),
    ),
    mcq: z.object({
      options: z.array(z.object({ id: z.string(), text: z.string() })),
      correctOptionIds: z.array(z.string()),
      multiple: z.boolean(),
    }),
    short: z.object({
      canonical: z.string(),
      acceptedVariants: z.array(z.object({ key: z.string(), value: z.string() })),
    }),
  })
  .superRefine((d, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const text = [
      d.statementMd,
      ...Object.values(d.starterCode),
      ...Object.values(d.referenceSolution),
    ];
    if (text.some(hasUnsupportedSyntax)) {
      issue(
        ['statementMd'],
        'Only {{name}} placeholders are supported. Remove sections ({{#x}}), partials and triple braces.',
      );
    }
    if (d.type === 'CODING') {
      if (d.allowedLanguages.length === 0)
        issue(['allowedLanguages'], 'Pick at least one language.');
      const ids = d.testCases.map((t) => t.id);
      d.testCases.forEach((t, i) => {
        if (ids.indexOf(t.id) !== i) issue(['testCases', i, 'id'], 'Duplicate test case.');
      });
      const used = placeholdersOf(text.join('\n'));
      const names = (list: string[]) => list.map((m) => `"${m}"`).join(', ');
      if (used.length > 0 && d.variants.length === 0) {
        issue(
          ['variants'],
          `The question uses ${names(used)} as placeholder${used.length === 1 ? '' : 's'}. Add a variant that gives ${used.length === 1 ? 'it' : 'them'} a value.`,
        );
      }
      d.variants.forEach((v, i) => {
        const parsed = parseParams(v.paramsText);
        if (!parsed.ok) {
          issue(['variants', i, 'paramsText'], parsed.error);
          return;
        }
        const errors = checkParams(parsed.value);
        const missing = missingPlaceholders(parsed.value, used);
        if (missing.length > 0) {
          errors.push(
            `Needs a value for ${names(missing)}: the question uses ${missing.length === 1 ? 'it' : 'them'} as a placeholder.`,
          );
        }
        if (errors.length > 0) issue(['variants', i, 'paramsText'], errors.join(' '));
      });
    } else if (d.type === 'MCQ') {
      const texts = d.mcq.options.map((o) => o.text.trim());
      d.mcq.options.forEach((o, i) => {
        if (o.text.trim() === '')
          issue(['mcq', 'options', i, 'text'], 'Write the option or remove it.');
        else if (texts.indexOf(o.text.trim()) !== i)
          issue(['mcq', 'options', i, 'text'], 'Two options have the same text.');
      });
      if (d.mcq.options.length < 2) issue(['mcq', 'options'], 'Add at least two options.');
      const optionIds = new Set(d.mcq.options.map((o) => o.id));
      const correct = d.mcq.correctOptionIds.filter((id) => optionIds.has(id));
      if (correct.length === 0) {
        issue(['mcq', 'correctOptionIds'], 'Mark the correct answer.');
      } else if (!d.mcq.multiple && correct.length !== 1) {
        issue(
          ['mcq', 'correctOptionIds'],
          'Single choice needs exactly one correct option. Turn on multiple answers or unmark the others.',
        );
      }
    } else {
      if (normalizeShortAnswer(d.short.canonical) === '') {
        issue(['short', 'canonical'], 'Enter the canonical answer.');
      }
      const seen = new Set<string>([normalizeShortAnswer(d.short.canonical)]);
      d.short.acceptedVariants.forEach((a, i) => {
        const n = normalizeShortAnswer(a.value);
        if (n === '')
          issue(
            ['short', 'acceptedVariants', i, 'value'],
            'Write the accepted answer or remove it.',
          );
        else if (seen.has(n)) {
          issue(
            ['short', 'acceptedVariants', i, 'value'],
            'This matches the canonical answer or another variant once case and spacing are ignored.',
          );
        }
        seen.add(n);
      });
    }
  });

/** Slots that have no visible sample, for a hint (not an error: drafts may be incomplete). */
export function hasVisibleSample(testCases: readonly TestCase[]): boolean {
  return testCases.some((t) => !t.isHidden);
}
