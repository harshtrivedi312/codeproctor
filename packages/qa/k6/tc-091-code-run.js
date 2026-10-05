/* global __ENV, __VU */
// TC-091 (NFR-01, P2): 50 concurrent code runs. Expected: p95 under 5 s.
// Each virtual user is one candidate with its own seeded session; FR-502 allows one run per 5 s per
// candidate, so each user waits 5.5 s between runs. Judge0 is the part under test.
//   k6 run -e API_BASE_URL=https://<staging-host>/api/v1 -e SESSIONS_FILE=/path/sessions.json \
//     packages/qa/k6/tc-091-code-run.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import {
  API_BASE,
  SESSIONS,
  assertSafeTarget,
  requireSessions,
  intEnv,
  SYSTEM_TAGS,
} from './lib/config.js';

const VUS = intEnv('VUS', 50);
const ROUNDS = intEnv('ROUNDS', 6);
const CODE = __ENV.RUN_CODE || 'import sys\nprint(sum(int(x) for x in sys.stdin.read().split()))\n';
const failures = new Counter('cp_failures');

export const options = {
  systemTags: SYSTEM_TAGS,
  scenarios: {
    runs: { executor: 'per-vu-iterations', vus: VUS, iterations: ROUNDS, maxDuration: '10m' },
  },
  thresholds: {
    'http_req_duration{endpoint:run}': ['p(95)<5000'],
    'http_req_failed{endpoint:run}': ['rate==0'],
    cp_failures: ['count==0'],
    checks: ['rate==1'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  assertSafeTarget();
  requireSessions(VUS);
}

export default function () {
  const entry = SESSIONS[(__VU - 1) % SESSIONS.length];
  const res = http.post(
    `${API_BASE}/candidate/answers/${entry.questionId}/run`,
    JSON.stringify({ language: 'python', code: CODE }),
    {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${entry.token}` },
      tags: { endpoint: 'run', name: 'run' },
    },
  );
  // 200 alone is not enough: the body must be a JSON object holding a results array (shape per the
  // mock and ADR 0013; confirm against BE-09 when it merges).
  const ok = check(res, {
    'run completed with 200': (r) => r.status === 200,
    'run result has a results array': (r) => {
      try {
        return Array.isArray(r.json('results'));
      } catch {
        return false;
      }
    },
  });
  if (!ok) {
    failures.add(1, { status: String(res.status) });
  }
  sleep(5.5);
}
