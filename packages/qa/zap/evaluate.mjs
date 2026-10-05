// TC-093 verdict from a ZAP JSON report (zap-baseline.py -J report.json).
//   node packages/qa/zap/evaluate.mjs zap/report.json [--fail-on-medium]
// Exit 0: the scan reached the target and found no High alert (risk code 3).
// Exit 1: a High alert, or (with --fail-on-medium) a Medium alert.
// Exit 2: unusable report, or the scan reached nothing. The second case matters: an unreachable
// target gives an empty report, and "zero High alerts" on an empty report is a false pass.
//
// Output lists alert names, rule ids, risk and instance counts only. It prints no URL, because a URL
// can carry a token (CLAUDE.md: never log tokens).
import fs from 'node:fs';

const RISK = { 0: 'Informational', 1: 'Low', 2: 'Medium', 3: 'High' };

export function evaluate(report, { failOnMedium = false } = {}) {
  const sites = Array.isArray(report?.site) ? report.site : [];
  if (sites.length === 0) {
    return { code: 2, lines: ['No site in the report: the scan reached nothing. Not a pass.'] };
  }
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
  const rows = [];
  for (const site of sites) {
    for (const a of site.alerts ?? []) {
      const risk = Number(a.riskcode);
      const n = Number(a.count ?? (a.instances ? a.instances.length : 1));
      counts[risk] = (counts[risk] ?? 0) + 1;
      rows.push({ risk, name: String(a.name ?? a.alert ?? '?'), id: String(a.pluginid ?? '?'), n });
    }
  }
  rows.sort((x, y) => y.risk - x.risk || x.name.localeCompare(y.name));
  const lines = rows.map(
    (r) => `${RISK[r.risk] ?? r.risk}\t${r.id}\t${r.name}\t${r.n} instance(s)`,
  );
  lines.push(
    `High: ${counts[3]}  Medium: ${counts[2]}  Low: ${counts[1]}  Informational: ${counts[0]}  (distinct alerts)`,
  );
  const failed = counts[3] > 0 || (failOnMedium && counts[2] > 0);
  lines.push(failed ? 'TC-093 FAIL' : 'TC-093 PASS');
  return { code: failed ? 1 : 0, lines };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: node evaluate.mjs <report.json> [--fail-on-medium]');
    process.exit(2);
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    console.error('Cannot read the ZAP report as JSON.');
    process.exit(2);
  }
  const { code, lines } = evaluate(report, { failOnMedium: args.includes('--fail-on-medium') });
  console.log(lines.join('\n'));
  process.exit(code);
}
