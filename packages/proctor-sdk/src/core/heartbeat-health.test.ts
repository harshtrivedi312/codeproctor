import 'fake-indexeddb/auto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_KEY_B64 } from '../test/helpers';
import type { SendResult } from './batch-queue';
import {
  FLAG_DETAIL_MAX,
  FLAG_ID_RE,
  FLAG_RESEND_MS,
  FlagReporter,
  MAX_HEARTBEAT_FLAGS,
  cutDetail,
  sanitizeRecorder,
  type HeartbeatBody,
} from './health';
import { IdbStore } from './idb';
import { ProctorSession, type ProctorSessionConfig } from './session';
import { createFetchTransport, parseHeartbeatAnswer, type HeartbeatResult } from './transport';
import { Heartbeat } from './heartbeat';
import { STORES } from './idb';
import type { CapabilityFlag } from './types';

/**
 * Heartbeat health (ADR 0013 section 5.3, 5.8; FR-609, TC-063, TC-065, NFR-04): changed-only flags
 * with a 5-minute resend, recorder and queue blocks, token renewal, 401 handling, probe,
 * capability id conformity. Counts and reasons only: never content, tokens or keys.
 */
const TOKEN = 'renewed-token-SECRET';
let db = 0;
afterEach(() => vi.restoreAllMocks());

const flag = (id: string, status: CapabilityFlag['status'] = 'UNVERIFIABLE', detail?: string) =>
  ({ id, status, ...(detail === undefined ? {} : { detail }) }) satisfies CapabilityFlag;

describe('FlagReporter (changed flags, 5-minute resend, 32 at most)', () => {
  it('sends a flag once, again only when it changed, and everything every 5 minutes', () => {
    const r = new FlagReporter();
    r.record(flag('a-flag'));
    r.record(flag('b-flag', 'SUPPORTED'));
    const t0 = 1_000_000;
    const first = r.take(t0);
    expect(first.flags.map((f) => f.id).sort()).toEqual(['a-flag', 'b-flag']);
    first.commit();
    expect(r.take(t0 + 10_000).flags).toEqual([]); // nothing changed
    r.record(flag('a-flag', 'UNSUPPORTED', 'now worse'));
    const changed = r.take(t0 + 20_000);
    expect(changed.flags).toEqual([flag('a-flag', 'UNSUPPORTED', 'now worse')]);
    changed.commit();
    const resend = r.take(t0 + FLAG_RESEND_MS + 1);
    expect(resend.flags.map((f) => f.id).sort()).toEqual(['a-flag', 'b-flag']);
  });

  it('a beat that was not acknowledged does not mark flags as sent', () => {
    const r = new FlagReporter();
    r.record(flag('a-flag'));
    r.take(1); // not committed: the beat failed
    expect(r.take(2).flags).toHaveLength(1);
  });

  it('a flag that changes while the beat is in flight stays pending', () => {
    const r = new FlagReporter();
    r.record(flag('a-flag'));
    const t = r.take(1);
    r.record(flag('a-flag', 'UNSUPPORTED'));
    t.commit();
    expect(r.take(2).flags).toEqual([flag('a-flag', 'UNSUPPORTED')]);
  });

  it('sends at most 32, worst first, and keeps the rest for the next beat', () => {
    const r = new FlagReporter();
    for (let i = 0; i < 40; i++) r.record(flag(`ok-${String(i).padStart(2, '0')}`, 'SUPPORTED'));
    r.record(flag('bad-one', 'UNSUPPORTED'));
    const t = r.take(1);
    expect(t.flags).toHaveLength(MAX_HEARTBEAT_FLAGS);
    expect(t.flags[0]?.id).toBe('bad-one');
    t.commit();
    expect(r.take(2).flags.length).toBe(9);
  });

  it('what is sent always conforms: invalid ids are not sent, details are cut to 128', () => {
    const r = new FlagReporter();
    r.record(flag('Bad_ID'));
    r.record(flag('x'));
    r.record(flag('long-detail', 'UNVERIFIABLE', 'd'.repeat(500)));
    const sent = r.take(1).flags;
    expect(sent.map((f) => f.id)).toEqual(['long-detail']);
    expect(sent[0]?.detail?.length).toBe(FLAG_DETAIL_MAX);
  });
});

describe('transport heartbeat (body, answer, 401)', () => {
  const tr = (respond: () => Response, seen?: { body?: string; token?: string }) =>
    createFetchTransport({
      baseUrl: 'https://api.test',
      getToken: () => 'tok',
      fetchFn: ((_u: string, init: RequestInit) => {
        if (seen) {
          seen.body = typeof init.body === 'string' ? init.body : undefined;
          seen.token = (init.headers as Record<string, string>)['Authorization'];
        }
        return Promise.resolve(respond());
      }) as unknown as typeof fetch,
    });

  it('sends the body as JSON and parses state and a renewed token', async () => {
    const seen: { body?: string } = {};
    const body: HeartbeatBody = {
      capabilities: [flag('a-flag')],
      queue: { pendingEventBatches: 1, pendingKeystrokeBatches: 0, rejectedBatches: 2 },
    };
    const r = await tr(
      () =>
        new Response(
          JSON.stringify({
            status: 'IN_PROGRESS',
            serverTime: '2026-01-01T00:00:00Z',
            deadlineAt: '2026-01-01T01:00:00Z',
            sectionDeadlineAt: null,
            pauseReasons: [],
            sessionToken: TOKEN,
            sessionTokenExpiresAt: '2026-01-01T00:15:00Z',
          }),
          { status: 200 },
        ),
      seen,
    ).heartbeat(body);
    expect(JSON.parse(seen.body ?? '{}')).toEqual(body);
    expect(r).toMatchObject({
      ok: true,
      state: { status: 'IN_PROGRESS', pauseReasons: [] },
      renewal: { sessionToken: TOKEN, sessionTokenExpiresAt: '2026-01-01T00:15:00Z' },
    });
  });

  it('no body for a plain beat; an empty or odd 200 is just true; 401 is auth, not offline', async () => {
    const seen: { body?: string } = {};
    expect(await tr(() => new Response('', { status: 200 }), seen).heartbeat()).toBe(true);
    expect(seen.body).toBeUndefined();
    expect(parseHeartbeatAnswer('not json')).toEqual({});
    expect(parseHeartbeatAnswer('{"sessionToken":""}')).toEqual({});
    expect(
      await tr(() => new Response('{"code":"TOKEN_EXPIRED"}', { status: 401 })).heartbeat(),
    ).toEqual({ auth: 'TOKEN_EXPIRED' });
    expect(await tr(() => new Response('{}', { status: 503 })).heartbeat()).toBe(false);
  });
});

function rig(
  over: Partial<ProctorSessionConfig> = {},
  beat?: (b: HeartbeatBody | undefined) => HeartbeatResult,
) {
  const bodies: (HeartbeatBody | undefined)[] = [];
  const cfg: ProctorSessionConfig = {
    sessionId: 'sess',
    hmacKeyBase64: TEST_KEY_B64,
    root: document.createElement('div'),
    consent: { recordedAt: '2026-01-01T00:00:00Z' },
    transport: {
      sendBatch: () => Promise.resolve<SendResult>('RETRY'),
      sendKeystrokeBatch: () => Promise.resolve<SendResult>('RETRY'),
      heartbeat: (b) => {
        bodies.push(b);
        return Promise.resolve(beat ? beat(b) : true);
      },
    },
    detectors: [],
    store: new IdbStore(indexedDB, `hb-${++db}`),
    heartbeatIntervalMs: 20,
    backoffBaseMs: 600_000,
    ...over,
  };
  return { cfg, bodies };
}

describe('session heartbeat body and answers (FR-609, TC-063)', () => {
  it('carries a flag once after it changed, the recorder block from getHealth, and queue counts', async () => {
    const recorder = {
      streams: [
        {
          stream: 'WEBCAM',
          segment: 1,
          lastSeq: 7,
          bufferedChunks: 2,
          bufferedBytes: 2048,
          droppedChunks: 0,
          droppedBytes: 0,
        },
      ],
      seqConflicts: 0,
    };
    const r = rig({ getHealth: () => ({ recorder }) });
    const s = new ProctorSession();
    await s.start(r.cfg);
    await vi.waitFor(() => expect(r.bodies.length).toBeGreaterThan(1), { timeout: 3000 });
    s.reportCapability(flag('record-webcam', 'DENIED', 'permission denied'));
    const n = r.bodies.length;
    await vi.waitFor(() => expect(r.bodies.length).toBeGreaterThan(n + 2), { timeout: 3000 });
    const withFlag = r.bodies.filter((b) => b?.capabilities?.some((f) => f.id === 'record-webcam'));
    expect(withFlag).toHaveLength(1); // once, not every beat
    const last = r.bodies[r.bodies.length - 1];
    expect(last?.recorder).toEqual(recorder);
    expect(last?.queue).toEqual({
      pendingEventBatches: 0,
      pendingKeystrokeBatches: 0,
      rejectedBatches: 0,
    });
    await s.stop();
  });

  it('a flag whose beat failed is sent again; everything is resent after 5 minutes', async () => {
    let ok = false;
    const r = rig({}, () => ok);
    const s = new ProctorSession();
    await s.start(r.cfg);
    s.reportCapability(flag('record-audio', 'UNSUPPORTED'));
    await vi.waitFor(() => expect(r.bodies.length).toBeGreaterThan(2), { timeout: 3000 });
    expect(r.bodies.filter((b) => b?.capabilities?.length).length).toBeGreaterThan(1); // resent while failing
    ok = true;
    await vi.waitFor(() => expect(r.bodies.slice(-1)[0]?.capabilities).toBeUndefined(), {
      timeout: 3000,
    });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + FLAG_RESEND_MS + 1000);
    const n = r.bodies.length;
    await vi.waitFor(
      () =>
        expect(
          r.bodies.slice(n).some((b) => b?.capabilities?.some((f) => f.id === 'record-audio')),
        ).toBe(true),
      { timeout: 3000 },
    );
    await s.stop();
  });

  it('a renewed token goes to onToken and nowhere else; the state goes to onHeartbeat', async () => {
    const tokens: string[] = [];
    const states: string[] = [];
    const seen: string[] = [];
    const r = rig(
      { onToken: (t) => tokens.push(t.sessionToken), onHeartbeat: (st) => states.push(st.status) },
      () => ({
        ok: true,
        state: { status: 'PAUSED' },
        renewal: { sessionToken: TOKEN, sessionTokenExpiresAt: '2026-01-01T00:15:00Z' },
      }),
    );
    const s = new ProctorSession();
    s.on('capability', (f) => seen.push(JSON.stringify(f)));
    s.on('ended', (e) => seen.push(JSON.stringify(e)));
    await s.start(r.cfg);
    await vi.waitFor(() => expect(tokens.length).toBeGreaterThan(0), { timeout: 3000 });
    expect(tokens[0]).toBe(TOKEN);
    expect(states[0]).toBe('PAUSED');
    expect(seen.join(' ')).not.toContain(TOKEN);
    expect(JSON.stringify(s.getCapabilities())).not.toContain(TOKEN);
    expect(JSON.stringify(r.bodies)).not.toContain(TOKEN);
    await s.stop();
  });

  it('3 consecutive 401: the heartbeat stops, onReauthRequired once; resume() beats again', async () => {
    let auth = true;
    const reasons: string[] = [];
    const r = rig({ onReauthRequired: (x) => reasons.push(x), authLostAfter: 3 }, () =>
      auth ? { auth: 'TOKEN_EXPIRED' } : true,
    );
    const s = new ProctorSession();
    const online: boolean[] = [];
    s.on('connection', (c) => online.push(c.online));
    await s.start(r.cfg);
    await vi.waitFor(() => expect(reasons).toEqual(['TOKEN_EXPIRED']), { timeout: 3000 });
    const n = r.bodies.length;
    await new Promise((x) => setTimeout(x, 100));
    expect(r.bodies.length).toBe(n); // stopped
    expect(online).toEqual([]); // reachable: never reported as offline
    auth = false;
    s.resume();
    await vi.waitFor(() => expect(r.bodies.length).toBeGreaterThan(n), { timeout: 3000 });
    await s.stop();
  });

  it('probe() answers true at once after a fresh acknowledged beat and beats now when offline', async () => {
    let up = true;
    const r = rig({ heartbeatIntervalMs: 60_000 }, () => up);
    const s = new ProctorSession();
    await s.start(r.cfg);
    await vi.waitFor(() => expect(r.bodies.length).toBe(1));
    expect(await s.probe()).toBe(true);
    expect(r.bodies.length).toBe(1); // no extra request
    up = false;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000); // the last ack is old
    expect(await s.probe()).toBe(false);
    expect(r.bodies.length).toBe(2);
    await s.stop();
  });
});

describe('capability id conformity (ADR 0013 sections 2, 5.8)', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return files(p);
      return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
    });

  it('every flag id literal in the SDK matches ^[a-z][a-z0-9-]{1,47}$ and the hub names exist', () => {
    const ids = new Set<string>();
    for (const f of files(join(__dirname, '..'))) {
      const src = readFileSync(f, 'utf8');
      // 'x', "x" and `x` literals; a template with a hole is expanded for the known vision tasks.
      for (const m of src.matchAll(/\bid:\s*(['"`])([^'"`]+)\1/g)) {
        const id = m[2] as string;
        if (id.includes('${')) {
          if (id === 'vision-${task}' || id === 'vision-${t}') {
            for (const t of ['face', 'gaze', 'objects']) ids.add(`vision-${t}`);
          } else if (id === 'record-${stream.toLowerCase()}') {
            for (const t of ['screen', 'webcam', 'audio']) ids.add(`record-${t}`);
          } else {
            throw new Error(`unexpanded template id: ${id}`);
          }
        } else {
          ids.add(id);
        }
      }
      for (const m of src.matchAll(/readonly id\s*=\s*(['"`])([^'"`]+)\1/g))
        ids.add(m[2] as string);
    }
    expect(ids.size).toBeGreaterThan(20);
    for (const id of ids) expect(id, id).toMatch(FLAG_ID_RE);
    for (const hub of [
      'keystroke-unrepresentable',
      'keystroke-rejected',
      'keystroke-seq-reset',
      'idb',
    ]) {
      expect(ids.has(hub), hub).toBe(true);
    }
    // The renamed ones are gone.
    for (const old of ['event-storage', 'keystroke-storage', 'keystroke-seq']) {
      expect(ids.has(old), old).toBe(false);
    }
  });

  it('IndexedDB parts fold into ONE idb flag: UNSUPPORTED beats UNVERIFIABLE, recovery needs all parts', async () => {
    const s = new ProctorSession();
    const seen: string[] = [];
    s.on('capability', (f) => {
      if (f.id === 'idb') seen.push(`${f.status}:${f.detail ?? ''}`);
    });
    const r = rig();
    await s.start(r.cfg);
    s.reportCapability({ id: 'recording-storage', status: 'UNVERIFIABLE' });
    s.reportCapability({ id: 'recording-storage', status: 'UNSUPPORTED' });
    s.reportCapability({ id: 'recording-storage', status: 'SUPPORTED' });
    expect(seen.map((x) => x.split(':')[0])).toEqual(['UNVERIFIABLE', 'UNSUPPORTED', 'SUPPORTED']);
    for (const x of seen) expect(x.length).toBeLessThan(160);
    await s.stop();
  });
});

describe('probe, timeouts, rejected bodies (FR-609, TC-063)', () => {
  it('TC-063: after ended (heartbeat 409) and after stop() the probe answers false and sends nothing', async () => {
    let ended = false;
    const r = rig({ heartbeatIntervalMs: 20 }, () =>
      ended ? { ended: 'SESSION_NOT_ACTIVE' } : true,
    );
    const s = new ProctorSession();
    const ev: string[] = [];
    s.on('ended', (e) => ev.push(e.reason));
    await s.start(r.cfg);
    await vi.waitFor(() => expect(r.bodies.length).toBeGreaterThan(1));
    ended = true;
    await vi.waitFor(() => expect(ev).toEqual(['SESSION_NOT_ACTIVE']), { timeout: 3000 });
    const n = r.bodies.length;
    expect(await s.probe()).toBe(false);
    await new Promise((x) => setTimeout(x, 60));
    expect(r.bodies.length).toBe(n); // the probe sent no beat with a refused token

    const r2 = rig({ heartbeatIntervalMs: 60_000 });
    const s2 = new ProctorSession();
    await s2.start(r2.cfg);
    await vi.waitFor(() => expect(r2.bodies.length).toBe(1));
    await s2.stop();
    expect(await s2.probe()).toBe(false);
    expect(r2.bodies.length).toBe(1);
  });

  it('a probe during the 401 hold does not bypass it', async () => {
    const r = rig(
      { authLostAfter: 1, onReauthRequired: () => undefined, heartbeatIntervalMs: 60_000 },
      () => ({
        auth: 'TOKEN_EXPIRED',
      }),
    );
    const s = new ProctorSession();
    await s.start(r.cfg);
    await vi.waitFor(() => expect(r.bodies.length).toBe(1));
    expect(await s.probe()).toBe(false);
    expect(r.bodies.length).toBe(1);
    await s.stop();
  });

  it('a transport that never settles does not block later beats (heartbeat-level timeout)', async () => {
    let calls = 0;
    const hb = new Heartbeat(
      () => (++calls === 1 ? new Promise<HeartbeatResult>(() => undefined) : Promise.resolve(true)),
      100,
    );
    hb.start();
    await vi.waitFor(() => expect(hb.online).toBe(true), { timeout: 3000 });
    expect(calls).toBeGreaterThan(1);
    hb.stop();
  });

  it('429 is reachable (online), nothing is acknowledged and the flags stay pending', async () => {
    const h = new Heartbeat(() => Promise.resolve({ busy: true }), 60_000);
    const changes: boolean[] = [];
    const h2 = new Heartbeat(
      () => Promise.reject(new Error('x')),
      60_000,
      (o) => changes.push(o),
    );
    h2.start();
    await vi.waitFor(() => expect(changes).toEqual([false]));
    h2.stop();
    expect(await h.beatNow()).toBe(true);
    h.stop();
  });

  it('400/413 on the body: one more beat without it, last_heartbeat stays fresh, flagged once, flags marked sent', async () => {
    const bodies: (string | undefined)[] = [];
    const t = createFetchTransport({
      baseUrl: 'https://api.test',
      getToken: () => 'tok',
      fetchFn: ((_u: string, init: RequestInit) => {
        bodies.push(typeof init.body === 'string' ? init.body : undefined);
        return Promise.resolve(
          typeof init.body === 'string'
            ? new Response('{"code":"BODY_TOO_LARGE"}', { status: 413 })
            : new Response('{"status":"IN_PROGRESS"}', { status: 200 }),
        );
      }) as unknown as typeof fetch,
    });
    const r = await t.heartbeat({
      queue: { pendingEventBatches: 0, pendingKeystrokeBatches: 0, rejectedBatches: 0 },
    });
    expect(r).toMatchObject({ ok: true, bodyRejected: true, state: { status: 'IN_PROGRESS' } });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBeUndefined();

    // session level
    const flags: string[] = [];
    const rr = rig({ heartbeatIntervalMs: 20 }, () => ({ ok: true, bodyRejected: true }));
    const s = new ProctorSession();
    s.on('capability', (f) => flags.push(f.id));
    await s.start(rr.cfg);
    s.reportCapability(flag('record-audio', 'UNSUPPORTED'));
    await vi.waitFor(() => expect(rr.bodies.length).toBeGreaterThan(4), { timeout: 3000 });
    expect(flags.filter((f) => f === 'heartbeat-body-rejected')).toHaveLength(1);
    await s.stop();
  });

  it('resyncCapabilities arms a full resend', () => {
    expect(parseHeartbeatAnswer('{"status":"PAUSED","resyncCapabilities":true}')).toMatchObject({
      resync: true,
    });
    const r = new FlagReporter();
    r.record(flag('a-flag'));
    r.take(1).commit();
    expect(r.take(2).flags).toEqual([]);
    r.forceFull();
    expect(r.take(3).flags.map((f) => f.id)).toEqual(['a-flag']);
  });
});

describe('what the body may carry (counts only)', () => {
  it('sanitizeRecorder keeps known numeric fields and drops everything else', () => {
    const dirty = {
      streams: [
        {
          stream: 'WEBCAM',
          segment: 1,
          lastSeq: 2,
          bufferedChunks: 3,
          bufferedBytes: 4,
          droppedChunks: 5,
          droppedBytes: 6,
          url: 'https://store.invalid/secret',
          key: 'abc',
        },
        {
          stream: 'https://evil',
          segment: 0,
          lastSeq: 0,
          bufferedChunks: 0,
          bufferedBytes: 0,
          droppedChunks: 0,
          droppedBytes: 0,
        },
        {
          stream: 'AUDIO',
          segment: -1,
          lastSeq: 0,
          bufferedChunks: 0,
          bufferedBytes: 0,
          droppedChunks: 0,
          droppedBytes: 0,
        },
        {
          stream: 'SCREEN',
          segment: 1.5,
          lastSeq: 0,
          bufferedChunks: 0,
          bufferedBytes: 0,
          droppedChunks: 0,
          droppedBytes: 0,
        },
      ],
      seqConflicts: 2,
      heldStreams: 'two',
      note: 'editor text here',
    };
    expect(sanitizeRecorder(dirty)).toEqual({
      streams: [
        {
          stream: 'WEBCAM',
          segment: 1,
          lastSeq: 2,
          bufferedChunks: 3,
          bufferedBytes: 4,
          droppedChunks: 5,
          droppedBytes: 6,
        },
      ],
      seqConflicts: 2,
    });
    expect(sanitizeRecorder('nope')).toBeUndefined();
  });

  it('flags: worst first (DENIED counts as worst), invalid ids do not use the 32 slots, details cut on code points', () => {
    const r = new FlagReporter();
    for (let i = 0; i < 32; i++) r.record(flag(`BAD_${String(i)}`));
    r.record(flag('fine-ok', 'SUPPORTED'));
    r.record(flag('denied-one', 'DENIED'));
    r.record(flag('unver-one', 'UNVERIFIABLE'));
    r.record(flag('emoji', 'UNVERIFIABLE', '😀'.repeat(200)));
    const sent = r.take(1).flags;
    expect(sent.map((f) => f.id)).toEqual(['denied-one', 'unver-one', 'emoji', 'fine-ok']);
    expect(Array.from(sent[2]?.detail ?? '').length).toBe(128);
    expect(cutDetail('a😀b', 2)).toBe('a😀');
  });

  it('reportCapability ignores ids the SDK owns (no forged idb or signing-key)', async () => {
    const r = rig();
    const s = new ProctorSession();
    const seen: string[] = [];
    await s.start(r.cfg);
    s.on('capability', (f) => seen.push(`${f.id}:${f.status}`));
    s.reportCapability({ id: 'idb', status: 'SUPPORTED' });
    s.reportCapability({ id: 'signing-key', status: 'SUPPORTED' });
    s.reportCapability({ id: 'record-webcam', status: 'DENIED' });
    expect(seen).toEqual(['record-webcam:DENIED']);
    await s.stop();
  });

  it('a renewed token is nowhere: not in flags, bodies, IndexedDB or localStorage', async () => {
    const r = rig({ heartbeatIntervalMs: 20 }, () => ({
      ok: true,
      renewal: { sessionToken: TOKEN, sessionTokenExpiresAt: '2026-01-01T00:15:00Z' },
    }));
    const s = new ProctorSession();
    await s.start(r.cfg);
    await vi.waitFor(() => expect(r.bodies.length).toBeGreaterThan(2));
    await s.stop();
    const store = r.cfg.store as IdbStore;
    const all: unknown[] = [];
    for (const name of [STORES.meta, STORES.eventBatches, STORES.chunks]) {
      all.push(await store.entries(name, ''));
    }
    expect(JSON.stringify(all)).not.toContain(TOKEN);
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain(TOKEN);
    expect(JSON.stringify(r.bodies)).not.toContain(TOKEN);
  });
});
