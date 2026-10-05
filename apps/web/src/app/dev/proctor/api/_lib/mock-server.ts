import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { keystrokeBatchSchema, proctorEventBatchSchema } from '@codeproctor/shared';
import { DEMO_HMAC_KEY_B64 } from '../../demo-key';

/**
 * DEV-ONLY mock of the candidate API for the /dev/proctor demo.
 *
 * PROVISIONAL, ADR 0013 (Proposed, PR #39): the wire formats follow the tables in ADR 0013
 * sections 2 to 5 and can change when the owner accepts or amends it. State is in memory per demo
 * session and per server process; nothing here logs keys, tokens, bodies, URLs or object keys.
 * Not modelled: key epochs (one demo key, so no KEY_EPOCH_STALE), SESSION_NOT_ACTIVE, rate limits
 * other than the 1 per 60 s identity limit, org prefixes beyond a fixed `demo` org.
 */

export const PROVISIONAL_LABEL = 'provisional, ADR 0013 (Proposed, PR #39)';

// ---------- limits (ADR 0013 sections 2, 5.2, 5.5, 5.6) ----------
export const MAX_EVENT_BATCH_BYTES = 256 * 1024;
export const MAX_KEYSTROKE_BATCH_BYTES = 2 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
export const MAX_AUDIO_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 1024 * 1024;
export const MAX_SESSIONS = 20;
export const MAX_CHUNKS_PER_SESSION = 5000;
export const MAX_BATCHES_PER_SESSION = 5000;
export const IDENTITY_MIN_INTERVAL_MS = 60_000;

export type BatchStatus =
  'ACCEPTED' | 'DUPLICATE' | 'SEQ_CONFLICT' | 'SIGNATURE_INVALID' | 'VALIDATION_FAILED';

export interface BatchRecord {
  route: 'events' | 'keystrokes';
  seq: number | null;
  status: BatchStatus;
  events: number;
  at: string;
}
export interface ChunkRecord {
  stream: string;
  segment: number;
  seq: number;
  declaredBytes: number;
  contentType: string;
  putBytes: number | null;
  putType: string | null;
  confirmed: boolean;
}
export interface SessionState {
  heartbeats: {
    count: number;
    lastAt: string | null;
    withHealth: number;
    lastRecorder: unknown;
    lastQueue: unknown;
  };
  /** `${route}:${seq}` -> signature of the accepted batch. */
  accepted: Map<string, string>;
  batches: BatchRecord[];
  eventTypes: Record<string, number>;
  chunks: Map<string, ChunkRecord>;
  /** Evidence names issued by presign: name -> purpose. */
  evidenceIssued: Map<string, 'EVENT' | 'IDENTITY_RECHECK'>;
  evidence: { presigned: number; uploaded: number; namesDropped: number };
  identity: { accepted: number; serverFaceMismatch: number; lastAt: number };
  errors: Record<string, number>;
}

const GLOBAL_KEY = Symbol.for('codeproctor.dev-proctor.mock-state');
type Store = Map<string, SessionState>;

export function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  const existing = g[GLOBAL_KEY];
  if (existing) return existing;
  const fresh: Store = new Map<string, SessionState>();
  g[GLOBAL_KEY] = fresh;
  return fresh;
}

function emptyState(): SessionState {
  return {
    heartbeats: { count: 0, lastAt: null, withHealth: 0, lastRecorder: null, lastQueue: null },
    accepted: new Map(),
    batches: [],
    eventTypes: {},
    chunks: new Map(),
    evidenceIssued: new Map(),
    evidence: { presigned: 0, uploaded: 0, namesDropped: 0 },
    identity: { accepted: 0, serverFaceMismatch: 0, lastAt: 0 },
    errors: {},
  };
}

/** Per-session state; the oldest session is evicted past MAX_SESSIONS so memory stays bounded. */
export function sessionState(id: string): SessionState {
  const s = store();
  let st = s.get(id);
  if (!st) {
    if (s.size >= MAX_SESSIONS) {
      const oldest = s.keys().next().value;
      if (oldest !== undefined) s.delete(oldest);
    }
    st = emptyState();
    s.set(id, st);
  }
  return st;
}

/** The mock identifies the demo session from its dev token (`demo-<id>`). */
export function sessionIdFromAuth(header: string | null): string | null {
  const m = /^Bearer demo-([A-Za-z0-9-]{1,64})$/.exec(header ?? '');
  return m?.[1] ?? null;
}

/** Dev handlers answer 404 in production builds. */
export function isDevBlocked(): boolean {
  return process.env.NODE_ENV === 'production';
}

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** RFC 7807 problem with the ADR 0013 `code` extension. Never echoes request values. */
export function problem(status: number, code: string, title: string, st?: SessionState): Reply {
  if (st) st.errors[code] = (st.errors[code] ?? 0) + 1;
  return {
    status,
    body: { type: 'about:blank', title, status, code },
    headers: { 'Content-Type': 'application/problem+json' },
  };
}

// ---------- signing ----------

export function hmacHex(body: string | Uint8Array, keyB64 = DEMO_HMAC_KEY_B64): string {
  return createHmac('sha256', Buffer.from(keyB64, 'base64')).update(body).digest('hex');
}

/** Constant-time compare of the lowercase-hex signature with HMAC over the received bytes. */
function signatureMatches(raw: Uint8Array, signature: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(hmacHex(raw), 'hex');
  return timingSafeEqual(Buffer.from(signature, 'hex'), expected);
}

// ---------- heartbeat (ADR 0013 section 5.3) ----------

export function heartbeat(st: SessionState, body: unknown): Reply {
  st.heartbeats.count++;
  st.heartbeats.lastAt = new Date().toISOString();
  const b = body as { recorder?: unknown; queue?: unknown } | null;
  if (b && (b.recorder !== undefined || b.queue !== undefined)) {
    st.heartbeats.withHealth++;
    st.heartbeats.lastRecorder = b.recorder ?? st.heartbeats.lastRecorder;
    st.heartbeats.lastQueue = b.queue ?? st.heartbeats.lastQueue;
  }
  return {
    status: 200,
    body: {
      serverTime: new Date().toISOString(),
      status: 'IN_PROGRESS',
      deadlineAt: new Date(Date.now() + 3600_000).toISOString(),
      sectionDeadlineAt: null,
      pauseReasons: [],
    },
  };
}

// ---------- batches (sections 2 and 5.2) ----------

function pushBatch(st: SessionState, r: BatchRecord): void {
  st.batches.push(r);
  if (st.batches.length > 200) st.batches.shift();
}

/** Strip evidence names that were not issued to this session (the batch still succeeds). */
function countUnissuedEvidence(
  st: SessionState,
  events: readonly { evidenceKey?: string }[],
): void {
  for (const e of events) {
    if (e.evidenceKey !== undefined && !st.evidenceIssued.has(e.evidenceKey)) {
      st.evidence.namesDropped++;
    }
  }
}

/**
 * Verification order of ADR 0013 section 2 for both batch routes: content type, size, signature
 * format and constant-time compare over the RECEIVED BYTES, strict UTF-8, JSON, shared schema, then
 * the (seq, signature) idempotency check.
 */
export function batch(
  route: 'events' | 'keystrokes',
  st: SessionState,
  raw: Uint8Array,
  signature: string,
  contentType: string | null,
): Reply {
  const at = new Date().toISOString();
  const fail = (
    status: number,
    code: BatchStatus | 'UNSUPPORTED_MEDIA_TYPE' | 'PAYLOAD_TOO_LARGE',
    title: string,
  ): Reply => {
    if (code === 'SIGNATURE_INVALID' || code === 'VALIDATION_FAILED') {
      pushBatch(st, { route, seq: null, status: code, events: 0, at });
    }
    return problem(status, code, title, st);
  };
  if (!/^application\/json\b/i.test(contentType ?? '')) {
    return fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported media type');
  }
  const limit = route === 'events' ? MAX_EVENT_BATCH_BYTES : MAX_KEYSTROKE_BATCH_BYTES;
  if (raw.byteLength > limit) return fail(413, 'PAYLOAD_TOO_LARGE', 'Payload too large');
  if (!signatureMatches(raw, signature)) return fail(403, 'SIGNATURE_INVALID', 'Signature invalid');
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    return fail(400, 'VALIDATION_FAILED', 'Validation failed');
  }
  const parsed =
    route === 'events'
      ? proctorEventBatchSchema.safeParse(json)
      : keystrokeBatchSchema.safeParse(json);
  if (!parsed.success) return fail(400, 'VALIDATION_FAILED', 'Validation failed');
  const { seq, events } = parsed.data;
  const id = `${route}:${seq}`;
  const prior = st.accepted.get(id);
  if (prior !== undefined) {
    if (prior === signature) {
      pushBatch(st, { route, seq, status: 'DUPLICATE', events: events.length, at });
      return { status: 200, body: { seq, duplicate: true } };
    }
    pushBatch(st, { route, seq, status: 'SEQ_CONFLICT', events: events.length, at });
    return problem(409, 'SEQ_CONFLICT', 'Sequence conflict', st);
  }
  if (st.accepted.size >= MAX_BATCHES_PER_SESSION) {
    return problem(429, 'RATE_LIMITED', 'Too many batches', st);
  }
  st.accepted.set(id, signature);
  if (route === 'events') {
    const evs = (parsed.data as { events: { type: string; evidenceKey?: string }[] }).events;
    for (const e of evs) st.eventTypes[e.type] = (st.eventTypes[e.type] ?? 0) + 1;
    countUnissuedEvidence(st, evs);
  }
  pushBatch(st, { route, seq, status: 'ACCEPTED', events: events.length, at });
  return { status: 200, body: { seq, duplicate: false } };
}

// ---------- media (section 5.5) ----------

const STREAMS = ['SCREEN', 'WEBCAM', 'AUDIO', 'ROOM_SCAN'];
const chunkId = (stream: string, segment: number, seq: number): string =>
  `${stream}/${segment}/${seq}`;

/** Server-built object path (ADR 0013 section 5.7); never shown or logged. */
export function chunkObjectPath(
  sessionId: string,
  stream: string,
  segment: number,
  seq: number,
): string {
  const p = (n: number, w: number): string => String(n).padStart(w, '0');
  return `orgs/demo/sessions/${sessionId}/media/${stream}/${p(segment, 6)}/${p(seq, 8)}.webm`;
}

export function mediaPresign(st: SessionState, sessionId: string, input: unknown): Reply {
  const c = (input ?? {}) as Record<string, unknown>;
  const stream = typeof c.stream === 'string' ? c.stream : '';
  const segment = Number(c.segment);
  const seq = Number(c.seq);
  const bytes = Number(c.bytes);
  const durationMs = Number(c.durationMs);
  const contentType = typeof c.contentType === 'string' ? c.contentType : '';
  const startedOk = typeof c.startedAt === 'string' && !Number.isNaN(Date.parse(c.startedAt));
  const maxBytes = stream === 'AUDIO' ? MAX_AUDIO_CHUNK_BYTES : MAX_CHUNK_BYTES;
  const ok =
    STREAMS.includes(stream) &&
    Number.isInteger(segment) &&
    segment >= 0 &&
    segment <= 999_999 &&
    Number.isInteger(seq) &&
    seq >= 0 &&
    seq <= 99_999_999 &&
    Number.isInteger(bytes) &&
    bytes >= 1 &&
    bytes <= maxBytes &&
    Number.isInteger(durationMs) &&
    durationMs >= 1 &&
    durationMs <= 60_000 &&
    (contentType === 'video/webm' || contentType === 'audio/webm') &&
    startedOk;
  if (!ok) return problem(400, 'VALIDATION_FAILED', 'Validation failed', st);
  // seq is unique per stream: the same seq under another segment is a conflict.
  for (const o of st.chunks.values()) {
    if (o.stream === stream && o.seq === seq && o.segment !== segment) {
      return problem(409, 'SEQ_CONFLICT', 'Sequence conflict', st);
    }
  }
  const id = chunkId(stream, segment, seq);
  const prev = st.chunks.get(id);
  if (prev?.confirmed) return { status: 200, body: { alreadyUploaded: true } };
  if (!prev && st.chunks.size >= MAX_CHUNKS_PER_SESSION) {
    return problem(429, 'RATE_LIMITED', 'Too many chunks', st);
  }
  st.chunks.set(id, {
    stream,
    segment,
    seq,
    declaredBytes: bytes,
    contentType,
    putBytes: prev?.putBytes ?? null,
    putType: prev?.putType ?? null,
    confirmed: false,
  });
  return {
    status: 200,
    body: {
      url: `/dev/proctor/api/media/put/${chunkObjectPath(sessionId, stream, segment, seq)}`,
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
}

/** PUT target: records size and Content-Type (what a HEAD would see); the body is discarded. */
export function mediaPut(
  st: SessionState,
  sessionId: string,
  path: string,
  byteLength: number,
  contentType: string | null,
): Reply {
  const m = new RegExp(
    `^orgs/demo/sessions/${sessionId}/media/([A-Z_]+)/(\\d{6})/(\\d{8})\\.webm$`,
  ).exec(path);
  const c = m ? st.chunks.get(chunkId(m[1] ?? '', Number(m[2]), Number(m[3]))) : undefined;
  if (!c) return problem(403, 'FORBIDDEN', 'Not presigned', st);
  c.putBytes = byteLength;
  c.putType = contentType;
  return { status: 200, body: {} };
}

export function mediaConfirm(st: SessionState, input: unknown): Reply {
  const c = (input ?? {}) as Record<string, unknown>;
  const segment = Number(c.segment);
  const seq = Number(c.seq);
  const stream = typeof c.stream === 'string' ? c.stream : '';
  const chunk = st.chunks.get(chunkId(stream, segment, seq));
  if (!chunk) return problem(404, 'CHUNK_NOT_PRESIGNED', 'Chunk not presigned', st);
  if (chunk.putBytes === null) return problem(409, 'UPLOAD_NOT_FOUND', 'Upload not found', st);
  if (chunk.putBytes !== chunk.declaredBytes || chunk.putType !== chunk.contentType) {
    // The real server deletes the object and keeps the row pending; the client presigns again.
    chunk.putBytes = null;
    chunk.putType = null;
    return problem(422, 'UPLOAD_MISMATCH', 'Upload mismatch', st);
  }
  chunk.confirmed = true;
  return { status: 200, body: { uploaded: true, sizeBytes: chunk.putBytes } };
}

// ---------- evidence and identity re-check (section 5.6) ----------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 26-character ULID: 48-bit time + 80 random bits, Crockford base32. */
export function ulid(now = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(16);
  let r = '';
  for (let i = 0; i < 16; i++) r += CROCKFORD[(rnd[i] ?? 0) % 32];
  return time + r;
}

export function evidencePresign(st: SessionState, sessionId: string, input: unknown): Reply {
  const c = (input ?? {}) as Record<string, unknown>;
  const purpose = c.purpose;
  const bytes = c.bytes;
  if (
    (purpose !== 'EVENT' && purpose !== 'IDENTITY_RECHECK') ||
    c.contentType !== 'image/jpeg' ||
    typeof bytes !== 'number' ||
    !Number.isInteger(bytes) ||
    bytes < 1 ||
    bytes > MAX_IMAGE_BYTES
  ) {
    return problem(400, 'VALIDATION_FAILED', 'Validation failed', st);
  }
  const name = `evidence/${ulid()}.jpg`;
  st.evidenceIssued.set(name, purpose);
  st.evidence.presigned++;
  return {
    status: 200,
    body: {
      url: `/dev/proctor/api/media/put/orgs/demo/sessions/${sessionId}/${name}`,
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      evidenceKey: name,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
}

export function evidencePut(st: SessionState): Reply {
  st.evidence.uploaded++;
  return { status: 200, body: {} };
}

/**
 * 202 with no result (the browser never learns the match). The "server" decides: every third
 * accepted check is a mismatch and counts as a server-written FACE_MISMATCH.
 */
export function identityRecheck(st: SessionState, input: unknown, nowMs = Date.now()): Reply {
  const c = (input ?? {}) as Record<string, unknown>;
  const name = typeof c.evidenceKey === 'string' ? c.evidenceKey : '';
  if (st.evidenceIssued.get(name) !== 'IDENTITY_RECHECK' || typeof c.capturedAt !== 'string') {
    return problem(400, 'VALIDATION_FAILED', 'Validation failed', st);
  }
  if (nowMs - st.identity.lastAt < IDENTITY_MIN_INTERVAL_MS) {
    const r = problem(429, 'RATE_LIMITED', 'Too many re-checks', st);
    return { ...r, headers: { ...r.headers, 'Retry-After': '60' } };
  }
  st.identity.lastAt = nowMs;
  st.identity.accepted++;
  if (st.identity.accepted % 3 === 0) st.identity.serverFaceMismatch++;
  st.evidenceIssued.delete(name);
  return { status: 202, body: { accepted: true } };
}

// ---------- panel ----------

export interface Summary {
  provisional: string;
  heartbeats: {
    count: number;
    lastAt: string | null;
    withHealth: number;
    lastRecorder: unknown;
    lastQueue: unknown;
  };
  batches: {
    accepted: number;
    duplicate: number;
    conflict: number;
    rejected: number;
    events: number;
  };
  seq: { highest: number | null; missing: number[] };
  recent: BatchRecord[];
  eventTypes: Record<string, number>;
  chunks: {
    presigned: number;
    uploaded: number;
    confirmed: number;
    bytes: Record<string, number>;
    unconfirmed: number;
  };
  evidence: SessionState['evidence'];
  identity: { accepted: number; serverFaceMismatch: number };
  errors: Record<string, number>;
}

export function summarize(st: SessionState): Summary {
  const count = (s: BatchStatus): number => st.batches.filter((b) => b.status === s).length;
  const seqs = [...st.accepted.keys()]
    .filter((k) => k.startsWith('events:'))
    .map((k) => Number(k.slice(7)));
  const highest = seqs.length ? Math.max(...seqs) : null;
  const have = new Set(seqs);
  const missing: number[] = [];
  if (highest !== null) for (let i = 0; i < highest; i++) if (!have.has(i)) missing.push(i);
  const bytes: Record<string, number> = {};
  let uploaded = 0;
  let confirmed = 0;
  for (const c of st.chunks.values()) {
    if (c.putBytes !== null) {
      uploaded++;
      bytes[c.stream] = (bytes[c.stream] ?? 0) + c.putBytes;
    }
    if (c.confirmed) confirmed++;
  }
  return {
    provisional: PROVISIONAL_LABEL,
    heartbeats: st.heartbeats,
    batches: {
      accepted: count('ACCEPTED'),
      duplicate: count('DUPLICATE'),
      conflict: count('SEQ_CONFLICT'),
      rejected: count('SIGNATURE_INVALID') + count('VALIDATION_FAILED'),
      events: st.batches.filter((b) => b.status === 'ACCEPTED').reduce((n, b) => n + b.events, 0),
    },
    seq: { highest, missing },
    recent: st.batches.slice(-15).reverse(),
    eventTypes: st.eventTypes,
    chunks: {
      presigned: st.chunks.size,
      uploaded,
      confirmed,
      bytes,
      unconfirmed: uploaded - confirmed,
    },
    evidence: st.evidence,
    identity: {
      accepted: st.identity.accepted,
      serverFaceMismatch: st.identity.serverFaceMismatch,
    },
    errors: st.errors,
  };
}
