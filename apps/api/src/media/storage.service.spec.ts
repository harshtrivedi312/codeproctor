// StorageService against the real AWS SDK presigner with dummy credentials (no network) and a
// stubbed `send` for the commands that would call the store. FR-701, FR-703, FR-704; TC-070,
// TC-071, FR-704 storage primitives; ADR 0013 sections 5.5 and 5.7.
import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  evidenceKey,
  evidenceSealedKey,
  mediaChunkKey,
  reportPdfKey,
  sessionPrefix,
} from './storage-keys';
import { GET_URL_TTL_SECONDS, PUT_URL_TTL_SECONDS, StorageService } from './storage.service';
import type { StorageSettings } from './storage.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const OTHER_SID = '33333333-3333-4333-8333-333333333333';
const ULID = '01HZX3K9QJ5W8E2M4N6P7R9T0V';
const scope = { orgId: ORG, sessionId: SID };
const NOW = new Date('2026-10-05T10:00:00.000Z');

const settings: StorageSettings = {
  bucket: 'cp-test-media',
  region: 'auto',
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  forcePathStyle: false,
  credentials: { accessKeyId: 'AKIATESTKEY', secretAccessKey: 'test-secret-value-not-real' },
  conditionalWrites: false,
};

function sendOf(service: StorageService): jest.SpyInstance {
  // The lazily built client is private: reach it through the first presign-free call path.
  const client = (service as unknown as { client: S3Client }).client;
  return jest.spyOn(client, 'send');
}

function callOf(send: jest.SpyInstance, n: number): unknown {
  const calls = send.mock.calls as unknown[][];
  return calls[n]?.[0];
}

function params(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe('StorageService presigned PUT (FR-701, ADR 0013 section 5.5)', () => {
  it('TC-070: the URL lives 60 s and signs Content-Type and Content-Length (ST-2, ST-3)', async () => {
    const storage = new StorageService(settings);
    const put = await storage.presignPut({
      scope,
      key: mediaChunkKey(scope, 'SCREEN', 0, 1),
      contentType: 'video/webm',
      bytes: 2_000_000,
      now: NOW,
    });
    const q = params(put.url);
    expect(PUT_URL_TTL_SECONDS).toBe(60);
    expect(q.get('X-Amz-Expires')).toBe('60');
    expect(q.get('X-Amz-Date')).toBe('20261005T100000Z');
    const signed = (q.get('X-Amz-SignedHeaders') ?? '').split(';');
    expect(signed).toEqual(expect.arrayContaining(['content-type', 'content-length', 'host']));
    expect(signed).not.toContain('if-none-match');
    // No checksum parameter: a browser PUT could not satisfy it (and R2 rejects it).
    expect([...q.keys()].some((k) => k.toLowerCase().includes('checksum'))).toBe(false);
    expect(put.method).toBe('PUT');
    expect(put.headers).toEqual({ 'Content-Type': 'video/webm' });
    expect(put.expiresAt.toISOString()).toBe('2026-10-05T10:01:00.000Z');
  });

  it('FR-701: with conditional writes on, If-None-Match: * is signed and returned', async () => {
    const storage = new StorageService({ ...settings, conditionalWrites: true });
    const put = await storage.presignPut({
      scope,
      key: mediaChunkKey(scope, 'AUDIO', 0, 0),
      contentType: 'audio/webm',
      bytes: 1000,
      now: NOW,
    });
    expect((params(put.url).get('X-Amz-SignedHeaders') ?? '').split(';')).toContain(
      'if-none-match',
    );
    expect(put.headers).toEqual({ 'Content-Type': 'audio/webm', 'If-None-Match': '*' });
  });

  it('CS-3: no URL is signed for another session, another org, or a sealed key', async () => {
    const storage = new StorageService(settings);
    const bad = [
      mediaChunkKey({ orgId: ORG, sessionId: OTHER_SID }, 'SCREEN', 0, 0),
      mediaChunkKey(
        { orgId: '44444444-4444-4444-8444-444444444444', sessionId: SID },
        'SCREEN',
        0,
        0,
      ),
      evidenceSealedKey(scope, ULID),
      `${sessionPrefix(scope)}../escape`,
    ];
    for (const key of bad) {
      await expect(
        storage.presignPut({ scope, key, contentType: 'video/webm', bytes: 10, now: NOW }),
      ).rejects.toThrow('not inside the session scope');
    }
  });

  it('FR-701: a zero or fractional size is refused before signing', async () => {
    const storage = new StorageService(settings);
    const key = mediaChunkKey(scope, 'SCREEN', 0, 0);
    await expect(
      storage.presignPut({ scope, key, contentType: 'video/webm', bytes: 0 }),
    ).rejects.toThrow(RangeError);
  });

  it('NFR-04: with no settings every call refuses with StorageUnconfiguredError, never a crash', async () => {
    const storage = new StorageService(null);
    expect(storage.configured).toBe(false);
    await expect(storage.head(mediaChunkKey(scope, 'SCREEN', 0, 0))).rejects.toMatchObject({
      name: 'StorageUnconfiguredError',
    });
    await expect(
      storage.presignPut({
        scope,
        key: mediaChunkKey(scope, 'SCREEN', 0, 0),
        contentType: 'video/webm',
        bytes: 1,
      }),
    ).rejects.toMatchObject({ name: 'StorageUnconfiguredError' });
  });
});

describe('StorageService presigned GET (FR-703, TC-071, ADR 0013 section 5.7)', () => {
  it('TC-071: the playback URL expires after 15 minutes and forces type and attachment', async () => {
    const storage = new StorageService(settings);
    const got = await storage.presignGet({
      key: mediaChunkKey(scope, 'WEBCAM', 0, 0),
      contentType: 'video/webm',
      now: NOW,
    });
    const q = params(got.url);
    expect(GET_URL_TTL_SECONDS).toBe(900);
    expect(q.get('X-Amz-Expires')).toBe('900');
    expect(q.get('response-content-type')).toBe('video/webm');
    expect(q.get('response-content-disposition')).toBe('attachment');
    expect(got.expiresAt.toISOString()).toBe('2026-10-05T10:15:00.000Z');
    // After 20 minutes the URL's own window has closed: date + expires < now + 20 min.
    const issued = Date.UTC(2026, 9, 5, 10, 0, 0);
    expect(issued + Number(q.get('X-Amz-Expires')) * 1000).toBeLessThan(issued + 20 * 60_000);
  });

  it('FR-703: a type outside the allowlist, or a key of an unknown layout, is never signed', async () => {
    const storage = new StorageService(settings);
    await expect(
      storage.presignGet({
        key: mediaChunkKey(scope, 'WEBCAM', 0, 0),
        contentType: 'text/html',
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      storage.presignGet({ key: 'orgs/x/anything.html', contentType: 'video/webm' }),
    ).rejects.toThrow('not inside the session scope');
  });

  it('FR-703: report PDFs can be served as application/pdf', async () => {
    const storage = new StorageService(settings);
    const got = await storage.presignGet({
      key: reportPdfKey(scope, ULID),
      contentType: 'application/pdf',
      now: NOW,
    });
    expect(params(got.url).get('response-content-type')).toBe('application/pdf');
  });
});

describe('StorageService HEAD, delete and prefix operations (FR-704 storage primitives; TC-072 stays open until the sweep and retention job exist, FU-BEB-43)', () => {
  const KEY = mediaChunkKey(scope, 'SCREEN', 0, 0);

  it('FR-701: head returns size, type and ETag, and null for a missing object', async () => {
    const storage = new StorageService(settings);
    const send = sendOf(storage);
    send.mockResolvedValueOnce({ ContentLength: 5, ContentType: 'video/webm', ETag: '"abc"' });
    await expect(storage.head(KEY)).resolves.toEqual({
      sizeBytes: 5,
      contentType: 'video/webm',
      etag: '"abc"',
    });
    expect(callOf(send, 0)).toBeInstanceOf(HeadObjectCommand);
    send.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NotFound' }));
    await expect(storage.head(KEY)).resolves.toBeNull();
    send.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    await expect(storage.head(KEY)).rejects.toThrow('denied');
  });

  it('FR-704: deleteMany batches by 1000 and counts per-key errors', async () => {
    const storage = new StorageService(settings);
    const send = sendOf(storage);
    send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Errors: [{ Key: 'a', Code: 'InternalError' }] });
    const keys = Array.from({ length: 1001 }, (_, i) => mediaChunkKey(scope, 'SCREEN', 0, i));
    const result = await storage.deleteMany(keys);
    expect(result).toEqual({ deleted: 1000, errors: 1 });
    expect(send.mock.calls).toHaveLength(2);
    const first = callOf(send, 0) as DeleteObjectsCommand;
    expect(first.input.Delete?.Objects).toHaveLength(1000);
  });

  it('FR-704: list follows every page; deletePrefix lists again and reports what remains', async () => {
    const storage = new StorageService(settings);
    const send = sendOf(storage);
    const prefix = sessionPrefix(scope);
    send
      .mockResolvedValueOnce({
        Contents: [{ Key: `${prefix}a`, Size: 1 }],
        IsTruncated: true,
        NextContinuationToken: 't1',
      })
      .mockResolvedValueOnce({ Contents: [{ Key: `${prefix}b`, Size: 2 }], IsTruncated: false })
      .mockResolvedValueOnce({}) // DeleteObjects
      .mockResolvedValueOnce({ Contents: [{ Key: `${prefix}b`, Size: 2 }] }); // still there
    const result = await storage.deletePrefix(prefix);
    expect(result).toEqual({ deleted: 2, errors: 0, remaining: 1 });
    const second = callOf(send, 1) as ListObjectsV2Command;
    expect(second.input.ContinuationToken).toBe('t1');
  });

  it('FR-704: only the session prefix, the consent prefix and named tier directories can be listed or deleted', async () => {
    const storage = new StorageService(settings);
    sendOf(storage);
    const refused = [
      '',
      '/',
      'orgs/',
      `orgs/${ORG}`,
      `orgs/${ORG}/`,
      `orgs/${ORG}/sessions/`,
      `orgs/${ORG}/consents/`,
      'orgs/x/y/',
      `orgs/${ORG}/../`,
      `orgs/${ORG}/sessions/${SID}`,
      `orgs/${ORG}/sessions/${SID}/media/SCREEN/`,
      `orgs/${ORG}/sessions/${SID}/../`,
      `orgs/${ORG}/sessions/${SID}/unknown/`,
    ];
    for (const p of refused) {
      await expect(storage.deletePrefix(p)).rejects.toThrow('not inside the session scope');
      await expect(storage.list(p)).rejects.toThrow('not inside the session scope');
    }
    const send = sendOf(storage);
    send.mockResolvedValue({});
    for (const p of [
      sessionPrefix(scope),
      `orgs/${ORG}/consents/${SID}/`,
      `${sessionPrefix(scope)}identity/`,
      `${sessionPrefix(scope)}evidence/sealed/`,
      `${sessionPrefix(scope)}media/`,
      `${sessionPrefix(scope)}reports/`,
    ]) {
      await expect(storage.list(p)).resolves.toEqual([]);
    }
  });

  it('FR-704: head, delete and deleteMany refuse keys of an unknown layout', async () => {
    const storage = new StorageService(settings);
    const send = sendOf(storage);
    await expect(storage.head('orgs/x/y')).rejects.toThrow('not inside the session scope');
    await expect(storage.delete('anything')).rejects.toThrow('not inside the session scope');
    await expect(storage.deleteMany([KEY, 'anything'])).rejects.toThrow(
      'not inside the session scope',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('FR-606: copy stays inside one session and always writes a sealed/ destination', async () => {
    const storage = new StorageService(settings);
    const send = sendOf(storage);
    send.mockResolvedValue({});
    const src = evidenceKey(scope, ULID);
    await storage.copy(src, evidenceSealedKey(scope, ULID));
    expect(send).toHaveBeenCalledTimes(1);
    const other = { orgId: ORG, sessionId: OTHER_SID };
    for (const dst of [
      evidenceKey(scope, ULID), // not sealed
      evidenceSealedKey(other, ULID), // another session
      evidenceSealedKey({ orgId: '44444444-4444-4444-8444-444444444444', sessionId: SID }, ULID),
    ]) {
      await expect(storage.copy(src, dst)).rejects.toThrow('not inside the session scope');
    }
    // A source in another session, or already sealed, is refused too.
    await expect(
      storage.copy(evidenceKey(other, ULID), evidenceSealedKey(scope, ULID)),
    ).rejects.toThrow();
    await expect(
      storage.copy(evidenceSealedKey(scope, ULID), evidenceSealedKey(scope, ULID)),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
