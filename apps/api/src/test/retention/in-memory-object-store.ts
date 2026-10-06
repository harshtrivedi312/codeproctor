// An in-memory object store for the retention tests, with the failure modes the verification must
// survive: pagination, a delete that reports errors, an object that comes back after deletion, and
// a listing that throws. Test only.
import type { DeleteResult, ListPage, VersioningState } from '../../retention/object-store.port';
import { ObjectStorePort } from '../../retention/object-store.port';

export class InMemoryObjectStore extends ObjectStorePort {
  readonly keys = new Set<string>();
  pageSize = 1000;
  /** Keys whose deletion DeleteObjects reports as an error (and does not delete). */
  failDeleteFor = new Set<string>();
  /** When set, listing throws. */
  failList = false;
  /** Keys that reappear in the next listing after a deletion (an eventual-consistency tail). */
  resurrect = new Set<string>();
  versioningState: VersioningState = { kind: 'never-enabled' };
  deleteCalls = 0;

  put(...keys: string[]): void {
    for (const key of keys) this.keys.add(key);
  }

  listPage(prefix: string, token?: string): Promise<ListPage> {
    if (this.failList) return Promise.reject(new Error('list failed'));
    const all = [...this.keys].filter((k) => k.startsWith(prefix)).sort();
    const start = token === undefined ? 0 : Number(token);
    const keys = all.slice(start, start + this.pageSize);
    const next = start + this.pageSize;
    return Promise.resolve(next < all.length ? { keys, nextToken: String(next) } : { keys });
  }

  deleteKeys(keys: readonly string[]): Promise<DeleteResult> {
    this.deleteCalls++;
    const failed: string[] = [];
    for (const key of keys) {
      if (this.failDeleteFor.has(key)) failed.push(key);
      else if (!this.resurrect.has(key)) this.keys.delete(key);
    }
    return Promise.resolve({ failed });
  }

  versioning(): Promise<VersioningState> {
    return Promise.resolve(this.versioningState);
  }
}
