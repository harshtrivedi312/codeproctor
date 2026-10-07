// The storage calls the identity check makes, behind one seam (design notes section 2, ADR 0014 5.1).
//
// Hub/owner question Q3: may the worker read `sealed/` by a short presigned GET (recommended, option
// a), or does it get read-only credentials (option b)? `presignForWorker` is the only method that
// changes with the answer; it defaults to (a): a 60 s GET for exactly one sealed key. Everything else
// is plain StorageService use. Nothing here logs a key or a URL.
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { CodedHttpException } from '../common/coded.exception';
import { identitySealedKey, identityUploadKey } from '../media/storage-keys';
import type { SessionScope } from '../media/storage-keys';
import { StorageService, StorageUnconfiguredError } from '../media/storage.service';
import type { ObjectHead, PresignedPut } from '../media/storage.service';
import { IDENTITY_IMAGE_TYPE, WORKER_GET_TTL_SECONDS } from './identity.constants';
import type { IdentityPurpose } from './identity.constants';

export type ImageKind = 'id' | 'selfie';
export const KIND_OF: Readonly<Record<IdentityPurpose, ImageKind>> = {
  ID_IMAGE: 'id',
  SELFIE: 'selfie',
};

@Injectable()
export class IdentityMedia {
  private readonly logger = new Logger(IdentityMedia.name);

  constructor(private readonly storage: StorageService) {}

  uploadKey(scope: SessionScope, attempt: number, kind: ImageKind, ulid: string): string {
    return identityUploadKey(scope, attempt, kind, ulid);
  }

  sealedKey(scope: SessionScope, attempt: number, kind: ImageKind, ulid: string): string {
    return identitySealedKey(scope, attempt, kind, ulid);
  }

  presignPut(scope: SessionScope, key: string, bytes: number): Promise<PresignedPut> {
    return this.guard(() =>
      this.storage.presignPut({ scope, key, contentType: IDENTITY_IMAGE_TYPE, bytes }),
    );
  }

  head(key: string): Promise<ObjectHead | null> {
    return this.guard(() => this.storage.head(key));
  }

  copy(from: string, to: string): Promise<void> {
    return this.guard(() => this.storage.copy(from, to));
  }

  /** Deletes quietly: a failure is logged by name only and returned, never thrown. */
  async deleteQuietly(...keys: readonly string[]): Promise<boolean> {
    let ok = true;
    for (const key of keys) {
      try {
        await this.storage.delete(key);
      } catch (e) {
        ok = false;
        this.logger.warn({
          event: 'identity.delete-failed',
          error: e instanceof Error ? e.name : 'unknown',
        });
      }
    }
    return ok;
  }

  /** DL-30: deletes every identity object of a session (originals and sealed) and says if none remain. */
  async deleteSessionIdentityImages(scope: SessionScope): Promise<boolean> {
    const probe = this.uploadKey(scope, 1, 'id', '0'.repeat(26));
    const prefix = probe.slice(0, probe.indexOf('identity/') + 'identity/'.length);
    const result = await this.guard(() => this.storage.deletePrefix(prefix));
    return result.remaining === 0;
  }

  /** A 60 s GET for the worker, for exactly one sealed key (ADR 0014 5.1, Q3 default). */
  async presignForWorker(key: string): Promise<string> {
    const get = await this.guard(() =>
      this.storage.presignGet({
        key,
        contentType: IDENTITY_IMAGE_TYPE,
        ttlSeconds: WORKER_GET_TTL_SECONDS,
      }),
    );
    return get.url;
  }

  /** Storage failures become 503 without the SDK message, which may name the bucket and key. */
  private async guard<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (e) {
      if (e instanceof StorageUnconfiguredError) {
        throw new CodedHttpException(
          HttpStatus.SERVICE_UNAVAILABLE,
          'Image storage is not configured.',
          'STORAGE_UNCONFIGURED',
        );
      }
      this.logger.warn({
        event: 'identity.storage-error',
        error: e instanceof Error ? e.name : 'unknown',
      });
      throw new CodedHttpException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'Image storage is unavailable. Retry shortly.',
        'STORAGE_UNAVAILABLE',
        { retryAfterSeconds: 5 },
      );
    }
  }
}
