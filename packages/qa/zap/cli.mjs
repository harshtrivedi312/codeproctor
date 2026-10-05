// Command line for the TC-093 verdict (logic in evaluate.mjs).
//   node packages/qa/zap/cli.mjs zap/report.json [--fail-on-medium] [--target-host <host>]
// Exit codes as in evaluate.mjs; any other option, or a --flag=value form, is a usage error (exit 2).
import fs from 'node:fs';
import { evaluate } from './evaluate.mjs';

const USAGE = 'Usage: node cli.mjs <report.json> [--fail-on-medium] [--target-host <host>]';

function parse(argv) {
  let file;
  let failOnMedium = false;
  let targetHost;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--fail-on-medium') failOnMedium = true;
    else if (a === '--target-host') {
      targetHost = argv[i + 1];
      i += 1;
      if (!targetHost || targetHost.startsWith('--')) return null;
    } else if (a.startsWith('--') || file !== undefined) return null;
    else file = a;
  }
  return file === undefined ? null : { file, failOnMedium, targetHost };
}

const opts = parse(process.argv.slice(2));
if (!opts) {
  console.error(USAGE);
  process.exitCode = 2;
} else {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
  } catch {
    console.error('Cannot read the ZAP report as JSON.');
    process.exitCode = 2;
  }
  if (process.exitCode !== 2) {
    const { code, lines } = evaluate(report, opts);
    console.log(lines.join('\n'));
    process.exitCode = code;
  }
}
