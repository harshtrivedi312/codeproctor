/*
 * 503 BUSY handling (docs/api-contract.md section 8, ADR 0013 5.7). Lock contention on ANY route
 * answers 503 with `Retry-After` (1 to 2 s) and the problem code BUSY, and the action did NOT
 * happen. Only that answer is retried here. Not retried, ever: any other 503 (for example Redis
 * being down, which carries no BUSY code), any 500 (a staff write whose audit row failed after the
 * action committed answers a fixed 500: the action DID happen), any other status.
 *
 * This file holds the pure rules and a tiny store for the status the screens show. The retry
 * itself lives in client.ts (staff API calls) and auth-session.ts (silent refresh).
 */

export const BUSY_CODE = 'BUSY';
/** Retries after the first attempt: 4 attempts in all. */
export const MAX_BUSY_RETRIES = 3;
const MIN_WAIT_MS = 1000;
const MAX_WAIT_MS = 5000;
/** Up to this much random time is added to every wait, so many tabs do not retry in step. */
export const JITTER_MS = 400;
/** The retries stop when waiting once more would pass this total. */
export const MAX_TOTAL_WAIT_MS = 10_000;

/** A request header that turns the automatic retry off for one call (opt-out for any caller). */
export const NO_BUSY_RETRY_HEADER = 'x-cp-no-busy-retry';

/** True when the response is a 503 whose problem body has code BUSY. Reads a clone; the original stays readable. */
export async function isBusyResponse(response: Response): Promise<boolean> {
  if (response.status !== 503) return false;
  try {
    const body: unknown = await response.clone().json();
    return (
      typeof body === 'object' && body !== null && (body as { code?: unknown }).code === BUSY_CODE
    );
  } catch {
    return false;
  }
}

/** Seconds of `Retry-After` clamped to 1..5 s, in ms. A missing or unusable header counts as 1 s. */
export function retryAfterMs(header: string | null): number {
  const seconds = header === null ? NaN : Number(header.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return MIN_WAIT_MS;
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, seconds * 1000));
}

/** The wait before a retry: the header's wait plus jitter in [0, JITTER_MS). */
export function busyDelayMs(header: string | null, random: () => number = Math.random): number {
  return retryAfterMs(header) + Math.floor(random() * JITTER_MS);
}

/**
 * Routes that are never retried automatically, relative to the API base. A retry there would
 * count one more attempt that is never refunded (login throttles, failed-attempt and lockout
 * counters) or hit a replay window (a TOTP code is single use inside its 30 s step), and the
 * admin re-auth routes take the actor's password. The user resubmits instead.
 */
export function isNoRetryRoute(pathname: string, method: string): boolean {
  const path = pathname.replace(/^\/api(?=\/v\d+\/)/, '');
  if (/^\/v\d+\/auth\//.test(path)) return true; // login, 2FA, password, refresh, logout
  // A Run that reached Judge0 keeps its slot on a 503 (contract section 8, FR-502); the SDK resends from its own buffer.
  if (/^\/v\d+\/candidate\//.test(path)) return true;
  const m = method.toUpperCase();
  if (m !== 'GET' && m !== 'HEAD' && /^\/v\d+\/admin\/users(?:\/|$)/.test(path)) return true; // invite, PATCH, unlock, re-issue, 2FA reset
  return false;
}

/* ---- the status the screens show ---------------------------------------------------------- */

export interface BusyState {
  /** A call is waiting to retry after a BUSY answer. */
  retrying: boolean;
  /** The retries ran out: the last answer was still BUSY. Cleared by the next answer that is not. */
  exhausted: boolean;
  /** The silent refresh got BUSY and gave up: the session is unchanged, nothing was signed out. */
  refreshBusy: boolean;
  /** A staff write got a 500: the action may have happened. Cleared by dismiss. */
  writeFailed: boolean;
}

let state: BusyState = {
  retrying: false,
  exhausted: false,
  refreshBusy: false,
  writeFailed: false,
};
let waiting = 0;
const listeners = new Set<() => void>();
function set(next: Partial<BusyState>): void {
  const merged = { ...state, ...next };
  if (
    merged.retrying === state.retrying &&
    merged.exhausted === state.exhausted &&
    merged.refreshBusy === state.refreshBusy &&
    merged.writeFailed === state.writeFailed
  )
    return;
  state = merged;
  for (const l of listeners) l();
}

export const busyStore = {
  get: (): BusyState => state,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** A call starts waiting to retry. */
  waitStart(): void {
    waiting += 1;
    set({ retrying: true, exhausted: false });
  },
  waitEnd(): void {
    waiting = Math.max(0, waiting - 1);
    if (waiting === 0) set({ retrying: false });
  },
  gaveUp(): void {
    set({ exhausted: true });
  },
  /** Any answer that is not BUSY: the service is answering again. */
  answered(): void {
    if (state.exhausted) set({ exhausted: false });
  },
  setRefreshBusy(on: boolean): void {
    set({ refreshBusy: on });
  },
  writeFailed(): void {
    set({ writeFailed: true });
  },
  dismiss(): void {
    set({ exhausted: false, writeFailed: false });
  },
  /** Session changed: nothing here belongs to the next person. */
  reset(): void {
    waiting = 0;
    set({ retrying: false, exhausted: false, refreshBusy: false, writeFailed: false });
  },
};

/** Sleeps `ms`; resolves false when `isCurrent` turned false or the signal aborted (the retry must stop). */
export function pause(
  ms: number,
  isCurrent: () => boolean,
  signal?: AbortSignal | null,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted || !isCurrent()) return resolve(false);
    const done = (ok: boolean): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(ok);
    };
    const onAbort = (): void => done(false);
    const timer = setTimeout(() => done(isCurrent() && !signal?.aborted), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
