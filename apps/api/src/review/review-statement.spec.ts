// The reviewer sees the statement the candidate saw (FR-105, FR-202, FR-205).
import { reviewStatement } from './review-statement';

const TEMPLATE = 'Print {{item}} at most {{limit}} times.';

describe('reviewStatement (FR-105, FR-202, FR-205)', () => {
  it('FR-105: applies the variant params to the template', () => {
    expect(
      reviewStatement(TEMPLATE, {
        params: { item: 'widget', limit: 3 },
        renderedStatement: 'stored text',
      }),
    ).toBe('Print widget at most 3 times.');
  });

  it('FR-202: two variants of the same template render their own values', () => {
    const a = reviewStatement(TEMPLATE, { params: { item: 'a', limit: 1 }, renderedStatement: '' });
    const b = reviewStatement(TEMPLATE, { params: { item: 'b', limit: 2 }, renderedStatement: '' });
    expect(a).toBe('Print a at most 1 times.');
    expect(b).toBe('Print b at most 2 times.');
  });

  it('FR-105: no variant returns the plain statement unchanged', () => {
    expect(reviewStatement('Plain text', null)).toBe('Plain text');
    expect(reviewStatement('Plain text', undefined)).toBe('Plain text');
  });

  it('FR-105: an unknown placeholder falls back to the stored rendering, then the raw statement', () => {
    const params = { item: 'x' };
    expect(reviewStatement(TEMPLATE, { params, renderedStatement: 'stored' })).toBe('stored');
    expect(reviewStatement(TEMPLATE, { params, renderedStatement: '' })).toBe(TEMPLATE);
  });

  it('FR-105: invalid stored params and a bad template never throw', () => {
    expect(reviewStatement(TEMPLATE, { params: 'nope', renderedStatement: '' })).toBe(TEMPLATE);
    expect(reviewStatement('{{ unclosed', { params: {}, renderedStatement: '' })).toBe(
      '{{ unclosed',
    );
    expect(reviewStatement('{{#sec}}x{{/sec}}', { params: {}, renderedStatement: '' })).toBe(
      '{{#sec}}x{{/sec}}',
    );
  });

  it('FR-105: an escaped brace stays literal and a param value is not rendered again', () => {
    expect(
      reviewStatement('\\{{item}} {{item}}', {
        params: { item: '{{limit}}' },
        renderedStatement: '',
      }),
    ).toBe('{{item}} {{limit}}');
  });
});
