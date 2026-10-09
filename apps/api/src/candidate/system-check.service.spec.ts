import { SessionLockRetryError } from '../database/errors';
import { VerifyEnqueueScopeError } from '../session/verify-session.jobs';
import {
  brandsOfSecChUa,
  evaluateSystemCheck,
  MIN_CHROMIUM_MAJOR,
  SystemCheckService,
} from './system-check.service';
import { systemCheckBodySchema } from './system-check.schema';

const base = {
  browser: { brand: 'Google Chrome', majorVersion: 124 },
  devices: { camera: true, microphone: true, screenShare: 'MONITOR' as const },
  findings: [],
  capabilities: [],
};
const parse = (b: object) => systemCheckBodySchema.parse(b);

describe('System check evaluation (FR-402, FR-605, FR-610, ADR 0013 section 5.4)', () => {
  it('FR-402: Chromium at the minimum version with a camera, a microphone and a monitor share passes', () => {
    expect(evaluateSystemCheck(parse(base))).toEqual([]);
    expect(
      evaluateSystemCheck(
        parse({ ...base, browser: { brand: 'Microsoft Edge', majorVersion: MIN_CHROMIUM_MAJOR } }),
      ),
    ).toEqual([]);
  });

  it('FR-402: an older Chromium, Firefox and Safari are BROWSER_UNSUPPORTED', () => {
    for (const browser of [
      { brand: 'Google Chrome', majorVersion: MIN_CHROMIUM_MAJOR - 1 },
      { brand: 'Firefox', majorVersion: 130 },
      { brand: 'Safari', majorVersion: 18 },
    ]) {
      expect(evaluateSystemCheck(parse({ ...base, browser }))).toEqual(['BROWSER_UNSUPPORTED']);
    }
  });

  it('FR-610, ADR 0013 section 5.8: VIRTUAL_CAMERA and an UNVERIFIABLE share surface do not block', () => {
    const body = parse({
      ...base,
      devices: { camera: true, microphone: true, screenShare: 'UNVERIFIABLE' },
      findings: [
        {
          type: 'VIRTUAL_CAMERA',
          occurredAt: '2026-10-09T10:00:00.000Z',
          payload: { deviceLabel: 'OBS' },
        },
      ],
    });
    expect(evaluateSystemCheck(body)).toEqual([]);
  });

  it('FR-402: Sec-CH-UA brands are read from the header; a missing or empty header is null', () => {
    expect(
      brandsOfSecChUa('"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"'),
    ).toEqual(['chromium', 'google chrome', 'not-a.brand']);
    expect(brandsOfSecChUa(undefined)).toBeNull();
    expect(brandsOfSecChUa('  ')).toBeNull();
    expect(brandsOfSecChUa('garbage')).toBeNull();
  });
});

describe('SystemCheckService store (ADR 0013 section 5.3 fencing; TC-056)', () => {
  const ctx = { sessionId: 's1', orgId: 'o1', status: 'CONSENTED' } as never;
  const finding = {
    type: 'MULTI_MONITOR' as const,
    occurredAt: '2026-10-09T10:00:00.000Z',
    payload: { api: 'SCREEN_IS_EXTENDED' as const, screenCount: 2 },
  };

  function build(options: { count: number; createManyFails?: boolean }) {
    const createMany = jest.fn(() =>
      options.createManyFails
        ? Promise.reject(new Error('insert failed'))
        : Promise.resolve({ count: 1 }),
    );
    const tx = {
      session: {
        findUnique: () => Promise.resolve({ status: 'CONSENTED', deviceInfo: {} }),
        updateMany: () => Promise.resolve({ count: options.count }),
      },
      consent: { findUnique: () => Promise.resolve(null) },
      proctorEvent: { createMany },
    };
    const prisma = { client: { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) } };
    const scope = {
      asOrg: (_c: unknown, fn: () => unknown) => fn(),
      asCandidate: (_c: unknown, fn: () => unknown) => fn(),
    };
    const enqueue = jest.fn(() => Promise.resolve());
    const service = new SystemCheckService(
      prisma as never,
      scope as never,
      { enqueueVerifySession: enqueue } as never,
    );
    return { service, createMany, enqueue };
  }
  const body = (findings: object[] = []) =>
    systemCheckBodySchema.parse({ ...base, findings, capabilities: [] });

  it('DL-37, TC-056: three lost compare-and-set races end in a busy error, write no evidence and queue nothing', async () => {
    const { service, createMany, enqueue } = build({ count: 0 });
    await expect(service.submit(ctx, body([finding]), undefined)).rejects.toBeInstanceOf(
      SessionLockRetryError,
    );
    expect(createMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ADR 0013 section 3: a failed evidence insert fails the call inside the transaction, so the fingerprints are rolled back with it', async () => {
    const { service, enqueue } = build({ count: 1, createManyFails: true });
    await expect(service.submit(ctx, body([finding]), undefined)).rejects.toThrow('insert failed');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('FR-605: two identical findings in one call make one evidence row', async () => {
    const { service, createMany } = build({ count: 1 });
    await service.submit(ctx, body([finding, finding]), undefined);
    const calls = createMany.mock.calls as unknown as Array<[{ data: unknown[] }]>;
    expect(calls[0]?.[0].data).toHaveLength(1);
  });

  it('TC-056: an enqueue scope error is a bug and is not hidden as a busy answer', async () => {
    const { service, enqueue } = build({ count: 1 });
    enqueue.mockRejectedValueOnce(new VerifyEnqueueScopeError());
    await expect(service.submit(ctx, body(), undefined)).rejects.toBeInstanceOf(
      VerifyEnqueueScopeError,
    );
  });
});
