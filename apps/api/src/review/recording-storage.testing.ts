import { RecordingStoragePort } from './recording-storage.port';

/** Test double: records every call and returns a fake URL that embeds the key and the TTL. */
export class InMemoryRecordingStorage extends RecordingStoragePort {
  readonly calls: Array<{ key: string; ttlSeconds: number }> = [];

  presignGet(key: string, ttlSeconds: number): Promise<string> {
    this.calls.push({ key, ttlSeconds });
    return Promise.resolve(
      `https://store.invalid/${encodeURIComponent(key)}?ttl=${ttlSeconds}&sig=fake`,
    );
  }
}
