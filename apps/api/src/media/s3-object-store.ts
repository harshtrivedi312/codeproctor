// S3ObjectStore: the ObjectStorePort RetentionService runs on (ADR 0004 9.2, ADR 0013 5.7), over
// the same settings as StorageService (its own client, built by createS3Client) (R2 on staging, AWS S3 on pilot and production).
//
//  - No layout guard: retention must delete orphans and keys of any shape under a tier prefix.
//    The prefixes themselves come from RetentionService, built from session and org ids.
//  - Never logs or throws an object key: errors carry the operation and the SDK error name only.
//    (`failed` in a DeleteResult is returned data for the caller's own accounting, never logged here.)
//  - Unconfigured storage fails closed: no settings throws StorageUnconfiguredError before any call.
import {
  DeleteObjectsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { LifecycleRule, S3Client } from '@aws-sdk/client-s3';
import { Inject, Injectable } from '@nestjs/common';
import { ObjectStorePort } from '../retention/object-store.port';
import type { DeleteResult, ListPage, VersioningState } from '../retention/object-store.port';
import { createS3Client, STORAGE_SETTINGS, StorageUnconfiguredError } from './storage.service';
import type { StorageSettings } from './storage.service';

const MAX_DELETE_BATCH = 1000;

/**
 * An error with no key or URL in it: the operation and the SDK error name, plus the request id and
 * HTTP status the SDK reports (both key-free) for support tickets.
 */
export class ObjectStoreError extends Error {
  readonly requestId?: string;
  readonly httpStatus?: number;

  constructor(operation: string, cause: unknown) {
    super(`object store ${operation} failed: ${errorName(cause)}`);
    this.name = 'ObjectStoreError';
    const meta = (cause as { $metadata?: { requestId?: string; httpStatusCode?: number } } | null)
      ?.$metadata;
    if (typeof meta?.requestId === 'string') this.requestId = meta.requestId;
    if (typeof meta?.httpStatusCode === 'number') this.httpStatus = meta.httpStatusCode;
  }
}

/** A DeleteObjects `Errors` entry with no Key cannot be attributed: the delete is not verified. */
const KEYLESS_DELETE_ERROR = Object.assign(new Error('x'), { name: 'DeleteErrorWithoutKey' });
const TRUNCATED_WITHOUT_TOKEN = Object.assign(new Error('x'), {
  name: 'TruncatedListingWithoutToken',
});

function errorName(e: unknown): string {
  return e instanceof Error && e.name !== '' ? e.name : 'UnknownError';
}

/** A rule that covers the whole bucket: no prefix, tag or size filter. */
function wholeBucket(rule: LifecycleRule): boolean {
  const f = rule.Filter;
  const prefix = f?.Prefix ?? rule.Prefix ?? '';
  return (
    prefix === '' &&
    f?.Tag === undefined &&
    f?.And === undefined &&
    f?.ObjectSizeGreaterThan === undefined &&
    f?.ObjectSizeLessThan === undefined
  );
}

@Injectable()
export class S3ObjectStore extends ObjectStorePort {
  private cached: S3Client | undefined;

  // Its own client from the shared settings: the raw client is never handed out of StorageService.
  constructor(@Inject(STORAGE_SETTINGS) private readonly settings: StorageSettings | null) {
    super();
  }

  private handle(): { readonly client: S3Client; readonly bucket: string } {
    if (this.settings === null) throw new StorageUnconfiguredError();
    this.cached ??= createS3Client(this.settings);
    return { client: this.cached, bucket: this.settings.bucket };
  }

  /** One ListObjectsV2 page. The continuation token is S3's own, passed through opaque. */
  async listPage(prefix: string, token?: string): Promise<ListPage> {
    const { client, bucket } = this.handle();
    try {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ...(token !== undefined && token !== '' ? { ContinuationToken: token } : {}),
        }),
      );
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key === undefined ? [] : [o.Key]));
      if (page.IsTruncated === true) {
        // A truncated page that cannot be continued would look like a finished listing and let a
        // delete be reported as verified: fail instead.
        if (page.NextContinuationToken === undefined || page.NextContinuationToken === '') {
          throw new ObjectStoreError('list', TRUNCATED_WITHOUT_TOKEN);
        }
        return { keys, nextToken: page.NextContinuationToken };
      }
      return { keys };
    } catch (e) {
      throw wrap('list', e);
    }
  }

  /** DeleteObjects for at most 1000 keys. A key already gone is success (S3 semantics). */
  async deleteKeys(keys: readonly string[]): Promise<DeleteResult> {
    if (keys.length === 0) return { failed: [] };
    if (keys.length > MAX_DELETE_BATCH) throw new RangeError('at most 1000 keys per delete');
    const { client, bucket } = this.handle();
    try {
      const out = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      const failed: string[] = [];
      for (const entry of out.Errors ?? []) {
        if (entry.Key === undefined) throw new ObjectStoreError('delete', KEYLESS_DELETE_ERROR);
        failed.push(entry.Key);
      }
      return { failed };
    } catch (e) {
      throw wrap('delete', e);
    }
  }

  /**
   * GetBucketVersioning plus GetBucketLifecycleConfiguration. A bucket that never had versioning
   * is `never-enabled`. Any store error on either call (R2 may not implement them) is
   * `unsupported`, so retention does not claim noncurrent versions are handled.
   */
  async versioning(): Promise<VersioningState> {
    const { client, bucket } = this.handle();
    let status: string | undefined;
    try {
      status = (await client.send(new GetBucketVersioningCommand({ Bucket: bucket }))).Status;
    } catch {
      return { kind: 'unsupported' };
    }
    if (status !== 'Enabled' && status !== 'Suspended') return { kind: 'never-enabled' };
    try {
      const out = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
      const days = (out.Rules ?? [])
        // A rule with NewerNoncurrentVersions keeps the N newest noncurrent versions for ever, so
        // erasure would leave versions behind: it does not count as a bound.
        .filter(
          (r) =>
            r.Status === 'Enabled' &&
            wholeBucket(r) &&
            (r.NoncurrentVersionExpiration?.NewerNoncurrentVersions ?? 0) === 0,
        )
        .flatMap((r) => {
          const d = r.NoncurrentVersionExpiration?.NoncurrentDays;
          return d === undefined ? [] : [d];
        });
      return {
        kind: 'versioned',
        noncurrentExpireDays: days.length > 0 ? Math.min(...days) : null,
      };
    } catch (e) {
      if (errorName(e) === 'NoSuchLifecycleConfiguration') {
        return { kind: 'versioned', noncurrentExpireDays: null };
      }
      return { kind: 'unsupported' };
    }
  }
}

function wrap(operation: string, e: unknown): Error {
  return e instanceof ObjectStoreError ? e : new ObjectStoreError(operation, e);
}
