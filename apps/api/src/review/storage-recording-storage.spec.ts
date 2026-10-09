// FR-703, FU-BE-229: reviewer playback signs through StorageService (15-minute GET, forced type).
import { ServiceUnavailableException } from '@nestjs/common';
import { StorageService } from '../media/storage.service';
import { StorageRecordingStorage } from './storage-recording-storage';

const KEY =
  'orgs/11111111-1111-4111-8111-111111111111/sessions/22222222-2222-4222-8222-222222222222/media/SCREEN/000000/00000001.webm';

describe('StorageRecordingStorage (FR-703, FU-BE-229)', () => {
  it('FR-703: answers 503 when storage is not configured, and signs nothing', async () => {
    const storage = new StorageService(null);
    const spy = jest.spyOn(storage, 'presignGet');
    const adapter = new StorageRecordingStorage(storage);
    await expect(adapter.presignGet(KEY, 'video/webm', 900)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('FR-703: signs a GET with the forced content type and the 900 s ttl', async () => {
    const storage = new StorageService({
      bucket: 'b',
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:9000',
      forcePathStyle: true,
      credentials: { accessKeyId: 'AKIATESTTESTTESTTEST', secretAccessKey: 'x'.repeat(40) },
      conditionalWrites: false,
    });
    const adapter = new StorageRecordingStorage(storage);
    const url = await adapter.presignGet(KEY, 'video/webm', 900);
    const u = new URL(url);
    expect(u.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(u.searchParams.get('response-content-type')).toBe('video/webm');
    expect(u.searchParams.get('response-content-disposition')).toBe('attachment');
  });
});
