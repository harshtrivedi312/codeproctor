/* global __ENV, open */
// Shared configuration for the TC-090 and TC-091 k6 scripts.
// Everything environment-specific comes from environment variables. No default points at a real
// host, and nothing here is a secret.
import { SharedArray } from 'k6/data';

export const API_BASE = (__ENV.API_BASE_URL || 'http://localhost:4000/api/v1').replace(/\/+$/, '');

// Tags k6 attaches to every metric sample. 'url' is left out on purpose: the storage PUT URL is a
// presigned URL (a bearer capability for its lifetime), and it would otherwise be a tag on
// http_req_* samples that reach summaries, --out files and cloud outputs. Each request sets its own
// 'name' tag, so per-endpoint results are still separable.
export const SYSTEM_TAGS = [
  'status',
  'method',
  'name',
  'group',
  'check',
  'error',
  'error_code',
  'scenario',
  'expected_response',
  'proto',
  'tls_version',
];

// Host guard, an allow-list that fails closed. ALLOWED_HOSTS (comma separated, exact host names,
// no scheme, port or path) is required; only localhost, 127.0.0.1 and host.docker.internal are
// allowed without it (for the mock server). The deny-list below is an extra check that nothing
// overrides: a host containing one of those words is refused even when it is in ALLOWED_HOSTS.
// The CI job has its own allow-list (QA_STAGING_HOSTS); this is a second guard for local runs.
const LOCAL_HOSTS = ['localhost', '127.0.0.1', 'host.docker.internal'];
const DENY = ['prod', 'production', 'pilot'];

export function targetHost() {
  return API_BASE.toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^[^@/]*@/, '')
    .split(/[/:?#]/)[0];
}

export function assertSafeTarget() {
  const host = targetHost();
  if (!host) {
    throw new Error('Refusing to run: API_BASE_URL has no host.');
  }
  for (const bad of DENY) {
    if (host.includes(bad)) {
      throw new Error(
        `Refusing to run: host name contains "${bad}". Load tests run against staging with ` +
          'synthetic data only (DEP-01). This check cannot be overridden.',
      );
    }
  }
  const allowed = (__ENV.ALLOWED_HOSTS || '')
    .toLowerCase()
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '');
  if (!LOCAL_HOSTS.includes(host) && !allowed.includes(host)) {
    throw new Error(
      `Refusing to run: host "${host}" is not in ALLOWED_HOSTS (exact names, comma separated). ` +
        'Name the staging host explicitly.',
    );
  }
}

// Run the guard in the init stage too, so a run with --no-setup or a script error before setup()
// cannot send a request. Importing this module is enough.
assertSafeTarget();

// One entry per simulated candidate session, seeded on staging with synthetic data:
//   { "token": "<candidate bearer token>",
//     "sessionQuestionId": "<uuid of the session question, for keystroke batches>",
//     "questionId": "<uuid of the question, for the run route>",
//     "keyB64": "<optional: the 32-byte batch key, base64, if it was already fetched>",
//     "counters": { optional: the counters object of the proctor-key response } }
// Provide the list with SESSIONS_FILE (a path; read in the init stage) or SESSIONS_JSON (the JSON
// text). The file is git-ignored (packages/qa/k6/.gitignore); keep it outside the repository.
export const SESSIONS = new SharedArray('sessions', function () {
  let text = __ENV.SESSIONS_JSON;
  if (!text && __ENV.SESSIONS_FILE) {
    // open() resolves a relative path against this file (lib/), not the working directory, which
    // is a trap. Require an absolute path.
    if (!__ENV.SESSIONS_FILE.startsWith('/')) {
      throw new Error('SESSIONS_FILE must be an absolute path.');
    }
    text = open(__ENV.SESSIONS_FILE);
  }
  if (!text) {
    return [];
  }
  const list = JSON.parse(text);
  if (!Array.isArray(list)) {
    throw new Error('SESSIONS_FILE / SESSIONS_JSON must hold a JSON array.');
  }
  return list;
});

export function requireSessions(minimum) {
  if (SESSIONS.length < minimum) {
    throw new Error(
      `Need at least ${minimum} seeded sessions (one per virtual user), got ${SESSIONS.length}. ` +
        'Set SESSIONS_FILE or SESSIONS_JSON (see packages/qa/k6/README.md).',
    );
  }
}

export function intEnv(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return n;
}
