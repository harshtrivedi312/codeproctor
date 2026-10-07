// S3ObjectStore over a stubbed S3 client. FR-704, NFR-05; ADR 0004 9.2, ADR 0013 5.7.
import {
  DeleteObjectsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { S3Client } from '@aws-sdk/client-s3';
import { ObjectStoreError, S3ObjectStore } from './s3-object-store';
import type { StorageSettings } from './storage.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const PREFIX = `orgs/${ORG}/sessions/${SID}/identity/`;
const SECRET_KEY = `${PREFIX}1/id-SECRETNAME.jpg`;

const settings: StorageSettings = {
  bucket: 'cp-test-media',
  region: 'auto',
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  forcePathStyle: false,
  credentials: { accessKeyId: 'AKIATESTKEY', secretAccessKey: 'test-secret-value-not-real' },
  conditionalWrites: false,
};

function build(): { store: S3ObjectStore; send: jest.SpyInstance } {
  const store = new S3ObjectStore(settings);
  // The client is private to the adapter; the test reaches it only to stub `send`.
  const client = (store as unknown as { handle(): { client: S3Client } }).handle().client;
  return { store, send: jest.spyOn(client, 'send') };
}

function command(send: jest.SpyInstance, n: number): unknown {
  const calls = send.mock.calls as unknown[][];
  return calls[n]?.[0];
}

function input(send: jest.SpyInstance, n: number): unknown {
  const calls = send.mock.calls as Array<[{ input: unknown }]>;
  return calls[n]?.[0].input;
}

const named = (name: string): Error => Object.assign(new Error(`${SECRET_KEY} ${name}`), { name });

describe('S3ObjectStore listPage (FR-704)', () => {
  it('FR-704: one page per call, full keys, and the continuation token round-trips', async () => {
    const { store, send } = build();
    send
      .mockResolvedValueOnce({
        Contents: [{ Key: `${PREFIX}a` }, { Key: `${PREFIX}b` }],
        IsTruncated: true,
        NextContinuationToken: 'tok-1',
      })
      .mockResolvedValueOnce({ Contents: [{ Key: `${PREFIX}c` }], IsTruncated: false });
    const first = await store.listPage(PREFIX);
    expect(first).toEqual({ keys: [`${PREFIX}a`, `${PREFIX}b`], nextToken: 'tok-1' });
    const second = await store.listPage(PREFIX, first.nextToken);
    expect(second).toEqual({ keys: [`${PREFIX}c`] });
    expect(command(send, 0)).toBeInstanceOf(ListObjectsV2Command);
    expect(input(send, 0)).toMatchObject({ Bucket: 'cp-test-media', Prefix: PREFIX });
    expect((input(send, 0) as { ContinuationToken?: string }).ContinuationToken).toBeUndefined();
    expect(input(send, 1)).toMatchObject({ ContinuationToken: 'tok-1' });
  });

  it('FR-704: an empty prefix listing is an empty page', async () => {
    const { store, send } = build();
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({ Contents: [], IsTruncated: false });
    await expect(store.listPage(PREFIX)).resolves.toEqual({ keys: [] });
    await expect(store.listPage(PREFIX)).resolves.toEqual({ keys: [] });
  });

  it('TC-094: a truncated page with no continuation token throws, so a delete is never reported verified', async () => {
    const { store, send } = build();
    send
      .mockResolvedValueOnce({ Contents: [{ Key: SECRET_KEY }], IsTruncated: true })
      .mockResolvedValueOnce({ Contents: [], IsTruncated: true, NextContinuationToken: '' });
    for (let i = 0; i < 2; i++) {
      const err = await store.listPage(PREFIX).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(ObjectStoreError);
      expect(err?.message).toBe('object store list failed: TruncatedListingWithoutToken');
      expect(err?.message).not.toContain('SECRETNAME');
    }
  });

  it('FR-704: no layout guard, so orphan keys of any shape are listed', async () => {
    const { store, send } = build();
    send.mockResolvedValueOnce({ Contents: [{ Key: `${PREFIX}weird/thing.bin` }] });
    await expect(store.listPage(PREFIX)).resolves.toEqual({ keys: [`${PREFIX}weird/thing.bin`] });
  });
});

describe('S3ObjectStore deleteKeys (FR-704)', () => {
  it('FR-704: DeleteObjects in quiet mode; already-gone keys are success; failed comes from Errors', async () => {
    const { store, send } = build();
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({
      Errors: [{ Key: `${PREFIX}b`, Code: 'InternalError' }],
    });
    await expect(store.deleteKeys([`${PREFIX}a`, 'orphan/not-a-known-layout'])).resolves.toEqual({
      failed: [],
    });
    expect(command(send, 0)).toBeInstanceOf(DeleteObjectsCommand);
    expect(input(send, 0)).toMatchObject({
      Bucket: 'cp-test-media',
      Delete: {
        Quiet: true,
        Objects: [{ Key: `${PREFIX}a` }, { Key: 'orphan/not-a-known-layout' }],
      },
    });
    await expect(store.deleteKeys([`${PREFIX}b`])).resolves.toEqual({ failed: [`${PREFIX}b`] });
  });

  it('FR-704: nothing to delete sends nothing; more than 1000 keys is refused without naming a key', async () => {
    const { store, send } = build();
    await expect(store.deleteKeys([])).resolves.toEqual({ failed: [] });
    const many = Array.from({ length: 1001 }, (_, i) => `${PREFIX}k${String(i)}`);
    await expect(store.deleteKeys(many)).rejects.toThrow(RangeError);
    await expect(store.deleteKeys(many)).rejects.not.toThrow(/k1000/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('S3ObjectStore delete errors without a key (TC-094)', () => {
  it('TC-094: an Errors entry with no Key throws instead of being dropped', async () => {
    const { store, send } = build();
    send.mockResolvedValueOnce({
      Errors: [{ Key: `${PREFIX}a`, Code: 'InternalError' }, { Code: 'InternalError' }],
    });
    const err = await store.deleteKeys([`${PREFIX}a`, `${PREFIX}b`]).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(ObjectStoreError);
    expect(err?.message).toBe('object store delete failed: DeleteErrorWithoutKey');
  });
});

describe('S3ObjectStore versioning (FR-704, ADR 0004 9.2)', () => {
  it('FR-704: no versioning status means never-enabled, and the lifecycle is not read', async () => {
    const { store, send } = build();
    send.mockResolvedValueOnce({});
    await expect(store.versioning()).resolves.toEqual({ kind: 'never-enabled' });
    expect(command(send, 0)).toBeInstanceOf(GetBucketVersioningCommand);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('FR-704: Enabled or Suspended reads the whole-bucket noncurrent expiration (smallest enabled rule)', async () => {
    for (const Status of ['Enabled', 'Suspended']) {
      const { store, send } = build();
      send.mockResolvedValueOnce({ Status }).mockResolvedValueOnce({
        Rules: [
          { Status: 'Enabled', Filter: {}, NoncurrentVersionExpiration: { NoncurrentDays: 30 } },
          { Status: 'Enabled', Prefix: '', NoncurrentVersionExpiration: { NoncurrentDays: 7 } },
          // Not whole-bucket, disabled, or not about noncurrent versions: ignored.
          {
            Status: 'Enabled',
            Filter: { Prefix: 'orgs/' },
            NoncurrentVersionExpiration: { NoncurrentDays: 1 },
          },
          { Status: 'Disabled', Filter: {}, NoncurrentVersionExpiration: { NoncurrentDays: 2 } },
          { Status: 'Enabled', Filter: {}, Expiration: { Days: 3 } },
        ],
      });
      await expect(store.versioning()).resolves.toEqual({
        kind: 'versioned',
        noncurrentExpireDays: 7,
      });
      expect(command(send, 1)).toBeInstanceOf(GetBucketLifecycleConfigurationCommand);
    }
  });

  it('TC-072: a rule that keeps NewerNoncurrentVersions is not a bound; with only such a rule the days are null', async () => {
    const a = build();
    a.send.mockResolvedValueOnce({ Status: 'Enabled' }).mockResolvedValueOnce({
      Rules: [
        {
          Status: 'Enabled',
          Filter: {},
          NoncurrentVersionExpiration: { NoncurrentDays: 1, NewerNoncurrentVersions: 3 },
        },
      ],
    });
    await expect(a.store.versioning()).resolves.toEqual({
      kind: 'versioned',
      noncurrentExpireDays: null,
    });
    const b = build();
    b.send.mockResolvedValueOnce({ Status: 'Enabled' }).mockResolvedValueOnce({
      Rules: [
        {
          Status: 'Enabled',
          Filter: {},
          NoncurrentVersionExpiration: { NoncurrentDays: 2, NewerNoncurrentVersions: 1 },
        },
        { Status: 'Enabled', Filter: {}, NoncurrentVersionExpiration: { NoncurrentDays: 30 } },
        {
          Status: 'Enabled',
          Filter: {},
          NoncurrentVersionExpiration: { NoncurrentDays: 5, NewerNoncurrentVersions: 0 },
        },
      ],
    });
    await expect(b.store.versioning()).resolves.toEqual({
      kind: 'versioned',
      noncurrentExpireDays: 5,
    });
  });

  it('TC-072: Filter.And, even with only an empty Prefix, is conservatively not whole-bucket', async () => {
    const { store, send } = build();
    send.mockResolvedValueOnce({ Status: 'Enabled' }).mockResolvedValueOnce({
      Rules: [
        {
          Status: 'Enabled',
          Filter: { And: { Prefix: '' } },
          NoncurrentVersionExpiration: { NoncurrentDays: 4 },
        },
      ],
    });
    await expect(store.versioning()).resolves.toEqual({
      kind: 'versioned',
      noncurrentExpireDays: null,
    });
  });

  it('FR-704: versioned with no lifecycle configuration, or no matching rule, is null days', async () => {
    const a = build();
    a.send
      .mockResolvedValueOnce({ Status: 'Enabled' })
      .mockRejectedValueOnce(named('NoSuchLifecycleConfiguration'));
    await expect(a.store.versioning()).resolves.toEqual({
      kind: 'versioned',
      noncurrentExpireDays: null,
    });
    const b = build();
    b.send.mockResolvedValueOnce({ Status: 'Enabled' }).mockResolvedValueOnce({ Rules: [] });
    await expect(b.store.versioning()).resolves.toEqual({
      kind: 'versioned',
      noncurrentExpireDays: null,
    });
  });

  it('FR-704: a store that cannot answer (R2, access denied) is unsupported, never never-enabled', async () => {
    const a = build();
    a.send.mockRejectedValueOnce(named('NotImplemented'));
    await expect(a.store.versioning()).resolves.toEqual({ kind: 'unsupported' });
    const b = build();
    b.send
      .mockResolvedValueOnce({ Status: 'Enabled' })
      .mockRejectedValueOnce(named('AccessDenied'));
    await expect(b.store.versioning()).resolves.toEqual({ kind: 'unsupported' });
  });
});

describe('S3ObjectStore failure handling (NFR-05)', () => {
  it('NFR-05: the error carries the SDK request id and HTTP status, which are key-free', async () => {
    const { store, send } = build();
    send.mockRejectedValue(
      Object.assign(new Error(`${SECRET_KEY} slow down`), {
        name: 'SlowDown',
        $metadata: { requestId: 'REQ123', httpStatusCode: 503 },
      }),
    );
    const err = (await store.listPage(PREFIX).then(
      () => undefined,
      (e: unknown) => e,
    )) as ObjectStoreError;
    expect(err.requestId).toBe('REQ123');
    expect(err.httpStatus).toBe(503);
    expect(err.message).toBe('object store list failed: SlowDown');
  });

  it('NFR-05: SDK errors become errors with the operation and the error name, never the key', async () => {
    const { store, send } = build();
    send.mockRejectedValue(named('InternalError'));
    const calls = [() => store.listPage(PREFIX), () => store.deleteKeys([SECRET_KEY])];
    for (const call of calls) {
      const err = await call().then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toMatch(/object store (list|delete) failed: InternalError/);
      expect(err?.message).not.toContain('SECRETNAME');
      expect(err?.message).not.toContain(ORG);
      expect(JSON.stringify(err)).not.toContain('SECRETNAME');
      expect(err?.cause).toBeUndefined();
    }
  });

  it('NFR-05: nothing is written to stdout or stderr, even on failure', async () => {
    const { store, send } = build();
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errOut = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      send.mockRejectedValueOnce(named('InternalError')).mockResolvedValueOnce({
        Contents: [{ Key: SECRET_KEY }],
      });
      await store.listPage(PREFIX).catch(() => undefined);
      await store.listPage(PREFIX);
      expect(out).not.toHaveBeenCalled();
      expect(errOut).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      errOut.mockRestore();
    }
  });

  it('NFR-04: with no storage settings every call fails closed with StorageUnconfiguredError', async () => {
    const store = new S3ObjectStore(null);
    const unconfigured = { name: 'StorageUnconfiguredError' };
    await expect(store.listPage(PREFIX)).rejects.toMatchObject(unconfigured);
    await expect(store.deleteKeys([SECRET_KEY])).rejects.toMatchObject(unconfigured);
    await expect(store.versioning()).rejects.toMatchObject(unconfigured);
  });
});

describe('The raw S3 client stays inside the adapters (NFR-05)', () => {
  const SRC = resolve(__dirname, '..');
  const ALLOWED = new Set(['storage.service.ts', 's3-object-store.ts']);

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return name === 'generated' ? [] : sources(full);
      return name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('-spec.ts')
        ? [full]
        : [];
    });
  }

  it('NFR-05: only storage.service.ts and s3-object-store.ts import the AWS S3 client, and nothing exposes it', () => {
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      const base = file.split('/').pop() as string;
      if (/from '@aws-sdk\/client-s3'/.test(text)) {
        expect(ALLOWED.has(base)).toBe(true);
      }
      expect(text).not.toMatch(/rawClient/);
    }
    const store = readFileSync(join(SRC, 'media/s3-object-store.ts'), 'utf8');
    const storage = readFileSync(join(SRC, 'media/storage.service.ts'), 'utf8');
    // The client is only ever a private field or a local; no public accessor returns it.
    expect(store).not.toMatch(/^\s+(get\s+)?client\(/m);
    expect(storage).not.toMatch(/^\s+(public\s+)?get client\(/m);
  });
});
