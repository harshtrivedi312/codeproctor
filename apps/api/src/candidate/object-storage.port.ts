// The object storage the candidate module needs, as a port. The real StorageService (S3 SDK, R2 on
// staging, AWS S3 on pilot and production, BE-09) binds this token; tests run against
// InMemoryObjectStorage. An unconfigured store fails loudly, so a signed consent PDF is never
// silently dropped: the job fails, retries, and the sweep re-enqueues it.
export abstract class ObjectStoragePort {
  /** Stores `body` at `key` (private bucket, encrypted at rest by the store). */
  abstract putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  abstract deleteObject(key: string): Promise<void>;
}
