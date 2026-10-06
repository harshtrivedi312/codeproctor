// S3ObjectStore: the ObjectStorePort RetentionService runs on (ADR 0004 9.2, ADR 0013 5.7), over
// the same S3 client and settings as StorageService (R2 on staging, AWS S3 on pilot and production).
//
//  - No layout guard: retention must delete orphans and keys of any shape under a tier prefix.
//    The prefixes themselves come from RetentionService, built from session and org ids.
//  - Never logs or throws an object key: errors carry the operation and the SDK error name only.
//    (`failed` in a DeleteResult is returned data for the caller's own accounting, never logged here.)
//  - Unconfigured storage fails closed: StorageService.rawClient() throws StorageUnconfiguredError.
import {
  DeleteObjectsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { LifecycleRule } from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { ObjectStorePort } from '../retention/object-store.port';
import type { DeleteResult, ListPage, VersioningState } from '../retention/object-store.port';
import { StorageService, StorageUnconfiguredError } from './storage.service';

const MAX_DELETE_BATCH = 1000;

/** An error with no key or URL in it: the operation and the SDK error name. */
export class ObjectStoreError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`object store ${operation} failed: ${errorName(cause)}`);
    this.name = 'ObjectStoreError';
  }
}

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
  constructor(private readonly storage: StorageService) {
    super();
  }

  /** One ListObjectsV2 page. The continuation token is S3's own, passed through opaque. */
  async listPage(prefix: string, token?: string): Promise<ListPage> {
    const { client, bucket } = this.storage.rawClient();
    try {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ...(token !== undefined && token !== '' ? { ContinuationToken: token } : {}),
        }),
      );
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key === undefined ? [] : [o.Key]));
      return page.IsTruncated === true && page.NextContinuationToken !== undefined
        ? { keys, nextToken: page.NextContinuationToken }
        : { keys };
    } catch (e) {
      throw wrap('list', e);
    }
  }

  /** DeleteObjects for at most 1000 keys. A key already gone is success (S3 semantics). */
  async deleteKeys(keys: readonly string[]): Promise<DeleteResult> {
    if (keys.length === 0) return { failed: [] };
    if (keys.length > MAX_DELETE_BATCH) throw new RangeError('at most 1000 keys per delete');
    const { client, bucket } = this.storage.rawClient();
    try {
      const out = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      return { failed: (out.Errors ?? []).flatMap((x) => (x.Key === undefined ? [] : [x.Key])) };
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
    const { client, bucket } = this.storage.rawClient();
    let status: string | undefined;
    try {
      status = (await client.send(new GetBucketVersioningCommand({ Bucket: bucket }))).Status;
    } catch (e) {
      if (e instanceof StorageUnconfiguredError) throw e;
      return { kind: 'unsupported' };
    }
    if (status !== 'Enabled' && status !== 'Suspended') return { kind: 'never-enabled' };
    try {
      const out = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
      const days = (out.Rules ?? [])
        .filter((r) => r.Status === 'Enabled' && wholeBucket(r))
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
  return e instanceof StorageUnconfiguredError ? e : new ObjectStoreError(operation, e);
}
