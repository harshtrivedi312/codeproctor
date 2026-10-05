/* global __VU, __ENV */
// One simulated candidate: the real client cadence of the proctoring SDK (docs/status.md R-02,
// ADR 0013 section 5):
//   heartbeat        every 10 s   POST /candidate/session/heartbeat      (unsigned)
//   event batch      every  5 s   POST /candidate/session/events         (signed, X-Signature)
//   keystroke batch  every  2 s   POST /candidate/session/keystrokes     (signed)
//   media chunk      every 10 s per stream (SCREEN, WEBCAM, AUDIO):
//                                 POST /candidate/session/media/presign, PUT to object storage,
//                                 POST /candidate/session/media/confirm
//   code run         once a minute (optional)  POST /candidate/answers/:questionId/run
// That is about 1.4 requests per second per candidate (280 per second at 200 candidates).
//
// Nothing here logs a token, a key, a signature, a presigned URL or a request body. Failures are
// counted by endpoint and status code only.
import http from 'k6/http';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { API_BASE, SESSIONS, intEnv } from './config.js';
import { canonicalJson } from './canonical.js';

export const apiDuration = new Trend('api_duration', true); // every API call except runs and storage PUTs
export const failures = new Counter('cp_failures'); // tagged by endpoint and status
export const setupFailures = new Counter('cp_setup_failures');

const STREAMS = ['SCREEN', 'WEBCAM', 'AUDIO'];
const CHUNK_MS = 10_000;
const VIDEO_BYTES = intEnv('CHUNK_BYTES_VIDEO', 262144); // real chunks are larger; see README
const AUDIO_BYTES = intEnv('CHUNK_BYTES_AUDIO', 65536);
const RUN_EVERY_MS = intEnv('RUN_EVERY_MS', 60_000); // 0 turns candidate code runs off
const RUN_CODE = __ENV.RUN_CODE || 'print(1)\n';

const payloads = {
  video: new Uint8Array(VIDEO_BYTES).buffer, // zero bytes: synthetic, not a playable WebM
  audio: new Uint8Array(AUDIO_BYTES).buffer,
};

// State of this virtual user. k6 keeps module-level variables per VU across iterations.
let state = null;

function init() {
  const entry = SESSIONS[(__VU - 1) % SESSIONS.length];
  const now = Date.now();
  state = {
    entry,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${entry.token}` },
    key: null,
    eventSeq: 0,
    keystrokeSeq: 0,
    editorOffset: 0,
    media: {},
    due: {},
    ready: false,
    dead: false,
  };
  STREAMS.forEach((s, i) => {
    state.media[s] = { seq: 0, segment: 0 };
    // Spread the three streams over the 10 s chunk interval, as separate recorders do.
    state.due['media:' + s] = now + 1000 + i * 3300;
  });
  state.due.heartbeat = now + Math.random() * 10_000; // spread the VUs
  state.due.events = now + Math.random() * 5_000;
  state.due.keystrokes = now + Math.random() * 2_000;
  state.due.run = RUN_EVERY_MS > 0 ? now + Math.random() * RUN_EVERY_MS : Infinity;
}

function api(path, body, endpoint, extraHeaders) {
  const headers = Object.assign({}, state.headers, extraHeaders || {});
  const params = { headers, tags: { kind: 'api', endpoint, name: endpoint } };
  const res = http.post(`${API_BASE}${path}`, body, params);
  if (endpoint !== 'run') {
    apiDuration.add(res.timings.duration, { endpoint });
  }
  if (res.status < 200 || res.status >= 300) {
    failures.add(1, { endpoint, status: String(res.status) });
  }
  return res;
}

function sign(body) {
  return crypto.hmac('sha256', state.key, body, 'hex');
}

function fetchKey() {
  if (state.entry.keyB64) {
    state.key = encoding.b64decode(state.entry.keyB64, 'std');
    applyCounters(state.entry.counters);
    return true;
  }
  const res = api('/candidate/session/proctor-key', null, 'proctor_key');
  if (res.status !== 200) {
    // 409 KEY_ALREADY_ISSUED means this session's key for this epoch was fetched in an earlier
    // run. Seed fresh sessions for every run (README).
    setupFailures.add(1, { status: String(res.status) });
    return false;
  }
  const json = res.json();
  state.key = encoding.b64decode(json.key, 'std');
  applyCounters(json.counters);
  return true;
}

function applyCounters(c) {
  if (!c) {
    return;
  }
  state.eventSeq = c.eventSeqStart || 0;
  state.keystrokeSeq = c.keystrokeSeqStart || 0;
  if (c.media) {
    STREAMS.forEach((s) => {
      if (c.media[s]) {
        state.media[s] = { seq: c.media[s].nextSeq || 0, segment: c.media[s].nextSegment || 0 };
      }
    });
  }
}

function heartbeat() {
  const res = api('/candidate/session/heartbeat', '{}', 'heartbeat');
  check(res, { 'heartbeat 200': (r) => r.status === 200 }, { endpoint: 'heartbeat' });
}

function eventBatch() {
  // RIGHT_CLICK is LOW severity with an empty payload: it adds a flag-free row without pausing the
  // session or moving the risk band much. Two events per batch, one batch every 5 s.
  const t = new Date().toISOString();
  const body = canonicalJson({
    seq: state.eventSeq,
    events: [
      { type: 'RIGHT_CLICK', occurredAt: t, payload: {} },
      { type: 'RIGHT_CLICK', occurredAt: t, payload: {} },
    ],
  });
  const res = api('/candidate/session/events', body, 'events', { 'X-Signature': sign(body) });
  const ok = check(
    res,
    { 'events 200 and stored': (r) => r.status === 200 && r.json('duplicate') === false },
    { endpoint: 'events' },
  );
  if (ok) {
    state.eventSeq += 1;
  }
}

function keystrokeBatch() {
  // About ten editor events per 2 s batch (a fast typist). t is the offset from startedAt, so each
  // batch is stamped with its own start and the offsets stay small and non-decreasing.
  const events = [];
  for (let i = 0; i < 10; i++) {
    events.push({
      kind: 'EDIT',
      t: i * 150,
      offset: state.editorOffset,
      deleteLength: 0,
      text: 'x',
    });
    state.editorOffset += 1;
  }
  const body = canonicalJson({
    seq: state.keystrokeSeq,
    sessionQuestionId: state.entry.sessionQuestionId,
    startedAt: new Date().toISOString(),
    events,
  });
  const res = api('/candidate/session/keystrokes', body, 'keystrokes', {
    'X-Signature': sign(body),
  });
  const ok = check(
    res,
    { 'keystrokes 200 and stored': (r) => r.status === 200 && r.json('duplicate') === false },
    { endpoint: 'keystrokes' },
  );
  if (ok) {
    state.keystrokeSeq += 1;
  }
}

function mediaChunk(stream) {
  const m = state.media[stream];
  const isAudio = stream === 'AUDIO';
  const bytes = isAudio ? AUDIO_BYTES : VIDEO_BYTES;
  const contentType = isAudio ? 'audio/webm' : 'video/webm';
  const presignBody = JSON.stringify({
    stream,
    segment: m.segment,
    seq: m.seq,
    bytes,
    contentType,
    startedAt: new Date(Date.now() - CHUNK_MS).toISOString(),
    durationMs: CHUNK_MS,
  });
  const presign = api('/candidate/session/media/presign', presignBody, 'presign');
  if (!check(presign, { 'presign 200': (r) => r.status === 200 }, { endpoint: 'presign' })) {
    return;
  }
  const grant = presign.json();
  if (!grant.alreadyUploaded) {
    // Straight to object storage (R2 on staging). Not an API call: tagged kind:storage and left out
    // of the 300 ms threshold (NFR-01 covers the API). The URL is never logged or stored in a metric.
    const put = http.put(grant.url, isAudio ? payloads.audio : payloads.video, {
      headers: grant.headers || { 'Content-Type': contentType },
      tags: { kind: 'storage', endpoint: 'media_put', name: 'media_put' },
    });
    // 412 means "already stored" (If-None-Match, ADR 0013 5.5): go on to confirm.
    if (
      !check(
        put,
        { 'chunk PUT 2xx or 412': (r) => (r.status >= 200 && r.status < 300) || r.status === 412 },
        { endpoint: 'media_put' },
      )
    ) {
      failures.add(1, { endpoint: 'media_put', status: String(put.status) });
      return;
    }
  }
  const confirm = api(
    '/candidate/session/media/confirm',
    JSON.stringify({ stream, segment: m.segment, seq: m.seq }),
    'confirm',
  );
  if (check(confirm, { 'confirm 200': (r) => r.status === 200 }, { endpoint: 'confirm' })) {
    m.seq += 1;
  }
}

function codeRun() {
  const res = api(
    `/candidate/answers/${state.entry.questionId}/run`,
    JSON.stringify({ language: 'python', code: RUN_CODE }),
    'run',
  );
  check(res, { 'run 200': (r) => r.status === 200 }, { endpoint: 'run' });
}

const SCHEDULE = [
  { name: 'keystrokes', every: 2_000, fn: keystrokeBatch },
  { name: 'events', every: 5_000, fn: eventBatch },
  { name: 'heartbeat', every: 10_000, fn: heartbeat },
  ...STREAMS.map((s) => ({ name: 'media:' + s, every: CHUNK_MS, fn: () => mediaChunk(s) })),
  { name: 'run', every: RUN_EVERY_MS || Infinity, fn: codeRun },
];

// One k6 iteration = run whatever is due, then sleep until the next thing is due (at most 1 s, so
// a ramp-down never waits long).
export function candidateTick() {
  if (state === null) {
    init();
  }
  if (state.dead) {
    sleep(5);
    return;
  }
  if (!state.ready) {
    state.ready = fetchKey();
    if (!state.ready) {
      state.dead = true;
      return;
    }
  }
  const now = Date.now();
  for (const item of SCHEDULE) {
    if (state.due[item.name] <= now) {
      item.fn();
      // Fixed-rate schedule: advance from the previous due time, so a slow response does not
      // lower the offered load. If we fell far behind, skip ahead (do not burst).
      state.due[item.name] = Math.max(state.due[item.name] + item.every, now + item.every / 2);
    }
  }
  const next = Math.min(...SCHEDULE.map((s) => state.due[s.name]));
  sleep(Math.min(1, Math.max(0.05, (next - Date.now()) / 1000)));
}
