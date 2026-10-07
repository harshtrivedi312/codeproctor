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

type Message = { t: 'start'; id: string } | { t: 'outcome'; id: string; outcome: RefreshOutcome };

const LOCK_NAME = 'cp.refresh';
const CHANNEL_NAME = 'cp.refresh.channel';
/** A waiter that got the lock but saw no outcome waits this long for a late message before sending itself. */
export const OUTCOME_GRACE_MS = 250;
/** Fallback election: how long a start announcement waits for a competing lower id. */
const ELECTION_MS = 150;
/** Fallback: the longest a tab waits for another tab's refresh before sending its own. */
const FOREIGN_WAIT_MS = 30_000;

const myId = makeId();
let channel: BroadcastChannel | null | undefined;
let waiting = 0;
/** The latest outcome another tab broadcast while this tab was waiting. Memory only. */
let adopted: RefreshOutcome | null = null;
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
  const s = v.session as { accessToken?: unknown; user?: { id?: unknown } };
  return typeof s.accessToken === 'string' && typeof s.user?.id === 'string';
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
  if (m.t !== 'outcome') return;
  foreignActive.delete(m.id);
  // Drop it unless a refresh of this tab is waiting: no idle tab holds another tab's token.
  if (waiting > 0 && isOutcome(m.outcome)) {
    adopted = m.outcome;
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

/** Resolves when an outcome was adopted, or after `ms` (true when one is there). */
function waitForAdopted(ms: number): Promise<boolean> {
  if (adopted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      outcomeWaiters.delete(done);
      resolve(adopted !== null);
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
): Promise<RefreshOutcome | null> {
  getChannel();
  waiting += 1;
  adopted = null;
  try {
    if (hasLocks()) return await withLock(send);
    if (getChannel()) return await withElection(send);
    return await send();
  } finally {
    waiting -= 1;
    if (waiting === 0) adopted = null;
  }
}

async function sendAndShare(
  send: () => Promise<RefreshOutcome | null>,
): Promise<RefreshOutcome | null> {
  const outcome = await send();
  // Not broadcast when this tab abandoned the request (sign-out here): waiters send their own.
  if (outcome) post({ t: 'outcome', id: myId, outcome });
  return outcome;
}

async function withLock(
  send: () => Promise<RefreshOutcome | null>,
): Promise<RefreshOutcome | null> {
  // Lock free: nobody else is refreshing, send at once.
  const first = await navigator.locks.request(
    LOCK_NAME,
    { ifAvailable: true },
    async (lock): Promise<{ outcome: RefreshOutcome | null } | null> =>
      lock ? { outcome: await sendAndShare(send) } : null,
  );
  if (first) return first.outcome;
  // Another tab holds it. Queue; when the lock comes, an outcome the holder broadcast is reused
  // and nothing is sent. The holder posts before it releases, but delivery here can lag the
  // release a little, hence the short grace. No outcome (holder closed or abandoned): send ours.
  return navigator.locks.request(LOCK_NAME, async () => {
    if (await waitForAdopted(OUTCOME_GRACE_MS)) return adopted;
    return sendAndShare(send);
  });
}

async function withElection(
  send: () => Promise<RefreshOutcome | null>,
): Promise<RefreshOutcome | null> {
  const now = Date.now();
  for (const [id, expires] of foreignActive) if (expires < now) foreignActive.delete(id);
  const others = (): boolean => foreignActive.size > 0;
  if (!others()) {
    post({ t: 'start', id: myId });
    // Give a tab that started at the same moment time to announce; the lower id sends.
    await new Promise((r) => setTimeout(r, ELECTION_MS));
    const lower = [...foreignActive.keys()].some((id) => id < myId);
    if (!lower && !adopted) return sendAndShare(send);
  }
  if (await waitForAdopted(FOREIGN_WAIT_MS)) return adopted;
  // The other tab never reported (closed or crashed): send our own.
  return sendAndShare(send);
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
  outcomeWaiters.clear();
  foreignActive.clear();
}
