// The object store as RetentionService needs it (ADR 0004 9.2, ADR 0013 5.7). One S3-compatible
// interface: Cloudflare R2 on staging, AWS S3 on pilot and production. BE-09's MediaModule provides
// the real implementation (S3ObjectStore) and exports it; RetentionModule.forRoot takes that module.
// `UnconfiguredObjectStore` below is for code that must construct a service without a store and
// fail closed when it is used.
// Implementations must never log an object key: keys name sessions and candidates' media.
import { Injectable } from '@nestjs/common';

export interface ListPage {
  readonly keys: readonly string[];
  /** Present while the listing is truncated (S3's IsTruncated). */
  readonly nextToken?: string;
}

export interface DeleteResult {
  /** Keys DeleteObjects reported in `Errors`. Empty when every key was deleted or already gone. */
  readonly failed: readonly string[];
}

/** What GetBucketVersioning and GetBucketLifecycleConfiguration say (ADR 0004 9.2 "Versioning"). */
export type VersioningState =
  | { readonly kind: 'never-enabled' }
  /** Enabled or Suspended: older noncurrent versions may remain. `noncurrentExpireDays` is the whole-bucket rule, or null. */
  | { readonly kind: 'versioned'; readonly noncurrentExpireDays: number | null }
  /** The store cannot say (R2 may not support GetBucketVersioning). */
  | { readonly kind: 'unsupported' };

export abstract class ObjectStorePort {
  /** One page of ListObjectsV2 for the prefix. */
  abstract listPage(prefix: string, token?: string): Promise<ListPage>;
  /** DeleteObjects for at most 1000 keys. Deleting a key that is already gone is not an error. */
  abstract deleteKeys(keys: readonly string[]): Promise<DeleteResult>;
  abstract versioning(): Promise<VersioningState>;
}

/** Refuses every call, so nothing runs without a real store. Not bound by RetentionModule. */
@Injectable()
export class UnconfiguredObjectStore extends ObjectStorePort {
  listPage(): Promise<ListPage> {
    return Promise.reject(new Error('object store is not configured'));
  }
  deleteKeys(): Promise<DeleteResult> {
    return Promise.reject(new Error('object store is not configured'));
  }
  versioning(): Promise<VersioningState> {
    return Promise.reject(new Error('object store is not configured'));
  }
}
