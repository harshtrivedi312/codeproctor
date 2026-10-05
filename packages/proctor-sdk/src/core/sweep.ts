import { IdbStore, STORES } from './idb';

export const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const lastSeenKey = (sessionId: string): string => `lastseen:${sessionId}`;

function sessionOfKey(key: string): string {
  return key.split(':')[0] ?? '';
}

/**
 * Retention sweep (FR-702, FR-704 spirit): the candidate's disk must not keep media or signed
 * batches of earlier sessions. Marks the current session as seen, then deletes chunks, event
 * batches and meta of any other session last seen more than `maxAgeMs` ago. A session with data
 * but no last-seen mark (older SDK version) gets a mark now and a full grace period instead of
 * being deleted blind. Failures are swallowed: a sweep must never stop recording.
 */
export async function sweepStaleSessions(
  store: IdbStore,
  currentSessionId: string,
  nowMs: number = Date.now(),
  maxAgeMs: number = DEFAULT_STALE_AFTER_MS,
): Promise<{ sessionsRemoved: number }> {
  let removed = 0;
  try {
    await store.put(STORES.meta, lastSeenKey(currentSessionId), nowMs);
    const sessions = new Set<string>();
    for (const name of [STORES.chunks, STORES.eventBatches, STORES.meta]) {
      for (const k of await store.keys(name, '')) {
        const sid = k.startsWith('lastseen:') ? k.slice('lastseen:'.length) : sessionOfKey(k);
        if (sid && sid !== currentSessionId) sessions.add(sid);
      }
    }
    for (const sid of sessions) {
      const seen = await store.get<number>(STORES.meta, lastSeenKey(sid));
      if (seen === undefined) {
        await store.put(STORES.meta, lastSeenKey(sid), nowMs);
        continue;
      }
      if (nowMs - seen <= maxAgeMs) continue;
      for (const name of [STORES.chunks, STORES.eventBatches, STORES.meta]) {
        await store.deletePrefix(name, `${sid}:`);
      }
      await store.delete(STORES.meta, lastSeenKey(sid));
      removed++;
    }
  } catch {
    // ignore
  }
  return { sessionsRemoved: removed };
}

/**
 * Keeps the "last seen" mark of a live session fresh (at most once per `minIntervalMs`) so a long
 * outage or a sleeping laptop does not make another tab's sweep think the session is stale. Never
 * throws: an IndexedDB failure must not affect recording.
 */
export class SessionTouch {
  private last = -Infinity;
  constructor(
    private readonly store: IdbStore,
    private readonly sessionId: string,
    private readonly minIntervalMs = 60_000,
  ) {}

  async touch(nowMs: number = Date.now()): Promise<void> {
    if (nowMs - this.last < this.minIntervalMs) return;
    this.last = nowMs;
    try {
      await this.store.put(STORES.meta, lastSeenKey(this.sessionId), nowMs);
    } catch {
      // ignore
    }
  }
}
