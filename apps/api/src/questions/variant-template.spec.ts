import {
  isValidName,
  paramsProblems,
  renderContent,
  renderTemplate,
  templateNames,
} from './variant-template';

const ok = (r: ReturnType<typeof renderTemplate>): string => {
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.text;
};

describe('Variant template renderer (FR-203, ADR 0007 V-2)', () => {
  it('FR-203: substitutes {{name}} with the variant param, with or without inner spaces, numbers and booleans as text', () => {
    expect(
      ok(renderTemplate('Sum {{ n }} and {{m}}: {{flag}}', { n: 5, m: 'x', flag: true }, 100)),
    ).toBe('Sum 5 and x: true');
  });

  it('FR-203: nothing is HTML-escaped (the output is Markdown and code, sanitized downstream)', () => {
    expect(ok(renderTemplate('if a {{op}} b', { op: '<' }, 100))).toBe('if a < b');
  });

  it('FR-203: an unknown placeholder is an error naming it, never an empty string', () => {
    const r = renderTemplate('Use {{size}} and {{other}}', { size: 3 }, 100);
    expect(r).toEqual({ ok: false, errors: ['offset 17: unknown placeholder "other"'] });
  });

  it('FR-203: only plain variable tags exist: sections, partials, comments, triple mustache, unescaped, delimiters, helpers and dotted paths are errors', () => {
    for (const t of [
      '{{#a}}x{{/a}}',
      '{{^a}}x{{/a}}',
      '{{> partial}}',
      '{{! comment}}',
      '{{{a}}}',
      '{{& a}}',
      '{{=<% %>=}}',
      '{{a.b}}',
      '{{constructor}}',
      '{{__proto__}}',
      '{{ }}',
      '{{a b}}',
      '{{fn(1)}}',
      '{{a}',
    ]) {
      const r = renderTemplate(t, { a: 1, b: 2 }, 100);
      expect([t, r.ok]).toEqual([t, false]);
    }
  });

  it('FR-203: \\{{ writes a literal {{ (so source code containing braces can be kept)', () => {
    expect(ok(renderTemplate('const o = \\{{a: {{n}}}};', { n: 1 }, 100))).toBe(
      'const o = {{a: 1}};',
    );
  });

  it('FR-203: a param value is inserted once and never rendered again (no recursion)', () => {
    expect(ok(renderTemplate('{{a}}', { a: '{{b}}', b: 'deep' }, 100))).toBe('{{b}}');
  });

  it('FR-203: lookups use own properties only; a prototype name is unknown even if params inherit it', () => {
    const inherited = Object.create({ secret: 'LEAK' }) as Record<string, string>;
    expect(renderTemplate('{{secret}}', inherited, 100).ok).toBe(false);
  });

  it('FR-203: the rendered length is bounded while it is built', () => {
    const r = renderTemplate('{{a}}{{a}}{{a}}', { a: 'x'.repeat(40) }, 100);
    expect(r).toEqual({ ok: false, errors: ['the rendered text is longer than 100 characters'] });
  });

  it('FR-203: an unclosed tag, and a huge tag with no end, are errors and cost linear time', () => {
    expect(renderTemplate('a {{b', {}, 100).ok).toBe(false);
    const big = `{{${'x'.repeat(50_000)}`;
    const started = Date.now();
    expect(renderTemplate(big, {}, 100_000).ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('FR-203: error lists are bounded', () => {
    const r = renderTemplate('{{#a}}'.repeat(500), {}, 100_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeLessThanOrEqual(20);
  });

  it('FR-203: templateNames lists each used name once', () => {
    expect(templateNames('{{a}} {{b}} {{a}}')).toEqual({ names: ['a', 'b'], errors: [] });
  });

  it('FR-203: renderContent renders statement, starter code and reference solution, labels errors by field', () => {
    const content = {
      statementMd: 'Array of {{n}}',
      starterCode: { python: 'N = {{n}}' },
      referenceSolution: { python: 'N = {{n}}; M = {{m}}' },
    };
    expect(renderContent(content, { n: 4 })).toEqual({
      ok: false,
      errors: ['referenceSolution.python: offset 15: unknown placeholder "m"'],
    });
    expect(renderContent(content, { n: 4, m: 2 })).toEqual({
      ok: true,
      content: {
        statementMd: 'Array of 4',
        starterCode: { python: 'N = 4' },
        referenceSolution: { python: 'N = 4; M = 2' },
      },
    });
  });
});

describe('Variant params rules (FR-203, prototype pollution)', () => {
  it('FR-203: accepts a flat object of strings, finite numbers and booleans', () => {
    expect(paramsProblems({ n: 1, name: 'Ada', on: false, empty: '' })).toEqual([]);
  });

  it('FR-203: refuses prototype keys, nested values, null, non-finite numbers, arrays and non-objects', () => {
    const polluted = JSON.parse('{"__proto__": {"x": 1}}') as unknown;
    for (const bad of [
      polluted,
      { constructor: 1 },
      { prototype: 1 },
      { __a: 1 },
      { '1a': 1 },
      { 'a.b': 1 },
      { a: { b: 1 } },
      { a: null },
      { a: [1] },
      { a: Number.POSITIVE_INFINITY },
      { a: Number.NaN },
      [],
      null,
      'x',
      42,
    ]) {
      expect([JSON.stringify(bad), paramsProblems(bad).length > 0]).toEqual([
        JSON.stringify(bad),
        true,
      ]);
    }
  });

  it('FR-203: bounds on count, value length, total size and storable text', () => {
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`p${i}`, 1]));
    expect(paramsProblems(many)).toContain('at most 50 parameters');
    expect(paramsProblems({ a: 'x'.repeat(1001) }).length).toBe(1);
    expect(paramsProblems({ a: 'a\u0000b' }).length).toBe(1);
    expect(paramsProblems({ a: 'a\ud800b' }).length).toBe(1);
    const wide = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`p${i}`, 'y'.repeat(1000)]),
    );
    expect(paramsProblems(wide)).toContain('parameters are too large in total');
  });

  it('FR-203: name rule', () => {
    expect(['n', 'size_2', '_x', 'A'].every(isValidName)).toBe(true);
    expect(
      ['', '__proto__', 'constructor', 'prototype', '2x', 'a-b', 'x'.repeat(41)].some(isValidName),
    ).toBe(false);
  });
});
