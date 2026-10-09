import 'fake-indexeddb/auto';
import { createHmac } from 'node:crypto';
import {
  MAX_KEYSTROKE_BATCH_BODY_BYTES,
  MAX_KEYSTROKE_EVENTS_PER_BATCH,
  MAX_SOURCE_CODE_LENGTH,
  keystrokeBatchSchema,
  type KeystrokeBatch,
} from '@codeproctor/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hmacOf,
  sameBytes,
  SIGNATURE_FORMAT,
} from '../../../../apps/api/src/proctor-events/signature';
import type { SendResult, SignedBatch } from '../core/event-queue';
import { EventQueue } from '../core/event-queue';
import { importSessionKey } from '../core/hmac';
import { IdbStore } from '../core/idb';
import { ProctorSession, type ProctorSessionConfig } from '../core/session';
import { createFetchTransport } from '../core/transport';
import { TEST_KEY_B64 } from '../test/helpers';
import { KeystrokeQueue } from './keystroke-queue';
import { KeystrokeRecorder, editsFromMonaco, type UnrepresentableReason } from './recorder';

/**
 * Keystroke (editor change) recording: FR-608, FR-802, TC-062 (replay reproduces the final code),
 * TC-065 (signing and sequence), NFR-05 (no key codes, no logged text), NFR-08 (no loss).
 */
const KEY = Buffer.from(TEST_KEY_B64, 'base64');
const Q1 = '8f14e45f-ceea-467a-9575-1b2a7c3d4e5f';
const Q2 = '9a1de644-815e-4e4b-8b0d-8f1c1b2d3e4a';
let n = 0;
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** What the API does with a received batch: signature over the raw bytes, strict UTF-8, schema. */
function apiAccepts(b: SignedBatch): KeystrokeBatch {
  expect(SIGNATURE_FORMAT.test(b.signature)).toBe(true);
  const raw = Buffer.from(b.body, 'utf8');
  expect(sameBytes(Buffer.from(b.signature, 'hex'), hmacOf(KEY, raw))).toBe(true);
  expect(raw.byteLength).toBeLessThanOrEqual(MAX_KEYSTROKE_BATCH_BODY_BYTES);
  const parsed = keystrokeBatchSchema.safeParse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)),
  );
  expect(parsed.success, 'keystroke batch passes the shared schema').toBe(true);
  return parsed.data as KeystrokeBatch;
}

/** Replay as the review page does: batches ordered by seq (not arrival), RESET and EDIT applied. */
function replay(batches: KeystrokeBatch[]): Map<string, string> {
  const text = new Map<string, string>();
  for (const b of [...batches].sort((x, y) => x.seq - y.seq)) {
    let t = text.get(b.sessionQuestionId) ?? '';
    for (const e of b.events) {
      if (e.kind === 'RESET') t = e.text;
      else if (e.kind === 'EDIT')
        t = t.slice(0, e.offset) + e.text + t.slice(e.offset + e.deleteLength);
    }
    text.set(b.sessionQuestionId, t);
  }
  return text;
}

async function rig(opts: { outcome?: SendResult; store?: IdbStore; clock?: { t: number } } = {}) {
  const store = opts.store ?? new IdbStore(indexedDB, `ks-${++n}`);
  const sent: SignedBatch[] = [];
  const attempted: SignedBatch[] = [];
  const clock = opts.clock ?? { t: 1_800_000_000_000 };
  const queue = new KeystrokeQueue({
    sessionId: 's',
    key: await importSessionKey(TEST_KEY_B64),
    store,
    jitter: 0,
    backoffBaseMs: 60_000,
    transport: {
      sendBatch: (b) => {
        attempted.push(b);
        if ((opts.outcome ?? 'OK') === 'OK') sent.push(b);
        return Promise.resolve(opts.outcome ?? 'OK');
      },
    },
  });
  await queue.start();
  const reasons: UnrepresentableReason[] = [];
  const recorder = new KeystrokeRecorder(
    queue,
    () => clock.t,
    (r) => reasons.push(r),
  );
  return { store, sent, attempted, queue, recorder, clock, reasons };
}

/** A tiny editor model that emits Monaco-shaped change events. */
class Model {
  constructor(public text = '') {}
  /** Apply several disjoint replacements as ONE event; offsets are against the text BEFORE it. */
  applyEvent(edits: { offset: number; length: number; text: string }[]) {
    const changes = edits.map((e) => ({
      rangeOffset: e.offset,
      rangeLength: e.length,
      text: e.text,
    }));
    let t = this.text;
    for (const e of [...edits].sort((a, b) => b.offset - a.offset)) {
      t = t.slice(0, e.offset) + e.text + t.slice(e.offset + e.length);
    }
    this.text = t;
    return changes;
  }
}

describe('replay reproduces the final code (TC-062, FR-608)', () => {
  it('TC-062 FR-608: random typing, deleting, replacing and multi-cursor events replay to the exact final text, also when batches arrive out of order', async () => {
    const r = await rig();
    const model = new Model('def solve():\n    pass\n');
    r.recorder.reset(Q1, 'python', model.text);
    let seed = 7;
    let multi = 0;
    const rnd = (m: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed >>> 8) % m; // the low bits of an LCG are not random
    };
    for (let i = 0; i < 400; i++) {
      r.clock.t += 40 + rnd(200);
      const len = model.text.length;
      const kind = rnd(4);
      let edits: { offset: number; length: number; text: string }[];
      if (kind === 0 && len > 3) {
        const o = rnd(len - 1);
        edits = [{ offset: o, length: 1 + rnd(Math.min(3, len - o - 1)), text: '' }];
      } else if (kind === 1) {
        const o = rnd(len + 1);
        edits = [{ offset: o, length: 0, text: 'x\n é😀'.slice(0, 1 + rnd(5)) }];
      } else if (kind === 2 && len > 10) {
        // multi-cursor: three disjoint insertions in one event
        multi++;
        const third = Math.floor(len / 3);
        const a = rnd(third);
        const b = third + rnd(third);
        const c = 2 * third + rnd(third);
        edits = [a, b, Math.min(c, len)].map((offset) => ({ offset, length: 0, text: '#' }));
      } else {
        const o = rnd(len + 1);
        edits = [{ offset: o, length: Math.min(2, len - o), text: 'ab' }];
      }
      r.recorder.recordChanges(editsFromMonaco(model.applyEvent(edits)));
      if (i % 25 === 0) r.recorder.recordCursor(rnd(model.text.length + 1));
      if (i % 90 === 0) await r.queue.flush();
    }
    await r.queue.flush();
    expect(multi).toBeGreaterThan(20); // the multi-cursor path really ran
    expect(r.recorder.stats().unrepresentable).toBe(0); // nothing was silently skipped
    expect(r.queue.stats().droppedInvalidItems).toBe(0);
    const batches = r.sent.map(apiAccepts);
    expect(batches.length).toBeGreaterThan(1);
    expect(replay(batches).get(Q1)).toBe(model.text);
    expect(replay([...batches].reverse()).get(Q1)).toBe(model.text); // arrival order does not matter
    expect(r.sent.map((b) => b.seq)).toEqual(batches.map((_b, i) => i)); // keystroke seq 0,1,2,...
  });

  it('TC-062 FR-608: editsFromMonaco orders changes from the highest offset down so sequential application is correct', () => {
    const m = new Model('0123456789');
    const changes = m.applyEvent([
      { offset: 1, length: 1, text: 'AAA' },
      { offset: 6, length: 2, text: '' },
      { offset: 9, length: 0, text: 'Z' },
    ]);
    const edits = editsFromMonaco(changes);
    expect(edits.map((e) => e.offset)).toEqual([9, 6, 1]);
    let t = '0123456789';
    for (const e of edits) t = t.slice(0, e.offset) + e.text + t.slice(e.offset + e.deleteLength);
    expect(t).toBe(m.text);
  });

  it('TC-062 FR-608: a reset (restore after reload, language switch) starts replay again from the new text', async () => {
    const r = await rig();
    r.recorder.reset(Q1, 'python', 'a = 1');
    r.recorder.recordChange({ offset: 5, deleteLength: 0, text: '0' });
    r.clock.t += 1000;
    r.recorder.reset(Q1, 'javascript', 'let a = 2;');
    r.recorder.recordChange({ offset: 10, deleteLength: 0, text: '!' });
    await r.queue.flush();
    expect(replay(r.sent.map(apiAccepts)).get(Q1)).toBe('let a = 2;!');
    const events = r.sent.flatMap((b) => apiAccepts(b).events);
    expect(
      events.filter((e) => e.kind === 'RESET').map((e) => (e.kind === 'RESET' ? e.language : '')),
    ).toEqual(['python', 'javascript']);
  });

  it('TC-062: each question has its own batches and its own replay; batches never mix questions', async () => {
    const r = await rig();
    r.recorder.reset(Q1, 'python', 'one');
    r.recorder.recordChange({ offset: 3, deleteLength: 0, text: '1' });
    r.clock.t += 500;
    r.recorder.reset(Q2, 'java', 'two');
    r.recorder.recordChange({ offset: 3, deleteLength: 0, text: '2' });
    r.clock.t += 500;
    r.recorder.reset(Q1, 'python', 'one1'); // back to question 1 (model reloaded)
    r.recorder.recordChange({ offset: 4, deleteLength: 0, text: '!' });
    await r.queue.flush();
    const batches = r.sent.map(apiAccepts);
    expect(batches.map((b) => b.sessionQuestionId)).toEqual([Q1, Q2, Q1]);
    expect(replay(batches).get(Q1)).toBe('one1!');
    expect(replay(batches).get(Q2)).toBe('two2');
  });
});

describe('signing and sequences (TC-065, NFR-04)', () => {
  it('TC-065: every keystroke batch passes the API verification path (HMAC over the raw bytes, strict UTF-8, shared schema)', async () => {
    const r = await rig();
    r.recorder.reset(Q1, 'python', 'é😀');
    r.recorder.recordChange({ offset: 3, deleteLength: 0, text: 'x' });
    await r.queue.flush();
    const [b] = r.sent;
    apiAccepts(b as SignedBatch);
    // independent signer, not the SDK's
    expect(
      createHmac('sha256', KEY)
        .update((b as SignedBatch).body)
        .digest('hex'),
    ).toBe((b as SignedBatch).signature);
  });

  it("TC-065: the keystroke sequence is separate from the event sequence, and neither queue loads, sends or deletes the other's batches", async () => {
    const store = new IdbStore(indexedDB, `ks-shared-${++n}`);
    const key = await importSessionKey(TEST_KEY_B64);
    const eventsSent: SignedBatch[] = [];
    const events = new EventQueue({
      sessionId: 's',
      key,
      store,
      transport: {
        sendBatch: (b) => {
          eventsSent.push(b);
          return Promise.resolve('RETRY');
        },
      },
      jitter: 0,
      backoffBaseMs: 60_000,
    });
    await events.start();
    const ks = await rig({ store, outcome: 'RETRY' });
    for (let i = 0; i < 3; i++) {
      events.enqueue({ type: 'RIGHT_CLICK', occurredAt: new Date().toISOString(), payload: {} });
      await events.flush();
      ks.recorder.reset(Q1, 'python', `v${i}`);
      await ks.queue.flush();
    }
    // both transports refuse, so each stream's head batch is retried; three batches were cut per stream
    expect(events.stats()).toMatchObject({ nextSeq: 3, unsentBatches: 3 });
    expect(ks.queue.stats()).toMatchObject({ nextSeq: 3, unsentBatches: 3 });
    expect(eventsSent.length).toBeGreaterThan(0);
    // a reloaded event queue sees only its own three batches
    const events2 = new EventQueue({
      sessionId: 's',
      key,
      store,
      transport: { sendBatch: () => Promise.resolve('RETRY') },
      jitter: 0,
      backoffBaseMs: 60_000,
    });
    await events2.start();
    expect(events2.stats().unsentBatches).toBe(3);
    // finishing the event queue leaves the keystroke batches alone, and vice versa
    await events2.finish(50);
    const left = await store.keys('eventBatches', 's:');
    expect(left.every((k) => k.startsWith('s:ks:'))).toBe(true);
    expect(left).toHaveLength(3);
    const ks2 = await rig({ store, outcome: 'RETRY' });
    expect(ks2.queue.stats().unsentBatches).toBe(3);
  });
});

describe('limits and splitting (TC-065, FR-608)', () => {
  it('FR-608: 2500 events are split into batches of at most 1000 events, each valid and in order', async () => {
    const r = await rig();
    r.recorder.reset(Q1, 'python', '');
    for (let i = 0; i < 2499; i++) {
      r.clock.t += 1;
      r.recorder.recordChange({ offset: i, deleteLength: 0, text: 'a' });
    }
    await r.queue.flush();
    const batches = r.sent.map(apiAccepts);
    expect(batches.every((b) => b.events.length <= MAX_KEYSTROKE_EVENTS_PER_BATCH)).toBe(true);
    expect(batches.length).toBeGreaterThanOrEqual(3);
    expect(replay(batches).get(Q1)).toBe('a'.repeat(2499));
  });

  it('FR-608: the worst case (a 100 000-character RESET of characters that escape to six bytes plus 100 000 characters of edits) stays under the body limit and the text caps', async () => {
    const r = await rig();
    const ctl = '\u0001'.repeat(MAX_SOURCE_CODE_LENGTH);
    r.recorder.reset(Q1, 'python', ctl);
    r.recorder.recordChange({ offset: 0, deleteLength: 0, text: ctl });
    r.recorder.recordChange({ offset: 0, deleteLength: 0, text: 'z' }); // pushes edit text over the cap: new batch
    await r.queue.flush();
    const batches = r.sent.map(apiAccepts);
    expect(batches.length).toBeGreaterThanOrEqual(2);
    for (const b of r.sent)
      expect(Buffer.byteLength(b.body)).toBeLessThan(MAX_KEYSTROKE_BATCH_BODY_BYTES);
    expect(replay(batches).get(Q1)).toBe('z' + ctl + ctl);
  });

  it('FR-608: a gap longer than ten minutes inside pending events starts a new batch (t stays within the schema bound)', async () => {
    const r = await rig();
    r.recorder.reset(Q1, 'python', 'a');
    r.clock.t += 11 * 60_000;
    r.recorder.recordChange({ offset: 1, deleteLength: 0, text: 'b' });
    await r.queue.flush();
    const batches = r.sent.map(apiAccepts);
    expect(batches).toHaveLength(2);
    expect(replay(batches).get(Q1)).toBe('ab');
  });

  it('FR-802: t is ms from the batch start, non-decreasing, even if the system clock steps back', async () => {
    const r = await rig();
    r.recorder.reset(Q1, 'python', '');
    r.clock.t += 500;
    r.recorder.recordChange({ offset: 0, deleteLength: 0, text: 'a' });
    r.clock.t -= 5000; // clock stepped back
    r.recorder.recordChange({ offset: 1, deleteLength: 0, text: 'b' });
    await r.queue.flush();
    const ts = r.sent.flatMap((b) => apiAccepts(b).events.map((e) => e.t));
    expect(ts).toEqual([0, 500, 500]);
  });

  it('FR-608: rapid consecutive cursor moves are coalesced; a cursor move after an edit is kept', async () => {
    const r = await rig();
    r.recorder.reset(Q1, 'python', 'abc');
    for (let i = 0; i < 5; i++) {
      r.clock.t += 20;
      r.recorder.recordCursor(i);
    }
    r.clock.t += 20;
    r.recorder.recordChange({ offset: 3, deleteLength: 0, text: 'd' });
    r.clock.t += 20;
    r.recorder.recordSelection(4, 1);
    await r.queue.flush();
    const events = r.sent.flatMap((b) => apiAccepts(b).events);
    expect(events.map((e) => e.kind)).toEqual(['RESET', 'CURSOR', 'EDIT', 'CURSOR']);
    expect(events[1]).toMatchObject({ kind: 'CURSOR', offset: 4 });
    expect(events[3]).toMatchObject({ kind: 'CURSOR', offset: 1, selectionLength: 3 });
  });
});

describe('what cannot be represented (ADR 0010, NFR-05)', () => {
  it('FR-608: a RESET over 100 000 characters is refused (the schema cannot carry it), later edits are skipped until a valid reset, and only reasons are reported', async () => {
    const r = await rig();
    const secret = 'SECRET_CODE_'.repeat(9000); // 108 000 characters
    expect(r.recorder.reset(Q1, 'python', secret)).toBe(false);
    r.recorder.recordChange({ offset: 0, deleteLength: 0, text: 'ignored' });
    expect(r.reasons).toEqual(['TEXT_TOO_LONG', 'TEXT_TOO_LONG']);
    await r.queue.flush();
    expect(r.sent).toHaveLength(0);
    expect(JSON.stringify(r.reasons)).not.toContain('SECRET');
    expect(r.recorder.reset(Q1, 'python', 'short')).toBe(true);
    r.recorder.recordChange({ offset: 5, deleteLength: 0, text: '!' });
    await r.queue.flush();
    expect(replay(r.sent.map(apiAccepts)).get(Q1)).toBe('short!');
  });

  it('FR-608: an edit whose offset is past the schema limit stops recording that question instead of sending an unreplayable edit', async () => {
    const r = await rig();
    r.recorder.reset(Q1, 'python', 'x');
    r.recorder.recordChange({ offset: MAX_SOURCE_CODE_LENGTH + 1, deleteLength: 0, text: 'y' });
    r.recorder.recordChange({ offset: 0, deleteLength: 0, text: 'z' }); // skipped: question overflowed
    await r.queue.flush();
    expect(r.reasons).toEqual(['OFFSET_TOO_LARGE', 'TEXT_TOO_LONG']);
    expect(r.sent.flatMap((b) => apiAccepts(b).events).map((e) => e.kind)).toEqual(['RESET']);
  });

  it('FR-608: no-op changes and edits before any reset are not recorded', async () => {
    const r = await rig();
    r.recorder.recordChange({ offset: 0, deleteLength: 0, text: 'a' });
    expect(r.reasons).toEqual(['NO_QUESTION']);
    r.recorder.reset(Q1, 'python', 'a');
    r.recorder.recordChange({ offset: 0, deleteLength: 0, text: '' });
    await r.queue.flush();
    expect(r.sent.flatMap((b) => apiAccepts(b).events)).toHaveLength(1);
  });

  it('NFR-05: invalid items (bad question id) are dropped and counted, never sent', async () => {
    const r = await rig();
    r.recorder.reset('not-a-uuid', 'python', 'secret');
    await r.queue.flush();
    expect(r.sent).toHaveLength(0);
    expect(r.queue.stats().droppedInvalidItems).toBe(1);
  });
});

describe('no editor text in logs or flags (NFR-05)', () => {
  it('NFR-05: nothing is written to the console while recording, failing or dropping, and the batch carries no key or modifier fields', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const r = await rig({ outcome: 'REJECTED' });
    r.recorder.reset(Q1, 'python', 'TOPSECRET');
    r.recorder.recordChange({ offset: 9, deleteLength: 0, text: 'MORESECRET' });
    r.recorder.recordChange({ offset: MAX_SOURCE_CODE_LENGTH + 5, deleteLength: 0, text: 'x' });
    await r.queue.flush();
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    const events = r.attempted.flatMap(
      (b) => (JSON.parse(b.body) as { events: Record<string, unknown>[] }).events,
    );
    const allowed = new Set([
      'kind',
      't',
      'language',
      'text',
      'offset',
      'deleteLength',
      'selectionLength',
    ]);
    for (const e of events) for (const k of Object.keys(e)) expect(allowed.has(k), k).toBe(true);
  });

  it('NFR-05: the session flags for keystroke trouble carry reasons only, never editor text', async () => {
    const s = new ProctorSession();
    const details: string[] = [];
    s.on('capability', (c) => details.push(`${c.id}:${c.detail ?? ''}`));
    await s.start({
      sessionId: 's',
      hmacKeyBase64: TEST_KEY_B64,
      root: document.createElement('div'),
      consent: { recordedAt: '2026-01-01T00:00:00Z' },
      transport: {
        sendBatch: () => Promise.resolve('OK'),
        sendKeystrokeBatch: () => Promise.resolve('OK'),
        heartbeat: () => Promise.resolve(true),
      },
      detectors: [],
      store: new IdbStore(indexedDB, `ks-flags-${++n}`),
    });
    s.keystrokes?.reset(Q1, 'python', 'LEAKME'.repeat(20_000));
    expect(details.some((d) => d.startsWith('keystroke-unrepresentable:'))).toBe(true);
    expect(details.join('|')).not.toContain('LEAKME');
    await s.stop();
  });
});

describe('delivery guarantees (NFR-08, TC-063, TC-065)', () => {
  it('TC-065 NFR-08: stop() while a keystroke batch is mid-signing waits for it and loses nothing (original seq, valid signature)', async () => {
    const r = await rig();
    const realSign = crypto.subtle.sign.bind(crypto.subtle);
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let entered!: () => void;
    const inSign = new Promise<void>((res) => (entered = res));
    let first = true;
    vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return realSign(...args);
    });
    r.recorder.reset(Q1, 'python', 'a');
    const flushing = r.queue.flush(); // cut starts, signing is held
    await inSign;
    r.clock.t += 100;
    r.recorder.recordChange({ offset: 1, deleteLength: 0, text: 'b' }); // enqueued while signing
    const stopped = r.queue.stop();
    release();
    await Promise.all([flushing, stopped]);
    const batches = r.sent.map(apiAccepts);
    expect(batches.map((b) => b.seq)).toEqual([0, 1]);
    expect(replay(batches).get(Q1)).toBe('ab');
  });

  it('TC-063 NFR-08: offline, batches wait in IndexedDB; a reload resends the same signatures and continues the sequence', async () => {
    const off = await rig({ outcome: 'RETRY' });
    off.recorder.reset(Q1, 'python', 'a');
    await off.queue.flush();
    off.clock.t += 1000;
    off.recorder.recordChange({ offset: 1, deleteLength: 0, text: 'b' });
    await off.queue.stop();
    expect(off.attempted.length).toBeGreaterThan(0);
    const saved = (await off.store.entries<SignedBatch>('eventBatches', 's:ks:')).map(
      (e) => `${e.value.seq}:${e.value.signature}`,
    );
    expect(saved).toHaveLength(2);
    const on = await rig({ store: off.store, clock: off.clock });
    await vi.waitFor(() => expect(on.sent).toHaveLength(2));
    expect(on.sent.map((b) => `${b.seq}:${b.signature}`)).toEqual(saved);
    on.recorder.reset(Q1, 'python', 'ab');
    await on.queue.flush();
    expect(on.sent.map((b) => b.seq)).toEqual([0, 1, 2]);
    expect(replay(on.sent.map(apiAccepts)).get(Q1)).toBe('ab');
  });

  it('TC-065 NFR-08: after IndexedDB writes failed and the page reloaded, the keystroke sequence does not restart below an acknowledged seq', async () => {
    const store = new IdbStore(indexedDB, `ks-seq-${++n}`);
    const realPut = store.put.bind(store);
    vi.spyOn(store, 'put').mockImplementation((name, key, value) =>
      name === 'chunks' ? realPut(name, key, value) : Promise.reject(new Error('quota')),
    );
    const first = await rig({ store });
    for (let i = 0; i < 3; i++) {
      first.recorder.reset(Q1, 'python', `v${i}`);
      await first.queue.flush();
    }
    expect(first.sent.map((b) => b.seq)).toEqual([0, 1, 2]);
    vi.restoreAllMocks();
    const second = await rig({ store });
    second.recorder.reset(Q1, 'python', 'again');
    await second.queue.flush();
    expect(second.sent.map((b) => b.seq)).toEqual([3]);
  });

  it('FR-702: finish() leaves no keystroke batches in IndexedDB but keeps the counter, so a new queue continues at the next seq', async () => {
    const r = await rig();
    r.recorder.reset(Q1, 'python', 'a');
    r.recorder.recordChange({ offset: 1, deleteLength: 0, text: 'b' });
    const { lostBatches } = await r.queue.finish(500);
    expect(lostBatches).toBe(0);
    expect(await r.store.keys('eventBatches', 's:')).toEqual([]);
    const again = await rig({ store: r.store });
    again.recorder.reset(Q1, 'python', 'ab');
    await again.queue.flush();
    expect(again.sent.map((b) => b.seq)).toEqual([1]);
  });
});

describe('ProctorSession wiring (FR-608, FR-702)', () => {
  const base = (
    over: Pick<ProctorSessionConfig, 'transport'> & Partial<ProctorSessionConfig>,
  ): ProctorSessionConfig => ({
    sessionId: 's',
    hmacKeyBase64: TEST_KEY_B64,
    root: document.createElement('div'),
    consent: { recordedAt: '2026-01-01T00:00:00Z' },
    detectors: [],
    store: new IdbStore(indexedDB, `ks-sess-${++n}`),
    ...over,
  });

  it('FR-608: a transport that cannot send keystroke batches gives no recorder and an UNSUPPORTED flag, not a silent no-op', async () => {
    const s = new ProctorSession();
    const caps: string[] = [];
    s.on('capability', (c) => caps.push(`${c.id}:${c.status}`));
    await s.start(
      base({
        transport: {
          sendBatch: () => Promise.resolve('OK'),
          heartbeat: () => Promise.resolve(true),
        },
      }),
    );
    expect(s.keystrokes).toBeNull();
    expect(caps).toContain('keystrokes:UNSUPPORTED');
    await s.stop();
  });

  it('FR-608 TC-062: session.keystrokes records, stop() flushes it, and the batches replay to the final code', async () => {
    const sent: SignedBatch[] = [];
    const s = new ProctorSession();
    await s.start(
      base({
        transport: {
          sendBatch: () => Promise.resolve('OK'),
          sendKeystrokeBatch: (b: SignedBatch) => {
            sent.push(b);
            return Promise.resolve('OK');
          },
          heartbeat: () => Promise.resolve(true),
        },
      }),
    );
    s.keystrokes?.reset(Q1, 'python', 'print(1)');
    s.keystrokes?.recordChange({ offset: 8, deleteLength: 0, text: '\n' });
    await s.stop(); // flushes both queues
    expect(replay(sent.map(apiAccepts)).get(Q1)).toBe('print(1)\n');
  });

  it('FR-702: session.finish() counts unsent keystroke batches as lost and warns first; nothing stays in IndexedDB', async () => {
    const store = new IdbStore(indexedDB, `ks-fin-${++n}`);
    const s = new ProctorSession();
    const caps: string[] = [];
    s.on('capability', (c) => caps.push(c.id));
    const sendKeystrokeBatch = vi.fn(() => Promise.resolve('RETRY' as const));
    await s.start(
      base({
        store,
        transport: {
          sendBatch: () => Promise.resolve('OK'),
          sendKeystrokeBatch,
          heartbeat: () => Promise.resolve(true),
        },
      }),
    );
    s.keystrokes?.reset(Q1, 'python', 'a');
    await vi.waitFor(() => expect(s.getKeystrokeStats()?.pendingItems).toBe(1));
    const r = await s.finish(200);
    expect(r.lostBatches).toBe(1);
    expect(caps).toEqual(expect.arrayContaining(['finish-pending', 'finish-lost']));
    expect(await store.keys('eventBatches', 's:')).toEqual([]);
  });

  it('FR-608: the fetch transport posts keystroke batches to /candidate/session/keystrokes with the signature header', async () => {
    const calls: { url: string; sig: string; body: string }[] = [];
    const fetchFn = vi.fn((url: string, init: RequestInit) => {
      calls.push({
        url,
        sig: (init.headers as Record<string, string>)['X-Signature'] as string,
        body: init.body as string,
      });
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    const t = createFetchTransport({
      baseUrl: 'https://api.example/v1',
      getToken: () => 't',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const r = await t.sendKeystrokeBatch({ seq: 0, body: '{"a":1}', signature: 'a'.repeat(64) });
    expect(r).toBe('OK');
    expect(calls[0]).toMatchObject({
      url: 'https://api.example/v1/candidate/session/keystrokes',
      body: '{"a":1}',
    });
    expect(calls[0]?.sig).toBe('a'.repeat(64));
  });
});
