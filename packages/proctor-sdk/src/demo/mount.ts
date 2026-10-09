import { ProctorSession } from '../core/session';
import { createFetchTransport } from '../core/transport';
import { createDefaultMonitors } from '../index';
import { createDefaultInferenceWorker } from '../detectors/default-worker';
import type { EvidenceApi } from '../detectors/evidence';
import { VisionMonitor } from '../detectors/vision-monitor';
import { VoiceMonitor, createVadWebFactory } from '../detectors/voice-monitor';
import { RecordingPipeline } from '../recording/pipeline';
import { MediaApiError, type ChunkRef, type MediaApi } from '../recording/types';
import { resolveModelUrls } from '../detectors/config';

/**
 * Framework-agnostic demo for the /dev/proctor page. Everything goes over real `fetch` to the
 * endpoints under `apiBase` (dev-only mock route handlers in apps/web), so DevTools offline mode
 * really cuts the traffic (TC-063). The "simulate network drop" checkbox does the same from inside
 * the page. Not for production use.
 *
 * The demo's injected adapters (heartbeat body, media API, evidence API, identity re-check) speak the
 * wire format of ADR 0013 (Proposed, PR #39), provisional. SDK core is unchanged: where the core
 * differs from the ADR, the adapter bridges it and says so below.
 */
export interface DemoOptions {
  /** Same-origin base of the mock API, for example `/dev/proctor/api`. */
  apiBase: string;
  /** Same-origin base of the self-hosted model files. */
  modelBaseUrl: string;
  /** Demo HMAC key, base64 (shared with the mock server). */
  hmacKeyBase64: string;
  sessionId: string;
  /** Called after consent when the session is running (the page mounts the calibration panel). */
  onStarted?: (h: { session: ProctorSession; vision: VisionMonitor }) => void;
}

const isHigh = (c: string | undefined): boolean =>
  c !== undefined && c >= '\uD800' && c <= '\uDBFF';
const isLow = (c: string | undefined): boolean => c !== undefined && c >= '\uDC00' && c <= '\uDFFF';

/**
 * One EDIT from a textarea value change (common prefix and suffix). The cut never falls inside a
 * surrogate pair, so the text of an edit is always well formed (the API rejects lone surrogates).
 */
export function diffEdit(
  previous: string,
  next: string,
): { offset: number; deleteLength: number; text: string } | null {
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let endPrev = previous.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && previous[endPrev - 1] === next[endNext - 1]) {
    endPrev--;
    endNext--;
  }
  // Do not cut a pair in two: move the start before a high surrogate, the end after a low one.
  if (start > 0 && isHigh(next[start - 1])) start--;
  if (endNext < next.length && isLow(next[endNext])) {
    endNext++;
    endPrev++;
  }
  if (endPrev === start && endNext === start) return null;
  return { offset: start, deleteLength: endPrev - start, text: next.slice(start, endNext) };
}

export interface DemoHandle {
  stop(): Promise<void>;
}

/** Fixed question id for the demo's single editor. */
const DEMO_QUESTION_ID = '8f14e45f-ceea-467a-9575-1b2a7c3d4e5f';
const ALREADY_UPLOADED = 'already-uploaded:';

async function problemCode(res: Response): Promise<string> {
  const j = (await res.json().catch(() => null)) as { code?: unknown } | null;
  return typeof j?.code === 'string' ? j.code : '';
}

/**
 * Media API adapter for ADR 0013 section 5.5. Bridges two differences from SDK core (both listed in
 * docs/followups/proctor-sdk.md): the ADR wants `startedAt`, `durationMs` and a bare `video/webm`
 * content type, and a per-stream unique `seq` (the SDK restarts `seq` at 0 in every segment), so the
 * adapter sends `segment * 100000 + seq`.
 */
function createAdrMediaApi(apiBase: string, token: string, f: typeof fetch): MediaApi {
  const wireSeq = (c: ChunkRef): number => c.segment * 100_000 + c.seq;
  const post = async (path: string, body: unknown): Promise<Response> => {
    let res: Response;
    try {
      res = await f(`${apiBase}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    } catch {
      throw new MediaApiError('RETRY', 'network');
    }
    if (res.ok) return res;
    const code = await problemCode(res);
    const fatal = res.status === 400 || code === 'SEQ_CONFLICT' || code === 'SESSION_NOT_ACTIVE';
    // 404 CHUNK_NOT_PRESIGNED, 409 UPLOAD_NOT_FOUND, 422 UPLOAD_MISMATCH, 429, 5xx: presign again.
    throw new MediaApiError(fatal ? 'FATAL' : 'RETRY', code || `status ${res.status}`);
  };
  return {
    async presign(c) {
      const contentType = c.stream === 'AUDIO' ? 'audio/webm' : 'video/webm';
      const res = await post('/media/presign', {
        stream: c.stream,
        segment: c.segment,
        seq: wireSeq(c),
        bytes: c.bytes,
        contentType,
        startedAt: new Date(Date.now() - 10_000).toISOString(),
        durationMs: 10_000,
      });
      const j = (await res.json()) as {
        url?: string;
        alreadyUploaded?: boolean;
        headers?: Record<string, string>;
      };
      if (j.alreadyUploaded) return { url: ALREADY_UPLOADED };
      if (typeof j.url !== 'string') throw new MediaApiError('RETRY', 'bad presign response');
      return { url: j.url, headers: { 'Content-Type': contentType, ...j.headers } };
    },
    async confirm(c) {
      await post('/media/confirm', { stream: c.stream, segment: c.segment, seq: wireSeq(c) });
    },
  };
}

export function mountProctorDemo(container: HTMLElement, o: DemoOptions): DemoHandle {
  container.innerHTML = `
    <div style="display:grid;gap:12px;font:14px system-ui">
      <p>
        <button data-a="consent">1. Record consent, then start camera + microphone + monitors</button>
        <span data-status></span>
      </p>
      <section data-test-root style="border:1px solid #888;padding:8px">
        <b>Test area</b> (paste, copy, cut, drop and right click are blocked here)
        <textarea style="width:100%;height:80px"></textarea>
        <p>Also try: F12, Ctrl+Shift+I, Ctrl+U, switch tab, leave fullscreen, open devtools.</p>
        <button data-a="fs">Enter fullscreen</button>
        <button data-a="share">Share entire screen (and record it)</button>
        <label><input type="checkbox" data-a="offline"> Simulate network drop (in-page)</label>
      </section>
      <section><b>Capabilities</b><ul data-cap></ul></section>
      <section><b>Editor lock</b> <span data-lock>unlocked</span></section>
      <section><b>Metrics and recorder health</b> <pre data-metrics></pre></section>
      <section><b>Events</b><ol data-events reversed></ol></section>
    </div>`;
  const q = <T extends HTMLElement>(s: string): T => container.querySelector<T>(s) as T;
  const root = q('[data-test-root]');
  const eventsEl = q('[data-events]');
  const capEl = q('[data-cap]');
  const lockEl = q('[data-lock]');
  const metricsEl = q('[data-metrics]');
  const statusEl = q('[data-status]');
  const offline = q<HTMLInputElement>('[data-a=offline]');

  // Every network call goes through here so the checkbox behaves like DevTools offline.
  const demoFetch: typeof fetch = (input, init) =>
    offline.checked ? Promise.reject(new TypeError('Simulated network drop')) : fetch(input, init);
  const token = `demo-${o.sessionId}`; // dev mock token, identifies the demo session only
  const auth = { Authorization: `Bearer ${token}` };

  const monitors = createDefaultMonitors();
  const session = new ProctorSession();
  let consented = false;
  /** Set by stop(): any async start step that resumes after it must tear down what it started. */
  let stopped = false;
  let removeEditorListeners: (() => void) | null = null;
  let pipeline: RecordingPipeline | null = null;
  const lockState = new Map<string, boolean>();

  session.on('event', (e) => {
    const li = document.createElement('li');
    li.textContent = `${e.occurredAt.slice(11, 23)} ${e.type} ${e.durationMs === undefined ? '' : `${e.durationMs}ms `}${JSON.stringify(e.payload)}`;
    eventsEl.prepend(li);
  });
  const renderCaps = (extra: string[] = []): void => {
    const lines = [
      ...session
        .getCapabilities()
        .map((c) => `${c.id}: ${c.status}${c.detail ? ` (${c.detail})` : ''}`),
      ...extra,
    ];
    capEl.replaceChildren(
      ...lines.map((t) => {
        const li = document.createElement('li');
        li.textContent = t;
        return li;
      }),
    );
  };
  const recordingCaps: string[] = [];
  session.on('capability', () => renderCaps(recordingCaps));
  session.on('lock', (l) => {
    lockState.set(l.reason, l.locked);
    const on = [...lockState].filter(([, v]) => v).map(([k]) => k);
    lockEl.textContent = on.length ? `LOCKED: ${on.join(', ')}` : 'unlocked';
  });
  const timer = setInterval(() => {
    const m = session.getMetrics();
    const s = session.getQueueStats();
    const h = pipeline?.health();
    if (m) {
      metricsEl.textContent = [
        `main-thread busy ${m.mainThreadBusyPercent.toFixed(3)}%  long tasks ${m.longTasks.count}`,
        `event batches: unsent ${s?.unsentBatches ?? 0}, sent ${s?.sentBatches ?? 0}, next seq ${s?.nextSeq ?? 0}`,
        h
          ? `recording: pending ${h.chunksPending} chunks / ${h.bytesPending} B, in flight ${h.inFlight}, failures ${h.consecutiveFailures}, dropped ${h.droppedChunks}, last ok ${h.lastSuccessfulUploadAt ? new Date(h.lastSuccessfulUploadAt).toISOString().slice(11, 19) : '-'}`
          : 'recording: not started',
      ].join('\n');
    }
  }, 1000);

  // ADR 0013 section 5.6: evidence presign takes a `purpose` and returns `evidenceKey`
  // (`evidence/<ULID>.jpg`); SDK core's EvidenceApi expects `key` and has no purpose.
  const presignEvidence = async (
    purpose: 'EVENT' | 'IDENTITY_RECHECK',
    input: { contentType: 'image/jpeg'; bytes: number },
  ): Promise<{ url: string; key: string; headers?: Record<string, string> }> => {
    const res = await demoFetch(`${o.apiBase}/evidence/presign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ purpose, ...input }),
    });
    if (!res.ok) throw new Error('presign failed');
    const j = (await res.json()) as {
      url: string;
      evidenceKey: string;
      headers?: Record<string, string>;
    };
    return { url: j.url, key: j.evidenceKey, ...(j.headers ? { headers: j.headers } : {}) };
  };
  const evidenceApi: EvidenceApi = { presign: (input) => presignEvidence('EVENT', input) };

  /** Release anything a start that finished (or is still finishing) after stop() created. */
  const teardownLate = async (): Promise<void> => {
    await pipeline?.stop();
    await session.stop();
  };

  q('[data-a=consent]').addEventListener('click', () => {
    if (consented || stopped) return;
    consented = true;
    statusEl.textContent = ' starting...';
    void (async () => {
      const transport = createFetchTransport({
        baseUrl: o.apiBase,
        getToken: () => token,
        fetchFn: demoFetch,
        eventsPath: '/events',
        heartbeatPath: '/heartbeat',
        keystrokesPath: '/keystrokes',
      });
      const media = createAdrMediaApi(o.apiBase, token, demoFetch);
      pipeline = new RecordingPipeline({
        sessionId: o.sessionId,
        api: media,
        assertConsent: () => {
          if (!consented) throw new Error('consent required');
        },
        put: async (url, body, headers) =>
          url === ALREADY_UPLOADED
            ? 200
            : (await demoFetch(url, { method: 'PUT', body, headers })).status,
        onCapability: (f) => {
          recordingCaps.push(`${f.id}: ${f.status}${f.detail ? ` (${f.detail})` : ''}`);
          renderCaps(recordingCaps);
        },
      });
      await pipeline.start();
      if (stopped) return teardownLate();
      await pipeline.recordWebcam();
      if (stopped) return teardownLate();
      await pipeline.recordAudio();
      if (stopped) return teardownLate();
      const pl = pipeline;
      const vision = new VisionMonitor({
        getWebcamStream: () => pl.webcamStream,
        createWorker: createDefaultInferenceWorker,
        modelBaseUrl: o.modelBaseUrl,
        evidenceApi,
        // The ADR limits re-checks to 1 per 60 s (SDK default is 120 s); 61 s so the demo shows one.
        config: { identityIntervalMs: 61_000 },
        // ADR 0013 section 5.6: upload the frame, then POST its name; the server answers 202 with
        // no result and writes FACE_MISMATCH itself. SDK core still relays a client-side
        // FACE_MISMATCH when the callback says `matched: false`, so this demo adapter always
        // reports `matched: true` to stop that relay (the mismatch shows in the server panel).
        recheckIdentity: async (frame) => {
          const p = await presignEvidence('IDENTITY_RECHECK', {
            contentType: 'image/jpeg',
            bytes: frame.size,
          });
          const put = await demoFetch(p.url, {
            method: 'PUT',
            body: frame,
            headers: { 'Content-Type': 'image/jpeg', ...p.headers },
          });
          if (!put.ok) return null;
          await demoFetch(`${o.apiBase}/identity/recheck`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...auth },
            body: JSON.stringify({ evidenceKey: p.key, capturedAt: new Date().toISOString() }),
          });
          return { matched: true };
        },
      });
      const voice = new VoiceMonitor({
        getStream: () => pl.audioStream,
        createVad: createVadWebFactory(resolveModelUrls(o.modelBaseUrl).vadAssets),
      });
      // ADR 0013 section 5.3: the heartbeat carries recorder and queue health. SDK core sends no
      // body, so the demo transport wraps it. Per-stream segment and lastSeq are not exposed by the
      // SDK yet, so those fields are 0 here; bytes and drops are real.
      const heartbeat = async (): Promise<boolean> => {
        const h = pl.health();
        const q = session.getQueueStats();
        try {
          const res = await demoFetch(`${o.apiBase}/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              recorder: {
                streams: (['SCREEN', 'WEBCAM', 'AUDIO'] as const).map((stream) => ({
                  stream,
                  segment: 0,
                  lastSeq: 0,
                  bufferedChunks: 0,
                  bufferedBytes: h.bytesPendingByStream[stream],
                  droppedChunks: h.droppedChunks,
                  droppedBytes: h.droppedBytes,
                })),
              },
              queue: {
                pendingEventBatches: q?.unsentBatches ?? 0,
                pendingKeystrokeBatches: session.getKeystrokeStats()?.unsentBatches ?? 0,
                rejectedBatches: q?.rejectedBatches ?? 0,
              },
            }),
          });
          return res.ok;
        } catch {
          return false;
        }
      };
      await session.start({
        sessionId: o.sessionId,
        hmacKeyBase64: o.hmacKeyBase64,
        root,
        consent: { recordedAt: new Date().toISOString() },
        detectors: [...Object.values(monitors), vision, voice],
        transport: {
          sendBatch: (b) => transport.sendBatch(b),
          sendKeystrokeBatch: (b) => transport.sendKeystrokeBatch(b),
          heartbeat,
        },
      });
      // Editor recording (FR-608): the demo textarea stands in for Monaco. Its input events are
      // turned into one EDIT each (common prefix and suffix), never raw key events (NFR-05).
      const keystrokes = session.keystrokes;
      const editor = root.querySelector('textarea');
      if (keystrokes && editor) {
        let previous = editor.value;
        keystrokes.reset(DEMO_QUESTION_ID, 'python', previous);
        const onInput = (): void => {
          const next = editor.value;
          const change = diffEdit(previous, next);
          if (change) keystrokes.recordChange(change);
          previous = next;
        };
        const onSelect = (): void =>
          keystrokes.recordSelection(editor.selectionStart, editor.selectionEnd);
        editor.addEventListener('input', onInput);
        editor.addEventListener('select', onSelect);
        removeEditorListeners = () => {
          editor.removeEventListener('input', onInput);
          editor.removeEventListener('select', onSelect);
        };
      }
      if (stopped) return teardownLate();
      statusEl.textContent = ' running';
      o.onStarted?.({ session, vision });
    })().catch((err: unknown) => {
      statusEl.textContent = ` failed: ${err instanceof Error ? err.name : 'error'}`;
    });
  });
  q('[data-a=fs]').addEventListener('click', () => void monitors.fullscreen.enter());
  q('[data-a=share]').addEventListener('click', () => {
    void (async () => {
      if (stopped) return;
      const r = await monitors.screenShare.request();
      if (stopped) {
        // The picker was answered after the page was left: release the capture.
        if (r.ok) r.stream.getTracks().forEach((t) => t.stop());
        return;
      }
      if (r.ok && pipeline) await pipeline.recordScreen(r.stream);
    })().catch(() => undefined);
  });

  return {
    async stop() {
      stopped = true;
      removeEditorListeners?.();
      consented = false; // device requests that start after this are refused by assertConsent
      clearInterval(timer);
      await session.stop();
      await pipeline?.stop();
      container.innerHTML = '';
    },
  };
}
