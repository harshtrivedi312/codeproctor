/**
 * P1 gate (QA-01). Reads Vitest and Playwright JSON reports, finds the TC ID in every test
 * title, and exits 1 when a test that names a P1 test case failed. Also prints one line per
 * P1 case: passed, failed or not covered by an automated run yet.
 *
 * Usage: tsx src/p1-gate.ts <report.json>...   (add --strict to also fail on P1 cases that
 * have an automated level in the matrix but no passing test; used once all owner tasks merged)
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const reports = args.filter((a) => !a.startsWith('--'));

interface Result {
  title: string;
  passed: boolean;
}

function priorities(): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of readFileSync(resolve(root, 'docs/test-cases.md'), 'utf8').split('\n')) {
    const m = /^\| (TC-\d{3}) \|.*\| (P[123]) \|$/.exec(line);
    if (m?.[1] && m[2]) map.set(m[1], m[2]);
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
  testResults?: { assertionResults?: { fullName?: string; title?: string; status?: string }[] }[];
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
    if (!skipped) out.push({ title: spec.title, passed: spec.ok === true });
  }
  for (const child of suite.suites ?? []) walkPlaywright(child, out);
}

function load(file: string): Result[] {
  const json = JSON.parse(readFileSync(resolve(file), 'utf8')) as VitestReport & PwSuite;
  const out: Result[] = [];
  if (json.testResults) {
    for (const f of json.testResults)
      for (const a of f.assertionResults ?? []) {
        if (a.status === 'pending' || a.status === 'skipped' || a.status === 'todo') continue;
        out.push({ title: a.fullName ?? a.title ?? '', passed: a.status === 'passed' });
      }
  } else {
    walkPlaywright(json, out);
  }
  return out;
}

const prio = priorities();
const level = levels();
const results: Result[] = [];
for (const r of reports) {
  if (!existsSync(resolve(r))) {
    console.error(`Report not found: ${r}`);
    process.exit(2);
  }
  results.push(...load(r));
}

const state = new Map<string, { passed: number; failed: number }>();
for (const res of results) {
  for (const id of new Set(res.title.match(/\bTC-\d{3}\b/g) ?? [])) {
    const s = state.get(id) ?? { passed: 0, failed: 0 };
    if (res.passed) s.passed++;
    else s.failed++;
    state.set(id, s);
  }
}

let failures = 0;
console.log('P1 test cases');
for (const [id, p] of [...prio].sort()) {
  if (p !== 'P1') continue;
  const s = state.get(id);
  let line: string;
  if (!s) {
    const automated = level.get(id) !== 'manual';
    line = automated ? 'no automated run yet' : 'manual (see docs/manual-tests.md)';
    if (strict && automated) failures++;
  } else if (s.failed > 0) {
    line = `FAILED (${s.failed} failing, ${s.passed} passing)`;
    failures++;
  } else {
    line = `passed (${s.passed} tests; partial coverage is listed in docs/test-matrix.md)`;
  }
  console.log(`  ${id}  ${line}`);
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
