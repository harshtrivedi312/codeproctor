/**
 * P1 gate (QA-01). Reads Vitest and Playwright JSON reports, finds the TC ID in every test
 * title, and exits 1 when a test that names a P1 test case failed. Also prints one line per
 * P1 case: passed, failed or not covered by an automated run yet.
 *
 * Reports: Vitest and Jest JSON (same shape), Playwright JSON, and JUnit XML (pytest for apps/worker,
 * node:test for packages/shared). In JUnit names a TC ID may be written TC_073 or tc073 because a
 * Python function name cannot contain a hyphen; it is read as TC-073.
 *
 * Usage: tsx src/p1-gate.ts <report.json|report.xml>...   (add --strict to also fail on P1 cases that
 * have an automated level in the matrix but no passing test; used once all owner tasks merged)
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const reports = args.filter((a) => !a.startsWith('--'));

interface Result {
  /** Leaf test title; TC IDs are read from here first. */
  title: string;
  /** Title with its describe blocks; used only when the leaf names no TC ID. */
  full?: string;
  passed: boolean;
  /** Skipped, pending or todo: written but switched off (staged). Not evidence, but counted. */
  staged?: boolean;
}

/** Test files that failed as a whole with no assertion results (compile error, crash). */
const suiteFailures: string[] = [];

function priorities(): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of readFileSync(resolve(root, 'docs/test-cases.md'), 'utf8').split('\n')) {
    const m = /^\| (TC-\d{3}) \|.*\| (P[123]) \|$/.exec(line);
    if (m?.[1] && m[2]) map.set(m[1], m[2]);
  }
  return map;
}

function statuses(): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of readFileSync(resolve(root, 'docs/test-matrix.md'), 'utf8').split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (/^TC-\d{3}$/.test(cells[1] ?? '') && cells[9]) map.set(cells[1] as string, cells[9]);
  }
  return map;
}

function levels(): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of readFileSync(resolve(root, 'docs/test-matrix.md'), 'utf8').split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (/^TC-\d{3}$/.test(cells[1] ?? '') && cells[5]) map.set(cells[1] as string, cells[5]);
  }
  return map;
}

interface VitestReport {
  testResults?: {
    name?: string;
    testFilePath?: string;
    status?: string;
    assertionResults?: { fullName?: string; title?: string; status?: string }[];
  }[];
}
interface PwSpec {
  title: string;
  ok?: boolean;
  tests?: { status?: string }[];
}
interface PwSuite {
  specs?: PwSpec[];
  suites?: PwSuite[];
}

function walkPlaywright(suite: PwSuite, out: Result[]): void {
  for (const spec of suite.specs ?? []) {
    const skipped = (spec.tests ?? []).every((t) => t.status === 'skipped');
    out.push({ title: spec.title, passed: skipped || spec.ok === true, staged: skipped });
  }
  for (const child of suite.suites ?? []) walkPlaywright(child, out);
}

const attr = (tag: string, name: string): string =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]?.replace(/&amp;/g, '&') ?? '';

/** Reads <testcase> elements: failed when it has a <failure> or <error> child, skipped on <skipped>. */
function loadJunit(xml: string): Result[] {
  const out: Result[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const body = m[3] ?? '';
    // test_tc073_x and TC_073 are read as TC-073
    const norm = (t: string): string =>
      t.replace(/(^|[^A-Za-z0-9])tc[-_]?(\d{3})(?!\d)/gi, '$1TC-$2');
    const name = norm(attr(m[1] ?? '', 'name'));
    out.push({
      title: name,
      full: `${norm(attr(m[1] ?? '', 'classname'))} ${name}`,
      passed: !/<(failure|error)\b/.test(body),
      staged: /<skipped\b/.test(body),
    });
  }
  return out;
}

function load(file: string): Result[] {
  if (file.endsWith('.xml')) return loadJunit(readFileSync(resolve(file), 'utf8'));
  const json = JSON.parse(readFileSync(resolve(file), 'utf8')) as VitestReport & PwSuite;
  const out: Result[] = [];
  if (json.testResults) {
    for (const f of json.testResults) {
      const asserts = f.assertionResults ?? [];
      // A file that failed to run (compile error, crash) has a failed status and no assertions.
      if (asserts.length === 0 && f.status === 'failed') {
        suiteFailures.push(f.name ?? f.testFilePath ?? '(unnamed test file)');
      }
      for (const a of asserts) {
        const staged = a.status === 'pending' || a.status === 'skipped' || a.status === 'todo';
        out.push({
          title: a.title ?? a.fullName ?? '',
          full: a.fullName ?? a.title ?? '',
          passed: staged || a.status === 'passed',
          staged,
        });
      }
    }
  } else {
    walkPlaywright(json, out);
  }
  return out;
}

const prio = priorities();
const level = levels();
const status = statuses();
const results: Result[] = [];
for (const r of reports) {
  if (!existsSync(resolve(r))) {
    console.error(`Report not found: ${r}`);
    process.exit(2);
  }
  results.push(...load(r));
}

const state = new Map<
  string,
  { passed: number; failed: number; known: number; fixed: number; staged: number }
>();
for (const res of results) {
  const find = (t: string): string[] => t.match(/(?<![A-Za-z0-9])TC-\d{3}(?!\d)/g) ?? [];
  const leaf = find(res.title);
  for (const id of new Set(leaf.length > 0 ? leaf : find(res.full ?? ''))) {
    const s = state.get(id) ?? { passed: 0, failed: 0, known: 0, fixed: 0, staged: 0 };
    if (res.staged) {
      s.staged++;
      state.set(id, s);
      continue;
    }
    // Tests written with it.fails carry KNOWN DEFECT in the title and pass while the defect exists.
    // If such a test fails, the defect was fixed or the test broke: either way it is a failure.
    if (/KNOWN DEFECT/.test(res.full ?? res.title)) {
      if (res.passed) s.known++;
      else {
        s.failed++;
        s.fixed++;
      }
    } else if (res.passed) s.passed++;
    else s.failed++;
    state.set(id, s);
  }
}

let failures = 0;
console.log('P1 test cases');
for (const [id, p] of [...prio].sort()) {
  if (p !== 'P1') continue;
  const s = state.get(id);
  const ran = s ? s.passed + s.failed + s.known : 0;
  let line: string;
  if (!s || ran === 0) {
    const automated = level.get(id) !== 'manual';
    line = automated ? 'no automated run yet' : 'manual (see docs/manual-tests.md)';
    if (s && s.staged > 0) line = `0 passing, ${s.staged} staged (skipped); no run yet`;
    if (strict && automated) failures++;
    // A row marked Verified must have a run in every mode: no run means the claim is unproven.
    if (/^Verified/i.test(status.get(id) ?? '')) {
      line = 'matrix says Verified but no test ran';
      failures++;
    }
  } else if (s.failed > 0) {
    line = `FAILED (${s.failed} failing, ${s.passed} passing)`;
    if (s.fixed > 0)
      line += `; ${s.fixed} KNOWN DEFECT test(s) no longer fail as expected: the defect is fixed (or decided by design) or the test broke; make it a plain test, drop the KNOWN DEFECT marker, update the matrix`;
    failures++;
  } else if (s.known > 0) {
    line = `KNOWN DEFECT open (${s.known} expected-fail test(s), ${s.passed} passing); not verified; matrix says: ${(status.get(id) ?? '').slice(0, 70)}`;
  } else {
    const st = status.get(id) ?? '';
    line = /^Verified/i.test(st)
      ? `passed (${s.passed} tests); matrix: verified`
      : `${s.passed} test(s) passing; NOT verified, matrix says: ${st.slice(0, 70)}`;
    if (s.staged > 0)
      line =
        line.replace(/^(passed \(|)(\d+)/, '$1$2') +
        `; ${s.passed} passing, ${s.staged} staged (skipped)`;
  }
  // Staged tests mean the case is not fully covered yet; --strict refuses that for P1.
  if (strict && s && s.staged > 0) {
    line += '; FAIL (--strict): staged tests are still skipped';
    failures++;
  }
  console.log(`  ${id}  ${line}`);
}
for (const f of suiteFailures) {
  console.error(`Test file failed to run (no assertion results): ${f}`);
  failures++;
}
for (const [id, s] of state) {
  if (!prio.has(id)) {
    console.error(`Test names unknown ${id}`);
    failures++;
  } else if (prio.get(id) !== 'P1' && s.failed > 0) {
    console.log(
      `Note: ${id} (${prio.get(id)}) has ${s.failed} failing test(s); not a gate failure`,
    );
  }
}
if (failures > 0) {
  console.error(`P1 gate failed: ${failures} problem(s).`);
  process.exit(1);
}
console.log('P1 gate passed.');
