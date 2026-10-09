// The object-store capability the reviewer playback route needs: a short-lived presigned GET
// (FR-703, 15 minutes). A review-owned port, so the read API does not wait for the S3 adapter
// (BE-09 media module). The real adapter (S3 on pilot and production, R2 on staging) binds this
// token. Implementations must never log the key or the URL: keys name sessions and candidates'
// media, and a presigned URL is a bearer credential.
import { Injectable, ServiceUnavailableException } from '@nestjs/common';

export abstract class RecordingStoragePort {
  /**
   * A presigned GET URL for `key`, valid for `ttlSeconds`. `contentType` is the type the object is
   * served as (forced on the response, with `attachment`, ADR 0013 section 5.7).
   */
  abstract presignGet(key: string, contentType: string, ttlSeconds: number): Promise<string>;
}

/**
 * The binding when no object store is wired: playback answers 503 and nothing else in the
 * review API is affected. The S3 binding is `StorageRecordingStorage` (FU-BE-229); this one stays the test default.
 */
@Injectable()
export class UnconfiguredRecordingStorage extends RecordingStoragePort {
  presignGet(): Promise<never> {
    return Promise.reject(new ServiceUnavailableException('Recording playback is not configured.'));
  }
}
