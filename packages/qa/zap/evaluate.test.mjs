// Run with: node --test packages/qa/zap/*.test.mjs   (TC-093 verdict logic; no scan needed)
import test from 'node:test';
import assert from 'node:assert/strict';
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
