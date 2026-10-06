import { mcqAnswerSpecSchema, normalizeShortAnswer, shortAnswerSpecSchema } from './answer-spec';
import { checkLimits, limitsFromStored, publishProblems, shapeProblems } from './question-content';
import type { PublishFields } from './question-content';

const coding: PublishFields = {
  title: 'T',
  statementMd: 'S',
  limits: { cpu_ms: 2000, wall_ms: 5000, memory_kb: 262_144 },
  allowedLanguages: ['python'],
  starterCode: { python: 'x' },
  referenceSolution: { python: 'print(1)' },
  answerSpec: null,
};
const good = [
  { isHidden: false, weight: 1 },
  { isHidden: true, weight: 2 },
];

describe('answer_spec (FR-205, D-23)', () => {
  it('FR-205: normalization is NFKC, trim, collapsed whitespace, lower case', () => {
    expect(normalizeShortAnswer('  Ｈello   \t World ')).toBe('hello world');
  });

  it('TC-014: MCQ spec rules', () => {
    const options = [
      { id: 'a', text: 'A' },
      { id: 'b', text: 'B' },
    ];
    expect(
      mcqAnswerSpecSchema.safeParse({ options, correctOptionIds: ['a'], multiple: false }).success,
    ).toBe(true);
    expect(
      mcqAnswerSpecSchema.safeParse({ options, correctOptionIds: ['a', 'b'], multiple: true })
        .success,
    ).toBe(true);
    expect(
      mcqAnswerSpecSchema.safeParse({ options, correctOptionIds: ['a', 'b'], multiple: false })
        .success,
    ).toBe(false);
    expect(
      mcqAnswerSpecSchema.safeParse({ options, correctOptionIds: ['z'], multiple: false }).success,
    ).toBe(false);
    expect(
      mcqAnswerSpecSchema.safeParse({
        options: [options[0]],
        correctOptionIds: ['a'],
        multiple: false,
      }).success,
    ).toBe(false);
    expect(
      mcqAnswerSpecSchema.safeParse({
        options: [options[0], options[0]],
        correctOptionIds: ['a'],
        multiple: false,
      }).success,
    ).toBe(false);
    expect(
      mcqAnswerSpecSchema.safeParse({ options, correctOptionIds: ['a'], multiple: false, extra: 1 })
        .success,
    ).toBe(false);
  });

  it('FR-205: short answer spec rules', () => {
    expect(
      shortAnswerSpecSchema.safeParse({ canonical: 'Paris', acceptedVariants: ['paris, france'] })
        .success,
    ).toBe(true);
    expect(
      shortAnswerSpecSchema.safeParse({ canonical: '   ', acceptedVariants: [] }).success,
    ).toBe(false);
    expect(
      shortAnswerSpecSchema.safeParse({ canonical: 'x', acceptedVariants: Array(21).fill('y') })
        .success,
    ).toBe(false);
  });
});

describe('content rules (FR-201, FR-202)', () => {
  it('FR-201: a complete coding question has no publish problems', () => {
    expect(publishProblems('CODING', coding, good)).toEqual([]);
  });

  it('FR-202: publish needs a sample, a hidden test, positive weights and a reference solution', () => {
    expect(publishProblems('CODING', coding, [])).toEqual(
      expect.arrayContaining(['testCases: at least one']),
    );
    expect(publishProblems('CODING', coding, [{ isHidden: true, weight: 1 }])).toEqual(
      expect.arrayContaining(['testCases: at least one sample (not hidden)']),
    );
    expect(publishProblems('CODING', coding, [{ isHidden: false, weight: 1 }])).toEqual(
      expect.arrayContaining(['testCases: at least one hidden test']),
    );
    expect(publishProblems('CODING', coding, [...good, { isHidden: true, weight: 0 }])).toEqual(
      expect.arrayContaining(['testCases: every weight must be above 0']),
    );
    expect(publishProblems('CODING', { ...coding, referenceSolution: {} }, good)).toEqual(
      expect.arrayContaining(['referenceSolution: at least one language']),
    );
    expect(
      publishProblems('CODING', { ...coding, referenceSolution: { java: 'x' } }, good),
    ).toEqual(expect.arrayContaining(['referenceSolution.java: language is not allowed']));
    expect(publishProblems('CODING', { ...coding, allowedLanguages: [] }, good)).toEqual(
      expect.arrayContaining(['allowedLanguages: at least one language']),
    );
  });

  it('FR-205: MCQ and short answer need a valid answer_spec and no test cases or code', () => {
    const base = { ...coding, allowedLanguages: [], starterCode: {}, referenceSolution: {} };
    expect(publishProblems('SHORT_ANSWER', base, [])).toContain('answerSpec: required to publish');
    expect(
      publishProblems(
        'SHORT_ANSWER',
        { ...base, answerSpec: { canonical: 'a', acceptedVariants: [] } },
        [],
      ),
    ).toEqual([]);
    expect(
      publishProblems(
        'SHORT_ANSWER',
        { ...base, answerSpec: { canonical: 'a', acceptedVariants: [] } },
        good,
      ),
    ).toEqual(['testCases: not allowed on a SHORT_ANSWER question']);
    expect(shapeProblems('MCQ', { ...base, allowedLanguages: ['python'] })).toContain(
      'allowedLanguages: must be empty on a MCQ question',
    );
    expect(shapeProblems('CODING', { ...coding, answerSpec: { canonical: 'a' } })).toContain(
      'answerSpec: not allowed on a CODING question',
    );
    expect(
      shapeProblems('MCQ', { ...base, answerSpec: { canonical: 'a', acceptedVariants: [] } }),
    ).not.toEqual([]);
  });

  it('FR-201: code maps accept only known languages', () => {
    expect(shapeProblems('CODING', { ...coding, starterCode: { cobol: 'x' } })).not.toEqual([]);
  });

  it('FR-201: limits fall back to defaults when stored data is malformed; wall may not be below cpu', () => {
    expect(limitsFromStored({ nope: 1 })).toEqual({ cpuMs: 2000, wallMs: 5000, memoryKb: 262_144 });
    expect(checkLimits({ cpuMs: 3000, wallMs: 2000, memoryKb: 65_536 })).toContain(
      'limits: wallMs must not be below cpuMs',
    );
    expect(checkLimits({ cpuMs: 1000, wallMs: 2000, memoryKb: 65_536 })).toEqual([]);
  });
});
