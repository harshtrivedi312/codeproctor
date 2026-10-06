import { parseRandomRule, ruleKey } from './random-rule';

describe('TC-020 part 1 (FR-301): random-pick rule shape', () => {
  it('TC-020: accepts exactly tags, difficulty and type, lower-casing and trimming tags', () => {
    const r = parseRandomRule({ tags: [' Arrays '], difficulty: 'MEDIUM', type: 'CODING' });
    expect(r).toEqual({
      ok: true,
      rule: { tags: ['arrays'], difficulty: 'MEDIUM', type: 'CODING' },
    });
  });

  it('TC-020: an empty rule is allowed and has no keys', () => {
    expect(parseRandomRule({})).toEqual({ ok: true, rule: {} });
  });

  it.each([
    ['unknown key', { tags: ['a'], bogus: 1 }],
    ['count is not part of the rule', { count: 2 }],
    ['empty tags', { tags: [] }],
    ['duplicate tags', { tags: ['a', 'A'] }],
    ['too many tags', { tags: Array.from({ length: 21 }, (_v, i) => `t${i}`) }],
    ['bad difficulty', { difficulty: 'IMPOSSIBLE' }],
    ['bad type', { type: 'ESSAY' }],
    ['NUL in a tag', { tags: ['a\u0000b'] }],
    ['lone surrogate in a tag', { tags: ['a\ud800'] }],
    ['null', null],
    ['array', []],
    ['string', 'arrays'],
    ['explicit null difficulty', { difficulty: null }],
  ])('TC-020: refuses %s', (_name, raw) => {
    expect(parseRandomRule(raw).ok).toBe(false);
  });

  it('TC-020: rules with the same meaning have the same key', () => {
    expect(ruleKey({ tags: ['b', 'a'], difficulty: 'EASY' })).toBe(
      ruleKey({ difficulty: 'EASY', tags: ['a', 'b'] }),
    );
    expect(ruleKey({ tags: ['a'] })).not.toBe(ruleKey({ tags: ['a'], type: 'MCQ' }));
  });
});
