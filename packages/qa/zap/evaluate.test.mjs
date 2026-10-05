// Run with: node --test packages/qa/zap/*.test.mjs   (TC-093 verdict logic; no scan needed)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluate } from './evaluate.mjs';

const alert = (riskcode, name = 'x', pluginid = '1') => ({
  riskcode: String(riskcode),
  name,
  pluginid,
  count: '2',
});

void test('TC-093: no alerts but a scanned site passes', () => {
  assert.equal(evaluate({ site: [{ alerts: [] }] }).code, 0);
});

void test('TC-093: a High alert fails', () => {
  const r = evaluate({ site: [{ alerts: [alert(1), alert(3, 'SQL Injection', '40018')] }] });
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /High\t40018\tSQL Injection/);
});

void test('TC-093: Medium and Low alone pass, Medium fails with --fail-on-medium', () => {
  const report = { site: [{ alerts: [alert(2), alert(1)] }] };
  assert.equal(evaluate(report).code, 0);
  assert.equal(evaluate(report, { failOnMedium: true }).code, 1);
});

void test('TC-093: an empty report (target unreachable) is not a pass', () => {
  assert.equal(evaluate({ site: [] }).code, 2);
  assert.equal(evaluate({}).code, 2);
  assert.equal(evaluate(null).code, 2);
});

void test('TC-093: the output never contains a URL', () => {
  const a = { ...alert(3), instances: [{ uri: 'https://x.example/?token=secret' }] };
  assert.doesNotMatch(evaluate({ site: [{ alerts: [a] }] }).lines.join('\n'), /secret|https?:/);
});

void test('TC-093: an alert with a missing, non-numeric or out-of-range riskcode is unusable', () => {
  for (const riskcode of [undefined, 'high', '', '4', '-1', '1.5', null]) {
    const a = { name: 'x', pluginid: '1', count: '1', riskcode };
    assert.equal(evaluate({ site: [{ alerts: [a] }] }).code, 2, String(riskcode));
  }
});

void test('TC-093: --target-host needs a site with that @host, else exit 2', () => {
  const report = { site: [{ '@host': 'a.example', alerts: [] }] };
  assert.equal(evaluate(report, { targetHost: 'a.example' }).code, 0);
  assert.equal(evaluate(report, { targetHost: 'b.example' }).code, 2);
});

// CLI: run through a relative path and through a symlink; the main-guard must hold for both.
const here = path.dirname(fileURLToPathSafe(import.meta.url));
function fileURLToPathSafe(u) {
  return decodeURIComponent(new URL(u).pathname);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc093-'));
const link = path.join(tmp, 'link.mjs');
fs.symlinkSync(path.join(here, 'evaluate.mjs'), link);
const write = (name, body) => {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, body);
  return f;
};
const run = (script, cwd, args) =>
  spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

for (const [label, script, cwd] of [
  ['relative path', path.relative(here, path.join(here, 'evaluate.mjs')), here],
  ['symlink', link, tmp],
]) {
  void test(`TC-093: CLI via ${label} exits 2 for a missing file, invalid JSON and an empty site list`, () => {
    assert.equal(run(script, cwd, [path.join(tmp, 'nope.json')]).status, 2);
    assert.equal(run(script, cwd, [write('bad.json', '{not json')]).status, 2);
    assert.equal(run(script, cwd, [write('empty.json', '{"site":[]}')]).status, 2);
    assert.equal(run(script, cwd, []).status, 2);
    const ok = write('ok.json', '{"site":[{"@host":"a.example","alerts":[]}]}');
    assert.equal(run(script, cwd, [ok]).status, 0);
    assert.equal(run(script, cwd, [ok, '--target-host', 'b.example']).status, 2);
  });
}
