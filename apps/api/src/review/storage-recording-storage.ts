// FR-703: the reviewer playback binding of RecordingStoragePort to the shared StorageService (BE-09).
// Keys come from media_chunks rows of the session, never from the caller; StorageService forces the
// response type and `attachment` and refuses a key outside the known layout. Never log the key or
// the URL: the URL is a bearer credential.
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { StorageService, StorageUnconfiguredError } from '../media/storage.service';
import { RecordingStoragePort } from './recording-storage.port';

const NOT_CONFIGURED = 'Recording playback is not configured.';

@Injectable()
export class StorageRecordingStorage extends RecordingStoragePort {
  constructor(private readonly storage: StorageService) {
    super();
  }

  async presignGet(key: string, contentType: string, ttlSeconds: number): Promise<string> {
    if (!this.storage.configured) throw new ServiceUnavailableException(NOT_CONFIGURED);
    try {
      const signed = await this.storage.presignGet({ key, contentType, ttlSeconds });
      return signed.url;
    } catch (e) {
      if (e instanceof StorageUnconfiguredError)
        throw new ServiceUnavailableException(NOT_CONFIGURED);
      throw e;
    }
  }
}
