import {
  classifyShortAnswer,
  codingScore,
  formatHundredths,
  mcqCorrect,
  toHundredths,
  weightedScore,
} from './scoring';

const w = (n: number): bigint => BigInt(n) * 100n;

describe('scoring arithmetic (FR-506, TC-048)', () => {
  it('TC-048: weights 1, 1, 2, 2, 4 with the tests weighted 1, 2 and 4 passing score exactly 70.00', () => {
    const tests = [
      { passed: true, weight: w(1) },
      { passed: false, weight: w(1) },
      { passed: true, weight: w(2) },
      { passed: false, weight: w(2) },
      { passed: true, weight: w(4) },
    ];
    expect(formatHundredths(codingScore(toHundredths('100.00'), tests))).toBe('70.00');
  });

  it('FR-506: all pass is full points, none is 0.00, no hidden weight is 0.00', () => {
    const ok = [{ passed: true, weight: w(3) }];
    expect(formatHundredths(codingScore(toHundredths('50'), ok))).toBe('50.00');
    expect(
      formatHundredths(codingScore(toHundredths('50'), [{ passed: false, weight: w(3) }])),
    ).toBe('0.00');
    expect(codingScore(toHundredths('50'), [])).toBe(0n);
  });

  it('FR-506: rounds half up to hundredths with no float error (100 x 1 / 3 and 100 x 2 / 3)', () => {
    expect(formatHundredths(weightedScore(10000n, 100n, 300n))).toBe('33.33');
    expect(formatHundredths(weightedScore(10000n, 200n, 300n))).toBe('66.67');
    // 0.5 hundredth rounds up: 0.01 points x 1/2 -> 0.01 (half up), never banker's rounding.
    expect(weightedScore(1n, 1n, 2n)).toBe(1n);
  });

  it('FR-506: decimal weights and points parse exactly', () => {
    expect(toHundredths('7.5')).toBe(750n);
    expect(toHundredths('0.05')).toBe(5n);
    expect(() => toHundredths('1.005')).toThrow();
    expect(() => toHundredths('-1')).toThrow();
    expect(formatHundredths(5n)).toBe('0.05');
  });
});

describe('MCQ and short answer scoring (FR-205, D-23, TC-099)', () => {
  const spec = { canonical: 'Photosynthesis', acceptedVariants: ['the process of photosynthesis'] };

  it('TC-099: an accepted variant in other case and spacing, and the exact answer, score automatically', () => {
    expect(classifyShortAnswer(spec, { text: '  THE   Process\tof PHOTOSYNTHESIS ' })).toBe(
      'CORRECT',
    );
    expect(classifyShortAnswer(spec, { text: 'Photosynthesis' })).toBe('CORRECT');
  });

  it('TC-099: NFKC folding counts (full-width letters match)', () => {
    expect(classifyShortAnswer(spec, { text: 'Ｐｈｏｔｏｓｙｎｔｈｅｓｉｓ' })).toBe('CORRECT');
  });

  it('TC-099: an unlisted wording is NEEDS_MANUAL, never wrong by machine; an empty answer is plain zero', () => {
    expect(classifyShortAnswer(spec, { text: 'plants turn light into sugar' })).toBe(
      'NEEDS_MANUAL',
    );
    expect(classifyShortAnswer(spec, { text: '   ' })).toBe('UNANSWERED');
    expect(classifyShortAnswer(spec, null)).toBe('UNANSWERED');
    expect(classifyShortAnswer(spec, { text: 'x', extra: 1 })).toBe('UNANSWERED');
  });

  it('FR-205: MCQ is right only when the selected set equals the key', () => {
    const mcq = {
      options: [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
        { id: 'c', text: 'C' },
      ],
      correctOptionIds: ['a', 'c'],
      multiple: true,
    };
    expect(mcqCorrect(mcq, { optionIds: ['c', 'a'] }, (id) => id)).toBe(true);
    expect(mcqCorrect(mcq, { optionIds: ['a'] }, (id) => id)).toBe(false);
    expect(mcqCorrect(mcq, { optionIds: ['a', 'b', 'c'] }, (id) => id)).toBe(false);
    expect(mcqCorrect(mcq, null, (id) => id)).toBe(false);
  });
});
