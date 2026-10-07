// In-memory StorageService for tests: the real key checks and URL shape rules, no network. A test
// "uploads" with `upload()` as the browser would, then the code under test HEADs it. Synthetic data
// only.
import {
  assertKeyInSession,
  isSealedKey,
  ObjectKeyScopeError,
  parseObjectKey,
} from '../storage-keys';
import { StorageService } from '../storage.service';
import type {
  ObjectHead,
  PresignedGet,
  PresignedPut,
  PresignGetOptions,
  PresignPutOptions,
} from '../storage.service';

interface Stored {
  size: number;
  contentType: string;
  etag: string;
}

export class FakeStorage extends StorageService {
  readonly objects = new Map<string, Stored>();
  readonly presigned: PresignPutOptions[] = [];
  readonly gets: PresignGetOptions[] = [];
  failHead = false;
  failPresign = false;
  private etagCounter = 0;

  /** Flip to false to simulate a deployment without storage settings. */
  enabled = true;

  constructor() {
    super({ bucket: 'fake', region: 'auto', forcePathStyle: false, conditionalWrites: false });
  }

  /** What the browser's PUT does: stores an object of `size` bytes with this content type. */
  upload(key: string, size: number, contentType: string): void {
    this.etagCounter += 1;
    this.objects.set(key, { size, contentType, etag: `"etag-${String(this.etagCounter)}"` });
  }

  override presignPut(options: PresignPutOptions): Promise<PresignedPut> {
    if (this.failPresign) return Promise.reject(new Error(`signer down for ${options.key}`));
    assertKeyInSession(options.scope, options.key);
    if (isSealedKey(options.key)) return Promise.reject(new ObjectKeyScopeError());
    this.presigned.push(options);
    const now = options.now ?? new Date();
    return Promise.resolve({
      url: `https://storage.invalid/upload?sig=${String(this.presigned.length)}`,
      method: 'PUT',
      headers: { 'Content-Type': options.contentType },
      expiresAt: new Date(now.getTime() + (options.ttlSeconds ?? 60) * 1000),
    });
  }

  override presignGet(options: PresignGetOptions): Promise<PresignedGet> {
    if (parseObjectKey(options.key) === null) return Promise.reject(new ObjectKeyScopeError());
    this.gets.push(options);
    const now = options.now ?? new Date();
    return Promise.resolve({
      url: `https://storage.invalid/get?n=${String(this.gets.length)}`,
      expiresAt: new Date(now.getTime() + (options.ttlSeconds ?? 900) * 1000),
    });
  }

  override head(key: string): Promise<ObjectHead | null> {
    if (this.failHead) return Promise.reject(new Error(`boom for ${key}`));
    const o = this.objects.get(key);
    return Promise.resolve(
      o === undefined ? null : { sizeBytes: o.size, contentType: o.contentType, etag: o.etag },
    );
  }

  override delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  override get configured(): boolean {
    return this.enabled;
  }
}
