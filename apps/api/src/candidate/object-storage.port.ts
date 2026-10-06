// The object storage the candidate module needs, as a port. The real StorageService (S3 SDK, R2 on
// staging, AWS S3 on pilot and production) arrives with BE-09 and binds this token; BE-07 tests run
// against InMemoryObjectStorage. Until BE-09 the default fails loudly, so a signed consent PDF is
// never silently dropped: the job fails, retries, and the sweep re-enqueues it.
export abstract class ObjectStoragePort {
  /** Stores `body` at `key` (private bucket, encrypted at rest by the store). */
  abstract putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  abstract deleteObject(key: string): Promise<void>;
}

export class UnconfiguredObjectStorage extends ObjectStoragePort {
  putObject(): Promise<never> {
    return Promise.reject(
      new Error('Object storage is not configured (BE-09 binds StorageService).'),
    );
  }

  deleteObject(): Promise<never> {
    return Promise.reject(
      new Error('Object storage is not configured (BE-09 binds StorageService).'),
    );
  }
}
