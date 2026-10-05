/* global __ENV, open */
// Shared configuration for the TC-090 and TC-091 k6 scripts.
// Everything environment-specific comes from environment variables. No default points at a real
// host, and nothing here is a secret.
import { SharedArray } from 'k6/data';

export const API_BASE = (__ENV.API_BASE_URL || 'http://localhost:4000/api/v1').replace(/\/+$/, '');

// Refuse to run against anything that is not an explicitly named non-production host. The CI job
// has its own allow-list (QA_STAGING_HOSTS); this is a second guard for local runs.
const FORBIDDEN = (__ENV.FORBIDDEN_HOST_SUBSTRINGS || 'prod,production,pilot').split(',');
export function assertSafeTarget() {
  const host = API_BASE.toLowerCase()
    .replace(/^https?:\/\//, '')
    .split(/[/:?#]/)[0];
  for (const bad of FORBIDDEN) {
    const b = bad.trim();
    if (b && host.includes(b) && __ENV.I_KNOW_THIS_IS_NOT_PRODUCTION !== 'yes') {
      throw new Error(
        `Refusing to run: host name contains "${b}". Load tests run against staging with ` +
          'synthetic data only (DEP-01). Set I_KNOW_THIS_IS_NOT_PRODUCTION=yes only if the name is misleading.',
      );
    }
  }
}

// One entry per simulated candidate session, seeded on staging with synthetic data:
//   { "token": "<candidate bearer token>",
//     "sessionQuestionId": "<uuid of the session question, for keystroke batches>",
//     "questionId": "<uuid of the question, for the run route>",
//     "keyB64": "<optional: the 32-byte batch key, base64, if it was already fetched>",
//     "counters": { optional: the counters object of the proctor-key response } }
// Provide the list with SESSIONS_FILE (a path; read in the init stage) or SESSIONS_JSON (the JSON
// text). The file is git-ignored (packages/qa/load/.gitignore); keep it outside the repository.
export const SESSIONS = new SharedArray('sessions', function () {
  let text = __ENV.SESSIONS_JSON;
  if (!text && __ENV.SESSIONS_FILE) {
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
        'Set SESSIONS_FILE or SESSIONS_JSON (see packages/qa/load/README.md).',
    );
  }
}

export function intEnv(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return n;
}
