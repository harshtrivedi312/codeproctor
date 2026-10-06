// In-memory ObjectStoragePort for tests. Synthetic data only.
import { ObjectStoragePort } from '../object-storage.port';

export class InMemoryObjectStorage extends ObjectStoragePort {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  failNextPut = false;

  putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false;
      return Promise.reject(new Error('storage unavailable'));
    }
    this.objects.set(key, { body, contentType });
    return Promise.resolve();
  }

  deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}
