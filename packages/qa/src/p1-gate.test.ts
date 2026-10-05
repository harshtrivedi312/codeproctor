// Tests of the P1 gate itself (packages/qa/src/p1-gate.ts) with synthetic reports and a fake docs
// tree, so a change to the gate cannot silently let a failing P1 test through. The gate is run as
// a child process, exactly as CI runs it.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'p1-gate-'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(
    join(root, 'docs/test-cases.md'),
    [
      '| TC-901 | FR-1 | Plain P1 | s | e | F | P1 |',
      '| TC-902 | FR-2 | Verified P1 | s | e | F | P1 |',
      '| TC-903 | FR-3 | P2 case | s | e | F | P2 |',
      '| TC-904 | FR-4 | Manual P1 | s | e | F | P1 |',
    ].join('\n'),
  );
  // columns: | TC | FR | name | type | level | owner | deps | tests | status | notes |
  writeFileSync(
    join(root, 'docs/test-matrix.md'),
    [
      '| TC-901 | FR-1 | Plain | F | integration | qa | - | `a.test.ts` | Partial pass | n |',
      '| TC-902 | FR-2 | Verified | F | integration | qa | - | `b.test.ts` | Verified 2026-10-05 | n |',
      '| TC-903 | FR-3 | P2 | F | unit | qa | - | `c.test.ts` | Partial pass | n |',
      '| TC-904 | FR-4 | Manual | F | manual | qa | - | none | Manual | n |',
    ].join('\n'),
  );
});

type Status = 'passed' | 'failed' | 'pending';
function jest(tests: [string, Status][], fileStatus = 'passed'): string {
  const path = join(root, `report-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      testResults: [
        {
          name: 'x.test.ts',
          status: fileStatus,
          assertionResults: tests.map(([title, status]) => ({ title, fullName: title, status })),
        },
      ],
    }),
  );
  return path;
}
function gate(report: string[], flags: string[] = []): { code: number; out: string } {
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', resolve(import.meta.dirname, 'p1-gate.ts'), ...report, ...flags],
    { env: { ...process.env, P1_GATE_ROOT: root }, encoding: 'utf8' },
  );
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

describe('P1 gate', () => {
  it('passes when every test that names a P1 case passes', () => {
    const r = gate([
      jest([
        ['TC-901 works', 'passed'],
        ['TC-902 works', 'passed'],
      ]),
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('P1 gate passed.');
  });

  it('fails when one test naming a P1 case fails', () => {
    const r = gate([
      jest([
        ['TC-901 a', 'passed'],
        ['TC-901 b', 'failed'],
        ['TC-902 ok', 'passed'],
      ]),
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/TC-901\s+FAILED \(1 failing, 1 passing\)/);
  });

  it('does not fail on a failing P2 case, but says so', () => {
    const r = gate([
      jest([
        ['TC-902 ok', 'passed'],
        ['TC-903 broken', 'failed'],
      ]),
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('TC-903 (P2) has 1 failing');
  });

  it('fails a row marked Verified that has no run', () => {
    const r = gate([jest([['TC-901 a', 'passed']])]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/TC-902\s+matrix says Verified but no test ran/);
  });

  it('fails on a test file that crashed with no assertion results', () => {
    const r = gate([jest([['TC-902 ok', 'passed']]), jest([], 'failed')]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('failed to run');
  });

  it('fails on a test name with an unknown TC id (a typo hides a case)', () => {
    const r = gate([
      jest([
        ['TC-902 ok', 'passed'],
        ['TC-999 typo', 'passed'],
      ]),
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('unknown TC-999');
  });

  it('a KNOWN DEFECT test that passes (expected failure happened) prints "KNOWN DEFECT open" and passes', () => {
    const r = gate([
      jest([
        ['TC-901 KNOWN DEFECT QA-D-04: x', 'passed'],
        ['TC-902 ok', 'passed'],
      ]),
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/TC-901\s+KNOWN DEFECT open/);
  });

  it('a KNOWN DEFECT test that fails (defect fixed or test broke) fails the gate and says what to do', () => {
    const r = gate([
      jest([
        ['TC-901 KNOWN DEFECT QA-D-04: x', 'failed'],
        ['TC-902 ok', 'passed'],
      ]),
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('no longer fail as expected');
  });

  it('counts staged (skipped) tests, passes them in normal mode and fails them with --strict', () => {
    const rep = jest([
      ['TC-901 a', 'passed'],
      ['TC-901 staged', 'pending'],
      ['TC-902 ok', 'passed'],
    ]);
    const normal = gate([rep]);
    expect(normal.code).toBe(0);
    expect(normal.out).toMatch(/TC-901.*1 staged \(skipped\)/);
    const strict = gate([rep], ['--strict']);
    expect(strict.code).toBe(1);
    expect(strict.out).toContain('staged tests are still skipped');
  });

  it('reads a pytest JUnit report where the id is written TC_901', () => {
    const xml = join(root, 'worker.xml');
    writeFileSync(
      xml,
      '<testsuite><testcase classname="t" name="test_TC_901_x"/><testcase classname="t" name="test_TC_902_y"><failure message="boom"/></testcase></testsuite>',
    );
    const r = gate([xml]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/TC-901\s+1 test\(s\) passing/);
    expect(r.out).toMatch(/TC-902\s+FAILED/);
  });

  it('exits 2 when a report file is missing', () => {
    expect(gate([join(root, 'nope.json')]).code).toBe(2);
  });

  it('prints manual P1 cases as manual and does not fail them', () => {
    const r = gate([jest([['TC-902 ok', 'passed']])]);
    expect(r.out).toMatch(/TC-904\s+manual/);
  });
});
