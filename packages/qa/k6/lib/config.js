/* global __ENV, open */
// Shared configuration for the TC-090 and TC-091 k6 scripts.
// Everything environment-specific comes from environment variables. No default points at a real
// host, and nothing here is a secret.
import { SharedArray } from 'k6/data';
import { checkTarget, LOCAL_HOSTS } from './guard.js';

const RAW_API_BASE = (__ENV.API_BASE_URL || 'http://localhost:4000/api/v1').replace(/\/+$/, '');
export const API_BASE = RAW_API_BASE;

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

// Host guard (lib/guard.js, tested by lib/guard.test.mjs): an allow-list that fails closed.
// API_BASE_URL must match a strict whole-URL pattern; ALLOWED_HOSTS (comma separated, exact host
// names) is required; only localhost, 127.0.0.1 and host.docker.internal are allowed without it.
// A host containing prod, production or pilot is refused even when listed; nothing overrides that.
// The CI job has its own allow-list (QA_STAGING_HOSTS); this is a second guard for local runs.
export function assertSafeTarget() {
  const host = checkTarget(RAW_API_BASE, __ENV.ALLOWED_HOSTS);
  // Bearer tokens, signed batches and proctor keys go to this URL: https unless the host is local.
  if (!LOCAL_HOSTS.includes(host) && !RAW_API_BASE.toLowerCase().startsWith('https://')) {
    throw new Error('API_BASE_URL must use https:// for a host that is not local.');
  }
}

// Run the guard in the init stage too, so a run with --no-setup or a script error before setup()
// cannot send a request. Importing this module is enough.
assertSafeTarget();

// One entry per simulated candidate session, seeded on staging with synthetic data:
//   { "token": "<candidate bearer token>",
//     "sessionQuestionId": "<uuid; used in the run, draft and submit routes (BE-11) and in keystroke batches>",
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
  // A seeder file made with --stop-at holds sessions that are not in progress and carry no
  // sessionQuestionId: refuse it here instead of failing later in a gate run.
  for (const e of list) {
    if (!e || typeof e.token !== 'string' || typeof e.sessionQuestionId !== 'string') {
      throw new Error(
        'Every session needs a token and a sessionQuestionId (a seeder file made with --stop-at has none).',
      );
    }
    if (e.state !== undefined && e.state !== 'IN_PROGRESS') {
      throw new Error('Every session must be IN_PROGRESS (this file was made with --stop-at).');
    }
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
