import { checkMultiScreen, type WindowLike } from '../monitors/multi-screen';
import { checkVirtualCamera } from '../monitors/virtual-camera';
import { timedFetch } from './http';
import { parseRetryAfter } from './transport';
import type { CapabilityFlag } from './types';

/**
 * Pre-start system check (ADR 0013 section 5.4; FR-604, FR-605, FR-610). A pure function the app
 * calls with a `getToken()` callback before the test starts: it looks at the browser (never asks
 * for camera, microphone or screen), builds the section 5.4 body and posts it.
 *
 * Privacy: device labels and ids are never sent, except the label of a camera that matched a
 * virtual-camera name (the VIRTUAL_CAMERA payload carries `deviceLabel`, ADR 0010). Permissions and
 * devices are enums and booleans; nothing is logged.
 */

export type ScreenShareSurface = 'MONITOR' | 'OTHER' | 'UNVERIFIABLE';

/** What the check looks at; every field defaults to the real browser global. Tests inject fakes. */
export interface SystemCheckEnv {
  navigator?: {
    userAgent?: string;
    userAgentData?: { brands?: { brand: string; version: string }[] };
    mediaDevices?: Pick<MediaDevices, 'enumerateDevices'> & { getDisplayMedia?: unknown };
    permissions?: { query(d: { name: string }): Promise<{ state: string }> };
    connection?: { downlink?: number; rtt?: number };
  };
  window?: WindowLike;
  MediaRecorder?: { isTypeSupported(t: string): boolean };
  document?: { fullscreenEnabled?: boolean; documentElement?: { requestFullscreen?: unknown } };
  indexedDB?: IDBFactory;
  crypto?: { subtle?: { importKey?: unknown; sign?: unknown } };
}

export interface SystemCheckOptions {
  /** API origin plus prefix, as for the transport. */
  baseUrl: string;
  /** The candidate token, read per request, never stored or logged. */
  getToken: () => string;
  /** The surface the app got from `ScreenShareMonitor.request()`; UNVERIFIABLE when it did not ask. */
  screenShare?: ScreenShareSurface;
  fetchFn?: typeof fetch;
  path?: string;
  env?: SystemCheckEnv;
  now?: () => Date;
  /** Per request, body read included (default 15 s). */
  timeoutMs?: number;
  /** Attempts for transient failures (network, timeout, 408, 429, 5xx), default 3. */
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type SystemCheckBlocking =
  'MULTI_MONITOR' | 'BROWSER_UNSUPPORTED' | 'SCREEN_SHARE_NOT_MONITOR' | 'DEVICE_MISSING';

export interface SystemCheckFinding {
  type: 'MULTI_MONITOR' | 'VIRTUAL_CAMERA';
  occurredAt: string;
  payload: Record<string, unknown>;
}

/** The section 5.4 request body. */
export interface SystemCheckBody {
  browser: { brand: string; majorVersion: number };
  network?: { downlinkKbps: number; rttMs: number };
  devices: { camera: boolean; microphone: boolean; screenShare: ScreenShareSurface };
  findings: SystemCheckFinding[];
  capabilities: CapabilityFlag[];
}

export interface SystemCheckResult {
  passed: boolean;
  blocking: SystemCheckBlocking[];
}

export type SystemCheckErrorKind =
  | 'REJECTED' // 400: the body was refused; will not succeed again
  | 'UNAUTHENTICATED' // 401
  | 'NOT_ACTIVE' // 409 SESSION_NOT_ACTIVE
  | 'UNAVAILABLE'; // retries ran out (network, timeout, 429, 5xx)

/** Carries the kind and the problem code only: never the body, the token or a label. */
export class SystemCheckError extends Error {
  constructor(
    readonly kind: SystemCheckErrorKind,
    readonly code?: string,
  ) {
    super(`system check failed: ${kind}`);
    this.name = 'SystemCheckError';
  }
}

function brandOf(nav: NonNullable<SystemCheckEnv['navigator']>): {
  brand: string;
  majorVersion: number;
} {
  const brands = nav.userAgentData?.brands;
  if (brands && brands.length > 0) {
    const real = brands.filter((b) => !/not.?a.?brand/i.test(b.brand));
    const pick =
      real.find(
        (b) => /edge|chrome|opera|brave|vivaldi/i.test(b.brand) && b.brand !== 'Chromium',
      ) ?? real[0];
    if (pick) {
      const v = Number.parseInt(pick.version, 10);
      return { brand: clean(pick.brand), majorVersion: Number.isFinite(v) && v >= 0 ? v : 0 };
    }
  }
  const ua = nav.userAgent ?? '';
  const table: [RegExp, string][] = [
    [/Edg\/(\d+)/, 'Microsoft Edge'],
    [/OPR\/(\d+)/, 'Opera'],
    [/Firefox\/(\d+)/, 'Firefox'],
    [/Chrome\/(\d+)/, 'Google Chrome'],
    [/Version\/(\d+).*Safari/, 'Safari'],
  ];
  for (const [re, brand] of table) {
    const m = re.exec(ua);
    if (m) return { brand, majorVersion: Number.parseInt(m[1] as string, 10) };
  }
  return { brand: 'Unknown', majorVersion: 0 };
}

/** The route trims and caps the brand at 64 and refuses NUL: send a tidy ASCII-ish string. */
function clean(s: string): string {
  // Keep printable characters only (the route refuses NUL; control characters are noise).
  const t = Array.from(s)
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c >= 0x20 && c !== 0x7f;
    })
    .join('')
    .trim()
    .slice(0, 64);
  return t === '' ? 'Unknown' : t;
}

const SCREEN_PERMISSIONS = [
  ['camera', 'camera-permission'],
  ['microphone', 'microphone-permission'],
] as const;

/**
 * Builds the body without any network call. Exported for the app's own pre-flight UI and tests.
 * Never requests a device: `enumerateDevices` and `permissions.query` do not prompt.
 */
export async function collectSystemCheck(
  o: Pick<SystemCheckOptions, 'env' | 'screenShare' | 'now'> = {},
): Promise<SystemCheckBody> {
  const g = globalThis as unknown as Record<string, unknown>;
  // A field the caller sets (even to undefined) is used as given: "absent" is a valid test and
  // browser state; only a field that is not mentioned falls back to the real global.
  const pick = <K extends keyof SystemCheckEnv>(k: K, real: () => SystemCheckEnv[K]) =>
    o.env !== undefined && k in o.env ? o.env[k] : real();
  const env: SystemCheckEnv = {
    navigator: pick('navigator', () =>
      typeof navigator === 'undefined'
        ? undefined
        : (navigator as unknown as SystemCheckEnv['navigator']),
    ),
    window: pick('window', () =>
      typeof window === 'undefined' ? undefined : (window as unknown as WindowLike),
    ),
    MediaRecorder: pick(
      'MediaRecorder',
      () => g['MediaRecorder'] as SystemCheckEnv['MediaRecorder'],
    ),
    document: pick('document', () =>
      typeof document === 'undefined' ? undefined : (document as never),
    ),
    indexedDB: pick('indexedDB', () => (typeof indexedDB === 'undefined' ? undefined : indexedDB)),
    crypto: pick('crypto', () => g['crypto'] as SystemCheckEnv['crypto']),
  };
  const nav = env.navigator ?? {};
  const now = (o.now ?? (() => new Date()))().toISOString();
  const capabilities: CapabilityFlag[] = [];
  const findings: SystemCheckFinding[] = [];

  // Screens (FR-605): count and API only.
  const ms = env.window ? await checkMultiScreen(env.window).catch(() => null) : null;
  if (ms?.kind === 'MULTI') {
    findings.push({
      type: 'MULTI_MONITOR',
      occurredAt: now,
      payload:
        ms.screenCount === undefined
          ? { api: ms.api }
          : { api: ms.api, screenCount: ms.screenCount },
    });
    capabilities.push({ id: 'multi-screen', status: 'SUPPORTED' });
  } else if (ms?.kind === 'SINGLE') {
    capabilities.push({ id: 'multi-screen', status: 'SUPPORTED' });
  } else {
    capabilities.push({
      id: 'multi-screen',
      status: ms?.kind === 'DENIED' ? 'DENIED' : 'UNSUPPORTED',
      detail: 'Cannot tell how many screens are connected.',
    });
  }

  // Cameras and microphones: counts as booleans; labels only for a virtual-camera match (FR-610).
  let camera = false;
  let microphone = false;
  const md = nav.mediaDevices;
  if (md && typeof md.enumerateDevices === 'function') {
    try {
      const list = await md.enumerateDevices();
      camera = list.some((d) => d.kind === 'videoinput');
      microphone = list.some((d) => d.kind === 'audioinput');
    } catch {
      // unknown: both stay false
    }
    const vc = await checkVirtualCamera(md).catch(() => ({ kind: 'UNSUPPORTED' }) as const);
    if (vc.kind === 'VIRTUAL') {
      findings.push({
        type: 'VIRTUAL_CAMERA',
        occurredAt: now,
        payload: { deviceLabel: vc.label },
      });
      capabilities.push({ id: 'virtual-camera', status: 'SUPPORTED' });
    } else if (vc.kind === 'CLEAN') {
      capabilities.push({ id: 'virtual-camera', status: 'SUPPORTED' });
    } else {
      capabilities.push({
        id: 'virtual-camera',
        status: vc.kind === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'UNVERIFIABLE',
        detail:
          vc.kind === 'LABELS_HIDDEN'
            ? 'Camera labels are hidden until camera permission is granted.'
            : 'enumerateDevices is not available.',
      });
    }
  } else {
    capabilities.push({
      id: 'virtual-camera',
      status: 'UNSUPPORTED',
      detail: 'enumerateDevices is not available.',
    });
  }

  // Permission states as enums (no prompt).
  for (const [name, id] of SCREEN_PERMISSIONS) {
    if (!nav.permissions || typeof nav.permissions.query !== 'function') {
      capabilities.push({
        id,
        status: 'UNVERIFIABLE',
        detail: 'The Permissions API is not available.',
      });
      continue;
    }
    try {
      const s = (await nav.permissions.query({ name })).state;
      capabilities.push({
        id,
        status: s === 'granted' ? 'SUPPORTED' : s === 'denied' ? 'DENIED' : 'UNVERIFIABLE',
        ...(s === 'prompt' ? { detail: 'Not asked yet.' } : {}),
      });
    } catch {
      capabilities.push({
        id,
        status: 'UNVERIFIABLE',
        detail: 'The permission state is not readable.',
      });
    }
  }

  // Screen share: capability only (getDisplayMedia needs a user gesture; the app asks).
  const surface: ScreenShareSurface = o.screenShare ?? 'UNVERIFIABLE';
  capabilities.push({
    id: 'screen-share',
    status: typeof md?.getDisplayMedia === 'function' ? 'SUPPORTED' : 'UNSUPPORTED',
  });
  if (surface === 'UNVERIFIABLE') {
    capabilities.push({
      id: 'screen-share-surface',
      status: 'UNVERIFIABLE',
      detail: 'The shared surface was not verified in this browser.',
    });
  }

  // Recording, fullscreen, storage and crypto support.
  const webm = ((): boolean => {
    try {
      return env.MediaRecorder?.isTypeSupported('video/webm;codecs=vp8,opus') === true;
    } catch {
      return false;
    }
  })();
  capabilities.push({
    id: 'media-recorder',
    status: webm ? 'SUPPORTED' : 'UNSUPPORTED',
    detail: 'WebM with VP8 and Opus',
  });
  const fs =
    env.document?.fullscreenEnabled === true ||
    typeof env.document?.documentElement?.requestFullscreen === 'function';
  capabilities.push({ id: 'fullscreen-api', status: fs ? 'SUPPORTED' : 'UNSUPPORTED' });
  capabilities.push({
    id: 'idb',
    status: (await idbWorks(env.indexedDB)) ? 'SUPPORTED' : 'UNSUPPORTED',
  });
  const subtle = env.crypto?.subtle;
  capabilities.push({
    id: 'web-crypto',
    status:
      typeof subtle?.importKey === 'function' && typeof subtle.sign === 'function'
        ? 'SUPPORTED'
        : 'UNSUPPORTED',
  });

  const body: SystemCheckBody = {
    browser: brandOf(nav),
    devices: { camera, microphone, screenShare: surface },
    findings,
    capabilities: capabilities.slice(0, 32),
  };
  const c = nav.connection;
  if (
    c &&
    typeof c.downlink === 'number' &&
    typeof c.rtt === 'number' &&
    Number.isFinite(c.downlink) &&
    Number.isFinite(c.rtt)
  ) {
    body.network = {
      downlinkKbps: Math.max(0, Math.min(1e7, Math.round(c.downlink * 1000))),
      rttMs: Math.max(0, Math.min(1e5, Math.round(c.rtt))),
    };
  }
  return body;
}

async function idbWorks(factory: IDBFactory | undefined): Promise<boolean> {
  if (!factory) return false;
  return new Promise((resolve) => {
    try {
      const r = factory.open('codeproctor-system-check', 1);
      r.onupgradeneeded = () => undefined;
      r.onsuccess = () => {
        r.result.close();
        try {
          factory.deleteDatabase('codeproctor-system-check');
        } catch {
          // best effort
        }
        resolve(true);
      };
      r.onerror = () => resolve(false);
      r.onblocked = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

function problemCode(text: string): string {
  try {
    const j = JSON.parse(text) as { code?: unknown } | null;
    return typeof j?.code === 'string' ? j.code.slice(0, 64) : '';
  } catch {
    return '';
  }
}

function parseResult(text: string): SystemCheckResult | null {
  try {
    const j = JSON.parse(text) as { passed?: unknown; blocking?: unknown } | null;
    if (typeof j?.passed !== 'boolean' || !Array.isArray(j.blocking)) return null;
    const ok = new Set<string>([
      'MULTI_MONITOR',
      'BROWSER_UNSUPPORTED',
      'SCREEN_SHARE_NOT_MONITOR',
      'DEVICE_MISSING',
    ]);
    const blocking = j.blocking.filter(
      (b): b is SystemCheckBlocking => typeof b === 'string' && ok.has(b),
    );
    return { passed: j.passed, blocking };
  } catch {
    return null;
  }
}

/**
 * Collects the findings and posts them to `POST /candidate/session/system-check`. The result says
 * whether the start gate will pass and why not (`blocking`). Transient failures (network, timeout,
 * 408, 429, 5xx incl. 503 BUSY) are retried with backoff and Retry-After; 400, 401 and 409 are
 * final. The route is authenticated by the candidate token only (no HMAC: no key exists yet).
 *
 * After the test has started the same checks repeat inside signed batches: the multi-screen and
 * virtual-camera monitors emit MULTI_MONITOR and VIRTUAL_CAMERA events through the session.
 */
export async function runSystemCheck(o: SystemCheckOptions): Promise<SystemCheckResult> {
  const body = await collectSystemCheck(o);
  const f = o.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = Math.max(1, o.maxAttempts ?? 3);
  const base = o.backoffBaseMs ?? 1000;
  const max = o.backoffMaxMs ?? 15_000;
  const payload = JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    let retryAfterMs: number | undefined;
    let token: string;
    try {
      token = o.getToken();
    } catch {
      throw new SystemCheckError('UNAUTHENTICATED'); // no token: final
    }
    try {
      const a = await timedFetch(
        f,
        `${o.baseUrl}${o.path ?? '/candidate/session/system-check'}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: payload,
          cache: 'no-store',
        },
        o.timeoutMs ?? 15_000,
      );
      if (a.ok) {
        const r = parseResult(a.text);
        if (!r) throw new SystemCheckError('UNAVAILABLE', 'BAD_RESPONSE');
        return r;
      }
      const code = problemCode(a.text);
      if (code === 'SESSION_NOT_ACTIVE') throw new SystemCheckError('NOT_ACTIVE', code);
      if (a.status === 401) throw new SystemCheckError('UNAUTHENTICATED', code || undefined);
      if (a.status === 400) throw new SystemCheckError('REJECTED', code || undefined);
      if (a.status === 408 || a.status === 429 || a.status >= 500) {
        retryAfterMs = parseRetryAfter(a.retryAfter);
      } else {
        throw new SystemCheckError('UNAVAILABLE', code || undefined);
      }
    } catch (err) {
      if (err instanceof SystemCheckError) throw err;
      // network error or timeout: transient
    }
    if (attempt + 1 >= attempts) throw new SystemCheckError('UNAVAILABLE');
    const exp = Math.min(max, base * 2 ** attempt);
    await sleep(Math.max(exp, Math.min(retryAfterMs ?? 0, 300_000)));
  }
}
