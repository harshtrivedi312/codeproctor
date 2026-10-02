/* global __ENV, __VU, __ITER */
// TC-090 (NFR-02): 200 simulated candidates send events, heartbeats and code runs.
// Expected: API p95 under 300 ms and no errors.
//
// Usage: k6 run -e API_URL=https://staging.example.com packages/qa/k6/tc-090-load.js
// Needs a staging API with seeded candidate sessions (token list in CANDIDATE_TOKENS, comma
// separated, one per virtual user; reused round-robin if fewer). Never run against production.
// The endpoint paths follow /docs/fsd.md section 4 and are checked against the real API when
// BE-10 and BE-11 merge.
import http from 'k6/http';
import { check, sleep } from 'k6';

const API = __ENV.API_URL || 'http://localhost:4000';
const TOKENS = (__ENV.CANDIDATE_TOKENS || 'load-token').split(',');

export const options = {
  scenarios: {
    candidates: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 200 },
        { duration: '10m', target: 200 },
        { duration: '1m', target: 0 },
      ],
    },
  },
  thresholds: {
    // TC-090: p95 under 300 ms across the whole API, and no errors.
    http_req_duration: ['p(95)<300'],
    http_req_failed: ['rate==0'],
    checks: ['rate==1'],
  },
};

export default function () {
  const token = TOKENS[(__VU - 1) % TOKENS.length];
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // Heartbeat every 10 s (FR-609).
  const hb = http.post(`${API}/v1/sessions/current/heartbeat`, '{}', { headers });
  check(hb, { 'heartbeat 2xx': (r) => r.status >= 200 && r.status < 300 });

  // An event batch every 5 s with a few events (FR-801). The signature is a placeholder; the
  // load environment must run with signature checks relaxed or with a k6 signer (see followups).
  const batch = {
    sequence: __ITER,
    events: [{ type: 'FOCUS_LOST', occurredAt: new Date().toISOString(), durationMs: 800 }],
  };
  const ev = http.post(`${API}/v1/sessions/current/events`, JSON.stringify(batch), { headers });
  check(ev, { 'events 2xx': (r) => r.status >= 200 && r.status < 300 });

  // About one run per minute per candidate (FR-502 allows one per 5 s).
  if (__ITER % 6 === 0) {
    const run = http.post(
      `${API}/v1/candidate/questions/current/run`,
      JSON.stringify({ language: 'python', code: 'print(1)' }),
      { headers },
    );
    check(run, {
      'run 2xx or 429': (r) => r.status === 202 || r.status === 200 || r.status === 429,
    });
  }
  sleep(5);
}
