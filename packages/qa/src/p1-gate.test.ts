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
          // Real Jest and Vitest reporters set the file to "failed" when any assertion failed.
          status:
            extra.fileStatus ?? (results.some((t) => t.status === 'failed') ? 'failed' : 'passed'),
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

describe('P1 gate: whole-file failures are kept per report', () => {
  it('names a crashed file in each report, whatever other reports or tests did', T, () => {
    const r = gate([
      jest([ok('TC-902 ok'), ['TC-903 p2 broken', 'failed']], {
        top: { numRuntimeErrorTestSuites: 1 },
      }),
      jest([], { fileStatus: 'failed' }),
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('numRuntimeErrorTestSuites');
    expect(r.out).toContain('x.test.ts');
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

  it('fails on a Playwright top-level errors[] entry even when every spec passed', T, () => {
    const rep = write(
      'e2e-errors.json',
      JSON.stringify({ suites: [], errors: [{ message: 'global setup failed' }] }),
    );
    const r = gate([rep, jest([ok('TC-902 ok')])]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Playwright errors[]');
  });

  it('fails on stats.unexpected with no failed spec naming a TC id', T, () => {
    const rep = write(
      'e2e-unexpected.json',
      JSON.stringify({ suites: [], stats: { unexpected: 2 } }),
    );
    const r = gate([rep, jest([ok('TC-902 ok')])]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('stats.unexpected 2');
  });

  it('does not count a spec with an empty tests array as staged', T, () => {
    const rep = pw([{ title: 'TC-905 empty', ok: true, tests: [] }]);
    const r = gate([rep, jest([ok('TC-902 ok')])]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/TC-905\s+no automated run yet/);
    expect(r.out).not.toMatch(/TC-905\s+0 passing, 1 staged/);
  });

  it(
    'treats an empty spec as not run: a Verified row resting on it fails, and it is no pass',
    T,
    () => {
      const rep = write(
        'e2e-empty-verified.json',
        JSON.stringify({
          suites: [{ title: 'f', specs: [{ title: 'TC-902 empty', ok: true, tests: [] }] }],
        }),
      );
      const r = gate([rep]);
      expect(r.code).toBe(1);
      expect(r.out).toContain('matrix says Verified but no test ran');
      const plain = gate([
        write(
          'e2e-empty-plain.json',
          JSON.stringify({
            suites: [{ title: 'f', specs: [{ title: 'TC-905 empty', ok: true, tests: [] }] }],
          }),
        ),
        jest([ok('TC-902 ok')]),
      ]);
      expect(plain.code).toBe(0);
      expect(plain.out).toMatch(/TC-905\s+no automated run yet/);
      expect(plain.out).not.toMatch(/TC-905\s+1 test\(s\) passing/);
      expect(plain.out).not.toMatch(/TC-905\s+0 passing, 1 staged/);
    },
  );

  it(
    'fails on an untagged failing spec next to a failing P2 spec (stats.unexpected 2, one tagged)',
    T,
    () => {
      const rep = write(
        'e2e-mixed.json',
        JSON.stringify({
          suites: [
            {
              title: 'f',
              specs: [
                { title: 'TC-903 p2 fails', ok: false, tests: [{ status: 'unexpected' }] },
                { title: 'no id fails', ok: false, tests: [{ status: 'unexpected' }] },
              ],
            },
          ],
          stats: { unexpected: 2 },
        }),
      );
      const r = gate([rep, jest([ok('TC-902 ok')])]);
      expect(r.code).toBe(1);
      expect(r.out).toContain('stats.unexpected 2');
    },
  );
});

describe('P1 gate: a failed file next to a failing non-P1 test', () => {
  it(
    'does not report a crashed file when only a P2 test failed in it (real reporters mark the file failed)',
    T,
    () => {
      const r = gate([jest([ok('TC-902 ok'), ['TC-903 p2 broken', 'failed']])]);
      expect(r.code).toBe(0);
      expect(r.out).toContain('TC-903 (P2) has 1 failing');
      expect(r.out).not.toContain('failed with no failed test recorded');
    },
  );

  it('does not fail on an untagged failing test alone', T, () => {
    const r = gate([jest([ok('TC-902 ok'), ['no id broken', 'failed']])]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('failed with no failed test recorded');
  });

  it('does not double-report when a P1 test in the file failed', T, () => {
    const r = gate([jest([ok('TC-902 ok'), ['TC-901 broken', 'failed']])]);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('failed with no failed test recorded');
  });

  it(
    'fails when a P2 test failed and a beforeAll crash skipped P1 tests of the file (leaf TC-903 inside describe TC-901)',
    T,
    () => {
      const r = gate([
        jest([
          { title: 'TC-903 inner p2', fullName: 'TC-901 block TC-903 inner p2', status: 'failed' },
          { title: 'other', fullName: 'TC-901 block other', status: 'pending' },
          ok('TC-902 ok'),
        ]),
      ]);
      expect(r.code).toBe(1);
      expect(r.out).toContain('left P1 test(s) skipped');
      expect(r.out).toContain('x.test.ts');
    },
  );

  it('a failed file with a P2 failure and only P2 or untagged skipped tests passes', T, () => {
    const r = gate([
      jest([ok('TC-902 ok'), ['TC-903 p2 broken', 'failed'], ['TC-903 later', 'pending']]),
    ]);
    expect(r.code).toBe(0);
  });

  it('treats Jest status "disabled" as staged', T, () => {
    const rep = jest([
      ok('TC-901 a'),
      { title: 'TC-901 off', status: 'disabled' as Status },
      ok('TC-902 ok'),
    ]);
    expect(gate([rep]).out).toMatch(/TC-901.*1 staged \(skipped\)/);
    expect(gate([rep], ['--strict']).code).toBe(1);
  });
});

describe('P1 gate: Playwright describe titles and distinct reasons', () => {
  it('sees a TC id and KNOWN DEFECT that only the test.describe title carries', T, () => {
    const rep = write(
      'e2e-describe.json',
      JSON.stringify({
        suites: [
          {
            title: 'f.spec.ts',
            suites: [
              {
                title: 'KNOWN DEFECT QA-D-09 TC-901 flow',
                specs: [{ title: 'does a thing', ok: true, tests: [{ status: 'expected' }] }],
              },
            ],
          },
        ],
      }),
    );
    const r = gate([rep, jest([ok('TC-902 ok')])]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/TC-901\s+KNOWN DEFECT open/);
  });

  it('gives each failure kind its own reason', T, () => {
    const pwErr = write('e2e-e.json', JSON.stringify({ suites: [], errors: [{ message: 'x' }] }));
    const pwUnexpected = write(
      'e2e-u.json',
      JSON.stringify({ suites: [], stats: { unexpected: 1 } }),
    );
    const rt = jest([ok('TC-902 ok')], { top: { numRuntimeErrorTestSuites: 1 } });
    const out = gate([pwErr, pwUnexpected, rt]).out;
    expect(out).toMatch(/Playwright errors\[\] has 1/);
    expect(out).toMatch(/Playwright stats\.unexpected 1 is more than/);
    expect(out).toMatch(/Jest reported 1 test file\(s\) that failed to run/);
    expect(out).not.toMatch(/Playwright errors.*failed with no failed test recorded/);
  });
});

describe('P1 gate: a node:test file that fails to load (JUnit)', () => {
  it('fails an untagged <failure> named after a test file', T, () => {
    const r = gate([
      jest([ok('TC-902 ok')]),
      junit(
        '<testcase classname="test" name="/repo/packages/shared/src/x.test.mjs"><failure message="Cannot find module"/></testcase>',
      ),
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('x.test.mjs');
    expect(r.out).toContain('failed to load or run');
  });

  it('does not fail an untagged <failure> whose name is not a file', T, () => {
    const r = gate([
      jest([ok('TC-902 ok')]),
      junit('<testcase classname="t" name="some helper check"><failure message="x"/></testcase>'),
    ]);
    expect(r.code).toBe(0);
  });
});
