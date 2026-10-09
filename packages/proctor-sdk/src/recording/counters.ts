import { IdbStore, STORES } from '../core/idb';
import { RECORDING_STREAMS, type RecordingStream } from './types';

export interface MediaCounter {
  nextSeq: number;
  nextSegment: number;
}

const valid = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < 100_000_000;

/**
 * Per-stream media counters (ADR 0013 5.5, hub answer): `seq` is unique per (session, stream)
 * across segments and must keep counting over recorder restarts, re-shares and page reloads;
 * `segment` is per stream and grows by one on every recorder start. Persisted in IndexedDB under
 * `<sessionId>:media:<STREAM>` BEFORE a chunk with that seq is stored, and mirrored in memory so
 * recording still works when IndexedDB is broken. `seed()` takes the server's `proctor-key`
 * counters later (`max(local, server)`).
 */
export class MediaCounters {
  private readonly c = new Map<RecordingStream, MediaCounter>(
    RECORDING_STREAMS.map((s) => [s, { nextSeq: 0, nextSegment: 0 }]),
  );

  constructor(
    private readonly store: IdbStore,
    private readonly sessionId: string,
  ) {}

  private key(stream: RecordingStream): string {
    return `${this.sessionId}:media:${stream}`;
  }

  /** Read what an earlier page load persisted. Failures leave the in-memory values. */
  async load(): Promise<void> {
    for (const stream of RECORDING_STREAMS) {
      try {
        const v = await this.store.get<MediaCounter>(STORES.meta, this.key(stream));
        if (v && valid(v.nextSeq) && valid(v.nextSegment)) this.raise(stream, v);
        // Earlier SDK versions (and the app's own seeding) stored the LAST segment used under
        // `<sessionId>:segment:<STREAM>`; the next segment starts after it.
        const legacy = await this.store.get<number>(
          STORES.meta,
          `${this.sessionId}:segment:${stream}`,
        );
        if (valid(legacy)) this.raise(stream, { nextSegment: legacy + 1 });
      } catch {
        // IndexedDB unreadable: the pending chunks (raiseFromPending) and the server counters
        // (seed) still lift the values.
      }
    }
  }

  private raise(stream: RecordingStream, v: Partial<MediaCounter>): void {
    const cur = this.c.get(stream) as MediaCounter;
    if (valid(v.nextSeq)) cur.nextSeq = Math.max(cur.nextSeq, v.nextSeq);
    if (valid(v.nextSegment)) cur.nextSegment = Math.max(cur.nextSegment, v.nextSegment);
  }

  /** Lift to at least the server's counters (`proctor-key`) or a pending chunk's position. */
  seed(stream: RecordingStream, v: Partial<MediaCounter>): void {
    this.raise(stream, v);
  }

  /** The next seq of the stream; assigned synchronously, persisted by `persist()`. */
  allocSeq(stream: RecordingStream): number {
    const cur = this.c.get(stream) as MediaCounter;
    return cur.nextSeq++;
  }

  /** A new segment for the stream (a recorder start). Persisted before it is used. */
  async newSegment(stream: RecordingStream): Promise<number> {
    const cur = this.c.get(stream) as MediaCounter;
    const segment = cur.nextSegment++;
    await this.persist(stream);
    return segment;
  }

  /** Write the counter; best effort (the in-memory value stays authoritative on failure). */
  async persist(stream: RecordingStream): Promise<void> {
    try {
      await this.store.put(STORES.meta, this.key(stream), {
        ...(this.c.get(stream) as MediaCounter),
      });
    } catch {
      // not persisted: a reload falls back to the pending chunks and the server counters
    }
  }

  snapshot(stream: RecordingStream): MediaCounter {
    return { ...(this.c.get(stream) as MediaCounter) };
  }
}
