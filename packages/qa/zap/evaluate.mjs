// TC-093 verdict from a ZAP JSON report (zap-baseline.py -J report.json).
// Library only. The command line is cli.mjs:
//   node packages/qa/zap/cli.mjs zap/report.json [--fail-on-medium] [--target-host <host>]
// Exit 0: the scan reached the target and found no High alert (risk code 3).
// Exit 1: a High alert, or (with --fail-on-medium) a Medium alert.
// Exit 2: unusable report, or the scan reached nothing. The second case matters: an unreachable
// target gives an empty report, and "zero High alerts" on an empty report is a false pass.
// Unusable also means: an alert whose riskcode is missing, not an integer, or outside 0..3, and (with
// --target-host) no site entry whose @host equals that host.
// ZAP's own exit code 3 (the scan itself failed) must fail the CI step before this script runs.
//
// Output lists alert names, rule ids, risk and instance counts only. It prints no URL, because a URL
// can carry a token (CLAUDE.md: never log tokens).

const RISK = { 0: 'Informational', 1: 'Low', 2: 'Medium', 3: 'High' };

export function evaluate(report, { failOnMedium = false, targetHost } = {}) {
  const sites = Array.isArray(report?.site) ? report.site : [];
  if (sites.length === 0) {
    return { code: 2, lines: ['No site in the report: the scan reached nothing. Not a pass.'] };
  }
  if (targetHost && !sites.some((s) => String(s?.['@host'] ?? '') === targetHost)) {
    return {
      code: 2,
      lines: ['The report has no site for the target host: the scan did not reach it. Not a pass.'],
    };
  }
  const unusable = {
    code: 2,
    lines: ['The report has a malformed site or alerts list: unusable report.'],
  };
  for (const site of sites) {
    if (site === null || typeof site !== 'object') return unusable;
    if (site.alerts !== undefined && !Array.isArray(site.alerts)) return unusable;
    for (const a of site.alerts ?? []) if (a === null || typeof a !== 'object') return unusable;
  }
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
  const rows = [];
  for (const site of sites) {
    for (const a of site.alerts ?? []) {
      const raw = a.riskcode;
      const risk = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
      if (raw === '' || !Number.isInteger(risk) || risk < 0 || risk > 3) {
        return { code: 2, lines: ['An alert has a missing or invalid riskcode: unusable report.'] };
      }
      const n = Number(a.count ?? (a.instances ? a.instances.length : 1));
      counts[risk] += 1;
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
