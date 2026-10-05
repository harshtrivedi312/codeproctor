// Tests of the P1 gate itself (packages/qa/src/p1-gate.ts) with synthetic reports and a fake docs
// tree, so a change to the gate cannot silently let a failing P1 test through. The gate is run as
// a child process, exactly as CI runs it (it spawns tsx, so every test has a longer timeout).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const T = { timeout: 30_000 };
let root: string;
let n = 0;
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
      '| TC-905 | FR-5 | Automated P1, never run | s | e | F | P1 |',
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
      '| TC-905 | FR-5 | Never run | F | integration | qa | - | `e.test.ts` | Planned | n |',
    ].join('\n'),
  );
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Status = 'passed' | 'failed' | 'pending';
interface T3 {
  title: string;
  status: Status;
  fullName?: string;
}
const ok = (title: string): T3 => ({ title, status: 'passed' });

function write(name: string, body: string): string {
  const path = join(root, `${++n}-${name}`);
  writeFileSync(path, body);
  return path;
}
/** Jest/Vitest JSON with one test file. */
function jest(
  tests: (T3 | [string, Status])[],
  extra: { fileStatus?: string; top?: Record<string, unknown> } = {},
): string {
  const results = tests.map((t) => (Array.isArray(t) ? { title: t[0], status: t[1] } : t));
  return write(
    'report.json',
    JSON.stringify({
      ...extra.top,
      testResults: [
        {
          name: 'x.test.ts',
          status: extra.fileStatus ?? 'passed',
          assertionResults: results.map((t) => ({
            title: t.title,
            fullName: ('fullName' in t ? t.fullName : undefined) ?? t.title,
            status: t.status,
          })),
        },
      ],
    }),
  );
}
const junit = (cases: string): string => write('report.xml', `<testsuite>${cases}</testsuite>`);
function gate(report: string[], flags: string[] = []): { code: number; out: string } {
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', resolve(import.meta.dirname, 'p1-gate.ts'), ...report, ...flags],
    { env: { ...process.env, P1_GATE_ROOT: root }, encoding: 'utf8' },
  );
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

describe('P1 gate: verdicts from Jest and Vitest reports', () => {
  it('passes when every test that names a P1 case passes, and prints the override', T, () => {
    const r = gate([jest([ok('TC-901 works'), ok('TC-902 works')])]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('P1 gate passed.');
    expect(r.out).toContain('P1_GATE_ROOT override in use');
    expect(r.out).toMatch(/TC-902\s+passed \(1 tests\); matrix: verified/);
  });

  it('fails when one test naming a P1 case fails', T, () => {
    const r = gate([jest([ok('TC-901 a'), ['TC-901 b', 'failed'], ok('TC-902 ok')])]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/TC-901\s+FAILED \(1 failing, 1 passing\)/);
  });

  it('does not fail on a failing P2 case, but says so', T, () => {
    const r = gate([jest([ok('TC-902 ok'), ['TC-903 broken', 'failed']])]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('TC-903 (P2) has 1 failing');
  });

  it('fails a row marked Verified that has no run', T, () => {
    const r = gate([jest([ok('TC-901 a')])]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/TC-902\s+matrix says Verified but no test ran/);
  });

  it('fails a Verified row whose only tests are staged (skipped)', T, () => {
    const r = gate([jest([ok('TC-901 a'), ['TC-902 only staged', 'pending']])]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/TC-902\s+matrix says Verified but no test ran/);
  });

  it('fails on a test name with an unknown TC id (a typo hides a case)', T, () => {
    const r = gate([jest([ok('TC-902 ok'), ok('TC-999 typo')])]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('unknown TC-999');
  });

  it('reads the TC id from the describe block when the leaf title names none', T, () => {
    const r = gate([
      jest([{ title: 'works', fullName: 'TC-901 login works', status: 'failed' }, ok('TC-902 ok')]),
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/TC-901\s+FAILED/);
  });

  it('a leaf title that names a TC id wins over the describe block', T, () => {
    const r = gate([
      jest([
        { title: 'TC-902 leaf', fullName: 'TC-901 block TC-902 leaf', status: 'failed' },
        ok('TC-902 ok'),
      ]),
    ]);
    expect(r.out).toMatch(/TC-902\s+FAILED/);
    expect(r.out).not.toMatch(/TC-901\s+FAILED/);
  });
});

describe('P1 gate: known defects', () => {
  it(
    'a KNOWN DEFECT test that passes (the expected failure happened) prints "KNOWN DEFECT open" and passes',
    T,
    () => {
      const r = gate([jest([ok('TC-901 KNOWN DEFECT QA-D-04: x'), ok('TC-902 ok')])]);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/TC-901\s+KNOWN DEFECT open/);
    },
  );

  it(
    'a KNOWN DEFECT test that fails (defect fixed or test broke) fails the gate and says what to do',
    T,
    () => {
      const r = gate([jest([['TC-901 KNOWN DEFECT QA-D-04: x', 'failed'], ok('TC-902 ok')])]);
      expect(r.code).toBe(1);
      expect(r.out).toContain('no longer fail as expected');
    },
  );

  it('KNOWN DEFECT named only in the describe block still counts as a known defect', T, () => {
    const r = gate([
      jest([
        {
          title: 'TC-901 cold start',
          fullName: 'KNOWN DEFECT QA-D-04 TC-901 cold start',
          status: 'passed',
        },
        ok('TC-902 ok'),
      ]),
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/TC-901\s+KNOWN DEFECT open/);
  });
});

describe('P1 gate: staged tests and --strict', () => {
  it('counts staged tests, passes them normally and fails them with --strict', T, () => {
    const rep = jest([ok('TC-901 a'), ['TC-901 staged', 'pending'], ok('TC-902 ok')]);
    const normal = gate([rep]);
    expect(normal.code).toBe(0);
    expect(normal.out).toMatch(/TC-901.*1 staged \(skipped\)/);
    const strict = gate([rep], ['--strict']);
    expect(strict.code).toBe(1);
    expect(strict.out).toContain('staged tests are still skipped');
  });

  it(
    '--strict fails an automated P1 case that has no run, and leaves a manual one alone',
    T,
    () => {
      const rep = jest([ok('TC-901 a'), ok('TC-902 ok')]);
      expect(gate([rep]).code).toBe(0);
      const strict = gate([rep], ['--strict']);
      expect(strict.code).toBe(1);
      expect(strict.out).toMatch(/TC-905\s+no automated run yet/);
      expect(strict.out).toMatch(/TC-904\s+manual/);
    },
  );

  it('prints manual P1 cases as manual and does not fail them', T, () => {
    const r = gate([jest([ok('TC-902 ok')])]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/TC-904\s+manual/);
  });
});

describe('P1 gate: a test file that fails as a whole', () => {
  it('fails on a file that crashed with no assertion results, naming it', T, () => {
    const r = gate([jest([ok('TC-902 ok')]), jest([], { fileStatus: 'failed' })]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('x.test.ts');
    expect(r.out).toContain('failed with no failed test recorded');
  });

  it(
    'fails on a file whose recorded tests all passed but the file failed (afterAll hook, suite error)',
    T,
    () => {
      const r = gate([jest([ok('TC-901 a'), ok('TC-902 ok')], { fileStatus: 'failed' })]);
      expect(r.code).toBe(1);
      expect(r.out).toContain('x.test.ts');
    },
  );

  it('fails on a Jest report with numRuntimeErrorTestSuites > 0', T, () => {
    const r = gate([jest([ok('TC-902 ok')], { top: { numRuntimeErrorTestSuites: 1 } })]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('numRuntimeErrorTestSuites');
  });

  it('fails on a Vitest report with success false and no failed test', T, () => {
    const r = gate([jest([ok('TC-902 ok')], { top: { success: false } })]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('success: false');
  });
});

describe('P1 gate: JUnit reports (pytest, node:test)', () => {
  it('reads an id written TC_901, a failure as FAILED and a skipped case as staged', T, () => {
    const xml = junit(
      '<testcase classname="t" name="test_TC_901_x"/>' +
        '<testcase classname="t" name="test_TC_902_y"><failure message="boom"/></testcase>' +
        '<testcase classname="t" name="test_TC_905_z"><skipped/></testcase>',
    );
    const r = gate([xml]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/TC-901\s+1 test\(s\) passing/);
    expect(r.out).toMatch(/TC-902\s+FAILED/);
    expect(r.out).toMatch(/TC-905\s+0 passing, 1 staged/);
  });

  it('fails an <error> case that names a P1 case', T, () => {
    const r = gate([
      junit('<testcase classname="t" name="test_TC_901_x"><error message="e"/></testcase>'),
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/TC-901\s+FAILED/);
  });

  it('fails a collection <error> whose name has no TC id, naming it', T, () => {
    const r = gate([
      jest([ok('TC-901 a'), ok('TC-902 ok')]),
      junit(
        '<testcase classname="" name="tests/test_broken.py"><error message="ImportError"/></testcase>',
      ),
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('tests/test_broken.py');
  });

  it('exits 2 when a report file is missing', T, () => {
    expect(gate([join(root, 'nope.json')]).code).toBe(2);
  });
});

describe('P1 gate: Playwright JSON', () => {
  const spec = (title: string, okFlag: boolean, status: string): object => ({
    title,
    ok: okFlag,
    tests: [{ status }],
  });
  const pw = (specs: object[]): string =>
    write(
      'e2e.json',
      JSON.stringify({ suites: [{ title: 'file', suites: [{ title: 'inner', specs }] }] }),
    );

  it('reads specs in nested suites and fails on ok:false', T, () => {
    const r = gate([
      pw([spec('TC-901 a', true, 'expected'), spec('TC-901 b', false, 'unexpected')]),
      jest([ok('TC-902 ok')]),
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/TC-901\s+FAILED \(1 failing, 1 passing\)/);
  });

  it('counts specs that are all skipped as staged, not as a pass', T, () => {
    const rep = pw([spec('TC-901 a', true, 'expected'), spec('TC-905 later', true, 'skipped')]);
    const r = gate([rep, jest([ok('TC-902 ok')])]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/TC-905\s+0 passing, 1 staged/);
    expect(gate([rep, jest([ok('TC-902 ok')])], ['--strict']).code).toBe(1);
  });
});
