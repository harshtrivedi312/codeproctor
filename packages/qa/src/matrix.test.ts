/**
 * Keeps /docs/test-matrix.md honest: every TC ID in /docs/test-cases.md appears exactly once in
 * the matrix with a valid level and a status, and every TC ID named in a test file exists.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8');

const LEVELS = ['unit', 'integration', 'e2e', 'a11y', 'load', 'security', 'manual'];

function ids(text: string, rowPattern: RegExp): string[] {
  return text
    .split('\n')
    .map((l) => rowPattern.exec(l)?.[1])
    .filter((x): x is string => x !== undefined);
}

describe('test matrix (QA-01)', () => {
  const cases = ids(read('docs/test-cases.md'), /^\| (TC-\d{3}) \|/);
  const matrixText = read('docs/test-matrix.md');
  const matrixRows = matrixText.split('\n').filter((l) => /^\| TC-\d{3} \|/.test(l));

  it('lists 72 test cases in test-cases.md', () => {
    expect(cases).toHaveLength(72);
  });

  it('has exactly one row for every test case', () => {
    const inMatrix = matrixRows.map((l) => l.split('|')[1]?.trim());
    expect([...inMatrix].sort()).toEqual([...cases].sort());
  });

  it('gives every row a level, an owner and a status', () => {
    for (const row of matrixRows) {
      const cells = row.split('|').map((c) => c.trim());
      expect(LEVELS, row).toContain(cells[5]);
      expect(cells[6], row).not.toBe('');
      expect(cells[9], row).not.toBe('');
    }
  });

  it('only names TC IDs that exist in tests', () => {
    const files = execFileSync(
      'git',
      [
        'ls-files',
        '*.test.ts',
        '*.test.tsx',
        '*.spec.ts',
        '*.test.mjs',
        '*.js',
        'apps/worker/tests/*.py',
      ],
      { cwd: root, encoding: 'utf8' },
    )
      .split('\n')
      .filter((f) => f !== '' && !f.startsWith('docs/') && !f.includes('matrix.test.ts'));
    const known = new Set(cases);
    for (const f of files) {
      for (const m of read(f).matchAll(/(?<![A-Za-z0-9])TC[-_]?(\d{3})(?!\d)/gi)) {
        const id = `TC-${m[1]}`;
        expect(known.has(id), `${f} names ${m[0]}`).toBe(true);
      }
    }
  });

  it('lists no test file in a Verified or Partial row that does not exist', () => {
    const missing: string[] = [];
    for (const row of matrixRows) {
      const cells = row.split('|').map((c) => c.trim());
      if (!/^(Verified|Partial)/i.test(cells[9] ?? '')) continue;
      for (const m of (cells[8] ?? '').matchAll(/`([^`#]+?)(?:#[^`]*)?`/g)) {
        const path = (m[1] ?? '').replace(/ \(.*$/, '');
        if (/^(apps|packages|docs)\//.test(path) && !existsSync(resolve(root, path)))
          missing.push(`${cells[1]}: ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('marks a row Verified only when the notes say what was run', () => {
    for (const row of matrixRows) {
      const cells = row.split('|').map((c) => c.trim());
      if (/^Verified/i.test(cells[9] ?? '')) expect(cells[10], row).not.toBe('');
    }
  });
});
