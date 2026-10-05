import { createHmac, timingSafeEqual } from 'node:crypto';
import { proctorEventBatchSchema } from '@codeproctor/shared';
import { DEMO_HMAC_KEY_B64 } from '../../demo-key';

/**
 * DEV-ONLY mock of the candidate API for the /dev/proctor demo. The wire formats below are
 * ASSUMPTIONS pending the architecture hub's answers (ARC-03): canonical JSON body signed with
 * HMAC-SHA256 and sent in X-Signature, media presign/confirm shapes, evidence presign, identity
 * re-check. State is in memory per demo session and per server process. Nothing here logs keys,
 * tokens or bodies.
 */

export type BatchStatus = 'ACCEPTED' | 'DUPLICATE' | 'CONFLICT' | 'BAD_SIGNATURE' | 'BAD_SCHEMA';

export interface BatchRecord {
  seq: number | null;
  status: BatchStatus;
  events: number;
  at: string;
}
export interface ChunkRecord {
  key: string;
  stream: string;
  segment: number;
  seq: number;
  declaredBytes: number;
  putBytes: number | null;
  confirmed: boolean;
}
export interface SessionState {
  heartbeats: { count: number; lastAt: string | null };
  /** seq -> signature of the accepted batch. */
  accepted: Map<number, string>;
  batches: BatchRecord[];
  eventTypes: Record<string, number>;
  chunks: Map<string, ChunkRecord>;
  evidence: { presigned: number; uploaded: number };
  identity: { checks: number };
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

export function sessionState(id: string): SessionState {
  const s = store();
  let st = s.get(id);
  if (!st) {
    st = {
      heartbeats: { count: 0, lastAt: null },
      accepted: new Map(),
      batches: [],
      eventTypes: {},
      chunks: new Map(),
      evidence: { presigned: 0, uploaded: 0 },
      identity: { checks: 0 },
    };
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

export function hmacHex(body: string, keyB64 = DEMO_HMAC_KEY_B64): string {
  return createHmac('sha256', Buffer.from(keyB64, 'base64')).update(body).digest('hex');
}

function signatureMatches(body: string, signature: string): boolean {
  const expected = Buffer.from(hmacHex(body), 'hex');
  const got = Buffer.from(/^[0-9a-f]{64}$/.test(signature) ? signature : '', 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export interface Reply {
  status: number;
  body: unknown;
}

export function heartbeat(st: SessionState): Reply {
  st.heartbeats.count++;
  st.heartbeats.lastAt = new Date().toISOString();
  return { status: 200, body: { ok: true } };
}

function pushBatch(st: SessionState, r: BatchRecord): void {
  st.batches.push(r);
  if (st.batches.length > 200) st.batches.shift();
}

/** TC-063 / TC-065: verify signature and seq; same seq + same signature is an idempotent replay. */
export function eventBatch(st: SessionState, rawBody: string, signature: string): Reply {
  const at = new Date().toISOString();
  if (!signatureMatches(rawBody, signature)) {
    pushBatch(st, { seq: null, status: 'BAD_SIGNATURE', events: 0, at });
    return { status: 400, body: { error: 'bad signature' } };
  }
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    json = null;
  }
  const parsed = proctorEventBatchSchema.safeParse(json);
  if (!parsed.success) {
    pushBatch(st, { seq: null, status: 'BAD_SCHEMA', events: 0, at });
    return { status: 400, body: { error: 'bad schema' } };
  }
  const { seq, events } = parsed.data;
  const prior = st.accepted.get(seq);
  if (prior !== undefined) {
    const same = prior === signature;
    pushBatch(st, { seq, status: same ? 'DUPLICATE' : 'CONFLICT', events: events.length, at });
    return same ? { status: 200, body: { ok: true, duplicate: true } } : { status: 409, body: {} };
  }
  st.accepted.set(seq, signature);
  for (const e of events) st.eventTypes[e.type] = (st.eventTypes[e.type] ?? 0) + 1;
  pushBatch(st, { seq, status: 'ACCEPTED', events: events.length, at });
  return { status: 200, body: { ok: true } };
}

const STREAMS = ['SCREEN', 'WEBCAM', 'AUDIO'];

export function mediaPresign(st: SessionState, sessionId: string, input: unknown): Reply {
  const c = input as Record<string, unknown> | null;
  const stream = typeof c?.stream === 'string' ? c.stream : '';
  const segment = Number(c?.segment);
  const seq = Number(c?.seq);
  const bytes = Number(c?.bytes);
  if (!STREAMS.includes(stream) || ![segment, seq, bytes].every(Number.isInteger)) {
    return { status: 400, body: { error: 'bad chunk' } };
  }
  const key = `${sessionId}/${stream}/${segment}/${seq}`;
  const prev = st.chunks.get(key);
  st.chunks.set(key, {
    key,
    stream,
    segment,
    seq,
    declaredBytes: bytes,
    putBytes: prev?.putBytes ?? null,
    confirmed: prev?.confirmed ?? false,
  });
  return { status: 200, body: { url: `/dev/proctor/api/media/put/${key}` } };
}

export function mediaPut(st: SessionState, key: string, byteLength: number): Reply {
  const c = st.chunks.get(key);
  if (!c) return { status: 403, body: { error: 'not presigned' } };
  c.putBytes = byteLength;
  return { status: 200, body: { ok: true } };
}

/** Confirm checks the object exists (a HEAD in the real API). Before the PUT: 503, so it retries. */
export function mediaConfirm(st: SessionState, sessionId: string, input: unknown): Reply {
  const c = input as Record<string, unknown> | null;
  const key = `${sessionId}/${String(c?.stream)}/${Number(c?.segment)}/${Number(c?.seq)}`;
  const chunk = st.chunks.get(key);
  if (!chunk || chunk.putBytes === null) return { status: 503, body: { error: 'object missing' } };
  chunk.confirmed = true;
  return { status: 200, body: { ok: true } };
}

export function evidencePresign(st: SessionState, sessionId: string): Reply {
  st.evidence.presigned++;
  const key = `evidence/${sessionId}/${st.evidence.presigned}.jpg`;
  return { status: 200, body: { url: `/dev/proctor/api/media/put/${key}`, key } };
}

/** Canned: every third check reports a mismatch so FACE_MISMATCH can be seen. */
export function identityRecheck(st: SessionState): Reply {
  st.identity.checks++;
  const mismatch = st.identity.checks % 3 === 0;
  return { status: 200, body: { matched: !mismatch, similarity: mismatch ? 0.21 : 0.93 } };
}

export interface Summary {
  heartbeats: SessionState['heartbeats'];
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
  identity: SessionState['identity'];
}

export function summarize(st: SessionState): Summary {
  const count = (s: BatchStatus): number => st.batches.filter((b) => b.status === s).length;
  const seqs = [...st.accepted.keys()];
  const highest = seqs.length ? Math.max(...seqs) : null;
  const missing: number[] = [];
  if (highest !== null) for (let i = 0; i < highest; i++) if (!st.accepted.has(i)) missing.push(i);
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
    heartbeats: st.heartbeats,
    batches: {
      accepted: count('ACCEPTED'),
      duplicate: count('DUPLICATE'),
      conflict: count('CONFLICT'),
      rejected: count('BAD_SIGNATURE') + count('BAD_SCHEMA'),
      events: [...st.batches]
        .filter((b) => b.status === 'ACCEPTED')
        .reduce((n, b) => n + b.events, 0),
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
    identity: st.identity,
  };
}
