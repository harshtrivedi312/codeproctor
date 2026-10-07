import { RecordingStoragePort } from './recording-storage.port';

/** Test double: records every call and returns a fake URL that embeds the key and the TTL. */
export class InMemoryRecordingStorage extends RecordingStoragePort {
  readonly calls: Array<{ key: string; contentType: string; ttlSeconds: number }> = [];

  presignGet(key: string, contentType: string, ttlSeconds: number): Promise<string> {
    this.calls.push({ key, contentType, ttlSeconds });
    return Promise.resolve(
      `https://store.invalid/${encodeURIComponent(key)}?ttl=${ttlSeconds}&sig=fake`,
    );
  }
}
