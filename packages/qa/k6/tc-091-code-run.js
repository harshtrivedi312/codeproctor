/* global __ENV, __VU */
// TC-091 (NFR-01): 50 concurrent code runs. Expected: p95 under 5 s.
//
// PLACEHOLDER PATH: the run endpoint path is a guess; replace it with the real one from the API
// contract when BE-11 merges.
//
// Usage: k6 run -e API_URL=https://staging.example.com -e CANDIDATE_TOKENS=t1,t2,... packages/qa/k6/tc-091-code-run.js
// Use 50 different candidate tokens: FR-502 allows only one run per 5 s per candidate.
import http from 'k6/http';
import { check, sleep } from 'k6';

const API = __ENV.API_URL || 'http://localhost:4000';
const TOKENS = (__ENV.CANDIDATE_TOKENS || 'load-token').split(',');

export const options = {
  scenarios: {
    runs: { executor: 'per-vu-iterations', vus: 50, iterations: 6, maxDuration: '5m' },
  },
  thresholds: {
    // TC-091: p95 of the run endpoint under 5 s.
    'http_req_duration{endpoint:run}': ['p(95)<5000'],
    http_req_failed: ['rate==0'],
  },
};

const CODE = 'import sys\nprint(sum(int(x) for x in sys.stdin.read().split()))\n';

export default function () {
  const token = TOKENS[(__VU - 1) % TOKENS.length];
  const res = http.post(
    `${API}/v1/candidate/questions/current/run`,
    JSON.stringify({ language: 'python', code: CODE }),
    {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      tags: { endpoint: 'run' },
    },
  );
  check(res, { 'run completed': (r) => r.status === 200 });
  // Stay under the one-run-per-5-s rule per candidate.
  sleep(5.5);
}
