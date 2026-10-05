/**
 * Minimal promise wrapper over IndexedDB, shared by the event queue (Step 6) and the recorder
 * (Step 7). One database, fixed stores; values are structured-cloneable records.
 */
export const DB_NAME = 'codeproctor-sdk';
export const DB_VERSION = 1;
export const STORES = {
  /** Signed event batches not yet acknowledged. key = `${sessionId}:${seq padded}` */
  eventBatches: 'eventBatches',
  /** Recording chunks not yet uploaded (Step 7). key = `${sessionId}:${stream}:${segment}:${seq}` */
  chunks: 'chunks',
  /** Small counters, e.g. the next batch sequence. key = `${sessionId}:${name}` */
  meta: 'meta',
} as const;
export type StoreName = (typeof STORES)[keyof typeof STORES];

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

export class IdbStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly factory: IDBFactory = indexedDB,
    private readonly name = DB_NAME,
  ) {}

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise((resolve, reject) => {
      const open = this.factory.open(this.name, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        for (const s of Object.values(STORES)) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error('IndexedDB open failed'));
    });
    return this.dbPromise;
  }

  private async store(name: StoreName, mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.db()).transaction(name, mode).objectStore(name);
  }

  async put<T>(name: StoreName, key: string, value: T): Promise<void> {
    await req(await this.store(name, 'readwrite').then((s) => s.put(value, key)));
  }

  async get<T>(name: StoreName, key: string): Promise<T | undefined> {
    return (await req((await this.store(name, 'readonly')).get(key))) as T | undefined;
  }

  async delete(name: StoreName, key: string): Promise<void> {
    await req((await this.store(name, 'readwrite')).delete(key));
  }

  /** All entries whose key starts with `prefix`, in key order. */
  async entries<T>(name: StoreName, prefix: string): Promise<{ key: string; value: T }[]> {
    const s = await this.store(name, 'readonly');
    const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
    const keys = (await req(s.getAllKeys(range))) as string[];
    const values = (await req(s.getAll(range))) as T[];
    return keys.map((key, i) => ({ key, value: values[i] as T }));
  }

  async close(): Promise<void> {
    if (!this.dbPromise) return;
    (await this.dbPromise).close();
    this.dbPromise = null;
  }
}

/** Zero-pad so lexicographic key order equals numeric order. */
export function padSeq(n: number): string {
  return String(n).padStart(10, '0');
}
