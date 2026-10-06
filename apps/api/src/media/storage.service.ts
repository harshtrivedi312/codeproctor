// StorageService: the one S3-compatible interface (ADR 0001 section 2.1, ADR 0013 section 5.7).
// AWS SDK v3. Cloudflare R2 on staging (synthetic data only), AWS S3 on pilot and production: only
// the settings differ. Buckets are private, objects are encrypted at rest by the store.
//
// Rules this class enforces:
//  - A key is never taken from a client. Candidate-scope calls pass a SessionScope and the key is
//    checked to be inside that session's prefix (CS-3); a key of an unknown layout is refused.
//  - No PUT URL is ever issued for a `sealed/` key (ADR 0013 section 5.6).
//  - Nothing here logs: keys, presigned URLs and credentials never reach a log (ADR 0013 5.1).
//    Errors thrown from here carry no key.
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import { ObjectStoragePort } from '../candidate/object-storage.port';
import {
  assertKeyInSession,
  isSealedKey,
  sessionPrefix,
  ObjectKeyScopeError,
  parseObjectKey,
} from './storage-keys';
import type { SessionScope } from './storage-keys';

export const STORAGE_SETTINGS = Symbol('STORAGE_SETTINGS');

export interface StorageSettings {
  readonly bucket: string;
  readonly region: string;
  /** Empty for AWS S3; the account endpoint for Cloudflare R2. */
  readonly endpoint?: string;
  readonly forcePathStyle: boolean;
  /** Absent: the SDK default chain (the instance role on AWS). */
  readonly credentials?: { readonly accessKeyId: string; readonly secretAccessKey: string };
  /** Sign `If-None-Match: *` on PUTs (ADR 0013 section 5.5 control 3). */
  readonly conditionalWrites: boolean;
}

export const PUT_URL_TTL_SECONDS = 60;
export const GET_URL_TTL_SECONDS = 15 * 60;

export class StorageUnconfiguredError extends Error {
  constructor() {
    super('Object storage is not configured');
    this.name = 'StorageUnconfiguredError';
  }
}

export interface PresignedPut {
  readonly url: string;
  readonly method: 'PUT';
  /** Headers the browser must send exactly as given (the signature covers them). */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface PresignPutOptions {
  readonly scope: SessionScope;
  readonly key: string;
  /** Exactly the value the browser will send as Content-Type (signed). */
  readonly contentType: string;
  /** The exact byte length of the body (signed as Content-Length, ST-2, ST-3). */
  readonly bytes: number;
  readonly ttlSeconds?: number;
  readonly now?: Date;
}

export interface PresignedGet {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface PresignGetOptions {
  readonly key: string;
  /** The type the object must be served as (response-content-type override, ADR 0013 5.7). */
  readonly contentType: string;
  readonly ttlSeconds?: number;
  readonly now?: Date;
}

export interface ObjectHead {
  readonly sizeBytes: number;
  readonly contentType: string | null;
  readonly etag: string | null;
}

export interface ListedObject {
  readonly key: string;
  readonly sizeBytes: number;
  readonly etag: string | null;
}

export interface DeleteResult {
  readonly deleted: number;
  /** Per-key errors from DeleteObjects: any non-zero value means the tier must not be marked done. */
  readonly errors: number;
}

export interface PrefixDeleteResult extends DeleteResult {
  /** Objects a fresh listing still found after the delete (must be 0 before a marker is written). */
  readonly remaining: number;
}

const DELETE_BATCH = 1000;
const RESPONSE_TYPES: ReadonlySet<string> = new Set([
  'video/webm',
  'audio/webm',
  'image/jpeg',
  'application/pdf',
]);

function isNotFound(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const meta = (e as { $metadata?: { httpStatusCode?: number } }).$metadata;
  const name = (e as { name?: string }).name;
  return meta?.httpStatusCode === 404 || name === 'NotFound' || name === 'NoSuchKey';
}

@Injectable()
export class StorageService extends ObjectStoragePort {
  private cached: S3Client | undefined;

  constructor(@Inject(STORAGE_SETTINGS) private readonly settings: StorageSettings | null) {
    super();
  }

  get configured(): boolean {
    return this.settings !== null;
  }

  get conditionalWrites(): boolean {
    return this.settings?.conditionalWrites === true;
  }

  private get bucket(): string {
    if (this.settings === null) throw new StorageUnconfiguredError();
    return this.settings.bucket;
  }

  /**
   * The configured client and bucket, for the retention adapter (S3ObjectStore) that shares this
   * service's settings. Throws StorageUnconfiguredError without settings: nothing runs unconfigured.
   */
  rawClient(): { readonly client: S3Client; readonly bucket: string } {
    return { client: this.client, bucket: this.bucket };
  }

  private get client(): S3Client {
    if (this.settings === null) throw new StorageUnconfiguredError();
    this.cached ??= new S3Client({
      region: this.settings.region,
      ...(this.settings.endpoint !== undefined ? { endpoint: this.settings.endpoint } : {}),
      forcePathStyle: this.settings.forcePathStyle,
      ...(this.settings.credentials !== undefined
        ? { credentials: this.settings.credentials }
        : {}),
      // The default adds an x-amz-checksum-crc32 query parameter to presigned PUTs, which a browser
      // upload (and R2) rejects: only compute a checksum when an operation requires it.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    return this.cached;
  }

  /**
   * A PUT URL valid 60 s for one candidate-scope key. Content-Type and Content-Length are signed,
   * so the browser must send exactly those (ST-2, ST-3); `If-None-Match: *` is signed too when
   * conditional writes are on, so a second PUT to the same key fails with 412.
   */
  async presignPut(options: PresignPutOptions): Promise<PresignedPut> {
    assertKeyInSession(options.scope, options.key);
    // No presigned PUT is ever issued under sealed/ (ADR 0013 section 5.6).
    if (isSealedKey(options.key)) throw new ObjectKeyScopeError();
    if (!Number.isInteger(options.bytes) || options.bytes < 1) {
      throw new RangeError('bytes must be a positive integer');
    }
    const ttl = options.ttlSeconds ?? PUT_URL_TTL_SECONDS;
    const now = options.now ?? new Date();
    const conditional = this.conditionalWrites;
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: options.key,
      ContentType: options.contentType,
      ContentLength: options.bytes,
      ...(conditional ? { IfNoneMatch: '*' } : {}),
    });
    const signed = new Set([
      'content-type',
      'content-length',
      ...(conditional ? ['if-none-match'] : []),
    ]);
    const url = await getSignedUrl(this.client, command, {
      expiresIn: ttl,
      signingDate: now,
      signableHeaders: signed,
      // Keep these as real headers (in X-Amz-SignedHeaders), not hoisted into the query string.
      unhoistableHeaders: signed,
    });
    return {
      url,
      method: 'PUT',
      headers: {
        'Content-Type': options.contentType,
        ...(conditional ? { 'If-None-Match': '*' } : {}),
      },
      expiresAt: new Date(now.getTime() + ttl * 1000),
    };
  }

  /**
   * A GET URL valid 15 minutes (FR-703) for staff playback and review. The served type is forced
   * and the disposition is `attachment`, so a file uploaded as HTML can never render as a page
   * from the storage host (ADR 0013 section 5.7). Callers pass keys read from the database.
   */
  async presignGet(options: PresignGetOptions): Promise<PresignedGet> {
    if (parseObjectKey(options.key) === null) throw new ObjectKeyScopeError();
    if (!RESPONSE_TYPES.has(options.contentType)) {
      throw new RangeError('unsupported response content type');
    }
    const ttl = options.ttlSeconds ?? GET_URL_TTL_SECONDS;
    const now = options.now ?? new Date();
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: options.key,
        ResponseContentType: options.contentType,
        ResponseContentDisposition: 'attachment',
      }),
      { expiresIn: ttl, signingDate: now },
    );
    return { url, expiresAt: new Date(now.getTime() + ttl * 1000) };
  }

  /** HEAD: the object's size, type and ETag, or null when it does not exist. */
  async head(key: string): Promise<ObjectHead | null> {
    assertKnownKey(key);
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        sizeBytes: out.ContentLength ?? 0,
        contentType: out.ContentType ?? null,
        etag: out.ETag ?? null,
      };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  /** Deletes one object. Deleting a missing key is not an error (S3 semantics). */
  async delete(key: string): Promise<void> {
    assertKnownKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** DeleteObjects in batches of 1000. `errors` counts per-key failures (retention checks it). */
  async deleteMany(keys: readonly string[]): Promise<DeleteResult> {
    keys.forEach(assertKnownKey);
    return this.removeKeys(keys);
  }

  /** Deletes keys without the layout check: only for keys just listed under a validated prefix. */
  private async removeKeys(keys: readonly string[]): Promise<DeleteResult> {
    let deleted = 0;
    let errors = 0;
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const batch = keys.slice(i, i + DELETE_BATCH);
      const out = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      const failed = out.Errors?.length ?? 0;
      errors += failed;
      deleted += batch.length - failed;
    }
    return { deleted, errors };
  }

  /** CopyObject inside the bucket: the sealed copy of an ID image or re-check frame (BE-08, BE-10). */
  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    // Same session, and the destination is always a sealed/ copy (ADR 0013 section 5.6).
    const from = parseObjectKey(sourceKey);
    const to = parseObjectKey(destinationKey);
    if (
      from === null ||
      to === null ||
      from.orgId !== to.orgId ||
      from.sessionId !== to.sessionId ||
      !to.sealed ||
      from.sealed ||
      !sourceKey.startsWith(sessionPrefix(from))
    ) {
      throw new ObjectKeyScopeError();
    }
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: destinationKey,
        CopySource: `${this.bucket}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`,
      }),
    );
  }

  /** Every object under `prefix`, all ListObjectsV2 pages. */
  async list(prefix: string): Promise<ListedObject[]> {
    assertDeletablePrefix(prefix);
    const out: ListedObject[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(token !== undefined ? { ContinuationToken: token } : {}),
        }),
      );
      for (const o of page.Contents ?? []) {
        if (o.Key !== undefined) {
          out.push({ key: o.Key, sizeBytes: o.Size ?? 0, etag: o.ETag ?? null });
        }
      }
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    return out;
  }

  /**
   * Retention and erasure delete (ADR 0013 section 5.7): list every page, DeleteObjects, then list
   * again. A caller writes its completion marker only when `errors` and `remaining` are both 0.
   */
  async deletePrefix(prefix: string): Promise<PrefixDeleteResult> {
    const found = await this.list(prefix);
    const result = await this.removeKeys(found.map((o) => o.key));
    const remaining = (await this.list(prefix)).length;
    return { ...result, remaining };
  }

  // ObjectStoragePort (the consent PDF job and tests): small bounded server-side writes.

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    assertKnownKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.delete(key);
  }
}

function assertKnownKey(key: string): void {
  if (parseObjectKey(key) === null) throw new ObjectKeyScopeError();
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** The session prefix, the consent prefix, and the named retention tier directories (ADR 0013 5.7). */
const DELETABLE_PREFIX = new RegExp(
  `^orgs/${UUID}/(?:consents/${UUID}/|sessions/${UUID}/(?:(?:media|identity|evidence|evidence/sealed|reports|live)/)?)$`,
);

/** A prefix delete or list runs only for those: never the bucket root, an org, or all sessions. */
function assertDeletablePrefix(prefix: string): void {
  if (!DELETABLE_PREFIX.test(prefix)) throw new ObjectKeyScopeError();
}
