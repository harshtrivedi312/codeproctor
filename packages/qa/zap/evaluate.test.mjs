// Run with: node --test packages/qa/zap/*.test.mjs   (TC-093 verdict logic; no scan needed)
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

void test('TC-093: a numeric riskcode 3 counts as High', () => {
  assert.equal(evaluate({ site: [{ alerts: [{ riskcode: 3, name: 'x' }] }] }).code, 1);
});

void test('TC-093: a null site or non-array alerts is an unusable report, not a TypeError', () => {
  assert.equal(evaluate({ site: [null] }).code, 2);
  assert.equal(evaluate({ site: [{ alerts: 'x' }] }).code, 2);
  assert.equal(evaluate({ site: [{ alerts: {} }] }).code, 2);
  assert.equal(evaluate({ site: [{ alerts: [null] }] }).code, 2);
});

// CLI (cli.mjs): run through a relative path and through a symlink.
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc093-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const link = path.join(tmp, 'link.mjs');
fs.symlinkSync(path.join(here, 'cli.mjs'), link);
const write = (name, body) => {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, body);
  return f;
};
const run = (script, cwd, args) =>
  spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
const site = (...alerts) => JSON.stringify({ site: [{ '@host': 'a.example', alerts }] });

for (const [label, script, cwd] of [
  ['relative path', 'cli.mjs', here],
  ['symlink', link, tmp],
]) {
  void test(`TC-093: CLI via ${label} gives the right exit code`, () => {
    assert.equal(run(script, cwd, [path.join(tmp, 'nope.json')]).status, 2);
    assert.equal(run(script, cwd, [write('bad.json', '{not json')]).status, 2);
    assert.equal(run(script, cwd, [write('empty.json', '{"site":[]}')]).status, 2);
    assert.equal(run(script, cwd, []).status, 2);
    const ok = write('ok.json', site());
    const good = run(script, cwd, [ok]);
    assert.equal(good.status, 0);
    assert.match(good.stdout, /TC-093 PASS/);
    assert.equal(run(script, cwd, [ok, '--target-host', 'b.example']).status, 2);
    assert.equal(run(script, cwd, [ok, '--target-host', 'a.example']).status, 0);
    const high = run(script, cwd, [write('high.json', site({ riskcode: '3', name: 'h' }))]);
    assert.equal(high.status, 1);
    assert.match(high.stdout, /TC-093 FAIL/);
    const med = write('med.json', site({ riskcode: '2', name: 'm' }));
    assert.equal(run(script, cwd, [med]).status, 0);
    assert.equal(run(script, cwd, [med, '--fail-on-medium']).status, 1);
  });

  void test(`TC-093: CLI via ${label} rejects unknown options and --flag=value forms`, () => {
    const ok = write('ok2.json', site());
    for (const bad of [
      ['--bogus'],
      ['--fail-on-medium=true'],
      ['--target-host=a.example'],
      ['--target-host'],
      ['--target-host', '--fail-on-medium'],
    ]) {
      assert.equal(run(script, cwd, [ok, ...bad]).status, 2, bad.join(' '));
    }
    assert.equal(run(script, cwd, [ok, ok]).status, 2);
  });
}
