/**
 * FU-BE-193: the web's `ProblemCode` enum (apps/web/openapi/openapi.yaml) must list every staff machine
 * code that docs/api-contract.md names in its preamble and every code the API's problem filter can
 * set, so a new code added on either side fails here instead of surfacing as an unknown string.
 * BUSY (DL-37, D-56) is the 503 with Retry-After that a client retries after the stated delay.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
const spec = readFileSync(resolve(root, 'apps/web/openapi/openapi.yaml'), 'utf8');
const contract = readFileSync(resolve(root, 'docs/api-contract.md'), 'utf8');
const codedExceptionSource = readFileSync(
  resolve(root, 'apps/api/src/common/coded.exception.ts'),
  'utf8',
);

const CODE = '[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*';
/** The codes written between backticks, like `BUSY` (the contract). */
const ticked = (text: string): string[] =>
  [...text.matchAll(new RegExp('`(' + CODE + ')`', 'g'))].map((m) => m[1] ?? '');
/** The codes written as quoted strings, like 'BUSY' (the API source). */
const quoted = (text: string): string[] =>
  [...text.matchAll(new RegExp("'(" + CODE + ")'", 'g'))].map((m) => m[1] ?? '');
/** The bare words of a YAML flow list, like [REAUTH_FAILED, BUSY]. */
const listed = (text: string): string[] =>
  text
    .replace(/[[\]]/g, ' ')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => new RegExp('^' + CODE + '$').test(x));

function enumCodes(): string[] {
  const start = spec.indexOf('\n    ProblemCode:\n');
  expect(start, 'ProblemCode schema exists').toBeGreaterThan(-1);
  const block = spec.slice(start + 1);
  const end = block.slice(1).search(/\n {4}[A-Za-z]+:\n/);
  const text = end === -1 ? block : block.slice(0, end + 1);
  expect(text.indexOf('enum:'), 'ProblemCode has an enum list').toBeGreaterThan(-1);
  const list = text.slice(text.indexOf('enum:') + 'enum:'.length);
  return listed(list);
}

describe('FU-BE-193 ProblemCode enum matches the contract', () => {
  it('FU-BE-193 lists BUSY, the 503 with Retry-After on lock contention', () => {
    expect(enumCodes()).toContain('BUSY');
  });

  it('FU-BE-193 lists every staff code the contract preamble names', () => {
    const start = contract.indexOf('`code` is set only where this contract names one:');
    expect(start, 'the contract preamble names its codes').toBeGreaterThan(-1);
    const end = contract.indexOf('Candidate-route codes', start);
    // The preamble also writes other backticked uppercase words that are not problem codes: the API
    // constant `PROBLEM_CODES`, HTTP methods (`PATCH`) and the ADR 0015 waiver reason value
    // `REFUSED_BIOMETRIC_PROCESSING`. They are excluded here, by name, so a new real code still counts.
    const NOT_CODES = new Set([
      'PROBLEM_CODES',
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'REFUSED_BIOMETRIC_PROCESSING',
    ]);
    const named = [...new Set(ticked(contract.slice(start, end === -1 ? undefined : end)))].filter(
      (c) => !NOT_CODES.has(c),
    );
    expect(named.length).toBeGreaterThan(5);
    const inEnum = enumCodes();
    expect(named.filter((c) => !inEnum.includes(c))).toEqual([]);
    // And the other way: the enum invents no staff code the contract does not name.
    expect(inEnum.filter((c) => !named.includes(c))).toEqual([]);
  });

  it('FU-BE-193 lists every code in the API PROBLEM_CODES list (coded.exception.ts)', () => {
    const block = codedExceptionSource.slice(
      codedExceptionSource.indexOf('PROBLEM_CODES = ['),
      codedExceptionSource.indexOf('] as const', codedExceptionSource.indexOf('PROBLEM_CODES = [')),
    );
    const apiCodes = quoted(block);
    expect(apiCodes.length).toBeGreaterThan(2);
    const inEnum = enumCodes();
    expect(apiCodes.filter((c) => !inEnum.includes(c))).toEqual([]);
  });
});
