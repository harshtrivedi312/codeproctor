// WorkerClient (BE-08b; FR-403, TC-033; ADR 0014 4.2, 6.1, 6.2, 6.4). No network: a fake fetch plays
// the worker. The signing vectors were produced by the worker's own Python code (apps/worker
// src/worker/signing.py) so the two sides cannot drift apart.
import { Logger } from '@nestjs/common';
import {
  HttpWorkerClient,
  requestStringToSign,
  responseStringToSign,
  sign,
  WorkerBusyError,
  WorkerRetryableError,
  WorkerUnrecoverableError,
} from './worker-client';
import type { FaceMatchRequest } from './worker-client';

const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const KID = 'k1';
const NOW = 1_800_000_000_000;

describe('signing strings match the worker (ADR 0014 4.2)', () => {
  const nonce = Buffer.from(Array.from({ length: 16 }, (_, i) => i)).toString('base64url');

  it('FR-403: request signature equals the Python worker vector', () => {
    const sig = sign(
      KEY,
      requestStringToSign({
        keyId: KID,
        method: 'POST',
        path: '/v1/face/match',
        timestamp: '1800000000',
        nonce,
        body: Buffer.from('{"a":1}'),
      }),
    );
    expect(sig).toBe('9fa1BmpEZuQnHFttyoVxBzTcXQ4P-ahO1v5vhMyQHWE');
  });

  it('FR-403: response signatures equal the Python worker vectors', () => {
    const ok = sign(
      KEY,
      responseStringToSign({ keyId: KID, nonce, status: 200, body: Buffer.from('{"ok":true}') }),
    );
    expect(ok).toBe('1NGUkEKt0ccQh0thyysm8Xq44nh-68N88eba8GIlCbo');
    const busy = sign(
      KEY,
      responseStringToSign({
        keyId: KID,
        nonce,
        status: 503,
        body: Buffer.from('{"code":"WORKER_BUSY"}'),
      }),
    );
    expect(busy).toBe('39BthA_pNWAK0xe0RH5fKPgEKEviihHLeBJ6O-i5pe0');
  });
});

const REQUEST: FaceMatchRequest = {
  sessionId: '3f1c2d4e-5b6a-4c7d-8e9f-0a1b2c3d4e5f',
  attempt: 1,
  idImageUrl: 'https://storage.invalid/id?sig=SENTINEL-ID',
  selfieUrl: 'https://storage.invalid/selfie?sig=SENTINEL-SELFIE',
  livenessConfirmed: true,
};

const GOOD_BODY = {
  decision: 'MATCH',
  reason: null,
  detail: null,
  score: 0.91,
  modelId: 'auraface-v1:a7933ea5',
  threshold: 0.75,
  workerVersion: '0.0.0',
  lockDigest: 'abcdef012345',
  futureField: 'ignored',
};

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** A fake worker: verifies the request signature, then answers as the test says. */
function fakeWorker(
  answer: (sent: Sent) => {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
    signed?: boolean | 'wrong' | 'wrong-kid';
  },
): { fetch: typeof fetch; calls: Sent[] } {
  const calls: Sent[] = [];
  const impl = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = Buffer.from(init?.body as Buffer);
    const sent: Sent = { url: urlOf(url), headers, body };
    calls.push(sent);
    const expected = sign(
      KEY,
      requestStringToSign({
        keyId: headers['x-cp-key-id'] ?? '',
        method: 'POST',
        path: new URL(sent.url).pathname,
        timestamp: headers['x-cp-timestamp'] ?? '',
        nonce: headers['x-cp-nonce'] ?? '',
        body,
      }),
    );
    if (expected !== headers['x-cp-signature']) {
      return Promise.resolve(new Response('{"code":"WORKER_AUTH_FAILED"}', { status: 401 }));
    }
    const out = answer(sent);
    const raw = Buffer.from(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
    const outHeaders: Record<string, string> = { ...(out.headers ?? {}) };
    const signed = out.signed ?? true;
    if (signed !== false) {
      const signature = sign(
        KEY,
        responseStringToSign({
          keyId: KID,
          nonce: headers['x-cp-nonce'] ?? '',
          status: out.status,
          body: raw,
        }),
      );
      outHeaders['x-cp-key-id'] = signed === 'wrong-kid' ? 'other' : KID;
      outHeaders['x-cp-signature'] = signed === 'wrong' ? 'A'.repeat(43) : signature;
    }
    return Promise.resolve(new Response(raw, { status: out.status, headers: outHeaders }));
  };
  return { fetch: impl, calls };
}

const client = (f: typeof fetch): HttpWorkerClient =>
  new HttpWorkerClient({ baseUrl: 'http://worker:8000', keyId: KID, key: KEY }, () => NOW, f);

describe('HttpWorkerClient.faceMatch', () => {
  it('FR-403/TC-033: sends a signed request with cacheSelfie false and returns the validated body', async () => {
    const w = fakeWorker(() => ({ status: 200, body: GOOD_BODY }));
    const result = await client(w.fetch).faceMatch(REQUEST);
    expect(result.decision).toBe('MATCH');
    expect(result).not.toHaveProperty('futureField'); // unknown response fields are stripped
    const sent = w.calls[0];
    expect(sent?.url).toBe('http://worker:8000/v1/face/match');
    expect(JSON.parse(sent?.body.toString() ?? '{}')).toEqual({ ...REQUEST, cacheSelfie: false });
    expect(sent?.headers['x-cp-timestamp']).toBe('1800000000');
    expect(sent?.headers['x-cp-nonce']).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(sent?.headers['x-request-id']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('every call uses a fresh nonce and a fresh request id', async () => {
    const w = fakeWorker(() => ({ status: 200, body: GOOD_BODY }));
    const c = client(w.fetch);
    await c.faceMatch(REQUEST);
    await c.faceMatch(REQUEST);
    expect(w.calls[0]?.headers['x-cp-nonce']).not.toBe(w.calls[1]?.headers['x-cp-nonce']);
    expect(w.calls[0]?.headers['x-request-id']).not.toBe(w.calls[1]?.headers['x-request-id']);
  });

  it('an unsigned 401 is unrecoverable (key or clock misconfiguration)', async () => {
    const f = (): Promise<Response> =>
      Promise.resolve(new Response('{"code":"WORKER_AUTH_FAILED"}', { status: 401 }));
    await expect(client(f as typeof fetch).faceMatch(REQUEST)).rejects.toMatchObject({
      name: 'WorkerUnrecoverableError',
      code: 'WORKER_AUTH_FAILED',
    });
  });

  it.each([
    ['unsigned 400', 400],
    ['unsigned 413', 413],
    ['unsigned 503', 503],
    ['unsigned 200', 200],
  ])('%s is a retryable failure, never trusted (ADR 0014 6.4)', async (_name, status) => {
    const w = fakeWorker(() => ({
      status,
      body: status === 200 ? GOOD_BODY : { code: 'WORKER_BUSY' },
      headers: { 'retry-after': '99' },
      signed: false,
    }));
    await expect(client(w.fetch).faceMatch(REQUEST)).rejects.toBeInstanceOf(WorkerRetryableError);
  });

  it.each([['wrong'], ['wrong-kid']] as const)(
    'a %s response signature is retryable and alerted, even for a MATCH',
    async (kind) => {
      const w = fakeWorker(() => ({ status: 200, body: GOOD_BODY, signed: kind }));
      await expect(client(w.fetch).faceMatch(REQUEST)).rejects.toMatchObject({
        name: 'WorkerRetryableError',
        code: 'WORKER_BAD_SIGNATURE',
      });
    },
  );

  it('a signed 503 WORKER_BUSY re-delays with the verified Retry-After', async () => {
    const w = fakeWorker(() => ({
      status: 503,
      body: { code: 'WORKER_BUSY' },
      headers: { 'retry-after': '7' },
    }));
    await expect(client(w.fetch).faceMatch(REQUEST)).rejects.toEqual(new WorkerBusyError(7));
  });

  it('a signed 503 with another code and a signed 500 are retryable', async () => {
    for (const [status, body] of [
      [503, { code: 'MODEL_UNAVAILABLE' }],
      [500, { code: 'INTERNAL' }],
    ] as const) {
      const w = fakeWorker(() => ({ status, body }));
      await expect(client(w.fetch).faceMatch(REQUEST)).rejects.toBeInstanceOf(WorkerRetryableError);
    }
  });

  it('a signed 400 or 422 is unrecoverable (the request itself is wrong)', async () => {
    for (const status of [400, 413, 422]) {
      const w = fakeWorker(() => ({ status, body: { code: 'VALIDATION_FAILED' } }));
      await expect(client(w.fetch).faceMatch(REQUEST)).rejects.toBeInstanceOf(
        WorkerUnrecoverableError,
      );
    }
  });

  it('a signed 200 with an invalid body is retryable (enum, range, missing field, not JSON)', async () => {
    const bad = [
      { ...GOOD_BODY, decision: 'REJECT' },
      { ...GOOD_BODY, score: 1.5 },
      { ...GOOD_BODY, threshold: undefined },
      { ...GOOD_BODY, reason: 'SOMETHING_NEW' },
      'not json',
    ];
    for (const body of bad) {
      const w = fakeWorker(() => ({ status: 200, body }));
      await expect(client(w.fetch).faceMatch(REQUEST)).rejects.toMatchObject({
        code: 'WORKER_BAD_RESPONSE',
      });
    }
  });

  it('a network error and a timeout are retryable with only a fixed code', async () => {
    const down = (): Promise<Response> =>
      Promise.reject(new Error('connect ECONNREFUSED 10.0.0.9 SENTINEL-HOST'));
    const err = await client(down as typeof fetch)
      .faceMatch(REQUEST)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'WorkerRetryableError', code: 'WORKER_UNAVAILABLE' });
    expect(JSON.stringify(err)).not.toContain('SENTINEL');
    expect((err as Error).message).not.toContain('SENTINEL');
    const slow = (): Promise<Response> =>
      Promise.reject(Object.assign(new Error('x'), { name: 'TimeoutError' }));
    await expect(client(slow as typeof fetch).faceMatch(REQUEST)).rejects.toMatchObject({
      code: 'WORKER_TIMEOUT',
    });
  });

  it('never logs URLs, scores, keys or signatures', async () => {
    const lines: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    const w = fakeWorker(() => ({ status: 200, body: GOOD_BODY, signed: 'wrong' }));
    await client(w.fetch)
      .faceMatch(REQUEST)
      .catch(() => undefined);
    spy.mockRestore();
    const text = lines.join('\n');
    expect(text).toContain('WORKER_BAD_SIGNATURE'); // the alert line exists, with a fixed code only
    expect(text).not.toMatch(/SENTINEL|storage\.invalid|x-cp-|0\.91/i);
  });
});
