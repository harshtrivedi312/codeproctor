import { CODE_LANGUAGES, type CodeLanguage } from '@codeproctor/shared';
import { z } from 'zod';
import type { Schemas } from '@/lib/api/client';
import { checkParams, missingPlaceholders, parseParams, type ParamValue } from './params';
import { hasUnsupportedSyntax, placeholdersOf } from './template';

/*
 * Web-local schemas and conversions for the question editor (FR-201..FR-205). [ARC-02] The content
 * shape and the limits belong in packages/shared once the API contract is pinned; see
 * docs/followups/frontend.md.
 */

export type QuestionType = Schemas['QuestionType'];
export type Difficulty = Schemas['Difficulty'];
export type QuestionDetail = Schemas['QuestionDetail'];
export type QuestionVersion = Schemas['QuestionVersion'];
export type Variant = Schemas['Variant'];

/** A test case in the form. Its position is its place in the list (the API stores `position`). */
export interface TestCase {
  id: string;
  input: string;
  expectedOutput: string;
  isHidden: boolean;
  weight: number;
}

export const LANGUAGE_LABELS: Record<CodeLanguage, string> = {
  python: 'Python',
  javascript: 'JavaScript',
  java: 'Java',
};

export const MAX_TITLE = 200;
export const MAX_STATEMENT = 50_000;
export const MAX_TEST_TEXT = 100_000;
export const MAX_WEIGHT = 9999.99;
export const MAX_TEST_CASES = 100;
export const MAX_TAGS = 20;
export const MAX_VARIANTS = 50;
/** The API's tag rule (BE-04a): lower case, starts with a letter or digit, at most 40 characters. */
export const TAG_PATTERN = /^[a-z0-9][a-z0-9 _.+#-]{0,39}$/;
/** The API's option id rule: 1 to 32 letters, digits, underscores or dashes. */
export const OPTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * A variant in the form. The API has no name for a variant, so the UI calls it "Variant N" by its
 * place in the list (`variantName`); the order is the server's (by id, not meaningful) and a new
 * version gives every variant a new id.
 */
export interface VariantValues {
  id: string;
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

/** Ids the form makes for variants that are not saved yet; the API's ids never start like this. */
export const DRAFT_VARIANT_PREFIX = 'draft-var';
export const isDraftVariantId = (id: string): boolean => id.startsWith(DRAFT_VARIANT_PREFIX);

export const variantName = (index: number): string => `Variant ${index + 1}`;

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

/** A short option id the API accepts (at most 32 characters). */
export function newOptionId(): string {
  return `o${Math.random().toString(36).slice(2, 10)}`;
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
        { id: newOptionId(), text: '' },
        { id: newOptionId(), text: '' },
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

/** The answer spec of a version as the form edits it. The question type says which shape applies. */
function mcqOf(spec: Schemas['AnswerSpec'] | null): Schemas['McqAnswerSpec'] | null {
  return spec && 'options' in spec ? spec : null;
}
function shortOf(spec: Schemas['AnswerSpec'] | null): Schemas['ShortAnswerSpec'] | null {
  return spec && 'canonical' in spec ? spec : null;
}

/** Server version (writer view, variants included) and the question tags to form values. */
export function toDraft(
  type: QuestionType,
  tags: readonly string[],
  v: QuestionVersion,
): DraftValues {
  const mcq = type === 'MCQ' ? mcqOf(v.answerSpec) : null;
  const short = type === 'SHORT_ANSWER' ? shortOf(v.answerSpec) : null;
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
    testCases: [...v.testCases]
      .sort((a, b) => a.position - b.position)
      .map((t) => ({
        id: t.id,
        input: t.input ?? '',
        expectedOutput: t.expectedOutput ?? '',
        isHidden: t.isHidden,
        weight: t.weight,
      })),
    variants: v.variants.map((x) => ({
      id: x.id,
      paramsText: JSON.stringify(x.params, null, 2),
      active: x.isActive,
      overrides: x.testCaseOverrides.map((o) => ({
        testCaseId: o.testCaseId,
        input: o.input,
        expectedOutput: o.expectedOutput,
      })),
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

/** Keeps the scalar values (the check on save has already rejected anything else). */
function scalarsOf(value: Record<string, unknown>): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** The content fields of a save (PATCH). Call only with values that passed `draftSchema`. */
export function toUpdate(d: DraftValues): Omit<Schemas['UpdateQuestion'], 'expectedRevision'> {
  const coding = d.type === 'CODING';
  const languages = coding ? d.allowedLanguages : [];
  const keep = (map: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(map).filter(([lang]) => languages.includes(lang as CodeLanguage)),
    );
  return {
    title: d.title.trim(),
    statementMd: d.statementMd,
    difficulty: d.difficulty,
    tags: parseTags(d.tagsText),
    allowedLanguages: languages,
    limits: { ...d.limits },
    starterCode: keep(d.starterCode),
    referenceSolution: keep(d.referenceSolution),
    ...(d.type === 'CODING' ? {} : { answerSpec: answerSpecOf(d) }),
  };
}

/** The answer spec for an MCQ or short-answer question (no `type` key: the question type decides). */
function answerSpecOf(d: DraftValues): Schemas['AnswerSpec'] {
  if (d.type === 'MCQ') {
    return {
      options: d.mcq.options.map((o) => ({ id: o.id, text: o.text.trim() })),
      correctOptionIds: d.mcq.correctOptionIds,
      multiple: d.mcq.multiple,
    };
  }
  return {
    canonical: d.short.canonical.trim(),
    acceptedVariants: d.short.acceptedVariants.map((a) => a.value.trim()),
  };
}

/** The body of a create (POST): the content plus the type and the test cases. */
export function toCreate(d: DraftValues): Schemas['CreateQuestion'] {
  const update = toUpdate(d);
  const { title, statementMd, difficulty } = update;
  return {
    ...update,
    type: d.type,
    title: title ?? '',
    statementMd: statementMd ?? '',
    difficulty: difficulty ?? 'EASY',
    ...(d.type === 'CODING'
      ? {
          testCases: d.testCases.map((t, position) => ({
            input: t.input,
            expectedOutput: t.expectedOutput,
            isHidden: t.isHidden,
            weight: t.weight,
            position,
          })),
        }
      : {}),
  };
}

/** A variant as the save sends it: the form's id, its params and flag, and its slot overrides. */
export interface DesiredVariant {
  id: string;
  params: Record<string, ParamValue>;
  isActive: boolean;
  overrides: { testCaseId: string; input: string; expectedOutput: string }[];
}

/** The variants of a coding question as the form has them (overrides of removed slots dropped). */
export function toVariants(d: DraftValues): DesiredVariant[] {
  if (d.type !== 'CODING') return [];
  const slotIds = new Set(d.testCases.map((t) => t.id));
  return d.variants.map((v) => {
    const parsed = parseParams(v.paramsText);
    return {
      id: v.id,
      params: parsed.ok ? scalarsOf(parsed.value) : {},
      isActive: v.active,
      overrides: v.overrides.filter((o) => slotIds.has(o.testCaseId)),
    };
  });
}

const weight = z
  .number({ error: 'Enter a weight.' })
  .gte(0.01, 'The weight must be at least 0.01.')
  .max(MAX_WEIGHT, `The weight cannot be more than ${MAX_WEIGHT}.`)
  .refine((w) => Math.round(w * 100) / 100 === w, 'Use at most 2 decimals.');

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
    .max(10_000, 'At most 10 000 ms.'),
  wallMs: z
    .number({ error: 'Enter the wall time in milliseconds.' })
    .int('Use a whole number.')
    .min(100, 'At least 100 ms.')
    .max(20_000, 'At most 20 000 ms.'),
  memoryKb: z
    .number({ error: 'Enter the memory in kilobytes.' })
    .int('Use a whole number.')
    .min(16_384, 'At least 16 384 KB.')
    .max(524_288, 'At most 524 288 KB.'),
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
    tagsText: z.string().max(1000, 'Too many tags.'),
    allowedLanguages: z.array(z.enum(CODE_LANGUAGES)),
    limits: limitsSchema,
    starterCode: z.record(z.string(), z.string().max(MAX_TEST_TEXT)),
    referenceSolution: z.record(z.string(), z.string().max(MAX_TEST_TEXT)),
    testCases: z.array(testCaseSchema),
    variants: z.array(
      z.object({
        id: z.string().min(1),
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
    const tags = parseTags(d.tagsText);
    if (tags.length > MAX_TAGS) issue(['tagsText'], `Use at most ${MAX_TAGS} tags.`);
    const badTag = tags.find((t) => !TAG_PATTERN.test(t));
    if (badTag !== undefined) {
      issue(
        ['tagsText'],
        `"${badTag}" is not a valid tag. Start with a letter or digit, at most 40 characters, using letters, digits, spaces and _ . + # -.`,
      );
    }
    if (text.some(hasUnsupportedSyntax)) {
      issue(
        ['statementMd'],
        'Only {{name}} placeholders are supported. Remove sections ({{#x}}), partials and triple braces.',
      );
    }
    if (d.type === 'CODING') {
      if (d.allowedLanguages.length === 0)
        issue(['allowedLanguages'], 'Pick at least one language.');
      if (d.limits.wallMs < d.limits.cpuMs) {
        issue(['limits', 'wallMs'], 'The wall time cannot be below the CPU time.');
      }
      if (d.testCases.length > MAX_TEST_CASES) {
        issue(['testCases'], `Use at most ${MAX_TEST_CASES} test cases.`);
      }
      const ids = d.testCases.map((t) => t.id);
      d.testCases.forEach((t, i) => {
        if (ids.indexOf(t.id) !== i) issue(['testCases', i, 'id'], 'Duplicate test case.');
      });
      if (d.variants.length > MAX_VARIANTS) {
        issue(['variants'], `Use at most ${MAX_VARIANTS} variants.`);
      }
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
        // An inactive variant is never rendered (the API checks it again when it is switched on).
        const missing = v.active ? missingPlaceholders(parsed.value, used) : [];
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
      if (d.mcq.options.length > 10) issue(['mcq', 'options'], 'Use at most 10 options.');
      d.mcq.options.forEach((o, i) => {
        if (o.text.length > 1000)
          issue(['mcq', 'options', i, 'text'], 'Keep the option under 1000 characters.');
        if (!OPTION_ID_PATTERN.test(o.id))
          issue(
            ['mcq', 'options', i, 'text'],
            'This option has an invalid id. Remove it and add it again.',
          );
      });
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
      if (d.short.canonical.trim().length > 500) {
        issue(['short', 'canonical'], 'Keep the canonical answer under 500 characters.');
      }
      if (d.short.acceptedVariants.length > 20) {
        issue(['short', 'acceptedVariants'], 'Use at most 20 accepted variants.');
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
