import { describe, expect, it } from 'vitest';
import type { Schemas } from '@/lib/api/client';
import {
  draftSchema,
  emptyDraft,
  normalizeShortAnswer,
  toContent,
  type DraftValues,
} from './draft';
import { aiGate, aiRefreshDue, canPublish, publishChecks } from './gate';
import { checkParams, parseParams } from './params';
import { hasUnsupportedSyntax, placeholdersOf, renderTemplate } from './template';

const NOW = new Date('2026-10-05T00:00:00Z');
const policy = { refreshDays: 90, minAssistants: 2 };
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
  collectedAt,
  collectedByName: 'a',
  supersededAt,
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

describe('variant parameters (FR-203)', () => {
  const defs: Schemas['ParamDef'][] = [
    { name: 'n', type: 'number' },
    { name: 'xs', type: 'array' },
  ];
  it('FR-203: parses only JSON objects', () => {
    expect(parseParams('{"n": 1}')).toEqual({ ok: true, value: { n: 1 } });
    expect(parseParams('').ok).toBe(false);
    expect(parseParams('[1]').ok).toBe(false);
    expect(parseParams('{').ok).toBe(false);
  });
  it('FR-203: checks types, missing and undeclared keys', () => {
    expect(checkParams({ n: 1, xs: [] }, defs)).toEqual([]);
    expect(checkParams({ n: '1', xs: [] }, defs)).toEqual(['"n" must be a number.']);
    expect(checkParams({ xs: [] }, defs)[0]).toMatch(/"n" is missing/);
    expect(checkParams({ n: 1, xs: [], z: 1 }, defs)[0]).toMatch(/"z" is not a declared parameter/);
    expect(checkParams({ n: Number.NaN, xs: [] }, defs)).toEqual(['"n" must be a number.']);
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
    expect(aiRefreshDue([], policy, NOW)).toBe(false);
    expect(aiRefreshDue([ref('python', 'A', '2026-07-05T00:00:00Z')], policy, NOW)).toBe(true);
    expect(
      aiRefreshDue(
        [ref('python', 'A', '2026-06-01T00:00:00Z'), ref('java', 'B', '2026-09-20T00:00:00Z')],
        policy,
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
    };
    expect(canPublish(base)).toBe(true);
    expect(canPublish({ ...base, dirty: true })).toBe(false);
    expect(canPublish({ ...base, validationPassed: false })).toBe(false);
    expect(canPublish({ ...base, aiGates: aiGate(['python'], [], policy) })).toBe(false);
    expect(canPublish({ ...base, isPublished: true })).toBe(false);
    // Other types have no AI gate.
    expect(publishChecks({ ...base, type: 'MCQ', aiGates: [] }).map((c) => c.id)).toEqual([
      'saved',
      'validated',
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
  it('FR-203: toContent keeps only overrides of existing slots and drops other languages', () => {
    const d = valid({
      allowedLanguages: ['python'],
      starterCode: { python: 'a', java: 'b' },
      testCases: [{ id: 't1', input: '', expectedOutput: '', isHidden: false, weight: 1 }],
      paramSchema: [{ name: 'n', type: 'number', key: 'k' }],
      variants: [
        {
          id: 'v',
          label: ' V ',
          paramsText: '{"n": 2}',
          active: true,
          overrides: [
            { testCaseId: 't1', input: 'i', expectedOutput: 'o' },
            { testCaseId: 'gone', input: 'i', expectedOutput: 'o' },
          ],
        },
      ],
    });
    const c = toContent(d);
    expect(c.starterCode).toEqual({ python: 'a' });
    expect(c.variants[0]).toMatchObject({ label: 'V', params: { n: 2 } });
    expect(c.variants[0]?.overrides).toHaveLength(1);
  });
});
