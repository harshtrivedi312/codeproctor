/* global __ENV */
// TC-090 (NFR-02, NFR-01, P1): 200 simulated candidates at the real client cadence.
// Expected (docs/test-cases.md): API p95 under 300 ms and no errors. NFR-01 excludes code execution
// from the 300 ms figure, so code runs are held to TC-091's 5 s instead.
//
// Offered load per candidate (docs/status.md R-02, ADR 0013 section 5):
//   presign + storage PUT + confirm per 10 s chunk x 3 streams, an event batch every 5 s,
//   a keystroke batch every 2 s, a heartbeat every 10 s, one code run a minute.
//   About 1.4 API requests per second per candidate, about 280 per second at 200 candidates.
//
// Run it against staging only, with synthetic data (README). Configuration comes from environment
// variables; nothing secret is in this file.
//   k6 run -e API_BASE_URL=https://<staging-host>/api/v1 -e ALLOWED_HOSTS=<staging-host> \
//     -e SESSIONS_FILE=/absolute/path/sessions.json \
//     packages/qa/k6/tc-090-load.js
import { assertSafeTarget, requireSessions, intEnv, SYSTEM_TAGS } from './lib/config.js';
import { candidateTick } from './lib/candidate.js';

const VUS = intEnv('VUS', 200);
const RAMP = __ENV.RAMP_UP || '2m';
const HOLD = __ENV.HOLD || '10m';
const DOWN = __ENV.RAMP_DOWN || '1m';

// Seconds in a k6 duration such as 90s, 2m or 1h (one unit only; enough for these variables).
function seconds(text) {
  const m = /^(\d+)(s|m|h)$/.exec(text);
  if (!m) {
    throw new Error(`Duration "${text}" must look like 30s, 2m or 1h.`);
  }
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2]];
}

// Proof of offered load: if the generator or the API falls behind, the achieved request rate drops
// below what the cadence requires and the run must fail rather than pass on a lighter load. The
// expected average rate over the whole run weights the ramps at half (VUs rise and fall linearly).
const R = seconds(RAMP);
const H = seconds(HOLD);
const D = seconds(DOWN);
if (VUS < 1) {
  throw new Error('VUS must be at least 1.');
}
if (R + H + D <= 0) {
  throw new Error('RAMP_UP + HOLD + RAMP_DOWN must be longer than zero.');
}
const EXPECTED_RATE = (1.4 * VUS * (R / 2 + H + D / 2)) / (R + H + D);

export const options = {
  // Keep 'url' out of every metric sample: storage PUT URLs are presigned (see lib/candidate.js).
  systemTags: SYSTEM_TAGS,
  scenarios: {
    candidates: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: VUS },
        { duration: HOLD, target: VUS },
        { duration: DOWN, target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    // Headline: every API call except code runs and storage PUTs (NFR-01).
    api_duration: ['p(95)<300'],
    'api_duration{endpoint:heartbeat}': ['p(95)<300'],
    'api_duration{endpoint:events}': ['p(95)<300'],
    'api_duration{endpoint:keystrokes}': ['p(95)<300'],
    'api_duration{endpoint:presign}': ['p(95)<300'],
    'api_duration{endpoint:confirm}': ['p(95)<300'],
    // Code runs wait for Judge0: TC-091 / NFR-01, p95 under 5 s.
    'http_req_duration{endpoint:run}': ['p(95)<5000'],
    // "No errors": any non-2xx API answer counts, a 429 included (the limits in ADR 0013 are sized
    // above this cadence). Storage PUTs are judged separately below.
    'http_req_failed{kind:api}': ['rate==0'],
    'http_req_failed{kind:storage}': ['rate<0.001'],
    // Storage PUTs: 2xx and 412 are expected; other failures are judged here, not in cp_failures.
    cp_storage_failures: ['count<=' + Math.ceil(0.001 * VUS * 0.3 * (R / 2 + H + D / 2))],
    // A replayed seq (duplicate:true) is a finding even though the script moves on.
    cp_duplicate_batches: ['count==0'],
    // Offered load: slots that ran more than half an interval late are counted and skipped ahead.
    cp_late_slots: ['rate<0.01'],
    'http_reqs{kind:api}': ['count>0', 'rate>=' + (0.9 * EXPECTED_RATE).toFixed(1)],
    cp_failures: ['count==0'],
    cp_setup_failures: ['count==0'],
    checks: ['rate==1'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  assertSafeTarget(); // also runs at init (lib/config.js)
  requireSessions(VUS);
}

export default function () {
  candidateTick();
}
