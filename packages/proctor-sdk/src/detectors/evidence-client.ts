import { timedFetch } from '../core/http';
import { parseRetryAfter } from '../core/transport';
import { EVIDENCE_NAME_RE, type EvidenceApi } from './evidence';
import type { IdentityRechecker } from './identity';

/**
 * Evidence presign and identity re-check against the routes of ADR 0013 section 5.6, authenticated
 * by the candidate token only. Nothing is logged: not the URL, not the evidence name, not a frame.
 */
export type EvidencePurpose = 'EVENT' | 'IDENTITY_RECHECK';

export type EvidenceErrorKind =
  | 'WAIVED' // 409 IDENTITY_CHECK_WAIVED
  | 'DETECTOR_DISABLED' // 409 DETECTOR_DISABLED
  | 'QUOTA_EXCEEDED' // 409 QUOTA_EXCEEDED
  | 'NOT_ACTIVE' // 409 SESSION_NOT_ACTIVE
  | 'UNAUTHENTICATED' // 401
  | 'RATE_LIMITED' // 429 (retryAfterMs)
  | 'UNAVAILABLE' // 503, 5xx, network, timeout (retryAfterMs)
  | 'REJECTED'; // 400, UPLOAD_NOT_FOUND, anything that will not succeed again

/** Kind and problem code only: never a URL, a name or a token. */
export class EvidenceError extends Error {
  constructor(
    readonly kind: EvidenceErrorKind,
    readonly code?: string,
    readonly retryAfterMs?: number,
  ) {
    super(`evidence request failed: ${kind}`);
    this.name = 'EvidenceError';
  }
}

export interface EvidenceClientOptions {
  /** API origin plus prefix. */
  baseUrl: string;
  /** The candidate token, read per request, never stored or logged. */
  getToken: () => string;
  fetchFn?: typeof fetch;
  presignPath?: string;
  recheckPath?: string;
  /** Per request, body read included (default 15 s). */
  timeoutMs?: number;
  /** PUT of the JPEG (default: fetch with the headers the presign returned). */
  put?: (url: string, body: Blob, headers: Record<string, string>) => Promise<number>;
}

function problemCode(text: string): string {
  try {
    const j = JSON.parse(text) as { code?: unknown } | null;
    return typeof j?.code === 'string' ? j.code.slice(0, 64) : '';
  } catch {
    return '';
  }
}

function errorFor(status: number, code: string, retryAfter: string | null): EvidenceError {
  if (code === 'IDENTITY_CHECK_WAIVED') return new EvidenceError('WAIVED', code);
  if (code === 'DETECTOR_DISABLED') return new EvidenceError('DETECTOR_DISABLED', code);
  if (code === 'QUOTA_EXCEEDED') return new EvidenceError('QUOTA_EXCEEDED', code);
  if (code === 'SESSION_NOT_ACTIVE') return new EvidenceError('NOT_ACTIVE', code);
  const wait = parseRetryAfter(retryAfter);
  if (status === 401) return new EvidenceError('UNAUTHENTICATED', code || undefined);
  if (status === 429) return new EvidenceError('RATE_LIMITED', code || undefined, wait);
  if (status === 408 || status >= 500)
    return new EvidenceError('UNAVAILABLE', code || undefined, wait);
  return new EvidenceError('REJECTED', code || undefined);
}

export function createEvidenceClient(o: EvidenceClientOptions): {
  presign(input: {
    purpose: EvidencePurpose;
    contentType: 'image/jpeg';
    bytes: number;
  }): Promise<{ url: string; evidenceKey: string; headers: Record<string, string> }>;
  recheck(input: { evidenceKey: string; capturedAt: Date }): Promise<void>;
  /** For `VisionMonitor.evidenceApi` (purpose EVENT). */
  evidenceApi: EvidenceApi;
  /** For `VisionMonitor.recheckIdentity`: upload, then POST the name. */
  rechecker: IdentityRechecker;
} {
  const f = o.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeoutMs = Math.min(60_000, Math.max(1, o.timeoutMs ?? 15_000));
  const put =
    o.put ??
    (async (url: string, body: Blob, headers: Record<string, string>) =>
      (await f(url, { method: 'PUT', body, headers })).status);

  const post = async (path: string, body: unknown): Promise<string> => {
    let token: string;
    try {
      token = o.getToken();
    } catch {
      throw new EvidenceError('UNAUTHENTICATED');
    }
    let a;
    try {
      a = await timedFetch(
        f,
        `${o.baseUrl}${path}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
          cache: 'no-store',
        },
        timeoutMs,
      );
    } catch {
      throw new EvidenceError('UNAVAILABLE'); // network error or timeout
    }
    if (!a.ok) throw errorFor(a.status, problemCode(a.text), a.retryAfter);
    return a.text;
  };

  const presign = async (input: {
    purpose: EvidencePurpose;
    contentType: 'image/jpeg';
    bytes: number;
  }) => {
    const text = await post(o.presignPath ?? '/candidate/session/evidence/presign', input);
    let j: { url?: unknown; evidenceKey?: unknown; headers?: unknown };
    try {
      j = JSON.parse(text) as typeof j;
    } catch {
      throw new EvidenceError('UNAVAILABLE', 'BAD_RESPONSE');
    }
    if (
      typeof j.url !== 'string' ||
      typeof j.evidenceKey !== 'string' ||
      !EVIDENCE_NAME_RE.test(j.evidenceKey)
    ) {
      throw new EvidenceError('UNAVAILABLE', 'BAD_RESPONSE');
    }
    const headers: Record<string, string> = {};
    if (typeof j.headers === 'object' && j.headers !== null) {
      for (const [k, v] of Object.entries(j.headers as Record<string, unknown>)) {
        if (typeof v === 'string') headers[k] = v;
      }
    }
    return { url: j.url, evidenceKey: j.evidenceKey, headers };
  };

  const recheck = async (input: { evidenceKey: string; capturedAt: Date }): Promise<void> => {
    await post(o.recheckPath ?? '/candidate/session/identity/recheck', {
      evidenceKey: input.evidenceKey,
      capturedAt: input.capturedAt.toISOString(),
    });
  };

  return {
    presign,
    recheck,
    evidenceApi: {
      presign: async (input) => {
        const p = await presign({ purpose: 'EVENT', ...input });
        return { url: p.url, key: p.evidenceKey, evidenceKey: p.evidenceKey, headers: p.headers };
      },
    },
    rechecker: async (frame, capturedAt) => {
      try {
        const p = await presign({
          purpose: 'IDENTITY_RECHECK',
          contentType: 'image/jpeg',
          bytes: frame.size,
        });
        const status = await put(p.url, frame, { 'Content-Type': 'image/jpeg', ...p.headers });
        if (status < 200 || status >= 300) return { kind: 'RETRY' };
        await recheck({ evidenceKey: p.evidenceKey, capturedAt });
        return { kind: 'ACCEPTED' };
      } catch (err) {
        if (!(err instanceof EvidenceError)) return { kind: 'RETRY' };
        switch (err.kind) {
          case 'WAIVED':
            return { kind: 'STOP', reason: 'IDENTITY_CHECK_WAIVED' };
          case 'DETECTOR_DISABLED':
            return { kind: 'STOP', reason: 'DETECTOR_DISABLED' };
          case 'QUOTA_EXCEEDED':
            return { kind: 'STOP', reason: 'QUOTA_EXCEEDED' };
          case 'NOT_ACTIVE':
            return { kind: 'STOP', reason: 'SESSION_NOT_ACTIVE' };
          case 'UNAUTHENTICATED':
            return { kind: 'STOP', reason: 'UNAUTHENTICATED' };
          case 'RATE_LIMITED':
          case 'UNAVAILABLE':
            return err.retryAfterMs === undefined
              ? { kind: 'RETRY' }
              : { kind: 'RETRY', retryAfterMs: err.retryAfterMs };
          default:
            return { kind: 'SKIP' };
        }
      }
    },
  };
}
