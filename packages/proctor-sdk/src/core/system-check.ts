import { checkMultiScreen, type WindowLike } from '../monitors/multi-screen';
import { classifyCameras } from '../monitors/virtual-camera';
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
  /**
   * The surface of the app's screen share: use `surfaceOf(outcome)` from the screen-share monitor.
   * UNVERIFIABLE when the app did not ask or the browser does not report the surface.
   */
  screenShare?: ScreenShareSurface | null;
  fetchFn?: typeof fetch;
  path?: string;
  env?: SystemCheckEnv;
  now?: () => Date;
  /** Each browser step (screens, devices, permissions, IndexedDB) is cut after this long (default 3 s) and reported UNVERIFIABLE. */
  stepTimeoutMs?: number;
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
  | 'NO_SCREEN_SHARE' // the app gave no share outcome: FR-604 needs the share, nothing was sent
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
      return { brand: clean(pick.brand, 64), majorVersion: clampMajor(v) };
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
    if (m) return { brand, majorVersion: clampMajor(Number.parseInt(m[1] as string, 10)) };
  }
  return { brand: 'Unknown', majorVersion: 0 };
}

/** The route takes 0..999: a spoofed UA must not turn the check into a final 400. */
function clampMajor(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(999, Math.trunc(v))) : 0;
}

/** Bounded wait for a browser step that may never settle (a prompt open, a hung API). */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  p.catch(() => undefined);
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Printable characters only, trimmed, at most `max` code points (the route refuses NUL and control characters). */
function clean(s: string, max: number): string {
  // Keep printable characters only (the route refuses NUL; control characters are noise).
  const t = Array.from(s)
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c >= 0x20 && c !== 0x7f;
    })
    .join('')
    .trim();
  const cut = Array.from(t).slice(0, max).join('').trim();
  return cut === '' ? 'Unknown' : cut;
}

const SCREEN_PERMISSIONS = [
  ['camera', 'camera-permission'],
  ['microphone', 'microphone-permission'],
] as const;

/**
 * Builds the body without any network call. Exported for the app's own pre-flight UI and tests.
 * Never requests a device: `enumerateDevices` and `permissions.query` do not prompt. The browser
 * steps run in parallel, each bounded by `stepTimeoutMs`; a step that fails or hangs is
 * UNVERIFIABLE, never a pass.
 *
 * `screenShare` null/undefined means no share was obtained: the body then says `screen-share`
 * DENIED or UNSUPPORTED (honestly) and `devices.screenShare` UNVERIFIABLE; `runSystemCheck`
 * refuses to send such a body.
 */
export async function collectSystemCheck(
  o: Pick<SystemCheckOptions, 'env' | 'screenShare' | 'now' | 'stepTimeoutMs'> = {},
): Promise<SystemCheckBody> {
  const stepIn =
    typeof o.stepTimeoutMs === 'number' && Number.isFinite(o.stepTimeoutMs)
      ? o.stepTimeoutMs
      : 3000;
  const step = Math.min(10_000, Math.max(1, stepIn)); // per browser step
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

  /** A permission state or 'unknown' (no API, a throw, a hang). A synchronous throw is caught too. */
  const permissionState = (name: string): Promise<string> => {
    const q = nav.permissions;
    if (!q || typeof q.query !== 'function') return Promise.resolve('unavailable');
    return within(
      Promise.resolve()
        .then(() => q.query({ name }))
        .then(
          (r) => r.state,
          () => 'unknown',
        ),
      step,
      'unknown',
    );
  };

  // Screens (FR-605): count and API only. getScreenDetails() would show the window-management
  // prompt while the permission is "prompt" (and never settle while it is open): it is only used
  // when the permission is already granted, else the prompt-free screen.isExtended.
  const screensP = (async () => {
    let win = env.window;
    if (!win) return undefined; // no window at all
    if (typeof win.getScreenDetails === 'function') {
      let granted = false;
      for (const name of ['window-management', 'window-placement']) {
        const st = await permissionState(name);
        if (st === 'granted') {
          granted = true;
          break;
        }
        if (st !== 'unknown' && st !== 'unavailable') break;
      }
      if (!granted) win = { screen: win.screen };
    }
    const w = win;
    return within(
      Promise.resolve()
        .then(() => checkMultiScreen(w))
        .catch(() => null),
      step,
      null,
    );
  })();

  // Devices: counts as booleans; labels only for a virtual-camera match (FR-610).
  const md = nav.mediaDevices;
  const devicesP = (async () => {
    if (!md || typeof md.enumerateDevices !== 'function') return 'UNSUPPORTED' as const;
    const list = await within<readonly { kind: string; label: string }[] | null>(
      Promise.resolve()
        .then(() => md.enumerateDevices())
        .then(
          (l) => l as readonly { kind: string; label: string }[],
          () => null,
        ),
      step,
      null,
    );
    return list;
  })();

  const permsP = Promise.all(SCREEN_PERMISSIONS.map(([name]) => permissionState(name)));
  const idbP = (async (): Promise<CapabilityFlag['status']> => {
    if (!env.indexedDB) return 'UNSUPPORTED';
    const r = await within<boolean | null>(idbWorks(env.indexedDB), step, null);
    return r === null ? 'UNVERIFIABLE' : r ? 'SUPPORTED' : 'UNSUPPORTED';
  })();
  const [ms, devices, perms, idbStatus] = await Promise.all([screensP, devicesP, permsP, idbP]);

  const capabilities: CapabilityFlag[] = [];
  const findings: SystemCheckFinding[] = [];

  if (ms === undefined) {
    capabilities.push({
      id: 'multi-screen',
      status: 'UNSUPPORTED',
      detail: 'Cannot tell how many screens are connected.',
    });
  } else if (ms?.kind === 'MULTI') {
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
      status: ms?.kind === 'DENIED' ? 'DENIED' : ms === null ? 'UNVERIFIABLE' : 'UNSUPPORTED',
      detail: 'Cannot tell how many screens are connected.',
    });
  }

  let camera = false;
  let microphone = false;
  if (devices === 'UNSUPPORTED') {
    capabilities.push({
      id: 'virtual-camera',
      status: 'UNSUPPORTED',
      detail: 'enumerateDevices is not available.',
    });
  } else if (devices === null) {
    capabilities.push({
      id: 'virtual-camera',
      status: 'UNVERIFIABLE',
      detail: 'The device list could not be read in time.',
    });
  } else {
    camera = devices.some((d) => d.kind === 'videoinput');
    microphone = devices.some((d) => d.kind === 'audioinput');
    const vc = classifyCameras(devices);
    // The label is untrusted text: printable, trimmed, at most 128; an empty one is no finding.
    const label = vc.kind === 'VIRTUAL' ? clean(vc.label, 128) : '';
    if (vc.kind === 'VIRTUAL' && label !== '' && label !== 'Unknown') {
      findings.push({ type: 'VIRTUAL_CAMERA', occurredAt: now, payload: { deviceLabel: label } });
      capabilities.push({ id: 'virtual-camera', status: 'SUPPORTED' });
    } else if (vc.kind === 'CLEAN' && camera) {
      capabilities.push({ id: 'virtual-camera', status: 'SUPPORTED' });
    } else if (vc.kind === 'LABELS_HIDDEN') {
      capabilities.push({
        id: 'virtual-camera',
        status: 'UNVERIFIABLE',
        detail: 'Camera labels are hidden until camera permission is granted.',
      });
    } else {
      // No camera to look at (or an unusable label): nothing was verified.
      capabilities.push({
        id: 'virtual-camera',
        status: 'UNVERIFIABLE',
        detail: camera ? 'The camera name could not be read.' : 'No camera was found.',
      });
    }
  }

  // Permission states as enums (no prompt).
  SCREEN_PERMISSIONS.forEach(([, id], i) => {
    const s = perms[i] ?? 'unknown';
    if (s === 'unavailable') {
      capabilities.push({
        id,
        status: 'UNVERIFIABLE',
        detail: 'The Permissions API is not available.',
      });
    } else if (s === 'unknown') {
      capabilities.push({
        id,
        status: 'UNVERIFIABLE',
        detail: 'The permission state is not readable.',
      });
    } else {
      capabilities.push({
        id,
        status: s === 'granted' ? 'SUPPORTED' : s === 'denied' ? 'DENIED' : 'UNVERIFIABLE',
        ...(s === 'prompt' ? { detail: 'Not asked yet.' } : {}),
      });
    }
  });

  // Screen share: the app asks (getDisplayMedia needs a user gesture) and passes the surface.
  const obtained = o.screenShare !== undefined && o.screenShare !== null;
  const surface: ScreenShareSurface = o.screenShare ?? 'UNVERIFIABLE';
  const canShare = typeof md?.getDisplayMedia === 'function';
  if (obtained) {
    capabilities.push({ id: 'screen-share', status: 'SUPPORTED' });
    if (surface === 'UNVERIFIABLE') {
      // A share happened, but this browser does not report which surface it is.
      capabilities.push({
        id: 'screen-share-surface',
        status: 'UNVERIFIABLE',
        detail: 'This browser does not report which surface was shared.',
      });
    }
  } else {
    capabilities.push({
      id: 'screen-share',
      status: canShare ? 'DENIED' : 'UNSUPPORTED',
      detail: canShare ? 'No screen share was obtained.' : 'This browser cannot share the screen.',
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
  // fullscreenEnabled is authoritative when the browser reports it (false means fullscreen is
  // blocked, for example in a sandboxed frame); the function check is only the fallback.
  const fe = env.document?.fullscreenEnabled;
  const fs =
    typeof fe === 'boolean'
      ? fe
      : typeof env.document?.documentElement?.requestFullscreen === 'function';
  capabilities.push({ id: 'fullscreen-api', status: fs ? 'SUPPORTED' : 'UNSUPPORTED' });
  capabilities.push({ id: 'idb', status: idbStatus });
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
  // The screen share is part of the gate (FR-604): without an outcome nothing may be sent, or a
  // missing share would pass as "unverified". The app obtains it with requestScreenShare() (or its
  // own getDisplayMedia) on a user gesture and passes surfaceOf(outcome).
  if (o.screenShare === undefined || o.screenShare === null) {
    throw new SystemCheckError('NO_SCREEN_SHARE');
  }
  const body = await collectSystemCheck(o);
  const f = o.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Bounded and finite: NaN or a huge value must not make the loop endless or the wait unbounded.
  const num = (v: number | undefined, def: number, lo: number, hi: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
  const attempts = Math.trunc(num(o.maxAttempts, 3, 1, 5));
  const base = num(o.backoffBaseMs, 1000, 0, 60_000);
  const max = num(o.backoffMaxMs, 15_000, 0, 60_000);
  const timeoutMs = num(o.timeoutMs, 15_000, 1, 60_000);
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
        timeoutMs,
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
