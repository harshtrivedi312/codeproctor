import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
// The route's own schema: the body must be one the built API accepts (ADR 0013 section 5.4).
import { systemCheckBodySchema } from '../../../../apps/api/src/candidate/system-check.schema';
import { MultiScreenMonitor } from '../monitors/multi-screen';
import { VirtualCameraMonitor } from '../monitors/virtual-camera';
import { TEST_KEY_B64 } from '../test/helpers';
import type { SendResult, SignedBatch } from './batch-queue';
import { FLAG_DETAIL_MAX, FLAG_ID_RE } from './health';
import { IdbStore } from './idb';
import { ProctorSession } from './session';
import {
  SystemCheckError,
  collectSystemCheck,
  runSystemCheck,
  type SystemCheckEnv,
} from './system-check';

/**
 * runSystemCheck (ADR 0013 section 5.4; FR-604 TC-054, FR-605 TC-056, FR-610 TC-064, FR-609):
 * only enums, booleans and counts; labels and device ids never leave, except the label of a
 * virtual-camera match that the VIRTUAL_CAMERA payload carries.
 */
const TOKEN = 'candidate-token-SECRET-xyz';
const PRIVATE_LABEL = 'Integrated Webcam (Acme 1234:abcd)';
const PRIVATE_ID = 'f3a9c0de1234567890abcdef';
const NOW = new Date('2026-03-01T10:00:00Z');

const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';

function env(over: Partial<SystemCheckEnv> = {}, devices?: MediaDeviceInfo[]): SystemCheckEnv {
  const list =
    devices ??
    ([
      { kind: 'videoinput', label: PRIVATE_LABEL, deviceId: PRIVATE_ID },
      { kind: 'audioinput', label: 'Microphone array', deviceId: 'mic-id-9' },
    ] as MediaDeviceInfo[]);
  return {
    navigator: {
      userAgent: EDGE_UA,
      mediaDevices: {
        enumerateDevices: () => Promise.resolve(list),
        getDisplayMedia: () => Promise.reject(new Error('must not be called')),
      },
      permissions: { query: () => Promise.resolve({ state: 'granted' }) },
      connection: { downlink: 12.5, rtt: 40 },
    },
    window: { screen: { isExtended: false } },
    MediaRecorder: { isTypeSupported: () => true },
    document: { fullscreenEnabled: true },
    indexedDB,
    crypto: { subtle: crypto.subtle },
    ...over,
  };
}

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe('collectSystemCheck: what is looked at and what is sent (FR-604, FR-605, FR-610)', () => {
  it('builds a body the built route accepts, with booleans and enums only', async () => {
    const body = await collectSystemCheck({ env: env(), screenShare: 'MONITOR', now: () => NOW });
    expect(systemCheckBodySchema.safeParse(body).success).toBe(true);
    expect(body.browser).toEqual({ brand: 'Microsoft Edge', majorVersion: 130 });
    expect(body.devices).toEqual({ camera: true, microphone: true, screenShare: 'MONITOR' });
    expect(body.network).toEqual({ downlinkKbps: 12_500, rttMs: 40 });
    expect(body.findings).toEqual([]);
    const ids = body.capabilities.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'multi-screen',
        'virtual-camera',
        'camera-permission',
        'microphone-permission',
        'screen-share',
        'media-recorder',
        'fullscreen-api',
        'idb',
        'web-crypto',
      ]),
    );
    for (const c of body.capabilities) {
      expect(c.id).toMatch(FLAG_ID_RE);
      expect((c.detail ?? '').length).toBeLessThanOrEqual(FLAG_DETAIL_MAX);
    }
    expect(body.capabilities.length).toBeLessThanOrEqual(32);
  });

  it('TC-056: a second monitor becomes a MULTI_MONITOR finding with the api and the count', async () => {
    const win = {
      screen: { isExtended: true },
      getScreenDetails: () => Promise.resolve({ screens: [{}, {}] }),
    };
    const body = await collectSystemCheck({ env: env({ window: win }), now: () => NOW });
    expect(body.findings).toEqual([
      {
        type: 'MULTI_MONITOR',
        occurredAt: NOW.toISOString(),
        payload: { api: 'WINDOW_MANAGEMENT', screenCount: 2 },
      },
    ]);
    expect(systemCheckBodySchema.safeParse(body).success).toBe(true);
  });

  it('a browser that cannot count screens says so (never a fake single screen)', async () => {
    const body = await collectSystemCheck({ env: env({ window: { screen: {} } }) });
    expect(body.capabilities.find((c) => c.id === 'multi-screen')?.status).toBe('UNSUPPORTED');
    expect(body.findings).toEqual([]);
  });

  it('TC-064: only the label of a virtual-camera match is sent; other labels and device ids never are', async () => {
    const body = await collectSystemCheck({
      env: env({}, [
        { kind: 'videoinput', label: 'OBS Virtual Camera', deviceId: PRIVATE_ID },
        { kind: 'videoinput', label: PRIVATE_LABEL, deviceId: 'other-id' },
        { kind: 'audioinput', label: 'Private headset mic', deviceId: 'mic-id-9' },
      ] as MediaDeviceInfo[]),
      now: () => NOW,
    });
    expect(body.findings).toEqual([
      {
        type: 'VIRTUAL_CAMERA',
        occurredAt: NOW.toISOString(),
        payload: { deviceLabel: 'OBS Virtual Camera' },
      },
    ]);
    const wire = JSON.stringify(body);
    for (const secret of [
      PRIVATE_LABEL,
      PRIVATE_ID,
      'other-id',
      'Private headset mic',
      'mic-id-9',
    ]) {
      expect(wire).not.toContain(secret);
    }
    expect(systemCheckBodySchema.safeParse(body).success).toBe(true);
  });

  it('privacy: with ordinary devices no label or id appears anywhere in the body', async () => {
    const body = await collectSystemCheck({ env: env(), now: () => NOW });
    const wire = JSON.stringify(body);
    for (const secret of [PRIVATE_LABEL, PRIVATE_ID, 'Microphone array', 'mic-id-9']) {
      expect(wire).not.toContain(secret);
    }
  });

  it('hidden labels are UNVERIFIABLE, not a pass and not a finding', async () => {
    const body = await collectSystemCheck({
      env: env({}, [{ kind: 'videoinput', label: '', deviceId: '' }] as MediaDeviceInfo[]),
    });
    expect(body.findings).toEqual([]);
    expect(body.capabilities.find((c) => c.id === 'virtual-camera')?.status).toBe('UNVERIFIABLE');
    expect(body.devices.camera).toBe(true);
  });

  it('TC-054: the surface the app obtained goes through; without one it is UNVERIFIABLE and flagged', async () => {
    const win = await collectSystemCheck({ env: env(), screenShare: 'OTHER' });
    expect(win.devices.screenShare).toBe('OTHER');
    expect(win.capabilities.some((c) => c.id === 'screen-share-surface')).toBe(false);
    const none = await collectSystemCheck({ env: env() });
    expect(none.devices.screenShare).toBe('UNVERIFIABLE');
    expect(none.capabilities.find((c) => c.id === 'screen-share-surface')?.status).toBe(
      'UNVERIFIABLE',
    );
  });

  it('missing APIs are reported UNSUPPORTED / UNVERIFIABLE, never as a pass', async () => {
    const body = await collectSystemCheck({
      env: {
        navigator: { userAgent: 'SomethingOdd/1.0' },
        window: { screen: {} },
        MediaRecorder: { isTypeSupported: () => false },
        document: {},
        indexedDB: undefined,
        crypto: {},
      },
    });
    const by = (id: string) => body.capabilities.find((c) => c.id === id)?.status;
    expect(body.browser).toEqual({ brand: 'Unknown', majorVersion: 0 });
    expect(body.devices).toEqual({ camera: false, microphone: false, screenShare: 'UNVERIFIABLE' });
    expect(by('media-recorder')).toBe('UNSUPPORTED');
    expect(by('fullscreen-api')).toBe('UNSUPPORTED');
    expect(by('idb')).toBe('UNSUPPORTED');
    expect(by('web-crypto')).toBe('UNSUPPORTED');
    expect(by('camera-permission')).toBe('UNVERIFIABLE');
    expect(body.network).toBeUndefined();
    expect(systemCheckBodySchema.safeParse(body).success).toBe(true);
  });

  it('never asks for a device: no getUserMedia, no getDisplayMedia', async () => {
    const getUserMedia = vi.fn();
    const getDisplayMedia = vi.fn();
    const e = env();
    (e.navigator as { mediaDevices: object }).mediaDevices = {
      enumerateDevices: () => Promise.resolve([]),
      getUserMedia,
      getDisplayMedia,
    };
    await collectSystemCheck({ env: e });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it('brand from userAgentData wins over the UA string; GREASE brands are skipped', async () => {
    const e = env();
    (e.navigator as { userAgentData: object }).userAgentData = {
      brands: [
        { brand: 'Not;A=Brand', version: '99' },
        { brand: 'Chromium', version: '131' },
        { brand: 'Google Chrome', version: '131' },
      ],
    };
    const body = await collectSystemCheck({ env: e });
    expect(body.browser).toEqual({ brand: 'Google Chrome', majorVersion: 131 });
  });
});

describe('runSystemCheck: the request and its answers (FR-605, TC-056)', () => {
  const run = (fetchFn: typeof fetch, over: Partial<Parameters<typeof runSystemCheck>[0]> = {}) => {
    const sleeps: number[] = [];
    return {
      sleeps,
      promise: runSystemCheck({
        baseUrl: 'https://api.test/v1',
        getToken: () => TOKEN,
        fetchFn,
        env: env(),
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        ...over,
      }),
    };
  };

  it('posts JSON with only the bearer token as secret and returns the gate answer', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const { promise } = run(((url: string, init: RequestInit) => {
      Object.assign(seen, { url, init });
      return Promise.resolve(
        reply(200, { passed: false, blocking: ['MULTI_MONITOR', 'WHATEVER'] }),
      );
    }) as unknown as typeof fetch);
    const r = await promise;
    expect(r).toEqual({ passed: false, blocking: ['MULTI_MONITOR'] }); // unknown reasons dropped
    expect(seen.url).toBe('https://api.test/v1/candidate/session/system-check');
    expect(seen.init?.method).toBe('POST');
    expect((seen.init?.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(String(seen.init?.body as string)).not.toContain(TOKEN);
    expect(
      systemCheckBodySchema.safeParse(JSON.parse(String(seen.init?.body as string))).success,
    ).toBe(true);
  });

  it('401, 400 and 409 SESSION_NOT_ACTIVE are final; nothing leaks into the error', async () => {
    for (const [status, code, kind] of [
      [401, 'TOKEN_EXPIRED', 'UNAUTHENTICATED'],
      [400, '', 'REJECTED'],
      [409, 'SESSION_NOT_ACTIVE', 'NOT_ACTIVE'],
    ] as const) {
      const fetchFn = vi.fn(() => Promise.resolve(reply(status, { code, detail: TOKEN })));
      const { promise } = run(fetchFn);
      const err = (await promise.catch((e: unknown) => e)) as SystemCheckError;
      expect(err).toBeInstanceOf(SystemCheckError);
      expect(err.kind).toBe(kind);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(`${err.message}${JSON.stringify(err)}${err.stack ?? ''}`).not.toContain(TOKEN);
      expect(`${err.message}${JSON.stringify(err)}`).not.toContain(PRIVATE_LABEL);
    }
  });

  it('429 and 503 BUSY wait for Retry-After and retry; attempts are bounded', async () => {
    let n = 0;
    const answers = [
      () => reply(429, { code: 'RATE_LIMITED' }, { 'Retry-After': '9' }),
      () => reply(503, { code: 'BUSY' }, { 'Retry-After': '2' }),
      () => reply(200, { passed: true, blocking: [] }),
    ];
    const ok = run(() => Promise.resolve((answers[n++] ?? answers[2])!()));
    expect(await ok.promise).toEqual({ passed: true, blocking: [] });
    expect(ok.sleeps[0]).toBe(9000);
    expect(ok.sleeps[1]).toBe(2000);

    const down = vi.fn(() => Promise.resolve(reply(503, { code: 'BUSY' })));
    const b = run(down, { maxAttempts: 2 });
    const err = (await b.promise.catch((e: unknown) => e)) as SystemCheckError;
    expect(err.kind).toBe('UNAVAILABLE');
    expect(down).toHaveBeenCalledTimes(2);
  });

  it('a hung request is cut by the timeout and counted as transient', async () => {
    const hung = vi.fn(() => new Promise<Response>(() => undefined));
    const { promise } = run(hung, { timeoutMs: 20, maxAttempts: 2 });
    const err = (await promise.catch((e: unknown) => e)) as SystemCheckError;
    expect(err.kind).toBe('UNAVAILABLE');
    expect(hung).toHaveBeenCalledTimes(2);
  });

  it('a getToken() that throws is final and sends nothing', async () => {
    const fetchFn = vi.fn();
    const { promise } = run(fetchFn, {
      getToken: () => {
        throw new Error('no token');
      },
    });
    const err = (await promise.catch((e: unknown) => e)) as SystemCheckError;
    expect(err.kind).toBe('UNAUTHENTICATED');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('after the start the checks repeat inside signed batches (FR-605, FR-610, TC-056, TC-064)', () => {
  it('the monitors emit MULTI_MONITOR and VIRTUAL_CAMERA through the session as signed batches', async () => {
    const sent: SignedBatch[] = [];
    const s = new ProctorSession();
    await s.start({
      sessionId: 'sess',
      hmacKeyBase64: TEST_KEY_B64,
      root: document.createElement('div'),
      consent: { recordedAt: '2026-01-01T00:00:00Z' },
      transport: {
        sendBatch: (b) => {
          sent.push(b);
          return Promise.resolve<SendResult>('OK');
        },
        heartbeat: () => Promise.resolve(true),
      },
      detectors: [
        new MultiScreenMonitor({ screen: { isExtended: true } }, 60_000),
        new VirtualCameraMonitor({
          enumerateDevices: () =>
            Promise.resolve([
              { kind: 'videoinput', label: 'OBS Virtual Camera' },
            ] as MediaDeviceInfo[]),
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }),
      ],
      store: new IdbStore(indexedDB, `sc-${Math.random()}`),
      flushIntervalMs: 10,
    });
    await vi.waitFor(() => {
      const types = sent.flatMap((b) =>
        (JSON.parse(b.body) as { events: { type: string }[] }).events.map((e) => e.type),
      );
      expect(types).toEqual(expect.arrayContaining(['MULTI_MONITOR', 'VIRTUAL_CAMERA']));
    });
    expect(sent[0]?.signature).toMatch(/^[0-9a-f]{64}$/);
    await s.stop();
  });
});
