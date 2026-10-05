// A small stand-in for the candidate API, only to check that the k6 scripts in this folder are
// correct (right routes, valid signatures, cadence under the ADR 0013 rate limits). It is NOT the
// product and proves nothing about it. Synthetic tokens only; nothing is stored on disk.
//   node packages/qa/k6/mock/server.mjs [port] [sessionCount]  -> writes mock/sessions.json
// then: k6 run -e API_BASE_URL=http://localhost:4010/api/v1 -e SESSIONS_FILE=packages/qa/k6/mock/sessions.json ...
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2] || 4010);
const count = Number(process.argv[3] || 200);
const here = path.dirname(fileURLToPath(import.meta.url));

const sessions = new Map();
const list = [];
for (let i = 0; i < count; i++) {
  const token = 'mock-' + crypto.randomBytes(12).toString('hex');
  const master = crypto.randomBytes(32);
  const s = {
    token,
    key: master,
    keyIssued: false,
    sessionQuestionId: crypto.randomUUID(),
    questionId: crypto.randomUUID(),
    events: new Set(),
    keystrokes: new Set(),
    chunks: new Map(), // "STREAM:seq" -> { bytes, put }
    hits: new Map(),
  };
  sessions.set(token, s);
  list.push({ token, sessionQuestionId: s.sessionQuestionId, questionId: s.questionId });
}
fs.writeFileSync(path.join(here, 'sessions.json'), JSON.stringify(list));

const LIMITS = {
  events: 120,
  keystrokes: 240,
  heartbeat: 12,
  presign: 60,
  confirm: 60,
  'proctor-key': 5,
  run: 12,
};
const stats = {};
const bump = (k) => (stats[k] = (stats[k] || 0) + 1);

function limited(s, route, stream) {
  const bucket = Math.floor(Date.now() / 60000);
  const key = `${route}:${stream || ''}:${bucket}`;
  const n = (s.hits.get(key) || 0) + 1;
  s.hits.set(key, n);
  return n > LIMITS[route];
}

function send(res, status, body, extra = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(text);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    if (req.method === 'PUT' && url.pathname.startsWith('/storage/')) {
      const [, , token, stream, seq] = url.pathname.split('/');
      const s = sessions.get(token);
      const c = s && s.chunks.get(`${stream}:${seq}`);
      if (!c) return send(res, 403, { code: 'NOT_PRESIGNED' });
      if (c.put) return send(res, 412, {});
      c.put = raw.length;
      bump('put');
      return send(res, 200);
    }
    const m = url.pathname.match(
      /^\/api\/v1\/candidate\/(session\/[a-z-]+(?:\/[a-z]+)?|answers\/[^/]+\/run)$/,
    );
    const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
    const s = sessions.get(auth);
    if (!m) return send(res, 404, { code: 'NOT_FOUND' });
    if (!s) return send(res, 401, {});
    const route = m[1].startsWith('answers')
      ? 'run'
      : m[1].replace('session/', '').replace('media/', '');
    bump(route);
    if (req.method !== 'POST') return send(res, 405, {});
    let body = {};
    if (raw.length && ['presign', 'confirm', 'run', 'heartbeat'].includes(route)) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return send(res, 400, { code: 'VALIDATION_FAILED' });
      }
    }
    const stream = body.stream;
    if (route in LIMITS && limited(s, route, stream))
      return send(res, 429, {}, { 'Retry-After': '5' });
    if (route === 'proctor-key') {
      if (s.keyIssued) return send(res, 409, { code: 'KEY_ALREADY_ISSUED' });
      s.keyIssued = true;
      return send(res, 200, {
        alg: 'HMAC-SHA256',
        key: s.key.toString('base64'),
        keyEpoch: 0,
        counters: {
          eventSeqStart: 0,
          keystrokeSeqStart: 0,
          media: {
            SCREEN: { nextSeq: 0, nextSegment: 0 },
            WEBCAM: { nextSeq: 0, nextSegment: 0 },
            AUDIO: { nextSeq: 0, nextSegment: 0 },
          },
        },
      });
    }
    if (route === 'heartbeat')
      return send(res, 200, {
        serverTime: new Date().toISOString(),
        status: 'IN_PROGRESS',
        deadlineAt: null,
        sectionDeadlineAt: null,
        pauseReasons: [],
      });
    if (route === 'events' || route === 'keystrokes') {
      if (!(req.headers['content-type'] || '').startsWith('application/json'))
        return send(res, 415, {});
      const sig = String(req.headers['x-signature'] || '');
      if (!/^[0-9a-f]{64}$/.test(sig)) return send(res, 403, { code: 'SIGNATURE_INVALID' });
      const expect = crypto.createHmac('sha256', s.key).update(raw).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)))
        return send(res, 403, { code: 'SIGNATURE_INVALID' });
      const parsed = JSON.parse(raw.toString('utf8'));
      // The signed string must be canonical JSON (sorted keys, no whitespace): the SDK scheme.
      if (JSON.stringify(sortKeys(parsed)) !== raw.toString('utf8'))
        return send(res, 400, { code: 'VALIDATION_FAILED' });
      const seen = route === 'events' ? s.events : s.keystrokes;
      if (seen.has(parsed.seq)) return send(res, 200, { seq: parsed.seq, duplicate: true });
      if (route === 'keystrokes' && parsed.sessionQuestionId !== s.sessionQuestionId)
        return send(res, 400, { code: 'VALIDATION_FAILED' });
      seen.add(parsed.seq);
      return send(res, 200, { seq: parsed.seq, duplicate: false });
    }
    if (route === 'presign') {
      const k = `${body.stream}:${body.seq}`;
      if (s.chunks.get(k)?.confirmed) return send(res, 200, { alreadyUploaded: true });
      s.chunks.set(k, { bytes: body.bytes, put: 0, confirmed: false });
      return send(res, 200, {
        url: `http://${req.headers.host}/storage/${auth}/${body.stream}/${body.seq}`,
        method: 'PUT',
        headers: { 'Content-Type': body.contentType },
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
    }
    if (route === 'confirm') {
      const c = s.chunks.get(`${body.stream}:${body.seq}`);
      if (!c) return send(res, 404, { code: 'CHUNK_NOT_PRESIGNED' });
      if (!c.put) return send(res, 409, { code: 'UPLOAD_NOT_FOUND' });
      if (c.put !== c.bytes) return send(res, 422, { code: 'UPLOAD_MISMATCH' });
      c.confirmed = true;
      return send(res, 200, { uploaded: true, sizeBytes: c.put });
    }
    if (route === 'run') {
      if (!body.code || !body.language) return send(res, 400, {});
      return setTimeout(() => send(res, 200, { results: [] }), 150 + Math.random() * 300);
    }
    return send(res, 404, {});
  });
});

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys(v[k])]),
    );
  return v;
}

server.listen(port, () =>
  console.log(`mock candidate API on http://localhost:${port}/api/v1 with ${count} sessions`),
);
setInterval(() => console.log(JSON.stringify(stats)), 15000).unref();
