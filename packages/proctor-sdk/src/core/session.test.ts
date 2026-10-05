import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { ClipboardMonitor } from '../monitors/clipboard';
import { DevtoolsMonitor } from '../monitors/devtools';
import { TEST_KEY_B64 } from '../test/helpers';
import type { SignedBatch } from './event-queue';
import { IdbStore } from './idb';
import { ProctorSession, type ProctorSessionConfig } from './session';
import { ConsentRequiredError } from './types';

function config(over: Partial<ProctorSessionConfig> = {}) {
  const sent: SignedBatch[] = [];
  const heartbeat = vi.fn(() => Promise.resolve(true));
  const root = document.createElement('div');
  document.body.append(root);
  const cfg: ProctorSessionConfig = {
    sessionId: 'sess',
    hmacKeyBase64: TEST_KEY_B64,
    root,
    consent: { recordedAt: '2026-01-01T00:00:00Z' },
    transport: {
      sendBatch: (b) => {
        sent.push(b);
        return Promise.resolve('OK');
      },
      heartbeat,
    },
    detectors: [new ClipboardMonitor()],
    store: new IdbStore(indexedDB, `sess-${Math.random()}`),
    flushIntervalMs: 20,
    ...over,
  };
  return { cfg, sent, heartbeat, root };
}

describe('ProctorSession', () => {
  it('D-17: refuses to start without recorded consent', async () => {
    const { cfg } = config({ consent: null });
    await expect(new ProctorSession().start(cfg)).rejects.toBeInstanceOf(ConsentRequiredError);
  });

  it('FR-603/FR-801: a blocked paste becomes a signed, sequenced batch', async () => {
    const { cfg, sent, root } = config();
    const s = new ProctorSession();
    const seen: string[] = [];
    s.on('event', (e) => seen.push(e.type));
    await s.start(cfg);
    root.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(seen).toEqual(['PASTE_ATTEMPT']);
    expect(sent[0]?.seq).toBe(0);
    expect(sent[0]?.signature).toMatch(/^[0-9a-f]{64}$/);
    await s.stop();
  });

  it('FR-609: sends a heartbeat at start and reports the metrics', async () => {
    const { cfg, heartbeat } = config();
    const s = new ProctorSession();
    await s.start(cfg);
    expect(heartbeat).toHaveBeenCalled();
    expect(s.getMetrics()?.mainThreadBusyPercent).toBeGreaterThanOrEqual(0);
    await s.stop();
  });

  it('FR-610/FR-106: a detector disabled by accommodation never starts', async () => {
    const devtools = new DevtoolsMonitor();
    const startSpy = vi.spyOn(devtools, 'start');
    const { cfg } = config({ detectors: [devtools], disabledDetectors: ['DEVTOOLS'] });
    const s = new ProctorSession();
    await s.start(cfg);
    expect(startSpy).not.toHaveBeenCalled();
    await s.stop();
  });

  it('FR-610: a detector that throws is reported as DETECTOR_UNAVAILABLE, not skipped silently', async () => {
    const devtools = new DevtoolsMonitor();
    vi.spyOn(devtools, 'start').mockImplementation(() => {
      throw new Error('boom');
    });
    const { cfg } = config({ detectors: [devtools] });
    const s = new ProctorSession();
    const seen: string[] = [];
    s.on('event', (e) => seen.push(e.type));
    await s.start(cfg);
    expect(seen).toEqual(['DETECTOR_UNAVAILABLE']);
    await s.stop();
  });

  it('FR-601: a locking monitor notifies the UI once per change', async () => {
    const { cfg } = config();
    const s = new ProctorSession();
    const locks: boolean[] = [];
    s.on('lock', (l) => locks.push(l.locked));
    await s.start({
      ...cfg,
      detectors: [
        {
          id: 'x',
          start: (ctx) => {
            ctx.setLock({ reason: 'FULLSCREEN', locked: true });
            ctx.setLock({ reason: 'FULLSCREEN', locked: true });
            ctx.setLock({ reason: 'FULLSCREEN', locked: false });
          },
          stop: () => undefined,
        },
      ],
    });
    expect(locks).toEqual([true, false]);
    await s.stop();
  });
});
