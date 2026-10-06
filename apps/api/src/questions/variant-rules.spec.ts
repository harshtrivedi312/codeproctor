import { mergeSlots, variantPublishProblems } from './variant-rules';
import type { VariantRow } from './question-tx';

const content = { statementMd: 'N = {{n}}', starterCode: {}, referenceSolution: { python: 'x' } };
const variant = (over: Partial<VariantRow>): VariantRow => ({
  id: 'v1',
  params: { n: 1 },
  renderedStatement: '',
  isActive: true,
  testCaseOverrides: [],
  ...over,
});

describe('Variant publish rules (FR-203, ADR 0007 V-2, V-6)', () => {
  it('FR-203: a clean active variant passes and its statement is rendered', () => {
    const r = variantPublishProblems(content, new Set(['s1']), [variant({})]);
    expect(r.problems).toEqual([]);
    expect(r.rendered.get('v1')).toBe('N = 1');
  });

  it('FR-203: an active variant with a missing param fails, naming the variant and field', () => {
    const r = variantPublishProblems(content, new Set(), [variant({ params: {} })]);
    expect(r.problems).toEqual(['variants[v1].statementMd: offset 4: unknown placeholder "n"']);
  });

  it('FR-203: an inactive variant is not rendered, so it does not block publishing', () => {
    const r = variantPublishProblems(content, new Set(), [
      variant({ params: {}, isActive: false }),
    ]);
    expect(r.problems).toEqual([]);
  });

  it('FR-203, V-6: an override of a slot outside the version fails, active or not', () => {
    const o = { testCaseId: 'other', input: 'i', expectedOutput: 'o' };
    for (const isActive of [true, false]) {
      const r = variantPublishProblems(content, new Set(['s1']), [
        variant({ isActive, testCaseOverrides: [o] }),
      ]);
      expect(r.problems).toEqual([
        'variants[v1]: overrides a test slot that is not in this version',
      ]);
    }
  });

  it('FR-203: corrupt stored params are a problem, not a crash', () => {
    const r = variantPublishProblems(content, new Set(), [variant({ params: { a: { b: 1 } } })]);
    expect(r.problems.length).toBe(1);
  });
});

describe('mergeSlots (ADR 0007 V-1, V-5)', () => {
  it('FR-203: an override replaces input and output only; the hidden flag and position follow the slot', () => {
    const slots = [
      { id: 's1', input: 'a', expectedOutput: 'b', isHidden: false, position: 0 },
      { id: 's2', input: 'c', expectedOutput: 'd', isHidden: true, position: 1 },
    ];
    expect(mergeSlots(slots, [{ testCaseId: 's2', input: 'X', expectedOutput: 'Y' }])).toEqual([
      { input: 'a', expectedOutput: 'b', isHidden: false, position: 0 },
      { input: 'X', expectedOutput: 'Y', isHidden: true, position: 1 },
    ]);
  });
});
