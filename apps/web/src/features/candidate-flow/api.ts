import type { ZodType } from 'zod';
import { apiBaseUrl } from '@/lib/env';
import { mockingReady } from '@/lib/mock-ready';
import {
  accommodationsProjectionSchema,
  consentDeclinedSchema,
  consentDocumentSchema,
  consentSignedSchema,
  identityReceivedSchema,
  linkViewSchema,
  mediaConfirmSchema,
  mediaPresignSchema,
  practiceQuestionSchema,
  practiceRunSchema,
  sideCameraLinkSchema,
  sideCameraPairSchema,
  sideCameraStatusSchema,
  otpSentSchema,
  presignSchema,
  sessionTokenSchema,
  systemCheckResultSchema,
  testStartedSchema,
  type SystemCheckBody,
} from './wire';
import { getSessionToken } from './session-store';

/**
 * Candidate API calls (PROVISIONAL contract, see wire.ts).
 *
 * Rules kept here, in one place (ADR 0013 section 5.1, ADR 0003):
 * - Never logs or reports a URL, a request or response body, or a token.
 * - The invitation token and the OTP travel in POST bodies only, never in a URL.
 * - The candidate session token is sent as a bearer header from memory only.
 * - Branches on the problem `code`, not on `detail`.
 * - No cookies, no cache, no Referer.
 */

export type ApiResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      kind: 'problem';
      status: number;
      code: string | null;
      retryAfterSeconds: number | null;
    }
  | { ok: false; kind: 'network' }
  | { ok: false; kind: 'shape' };

function parseRetryAfter(header: string | null, body: unknown): number | null {
  const fromHeader = header === null ? NaN : Number.parseInt(header, 10);
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return fromHeader;
  if (typeof body === 'object' && body !== null && 'retryAfterSeconds' in body) {
    const value = body.retryAfterSeconds;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

async function request<T>(
  schema: ZodType<T>,
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT';
    body?: unknown;
    authed: boolean;
    signal?: AbortSignal;
  },
): Promise<ApiResult<T>> {
  return requestAt(schema, `/session${path}`, options);
}

/**
 * Same rules for any route under /v1/candidate (questions, answers, sections): `path` starts with
 * a slash and is relative to /v1/candidate.
 */
export async function requestAt<T>(
  schema: ZodType<T>,
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT';
    body?: unknown;
    authed: boolean;
    /** Aborts the request (a timeout). An aborted call is reported as `network`. */
    signal?: AbortSignal;
  },
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.authed) {
    const token = getSessionToken();
    if (token === null)
      return { ok: false, kind: 'problem', status: 401, code: null, retryAfterSeconds: null };
    headers.Authorization = `Bearer ${token}`;
  }
  let response: Response;
  try {
    await mockingReady;
    response = await fetch(`${apiBaseUrl}/v1/candidate${path}`, {
      method: options.method ?? 'POST',
      headers,
      body: options.body === undefined ? null : JSON.stringify(options.body),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    return { ok: false, kind: 'network' };
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!response.ok) {
    const code = typeof json === 'object' && json !== null && 'code' in json ? json.code : null;
    return {
      ok: false,
      kind: 'problem',
      status: response.status,
      code: typeof code === 'string' ? code : null,
      retryAfterSeconds: parseRetryAfter(response.headers.get('Retry-After'), json),
    };
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, kind: 'shape' };
}

export const candidateApi = {
  /** What the link shows. Sends no email. */
  resolveLink: (invitationToken: string) =>
    request(linkViewSchema, '/link', { body: { invitationToken }, authed: false }),
  sendOtp: (invitationToken: string) =>
    request(otpSentSchema, '/otp', { body: { invitationToken }, authed: false }),
  startSession: (invitationToken: string, otp: string) =>
    request(sessionTokenSchema, '/start', { body: { invitationToken, otp }, authed: false }),

  getConsent: () => request(consentDocumentSchema, '/consent', { method: 'GET', authed: true }),
  signConsent: (body: { consentTextId: string; signedName: string; confirmedAge18: true }) =>
    request(consentSignedSchema, '/consent/sign', { body, authed: true }),
  declineConsent: () => request(consentDeclinedSchema, '/consent/decline', { authed: true }),

  /** PROVISIONAL route (ADR 0015 S4). */
  getAccommodations: () =>
    request(accommodationsProjectionSchema, '/accommodations', { method: 'GET', authed: true }),

  submitSystemCheck: (body: SystemCheckBody) =>
    request(systemCheckResultSchema, '/system-check', { body, authed: true }),

  /** PROVISIONAL route (BE-08 pins it; ADR 0013 section 5.6, same shape as evidence presign). */
  presignIdentityImage: (purpose: 'ID_IMAGE' | 'SELFIE', bytes: number) =>
    request(presignSchema, '/evidence/presign', {
      body: { purpose, contentType: 'image/jpeg', bytes },
      authed: true,
    }),
  /** PROVISIONAL route and body (BE-08 pins them). Names only, never object keys from the client. */
  submitIdentity: (body: {
    idImageName: string;
    selfieName: string;
    liveness: { prompts: string[]; completed: boolean };
  }) => request(identityReceivedSchema, '/identity', { body, authed: true }),

  /** ADR 0013 section 5.5. Room scan: stream ROOM_SCAN, state CONSENTED. */
  presignMedia: (body: {
    stream: 'ROOM_SCAN';
    segment: number;
    seq: number;
    bytes: number;
    contentType: 'video/webm';
    startedAt: string;
    durationMs: number;
  }) => request(mediaPresignSchema, '/media/presign', { body, authed: true }),
  confirmMedia: (body: { stream: 'ROOM_SCAN'; segment: number; seq: number }) =>
    request(mediaConfirmSchema, '/media/confirm', { body, authed: true }),

  /** PROVISIONAL routes (ARC-03 part 2). */
  getSideCamera: () =>
    request(sideCameraStatusSchema, '/side-camera', { method: 'GET', authed: true }),
  createSideCameraLink: () => request(sideCameraLinkSchema, '/side-camera/link', { authed: true }),
  /** Phone side: unauthenticated by session, the link token is the credential. */
  pairSideCamera: (linkToken: string) =>
    request(sideCameraPairSchema, '/side-camera/pair', { body: { linkToken }, authed: false }),

  /** PROVISIONAL routes (FR-406). Nothing is stored. */
  getPractice: () => request(practiceQuestionSchema, '/practice', { method: 'GET', authed: true }),
  runPractice: (body: { language: string; code: string }) =>
    request(practiceRunSchema, '/practice/run', { body, authed: true }),

  startTest: () => request(testStartedSchema, '/test/start', { authed: true }),
};
