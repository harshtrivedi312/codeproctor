// WorkerClient: the API side of the signed API-to-worker call (ADR 0014 4.2, 6.1, 6.2, 6.4).
//
// Requests are HMAC-SHA256 signed (key id, timestamp, nonce, body hash); every response the worker
// signs is verified before its status or body is trusted. What each outcome means (ADR 0014 6.4):
//   - an UNSIGNED 401 is the only unsigned response accepted as genuine: a key or clock mistake that
//     a retry cannot fix, so it is unrecoverable (and alerted);
//   - every other unsigned response, and any signed response with a wrong signature or key id, is a
//     retryable failure plus an alert (possible tampering): Retry-After is never honoured on it;
//   - a SIGNED 503 WORKER_BUSY re-delays without using an attempt; a signed 400 is unrecoverable;
//   - a signed 200 whose body fails validation is a retryable failure plus an alert.
// Nothing here logs a body, URL, score, key, signature or the X-CP-* headers; fixed codes only.
import { Injectable, Logger } from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { newUlid } from '../candidate/ulid';
import { MATCH_TIMEOUT_MS } from './identity.constants';

export type WorkerFailureCode =
  | 'WORKER_NOT_CONFIGURED'
  | 'WORKER_AUTH_FAILED'
  | 'WORKER_REFUSED'
  | 'WORKER_UNSIGNED_RESPONSE'
  | 'WORKER_BAD_SIGNATURE'
  | 'WORKER_BAD_RESPONSE'
  | 'WORKER_UNAVAILABLE'
  | 'WORKER_TIMEOUT';

/** Not worth retrying: the job ends and the check goes to manual review. */
export class WorkerUnrecoverableError extends Error {
  constructor(readonly code: WorkerFailureCode) {
    super(code);
    this.name = 'WorkerUnrecoverableError';
  }
}

/** Worth retrying with backoff. */
export class WorkerRetryableError extends Error {
  constructor(readonly code: WorkerFailureCode) {
    super(code);
    this.name = 'WorkerRetryableError';
  }
}

/** A verified, signed 503 WORKER_BUSY: try again later without using an attempt. */
export class WorkerBusyError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('WORKER_BUSY');
    this.name = 'WorkerBusyError';
  }
}

export interface FaceMatchRequest {
  readonly sessionId: string;
  readonly attempt: 1 | 2;
  readonly idImageUrl: string;
  readonly selfieUrl: string;
  readonly livenessConfirmed: boolean;
}

const reasonSchema = z.enum([
  'BELOW_THRESHOLD',
  'NO_FACE',
  'MULTIPLE_FACES',
  'LIVENESS_NOT_CONFIRMED',
  'MATCH_ERROR',
]);

// Unknown response fields are stripped, never rejected (ADR 0014 6.1); missing fields, wrong enums
// and out-of-range numbers are refused.
const matchResponseSchema = z.object({
  decision: z.enum(['MATCH', 'MANUAL_REVIEW']),
  reason: reasonSchema.nullable(),
  detail: z.string().max(64).nullable(),
  score: z.number().min(-1).max(1).nullable(),
  modelId: z.string().min(1).max(100),
  threshold: z.number().min(0).max(1),
  workerVersion: z.string().max(64),
  lockDigest: z.string().max(32),
});

export type FaceMatchResponse = z.infer<typeof matchResponseSchema>;

export abstract class WorkerClient {
  /** One face match. Throws WorkerBusyError, WorkerRetryableError or WorkerUnrecoverableError. */
  abstract faceMatch(request: FaceMatchRequest): Promise<FaceMatchResponse>;
}

/** Bound when the worker settings are not configured: every call is unrecoverable (D-05 fallback). */
@Injectable()
export class UnconfiguredWorkerClient extends WorkerClient {
  faceMatch(): Promise<FaceMatchResponse> {
    return Promise.reject(new WorkerUnrecoverableError('WORKER_NOT_CONFIGURED'));
  }
}

export interface WorkerClientSettings {
  readonly baseUrl: string;
  readonly keyId: string;
  /** The raw key bytes (32 or more random bytes). */
  readonly key: Buffer;
  readonly timeoutMs?: number;
}

const b64url = (data: Buffer): string => data.toString('base64url');
const sha256Hex = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex');

/** The string a request signature covers (ADR 0014 4.2). `path` is the percent-decoded path. */
export function requestStringToSign(parts: {
  keyId: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: Buffer;
}): string {
  return [
    'CP-WORKER-V1',
    parts.keyId,
    parts.method,
    parts.path,
    parts.timestamp,
    parts.nonce,
    sha256Hex(parts.body),
  ].join('\n');
}

/** The string a response signature covers (ADR 0014 4.2). */
export function responseStringToSign(parts: {
  keyId: string;
  nonce: string;
  status: number;
  body: Buffer;
}): string {
  return [
    'CP-WORKER-V1-RESP',
    parts.keyId,
    parts.nonce,
    String(parts.status),
    sha256Hex(parts.body),
  ].join('\n');
}

export function sign(key: Buffer, message: string): string {
  return b64url(createHmac('sha256', key).update(message).digest());
}

function sameSignature(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

@Injectable()
export class HttpWorkerClient extends WorkerClient {
  private readonly logger = new Logger(HttpWorkerClient.name);

  constructor(
    private readonly settings: WorkerClientSettings,
    private readonly now: () => number = () => Date.now(),
    private readonly doFetch: typeof fetch = fetch,
  ) {
    super();
  }

  async faceMatch(request: FaceMatchRequest): Promise<FaceMatchResponse> {
    const path = '/v1/face/match';
    // cacheSelfie is always false: embeddings are never kept (ADR 0014 6.3, C-18).
    const body = Buffer.from(JSON.stringify({ ...request, cacheSelfie: false }));
    const timestamp = String(Math.floor(this.now() / 1000));
    const nonce = b64url(randomBytes(16));
    const signature = sign(
      this.settings.key,
      requestStringToSign({
        keyId: this.settings.keyId,
        method: 'POST',
        path,
        timestamp,
        nonce,
        body,
      }),
    );

    let response: Response;
    try {
      response = await this.doFetch(new URL(path, this.settings.baseUrl), {
        method: 'POST',
        body,
        redirect: 'error', // a redirect would send the signed body somewhere else
        signal: AbortSignal.timeout(this.settings.timeoutMs ?? MATCH_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          // A fresh ULID per call, never a job id (the job ids of re-checks hold evidence names).
          'X-Request-Id': newUlid(),
          'X-CP-Key-Id': this.settings.keyId,
          'X-CP-Timestamp': timestamp,
          'X-CP-Nonce': nonce,
          'X-CP-Signature': signature,
        },
      });
    } catch (e) {
      // Only the error name: a message can carry the URL or the host.
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new WorkerRetryableError(timedOut ? 'WORKER_TIMEOUT' : 'WORKER_UNAVAILABLE');
    }

    let raw: Buffer;
    try {
      raw = Buffer.from(await response.arrayBuffer());
    } catch {
      throw new WorkerRetryableError('WORKER_UNAVAILABLE');
    }
    return this.interpret(response, raw, nonce);
  }

  private interpret(response: Response, raw: Buffer, nonce: string): FaceMatchResponse {
    const given = response.headers.get('x-cp-signature');
    const kid = response.headers.get('x-cp-key-id');
    if (given === null || kid === null) {
      // Unsigned. Only a 401 is genuine, and it is a configuration fault that retries cannot fix.
      if (response.status === 401) {
        this.alert('WORKER_AUTH_FAILED');
        throw new WorkerUnrecoverableError('WORKER_AUTH_FAILED');
      }
      this.alert('WORKER_UNSIGNED_RESPONSE');
      throw new WorkerRetryableError('WORKER_UNSIGNED_RESPONSE');
    }
    const expected = sign(
      this.settings.key,
      responseStringToSign({
        keyId: this.settings.keyId,
        nonce,
        status: response.status,
        body: raw,
      }),
    );
    if (kid !== this.settings.keyId || !sameSignature(expected, given)) {
      this.alert('WORKER_BAD_SIGNATURE'); // possible tampering
      throw new WorkerRetryableError('WORKER_BAD_SIGNATURE');
    }

    // From here the response is genuine.
    if (response.status === 503) {
      const code = problemCode(raw);
      if (code === 'WORKER_BUSY') {
        const retry = Number(response.headers.get('retry-after'));
        throw new WorkerBusyError(Number.isInteger(retry) && retry > 0 && retry <= 300 ? retry : 5);
      }
      throw new WorkerRetryableError('WORKER_UNAVAILABLE');
    }
    if (response.status >= 500) throw new WorkerRetryableError('WORKER_UNAVAILABLE');
    if (response.status !== 200) {
      // A signed 400, 413 or 422: the request itself is wrong, so a retry would repeat it.
      this.alert('WORKER_REFUSED');
      throw new WorkerUnrecoverableError('WORKER_REFUSED');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      this.alert('WORKER_BAD_RESPONSE');
      throw new WorkerRetryableError('WORKER_BAD_RESPONSE');
    }
    const result = matchResponseSchema.safeParse(parsed);
    if (!result.success) {
      this.alert('WORKER_BAD_RESPONSE');
      throw new WorkerRetryableError('WORKER_BAD_RESPONSE');
    }
    return result.data;
  }

  /** A fixed-code line the alarms can match (ADR 0014 section 8): no body, URL or header value. */
  private alert(code: WorkerFailureCode): void {
    this.logger.error(`worker call failed: ${code}`);
  }
}

function problemCode(raw: Buffer): string | null {
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'code' in parsed) {
      const code = parsed.code;
      return typeof code === 'string' ? code : null;
    }
  } catch {
    // not JSON
  }
  return null;
}
