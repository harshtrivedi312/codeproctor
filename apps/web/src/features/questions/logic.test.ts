import { describe, expect, it } from 'vitest';
import type { Schemas } from '@/lib/api/client';
import {
  draftSchema,
  emptyDraft,
  normalizeShortAnswer,
  toUpdate,
  toVariants,
  type DraftValues,
} from './draft';
import { aiGate, aiRefreshDue, canPublish, publishChecks } from './gate';
import { checkParams, missingPlaceholders, parseParams } from './params';
import { hasUnsupportedSyntax, placeholdersOf, renderTemplate } from './template';

const NOW = new Date('2026-10-05T00:00:00Z');
const policy = { minAssistants: 2, isDefault: true, refreshIntervalDays: null };
const ref = (
  language: Schemas['Language'],
  assistant: string,
  collectedAt: string,
  supersededAt: string | null = null,
): Schemas['AiReference'] => ({
  id: `${language}-${assistant}-${collectedAt}`,
  language,
  assistant,
  modelLabel: 'm',
  solutionCode: 'x',
  variantId: null,
  promptText: null,
  collectedAt,
  collectedById: 'a',
  supersededAt,
  createdAt: collectedAt,
});

describe('templates (FR-203, ADR 0007 V-2)', () => {
  it('FR-203: finds each placeholder once and renders values, leaving unknown ones visible', () => {
    expect(placeholdersOf('{{a}} and {{ b }} and {{a}}')).toEqual(['a', 'b']);
    expect(
      renderTemplate('n={{n}} xs={{xs}} s={{s}} q={{q}}', { n: 3, xs: [1, 2], s: 'hi' }),
    ).toEqual({
      text: 'n=3 xs=[1,2] s=hi q={{q}}',
      missing: ['q'],
    });
  });

  it('FR-203: flags Mustache syntax beyond plain variables', () => {
    expect(hasUnsupportedSyntax('{{#list}}x{{/list}}')).toBe(true);
    expect(hasUnsupportedSyntax('{{{raw}}}')).toBe(true);
    expect(hasUnsupportedSyntax('{{> partial}}')).toBe(true);
    expect(hasUnsupportedSyntax('{{plain}}')).toBe(false);
  });
});

describe('variant parameters (FR-203, DL-32)', () => {
  it('FR-203: parses only JSON objects', () => {
    expect(parseParams('{"n": 1}')).toEqual({ ok: true, value: { n: 1 } });
    expect(parseParams('').ok).toBe(false);
    expect(parseParams('[1]').ok).toBe(false);
    expect(parseParams('{').ok).toBe(false);
  });
  it('FR-203 BE-04b: values are strings, numbers or booleans with the API name and size rules', () => {
    expect(checkParams({ n: 1, s: 'x', ok: true })).toEqual([]);
    expect(checkParams({ xs: [1] })[0]).toMatch(/"xs" must be a string, a number or true or false/);
    expect(checkParams({ n: Number.NaN })[0]).toMatch(/"n" must be a string, a number/);
    expect(checkParams({ n: null })[0]).toMatch(/"n" must be a string, a number/);
    expect(checkParams({ 'bad name': 1 })[0]).toMatch(/not a valid name/);
    expect(checkParams({ __proto__x: 1, constructor: 1 })).toHaveLength(2);
    expect(checkParams({ s: 'x'.repeat(1001) })[0]).toMatch(/too long/);
    expect(checkParams({ ['a'.repeat(41)]: 1 })[0]).toMatch(/not a valid name/);
  });
  it('FR-203 BE-04b: the template syntax is the API subset: an escaped brace is text, other tags are errors', () => {
    expect(placeholdersOf('\\{{not}} but {{yes}}')).toEqual(['yes']);
    expect(renderTemplate('\\{{a}} {{b}}', { b: true }).text).toBe('{{a}} true');
    expect(hasUnsupportedSyntax('{{a.b}}')).toBe(true);
    expect(hasUnsupportedSyntax('{{ a')).toBe(true);
    expect(hasUnsupportedSyntax('\\{{ok')).toBe(false);
  });
  it('FR-203: finds the placeholders a variant gives no value, against its own keys', () => {
    expect(missingPlaceholders({ a: 1 }, ['a', 'b'])).toEqual(['b']);
    expect(missingPlaceholders({ a: 1, b: 'x' }, ['a', 'b'])).toEqual([]);
  });
});

describe('AI reference gate (D-20, ADR 0005 AI-4, AI-5)', () => {
  it('AI-5: needs distinct assistants per allowed language; superseded rows and repeats do not count', () => {
    const rows = [
      ref('python', 'ChatGPT', '2026-10-01T00:00:00Z'),
      ref('python', ' chatgpt ', '2026-10-02T00:00:00Z'),
      ref('python', 'Claude', '2026-10-01T00:00:00Z', '2026-10-03T00:00:00Z'),
      ref('javascript', 'ChatGPT', '2026-10-01T00:00:00Z'),
      ref('javascript', 'Claude', '2026-10-01T00:00:00Z'),
    ];
    const gates = aiGate(['python', 'javascript'], rows, policy);
    expect(gates.map((g) => [g.language, g.assistants.length, g.ok])).toEqual([
      ['python', 1, false],
      ['javascript', 2, true],
    ]);
  });
  it('AI-5: a minimum of 0 turns the gate off', () => {
    expect(aiGate(['java'], [], { ...policy, minAssistants: 0 })[0]?.ok).toBe(true);
  });
  it('AI-4: refresh is due only when the newest row is older than refreshDays', () => {
    expect(aiRefreshDue([], 90, NOW)).toBe(false);
    expect(aiRefreshDue([ref('python', 'A', '2026-07-05T00:00:00Z')], 90, NOW)).toBe(true);
    // The API sends null until it implements the interval: never due, the web invents none.
    expect(aiRefreshDue([ref('python', 'A', '2020-01-01T00:00:00Z')], null, NOW)).toBe(false);
    expect(
      aiRefreshDue(
        [ref('python', 'A', '2026-06-01T00:00:00Z'), ref('java', 'B', '2026-09-20T00:00:00Z')],
        90,
        NOW,
      ),
    ).toBe(false);
  });
  it('TC-012: publish needs saved, validated and (coding) the AI gate; never twice', () => {
    const ok = aiGate(
      ['python'],
      [ref('python', 'A', '2026-10-01T00:00:00Z'), ref('python', 'B', '2026-10-01T00:00:00Z')],
      policy,
    );
    const base = {
      type: 'CODING' as const,
      isPublished: false,
      dirty: false,
      validationPassed: true,
      aiGates: ok,
      tests: { count: 2, hasVisible: true, hasHidden: true, weightsOk: true },
    };
    expect(canPublish(base)).toBe(true);
    // The server's test rules (S5): at least one visible, one hidden, every weight above 0.
    expect(canPublish({ ...base, tests: { ...base.tests, hasVisible: false } })).toBe(false);
    expect(canPublish({ ...base, tests: { ...base.tests, hasHidden: false } })).toBe(false);
    expect(canPublish({ ...base, tests: { ...base.tests, weightsOk: false } })).toBe(false);
    expect(
      canPublish({
        ...base,
        tests: { count: 0, hasVisible: false, hasHidden: false, weightsOk: true },
      }),
    ).toBe(false);
    // An unknown policy closes the AI gate.
    expect(aiGate(['python'], [], null)[0]?.ok).toBe(false);
    expect(canPublish({ ...base, dirty: true })).toBe(false);
    expect(canPublish({ ...base, validationPassed: false })).toBe(false);
    expect(canPublish({ ...base, aiGates: aiGate(['python'], [], policy) })).toBe(false);
    expect(canPublish({ ...base, isPublished: true })).toBe(false);
    // Other types have no AI gate.
    expect(publishChecks({ ...base, type: 'MCQ', aiGates: [] }).map((c) => c.id)).toEqual([
      'saved',
    ]);
    expect(canPublish({ ...base, type: 'MCQ', aiGates: [] })).toBe(true);
  });
});

describe('question draft (FR-201..FR-205)', () => {
  const valid = (patch: Partial<DraftValues> = {}): DraftValues => ({
    ...emptyDraft('CODING'),
    title: 'T',
    statementMd: 'S',
    ...patch,
  });
  it('FR-205 D-23: normalises short answers like the API (NFKC, trim, collapse spaces, lower case)', () => {
    expect(normalizeShortAnswer('  Ｈｅｌｌｏ   WORLD ')).toBe('hello world');
  });
  it('FR-202: a weight must be above 0', () => {
    const tc = { id: 'a', input: '', expectedOutput: '', isHidden: false };
    expect(draftSchema.safeParse(valid({ testCases: [{ ...tc, weight: 0 }] })).success).toBe(false);
    expect(
      draftSchema.safeParse(valid({ testCases: [{ ...tc, weight: Number.NaN }] })).success,
    ).toBe(false);
    expect(draftSchema.safeParse(valid({ testCases: [{ ...tc, weight: 2 }] })).success).toBe(true);
  });
  it('FR-203: toVariants keeps only overrides of existing slots; toUpdate drops other languages and sends no test cases', () => {
    const d = valid({
      allowedLanguages: ['python'],
      starterCode: { python: 'a', java: 'b' },
      testCases: [{ id: 't1', input: '', expectedOutput: '', isHidden: false, weight: 1 }],
      variants: [
        {
          id: 'v',
          paramsText: '{"n": 2}',
          active: true,
          overrides: [
            { testCaseId: 't1', input: 'i', expectedOutput: 'o' },
            { testCaseId: 'gone', input: 'i', expectedOutput: 'o' },
          ],
        },
      ],
    });
    const update = toUpdate(d);
    expect(update.starterCode).toEqual({ python: 'a' });
    expect(update).not.toHaveProperty('testCases');
    expect(update).not.toHaveProperty('answerSpec');
    const [variant] = toVariants(d);
    expect(variant).toMatchObject({ params: { n: 2 }, isActive: true });
    expect(variant?.overrides).toHaveLength(1);
  });

  it('FR-205: an answer spec has no `type` key (the question type decides) and option ids fit the API rule', () => {
    const mcq = valid({ type: 'MCQ', allowedLanguages: [] });
    mcq.mcq = {
      options: [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
      ],
      correctOptionIds: ['a'],
      multiple: false,
    };
    expect(toUpdate(mcq).answerSpec).toEqual({
      options: [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
      ],
      correctOptionIds: ['a'],
      multiple: false,
    });
    expect(emptyDraft('MCQ').mcq.options.every((o) => /^[A-Za-z0-9_-]{1,32}$/.test(o.id))).toBe(
      true,
    );
    const short = valid({ type: 'SHORT_ANSWER', allowedLanguages: [] });
    short.short = { canonical: ' 201 ', acceptedVariants: [{ key: 'k', value: ' ok ' }] };
    expect(toUpdate(short).answerSpec).toEqual({ canonical: '201', acceptedVariants: ['ok'] });
  });

  it('FR-201: limits and tags follow the API rules', () => {
    expect(
      draftSchema.safeParse(valid({ limits: { cpuMs: 2000, wallMs: 25_000, memoryKb: 262_144 } }))
        .success,
    ).toBe(false);
    expect(
      draftSchema.safeParse(valid({ limits: { cpuMs: 2000, wallMs: 1000, memoryKb: 262_144 } }))
        .success,
    ).toBe(false);
    expect(draftSchema.safeParse(valid({ tagsText: 'arrays, Sorting' })).success).toBe(true);
    expect(draftSchema.safeParse(valid({ tagsText: '!bad' })).success).toBe(false);
  });
});
