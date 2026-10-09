import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
// The route's own schema: the body must be one the built API accepts (ADR 0013 section 5.4).
import { systemCheckBodySchema } from '../../../../apps/api/src/candidate/system-check.schema';
import { MultiScreenMonitor } from '../monitors/multi-screen';
import { ScreenShareMonitor, requestScreenShare, surfaceOf } from '../monitors/screen-share';
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
    // A share that happened but whose surface the browser does not report: UNVERIFIABLE + flag.
    const unreported = await collectSystemCheck({ env: env(), screenShare: 'UNVERIFIABLE' });
    expect(unreported.devices.screenShare).toBe('UNVERIFIABLE');
    expect(unreported.capabilities.find((c) => c.id === 'screen-share-surface')?.status).toBe(
      'UNVERIFIABLE',
    );
    expect(unreported.capabilities.find((c) => c.id === 'screen-share')?.status).toBe('SUPPORTED');
    // No share at all is NOT "unverified": the body says so honestly (and runSystemCheck refuses it).
    const none = await collectSystemCheck({ env: env(), screenShare: null });
    expect(none.capabilities.find((c) => c.id === 'screen-share')).toMatchObject({
      status: 'DENIED',
      detail: 'No screen share was obtained.',
    });
    expect(none.capabilities.some((c) => c.id === 'screen-share-surface')).toBe(false);
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
        screenShare: 'MONITOR',
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
    await vi.waitFor(
      () => {
        const types = sent.flatMap((b) =>
          (JSON.parse(b.body) as { events: { type: string }[] }).events.map((e) => e.type),
        );
        expect(types).toEqual(expect.arrayContaining(['MULTI_MONITOR', 'VIRTUAL_CAMERA']));
      },
      { timeout: 3000 },
    );
    expect(sent[0]?.signature).toMatch(/^[0-9a-f]{64}$/);
    await s.stop();
  });
});

describe('review fixes: prompts, timeouts, clamps, labels (FR-604, FR-605, FR-610, TC-054, TC-056, TC-064)', () => {
  it('surfaceOf never turns an unverified surface into a pass', () => {
    const stream = {} as MediaStream;
    expect(surfaceOf({ ok: true, stream, surface: 'monitor' })).toBe('MONITOR');
    expect(surfaceOf({ ok: true, stream, surface: null })).toBe('UNVERIFIABLE');
    expect(surfaceOf({ ok: true, stream, surface: 'window' })).toBe('OTHER');
    expect(surfaceOf({ ok: false, reason: 'WRONG_SURFACE' })).toBe('OTHER');
    expect(surfaceOf({ ok: false, reason: 'DENIED' })).toBeNull();
    expect(surfaceOf({ ok: false, reason: 'UNSUPPORTED' })).toBeNull();
  });

  it('getScreenDetails (a prompt) is only called when window-management is already granted', async () => {
    const getScreenDetails = vi.fn(() => Promise.resolve({ screens: [{}, {}] }));
    const win = { screen: { isExtended: false }, getScreenDetails };
    const e = env({ window: win });
    (e.navigator as { permissions: object }).permissions = {
      query: ({ name }: { name: string }) =>
        Promise.resolve({ state: name === 'window-management' ? 'prompt' : 'granted' }),
    };
    const body = await collectSystemCheck({ env: e });
    expect(getScreenDetails).not.toHaveBeenCalled();
    expect(body.findings).toEqual([]); // fell back to isExtended (single)
    // granted: the count is used
    (e.navigator as { permissions: object }).permissions = {
      query: () => Promise.resolve({ state: 'granted' }),
    };
    const granted = await collectSystemCheck({ env: e });
    expect(getScreenDetails).toHaveBeenCalledTimes(1);
    expect(granted.findings[0]?.payload).toEqual({ api: 'WINDOW_MANAGEMENT', screenCount: 2 });
  });

  it('a browser step that never settles is cut and reported UNVERIFIABLE (never a pass)', async () => {
    const e = env();
    const hang = () => new Promise<never>(() => undefined);
    (e.navigator as { mediaDevices: object; permissions: object }).mediaDevices = {
      enumerateDevices: hang,
    };
    (e.navigator as { permissions: object }).permissions = { query: hang };
    e.window = { screen: { isExtended: false }, getScreenDetails: hang };
    const t0 = Date.now();
    const body = await collectSystemCheck({ env: e, stepTimeoutMs: 30 });
    expect(Date.now() - t0).toBeLessThan(2000);
    const by = (id: string) => body.capabilities.find((c) => c.id === id)?.status;
    expect(body.devices).toMatchObject({ camera: false, microphone: false });
    expect(by('camera-permission')).toBe('UNVERIFIABLE');
    expect(by('virtual-camera')).toBe('UNVERIFIABLE');
  });

  it('fullscreenEnabled false means UNSUPPORTED even if the function exists', async () => {
    const e = env({
      document: {
        fullscreenEnabled: false,
        documentElement: { requestFullscreen: () => undefined },
      },
    });
    const body = await collectSystemCheck({ env: e });
    expect(body.capabilities.find((c) => c.id === 'fullscreen-api')?.status).toBe('UNSUPPORTED');
    const e2 = env({ document: { documentElement: { requestFullscreen: () => undefined } } });
    expect(
      (await collectSystemCheck({ env: e2 })).capabilities.find((c) => c.id === 'fullscreen-api')
        ?.status,
    ).toBe('SUPPORTED');
  });

  it('a virtual-camera label is cleaned (printable, <=128) and an empty one is no finding', async () => {
    const dirty = await collectSystemCheck({
      env: env({}, [
        {
          kind: 'videoinput',
          label: `OBS Virtual\u0000 Camera\u0007${'x'.repeat(300)}`,
          deviceId: 'a',
        },
      ] as MediaDeviceInfo[]),
      now: () => NOW,
    });
    const label = String(dirty.findings[0]?.payload['deviceLabel']);
    expect(label).toMatch(/^OBS Virtual Camerax+$/);
    expect(Array.from(label).length).toBeLessThanOrEqual(128);
    expect(systemCheckBodySchema.safeParse(dirty).success).toBe(true);
    const none = await collectSystemCheck({
      env: env({}, [
        { kind: 'videoinput', label: '\u0001\u0002obs', deviceId: 'a' },
      ] as MediaDeviceInfo[]),
    });
    expect(systemCheckBodySchema.safeParse(none).success).toBe(true);
  });

  it('no camera at all is UNVERIFIABLE for the virtual-camera check, not SUPPORTED', async () => {
    const body = await collectSystemCheck({
      env: env({}, [{ kind: 'audioinput', label: 'mic', deviceId: 'm' }] as MediaDeviceInfo[]),
    });
    expect(body.devices.camera).toBe(false);
    expect(body.capabilities.find((c) => c.id === 'virtual-camera')?.status).toBe('UNVERIFIABLE');
  });

  it('a spoofed UA version is clamped to the route range; NaN attempts cannot loop forever', async () => {
    const e = env();
    (e.navigator as { userAgent: string }).userAgent = 'Mozilla/5.0 Firefox/99999999';
    const body = await collectSystemCheck({ env: e });
    expect(body.browser).toEqual({ brand: 'Firefox', majorVersion: 999 });
    expect(systemCheckBodySchema.safeParse(body).success).toBe(true);
    const down = vi.fn(() => Promise.resolve(reply(503, { code: 'BUSY' })));
    const err = await runSystemCheck({
      baseUrl: 'https://api.test',
      getToken: () => TOKEN,
      fetchFn: down,
      env: env(),
      screenShare: 'MONITOR',
      maxAttempts: Number.NaN,
      sleep: () => Promise.resolve(),
    }).catch((x: unknown) => x);
    expect((err as SystemCheckError).kind).toBe('UNAVAILABLE');
    expect(down).toHaveBeenCalledTimes(3); // the default
    const big = vi.fn(() => Promise.resolve(reply(503, {})));
    await runSystemCheck({
      baseUrl: 'https://api.test',
      getToken: () => TOKEN,
      fetchFn: big,
      env: env(),
      screenShare: 'MONITOR',
      maxAttempts: 1_000_000,
      sleep: () => Promise.resolve(),
    }).catch(() => undefined);
    expect(big).toHaveBeenCalledTimes(5); // capped
  });

  it('408 is retried; a 200 with an invalid body is UNAVAILABLE (bad response), never a pass', async () => {
    let n = 0;
    const r = await runSystemCheck({
      baseUrl: 'https://api.test',
      getToken: () => TOKEN,
      fetchFn: () =>
        Promise.resolve(++n === 1 ? reply(408, {}) : reply(200, { passed: true, blocking: [] })),
      env: env(),
      screenShare: 'MONITOR',
      sleep: () => Promise.resolve(),
    });
    expect(r.passed).toBe(true);
    for (const bad of [{ passed: 'yes', blocking: [] }, { passed: true }, 'nope']) {
      const err = await runSystemCheck({
        baseUrl: 'https://api.test',
        getToken: () => TOKEN,
        fetchFn: () => Promise.resolve(reply(200, bad)),
        env: env(),
        screenShare: 'MONITOR',
      }).catch((x: unknown) => x);
      expect((err as SystemCheckError).kind).toBe('UNAVAILABLE');
      expect((err as SystemCheckError).code).toBe('BAD_RESPONSE');
    }
  });
});

describe('the pre-start share flow and honest unknowns (FR-604, FR-605, TC-054, TC-056)', () => {
  const stream = (surface?: string) => {
    const stops: number[] = [];
    const track = {
      getSettings: () => (surface === undefined ? {} : { displaySurface: surface }),
      stop: () => stops.push(1),
      addEventListener: () => undefined,
    };
    return {
      stops,
      value: {
        getVideoTracks: () => [track],
        getTracks: () => [track],
      } as unknown as MediaStream,
    };
  };

  it('no share outcome sends nothing: NO_SCREEN_SHARE, the fetch is never called', async () => {
    for (const screenShare of [null, undefined]) {
      const fetchFn = vi.fn();
      const err = await runSystemCheck({
        baseUrl: 'https://api.test',
        getToken: () => TOKEN,
        fetchFn: fetchFn,
        env: env(),
        ...(screenShare === undefined ? {} : { screenShare }),
      }).catch((x: unknown) => x);
      expect((err as SystemCheckError).kind).toBe('NO_SCREEN_SHARE');
      expect(fetchFn).not.toHaveBeenCalled();
    }
  });

  it('the whole flow before start: request, system check, then the started monitor adopts the stream (asked once)', async () => {
    const st = stream('monitor');
    const getDisplayMedia = vi.fn(() => Promise.resolve(st.value));
    const media = { getDisplayMedia } as unknown as Pick<MediaDevices, 'getDisplayMedia'>;
    const consent = vi.fn();
    const outcome = await requestScreenShare(consent, media);
    expect(consent).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ ok: true, surface: 'monitor' });
    expect(surfaceOf(outcome)).toBe('MONITOR');
    let sentBody: { devices: { screenShare: string } } | undefined;
    const result = await runSystemCheck({
      baseUrl: 'https://api.test',
      getToken: () => TOKEN,
      screenShare: surfaceOf(outcome),
      env: env(),
      fetchFn: ((_u: string, init: RequestInit) => {
        sentBody = JSON.parse(init.body as string) as typeof sentBody;
        return Promise.resolve(reply(200, { passed: true, blocking: [] }));
      }) as unknown as typeof fetch,
    });
    expect(result.passed).toBe(true);
    expect(sentBody?.devices.screenShare).toBe('MONITOR');
    // After start the monitor takes the same stream over: no second getDisplayMedia.
    const monitor = new ScreenShareMonitor(media);
    const locks: boolean[] = [];
    monitor.start({
      emit: () => undefined,
      root: document.body,
      setCapability: () => undefined,
      setLock: (l) => locks.push(l.locked),
      assertConsent: () => undefined,
      measure: (_l, fn) => fn(),
      isDisabled: () => false,
    });
    expect(monitor.adopt(outcome)).toMatchObject({ ok: true });
    expect(monitor.currentStream).toBe(st.value);
    expect(locks).toEqual([true, false]);
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  it('requestScreenShare: consent first, wrong surface stopped, null surface reported honestly, denial is not a surface', async () => {
    const getDisplayMedia = vi.fn();
    const media = { getDisplayMedia } as unknown as Pick<MediaDevices, 'getDisplayMedia'>;
    await expect(
      requestScreenShare(() => {
        throw new Error('consent');
      }, media),
    ).rejects.toThrow('consent');
    expect(getDisplayMedia).not.toHaveBeenCalled();

    const win = stream('window');
    getDisplayMedia.mockResolvedValueOnce(win.value);
    const wrong = await requestScreenShare(() => undefined, media);
    expect(wrong).toEqual({ ok: false, reason: 'WRONG_SURFACE' });
    expect(win.stops).toHaveLength(1);
    expect(surfaceOf(wrong)).toBe('OTHER');

    getDisplayMedia.mockResolvedValueOnce(stream().value);
    const unreported = await requestScreenShare(() => undefined, media);
    expect(unreported).toMatchObject({ ok: true, surface: null });
    expect(surfaceOf(unreported)).toBe('UNVERIFIABLE');

    getDisplayMedia.mockRejectedValueOnce(new Error('denied'));
    const denied = await requestScreenShare(() => undefined, media);
    expect(denied).toEqual({ ok: false, reason: 'DENIED' });
    expect(surfaceOf(denied)).toBeNull(); // no share: runSystemCheck refuses (NO_SCREEN_SHARE)
    expect(await requestScreenShare(() => undefined, undefined)).toEqual({
      ok: false,
      reason: 'UNSUPPORTED',
    });
  });

  it('adopt() on a monitor that is not started stops the stream (no device kept)', () => {
    const st = stream('monitor');
    const monitor = new ScreenShareMonitor({ getDisplayMedia: vi.fn() });
    expect(monitor.adopt({ ok: true, stream: st.value, surface: 'monitor' })).toEqual({
      ok: false,
      reason: 'UNSUPPORTED',
    });
    expect(st.stops).toHaveLength(1);
  });

  it('synchronous throws and a missing window never escape and never pass', async () => {
    const e = env();
    const boom = () => {
      throw new Error('sync');
    };
    (e.navigator as { permissions: object; mediaDevices: object }).permissions = { query: boom };
    (e.navigator as { mediaDevices: object }).mediaDevices = { enumerateDevices: boom };
    e.window = { screen: { isExtended: false }, getScreenDetails: boom };
    const body = await collectSystemCheck({ env: e });
    const by = (id: string) => body.capabilities.find((c) => c.id === id)?.status;
    expect(by('virtual-camera')).toBe('UNVERIFIABLE');
    expect(by('camera-permission')).toBe('UNVERIFIABLE');
    expect(by('multi-screen')).toBe('SUPPORTED'); // fell back to screen.isExtended
    const noWin = await collectSystemCheck({ env: env({ window: undefined }) });
    expect(noWin.capabilities.find((c) => c.id === 'multi-screen')?.status).toBe('UNSUPPORTED');
    const nan = await collectSystemCheck({ env: env(), stepTimeoutMs: Number.NaN });
    expect(nan.capabilities.length).toBeGreaterThan(5);
  });
});
