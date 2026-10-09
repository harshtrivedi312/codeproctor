import type { Schemas } from '@/lib/api/client';

/*
 * Cross-tab single flight for POST /v1/auth/refresh (FR-104, TC-005). The refresh cookie is shared
 * by every tab and rotates on use, so two tabs refreshing at once would present the same old token
 * twice, which the server treats as reuse (it revokes the family). Only one tab sends at a time.
 *
 * DECISION: the winner shares its outcome over a BroadcastChannel (option a). A bare "done" signal
 * (option b) cannot work: the access token lives in memory only, so a tab that did not send the
 * refresh has no other way to get one, and calling refresh itself is exactly what is forbidden.
 * The outcome carries the new access token and session user. Rules for that token:
 *  - It exists only in memory: in the message, and in `adopted` below. Nothing here touches
 *    localStorage, sessionStorage, IndexedDB or a cookie. The httpOnly refresh cookie never
 *    reaches page JS.
 *  - A tab keeps a received outcome only while it has a refresh of its own waiting (`waiting > 0`).
 *    Every other message is dropped on arrival, so a tab that did not ask never holds the token.
 *  - The receiving tab still applies the result through the session guards in auth-session.ts
 *    (generation, user id, sign-out markers), so it is never applied to a different user or after
 *    sign-out.
 *
 * Mechanism: Web Locks (`cp.refresh`) where available. The tab that holds the lock sends the
 * request and broadcasts the outcome before it releases the lock. A tab that waited for the lock
 * sends nothing when an outcome arrived meanwhile. Without Web Locks a best-effort BroadcastChannel
 * election is used (start announcement, lowest random id wins). With neither, only the in-tab
 * single flight remains.
 */

type AuthSession = Schemas['AuthSession'];

export type RefreshOutcome =
  | { kind: 'session'; session: AuthSession }
  /** The server refused the refresh (401, cookie cleared or invalid): signed out, no retry. */
  | { kind: 'signed-out' }
  /** 503 BUSY after the bounded retries: the session is unchanged, nobody is signed out. */
  | { kind: 'busy' }
  /** The request failed (network, timeout). */
  | { kind: 'error' };

type Message =
  | { t: 'start'; id: string }
  /** The election participant is done, whatever the result (frees waiters at once). */
  | { t: 'end'; id: string }
  /** The candidate lost the election: forget its candidacy (does not wake anyone). */
  | { t: 'retract'; id: string }
  | { t: 'outcome'; id: string; outcome: RefreshOutcome };

const LOCK_NAME = 'cp.refresh';
const CHANNEL_NAME = 'cp.refresh.channel';
/** A waiter that got the lock but saw no outcome waits this long for a late message before sending itself. */
export const OUTCOME_GRACE_MS = 250;
/** Fallback election: how long a start announcement waits for a competing lower id. */
const ELECTION_MS = 150;
/** Fallback: the longest a tab waits for another tab's refresh before sending its own. */
const FOREIGN_WAIT_MS = 60_000; // longer than the holder's worst case: 4 attempts x 10 s + ~10 s BUSY waits

const myId = makeId();
let channel: BroadcastChannel | null | undefined;
let waiting = 0;
/**
 * The latest outcome another tab broadcast while this tab was waiting, with a sequence number.
 * Memory only. A call accepts it only when `seq` is newer than the sequence at the moment that
 * call entered coordinateRefresh: an outcome that arrived for an earlier call (an older session
 * generation) is never handed to a later one (FR-104, TC-005).
 */
let adopted: { seq: number; outcome: RefreshOutcome } | null = null;
let outcomeSeq = 0;
const outcomeWaiters = new Set<() => void>();
/** Fallback: other tabs' refreshes announced and not yet finished (id to expiry time). */
const foreignActive = new Map<string, number>();

function makeId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  }
}

function isOutcome(value: unknown): value is RefreshOutcome {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { kind?: unknown; session?: unknown };
  if (v.kind === 'signed-out' || v.kind === 'busy' || v.kind === 'error') return true;
  if (v.kind !== 'session' || typeof v.session !== 'object' || v.session === null) return false;
  const s = v.session as { accessToken?: unknown; user?: { id?: unknown; role?: unknown } };
  return (
    typeof s.accessToken === 'string' &&
    typeof s.user?.id === 'string' &&
    typeof s.user.role === 'string'
  );
}

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    if (typeof BroadcastChannel === 'undefined') return (channel = null);
    const c = new BroadcastChannel(CHANNEL_NAME);
    c.onmessage = (event: MessageEvent<unknown>) => onMessage(event.data);
    channel = c;
  } catch {
    channel = null;
  }
  return channel;
}

function onMessage(data: unknown): void {
  if (typeof data !== 'object' || data === null) return;
  const m = data as { t?: unknown; id?: unknown; outcome?: unknown };
  if (typeof m.id !== 'string' || m.id === myId) return;
  if (m.t === 'start') {
    foreignActive.set(m.id, Date.now() + FOREIGN_WAIT_MS);
    return;
  }
  if (m.t === 'retract') {
    foreignActive.delete(m.id);
    return;
  }
  if (m.t === 'end') {
    foreignActive.delete(m.id);
    // Wake waiters so they re-check; an election waiter with no outcome and nobody left sends.
    for (const wake of outcomeWaiters) wake();
    return;
  }
  if (m.t !== 'outcome') return;
  foreignActive.delete(m.id);
  // Drop it unless a refresh of this tab is waiting: no idle tab holds another tab's token.
  if (waiting > 0 && isOutcome(m.outcome)) {
    outcomeSeq += 1;
    adopted = { seq: outcomeSeq, outcome: m.outcome };
    for (const wake of outcomeWaiters) wake();
  }
}

// Listen from page load, so a start announced by another tab is never missed (browser only).
if (typeof window !== 'undefined') getChannel();

function post(message: Message): void {
  try {
    getChannel()?.postMessage(message);
  } catch {
    // A closed channel: other tabs fall back to their own refresh after their wait.
  }
}

/** The adopted outcome if it arrived after the call that entered at sequence `since`. */
function freshOutcome(since: number): RefreshOutcome | null {
  return adopted && adopted.seq > since ? adopted.outcome : null;
}

/** Resolves when an outcome newer than `since` was adopted, or after `ms` (true when one is there). */
function waitForAdopted(ms: number, since: number): Promise<boolean> {
  if (freshOutcome(since)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      outcomeWaiters.delete(done);
      resolve(freshOutcome(since) !== null);
    };
    const timer = setTimeout(done, ms);
    outcomeWaiters.add(done);
  });
}

function hasLocks(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.locks?.request;
}

/**
 * Runs `send` (one refresh request, resolving to its outcome or null when this tab abandoned it)
 * once across all tabs. Returns the outcome to apply: this tab's own, or the one the winning tab
 * broadcast. Null means nothing to apply.
 */
export async function coordinateRefresh(
  send: () => Promise<RefreshOutcome | null>,
  /**
   * Checked right before this tab would send, after any wait for the lock or the election: false
   * (sign-out pending, session generation changed) means send nothing and return null. A queued
   * tab must never send for a session that ended while it waited (FR-104, TC-005).
   */
  canSend: () => boolean = () => true,
): Promise<RefreshOutcome | null> {
  getChannel();
  if (waiting === 0) adopted = null;
  // Only outcomes broadcast after this point can answer this call.
  const since = outcomeSeq;
  waiting += 1;
  try {
    if (hasLocks()) return await withLock(send, canSend, since);
    if (getChannel()) return await withElection(send, canSend, since);
    return canSend() ? await send() : null;
  } finally {
    waiting -= 1;
    if (waiting === 0) adopted = null;
  }
}

async function sendAndShare(
  send: () => Promise<RefreshOutcome | null>,
  canSend: () => boolean,
): Promise<RefreshOutcome | null> {
  if (!canSend()) return null;
  const outcome = await send();
  // Not broadcast when this tab abandoned the request (sign-out here): waiters send their own.
  if (outcome) post({ t: 'outcome', id: myId, outcome });
  return outcome;
}

async function withLock(
  send: () => Promise<RefreshOutcome | null>,
  canSend: () => boolean,
  since: number,
): Promise<RefreshOutcome | null> {
  // Lock free: nobody else is refreshing, send at once.
  const first = await navigator.locks.request(
    LOCK_NAME,
    { ifAvailable: true },
    async (lock): Promise<{ outcome: RefreshOutcome | null } | null> =>
      lock ? { outcome: await sendAndShare(send, canSend) } : null,
  );
  if (first) return first.outcome;
  // Another tab holds it. Queue; when the lock comes, an outcome the holder broadcast is reused
  // and nothing is sent. The holder posts before it releases, but delivery here can lag the
  // release a little, hence the short grace. No outcome (holder closed or abandoned): send ours.
  return navigator.locks.request(LOCK_NAME, async () => {
    if (await waitForAdopted(OUTCOME_GRACE_MS, since)) return freshOutcome(since);
    return sendAndShare(send, canSend);
  });
}

/** Rounds of election a tab takes part in before it sends regardless (each ends in an outcome, an end or a timeout). */
const MAX_ELECTION_ROUNDS = 5;

async function withElection(
  send: () => Promise<RefreshOutcome | null>,
  canSend: () => boolean,
  since: number,
): Promise<RefreshOutcome | null> {
  for (let round = 0; round < MAX_ELECTION_ROUNDS; round += 1) {
    const now = Date.now();
    for (const [id, expires] of foreignActive) if (expires < now) foreignActive.delete(id);
    const early = freshOutcome(since);
    if (early) return early;
    // Every tab that needs a refresh announces itself and the lowest id sends. A tab that lost
    // waits for the winner's outcome; if the winner ended without one, everyone still waiting
    // announces again, so losers never wait on each other and never send together.
    post({ t: 'start', id: myId });
    await new Promise((r) => setTimeout(r, ELECTION_MS));
    const quick = freshOutcome(since);
    if (quick) {
      post({ t: 'retract', id: myId });
      return quick;
    }
    const lower = [...foreignActive.keys()].some((id) => id < myId);
    if (!lower) {
      try {
        return await sendAndShare(send, canSend);
      } finally {
        post({ t: 'end', id: myId });
      }
    }
    post({ t: 'retract', id: myId });
    await waitForAdopted(FOREIGN_WAIT_MS, since);
    const late = freshOutcome(since);
    if (late) return late;
  }
  return sendAndShare(send, canSend);
}

/**
 * Runs `fn` while holding the cross-tab refresh lock (a logout must not overlap a refresh). With
 * `timeoutMs` the wait for the lock is bounded: after it `fn` runs anyway (it must make its own
 * check that it is still wanted). Without Web Locks `fn` just runs. Any other lock error
 * (SecurityError, an unusable lock manager) also falls back to running `fn` without the lock, on
 * purpose: a logout that cannot be serialised must still be sent rather than silently dropped.
 */
export async function withRefreshLock<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
  if (!hasLocks()) return fn();
  let started = false;
  const guarded = (): Promise<T> => {
    started = true;
    return fn();
  };
  try {
    return await navigator.locks.request(
      LOCK_NAME,
      timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) },
      guarded,
    );
  } catch (error) {
    if (started) throw error;
    return fn(); // the wait for the lock timed out (or the lock API failed): go on without it
  }
}

/** Test-only: forget all coordination state (a fresh tab). */
export function resetRefreshCoordinationForTests(): void {
  try {
    if (channel) channel.close();
  } catch {
    // ignore
  }
  channel = undefined;
  waiting = 0;
  adopted = null;
  outcomeSeq = 0;
  outcomeWaiters.clear();
  foreignActive.clear();
}
