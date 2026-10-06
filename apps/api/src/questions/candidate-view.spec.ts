import { InvalidAnswerSpecError, toCandidateQuestion } from './candidate-view';
import type { CandidateTestCaseSource, CandidateVersionSource } from './candidate-view';

const SECRETS = [
  'SECRET-HIDDEN-INPUT',
  'SECRET-HIDDEN-OUTPUT',
  'SECRET-REFERENCE-SOLUTION',
  'SECRET-AI-REFERENCE',
  'SECRET-CANONICAL',
  'SECRET-VARIANT-ACCEPTED',
  'SECRET-VARIANT-PARAMS',
  'SECRET-MCQ-KEY-OPTION',
];

function codingSource(): CandidateVersionSource & Record<string, unknown> {
  return {
    type: 'CODING',
    title: 'Two sum',
    statementMd: 'Find two numbers.',
    allowedLanguages: ['python', 'java'],
    limits: { cpu_ms: 1000, wall_ms: 3000, memory_kb: 65_536 },
    starterCode: {
      python: 'def f(): pass',
      java: 'class Main {}',
      cobol: 'SECRET-REFERENCE-SOLUTION',
    },
    answerSpec: { canonical: 'SECRET-CANONICAL', acceptedVariants: ['SECRET-VARIANT-ACCEPTED'] },
    // every other column of question_versions and its relations, populated:
    id: 'v1',
    referenceSolution: { python: 'SECRET-REFERENCE-SOLUTION' },
    aiReferenceSolutions: [{ solutionCode: 'SECRET-AI-REFERENCE' }],
    variants: [{ params: { n: 'SECRET-VARIANT-PARAMS' } }],
    validationReport: { note: 'SECRET-REFERENCE-SOLUTION' },
  };
}

const cases: (CandidateTestCaseSource & Record<string, unknown>)[] = [
  { input: '1 2', expectedOutput: '3', isHidden: false, position: 1, weight: 1 },
  {
    input: 'SECRET-HIDDEN-INPUT',
    expectedOutput: 'SECRET-HIDDEN-OUTPUT',
    isHidden: true,
    position: 0,
  },
  { input: '5 5', expectedOutput: '10', isHidden: false, position: 2 },
];

describe('toCandidateQuestion (FR-202, TC-011)', () => {
  it('TC-011: shows the statement and sample cases only; no hidden case, reference, AI reference, answer_spec or variant params', () => {
    const out = JSON.stringify(toCandidateQuestion(codingSource(), cases));
    for (const s of SECRETS) expect(out).not.toContain(s);
    expect(out).not.toMatch(
      /referenceSolution|answerSpec|aiReference|variants|params|validationReport/,
    );
  });

  it('TC-011: returns exactly the allowed keys (a new column cannot leak)', () => {
    const view = toCandidateQuestion(codingSource(), cases);
    expect(Object.keys(view).sort()).toEqual(
      ['languages', 'limits', 'samples', 'starterCode', 'statementMd', 'title', 'type'].sort(),
    );
    expect(Object.keys(view.samples[0] ?? {}).sort()).toEqual(['expectedOutput', 'input']);
  });

  it('TC-011: samples are the non-hidden cases in position order; hidden cases are dropped', () => {
    const view = toCandidateQuestion(codingSource(), cases);
    expect(view.samples).toEqual([
      { input: '1 2', expectedOutput: '3' },
      { input: '5 5', expectedOutput: '10' },
    ]);
  });

  it('TC-011: property style, every test-case permutation and every hidden flag keeps hidden data out', () => {
    for (let mask = 0; mask < 1 << 5; mask++) {
      const many = Array.from({ length: 5 }, (_, i) => {
        const hidden = (mask & (1 << i)) !== 0;
        return {
          input: hidden ? `SECRET-HIDDEN-INPUT-${i}` : `in${i}`,
          expectedOutput: hidden ? `SECRET-HIDDEN-OUTPUT-${i}` : `out${i}`,
          isHidden: hidden,
          position: 5 - i,
        };
      });
      const out = JSON.stringify(toCandidateQuestion(codingSource(), many));
      expect(out).not.toContain('SECRET-HIDDEN');
      expect(out).not.toContain('SECRET-REFERENCE-SOLUTION');
    }
  });

  it('FR-201: only starter code of allowed languages, only strings, is shown', () => {
    const v = toCandidateQuestion(codingSource(), cases);
    expect(v.starterCode).toEqual({ python: 'def f(): pass', java: 'class Main {}' });
    expect(v.languages).toEqual(['python', 'java']);
    expect(v.limits).toEqual({ cpuMs: 1000, wallMs: 3000, memoryKb: 65_536 });
  });

  it('FR-203 (4b hook): a rendered statement replaces the plain one', () => {
    expect(
      toCandidateQuestion(codingSource(), cases, { statementMd: 'Rendered n=7' }).statementMd,
    ).toBe('Rendered n=7');
  });

  it('TC-014, FR-205: an MCQ shows option ids, texts and the single/multiple flag, never the key', () => {
    const mcq = {
      ...codingSource(),
      type: 'MCQ' as const,
      allowedLanguages: [],
      starterCode: {},
      answerSpec: {
        options: [
          { id: 'a', text: 'Red' },
          { id: 'b', text: 'Blue' },
        ],
        correctOptionIds: ['b'],
        multiple: false,
      },
    };
    const view = toCandidateQuestion(mcq, cases);
    expect(view.mcq).toEqual({
      multiple: false,
      options: [
        { id: 'a', text: 'Red' },
        { id: 'b', text: 'Blue' },
      ],
    });
    expect(JSON.stringify(view)).not.toContain('correctOptionIds');
    expect(view.samples).toEqual([]);
  });

  it('FR-205: a SHORT_ANSWER view has no answer data at all', () => {
    const sa = {
      ...codingSource(),
      type: 'SHORT_ANSWER' as const,
      allowedLanguages: [],
      starterCode: {},
    };
    const view = toCandidateQuestion(sa, []);
    expect(view.mcq).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('SECRET');
  });

  it('FR-205: a broken MCQ answer_spec is an error, never a half-shown question', () => {
    const bad = { ...codingSource(), type: 'MCQ' as const, answerSpec: { options: 'x' } };
    expect(() => toCandidateQuestion(bad, [])).toThrow(InvalidAnswerSpecError);
  });

  it('does not mutate its input', () => {
    const src = codingSource();
    const before = JSON.stringify(src);
    const list = [...cases];
    toCandidateQuestion(src, list);
    expect(JSON.stringify(src)).toBe(before);
    expect(list).toEqual(cases);
  });
});
