import { ProctorSession } from '../core/session';
import { createFetchTransport } from '../core/transport';
import { createDefaultMonitors } from '../index';
import { createDefaultInferenceWorker } from '../detectors/default-worker';
import type { EvidenceApi } from '../detectors/evidence';
import { VisionMonitor } from '../detectors/vision-monitor';
import { VoiceMonitor, createVadWebFactory } from '../detectors/voice-monitor';
import { RecordingPipeline } from '../recording/pipeline';
import { createFetchMediaApi } from '../recording/media-api';
import { resolveModelUrls } from '../detectors/config';

/**
 * Framework-agnostic demo for the /dev/proctor page. Everything goes over real `fetch` to the
 * endpoints under `apiBase` (dev-only mock route handlers in apps/web), so DevTools offline mode
 * really cuts the traffic (TC-063). The "simulate network drop" checkbox does the same from inside
 * the page. Not for production use.
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

export interface DemoHandle {
  stop(): Promise<void>;
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
  let pipeline: RecordingPipeline | null = null;
  const lockState = new Map<string, boolean>();

  session.on('event', (e) => {
    const li = document.createElement('li');
    li.textContent = `${e.occurredAt.slice(11, 23)} ${e.type} ${e.durationMs === undefined ? '' : `${e.durationMs}ms `}${JSON.stringify(e.payload)}`;
    eventsEl.prepend(li);
  });
  const renderCaps = (extra: string[] = []): void => {
    capEl.innerHTML = [
      ...session
        .getCapabilities()
        .map((c) => `${c.id}: ${c.status}${c.detail ? ` (${c.detail})` : ''}`),
      ...extra,
    ]
      .map((t) => `<li>${t}</li>`)
      .join('');
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

  const evidenceApi: EvidenceApi = {
    presign: async (input) => {
      const res = await demoFetch(`${o.apiBase}/evidence/presign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error('presign failed');
      return (await res.json()) as { url: string; key: string };
    },
  };

  q('[data-a=consent]').addEventListener('click', () => {
    if (consented) return;
    consented = true;
    statusEl.textContent = ' starting...';
    void (async () => {
      const transport = createFetchTransport({
        baseUrl: o.apiBase,
        getToken: () => token,
        fetchFn: demoFetch,
        eventsPath: '/events',
        heartbeatPath: '/heartbeat',
      });
      const media = createFetchMediaApi({
        baseUrl: o.apiBase,
        getToken: () => token,
        fetchFn: demoFetch,
        presignPath: '/media/presign',
        confirmPath: '/media/confirm',
      });
      pipeline = new RecordingPipeline({
        sessionId: o.sessionId,
        api: media,
        assertConsent: () => {
          if (!consented) throw new Error('consent required');
        },
        put: async (url, body, headers) =>
          (await demoFetch(url, { method: 'PUT', body, headers })).status,
        onCapability: (f) => {
          recordingCaps.push(`${f.id}: ${f.status}${f.detail ? ` (${f.detail})` : ''}`);
          renderCaps(recordingCaps);
        },
      });
      await pipeline.start();
      await pipeline.recordWebcam();
      await pipeline.recordAudio();
      const pl = pipeline;
      const vision = new VisionMonitor({
        getWebcamStream: () => pl.webcamStream,
        createWorker: createDefaultInferenceWorker,
        modelBaseUrl: o.modelBaseUrl,
        evidenceApi,
        config: { identityIntervalMs: 20_000 },
        recheckIdentity: async (frame) => {
          const res = await demoFetch(`${o.apiBase}/identity/recheck`, {
            method: 'POST',
            headers: { 'Content-Type': 'image/jpeg', ...auth },
            body: frame,
          });
          return res.ok ? ((await res.json()) as { matched: boolean; similarity?: number }) : null;
        },
      });
      const voice = new VoiceMonitor({
        getStream: () => pl.audioStream,
        createVad: createVadWebFactory(resolveModelUrls(o.modelBaseUrl).vadAssets),
      });
      await session.start({
        sessionId: o.sessionId,
        hmacKeyBase64: o.hmacKeyBase64,
        root,
        consent: { recordedAt: new Date().toISOString() },
        detectors: [...Object.values(monitors), vision, voice],
        transport,
      });
      statusEl.textContent = ' running';
      o.onStarted?.({ session, vision });
    })().catch((err: unknown) => {
      statusEl.textContent = ` failed: ${err instanceof Error ? err.name : 'error'}`;
    });
  });
  q('[data-a=fs]').addEventListener('click', () => void monitors.fullscreen.enter());
  q('[data-a=share]').addEventListener('click', () => {
    void (async () => {
      const r = await monitors.screenShare.request();
      if (r.ok && pipeline) await pipeline.recordScreen(r.stream);
    })().catch(() => undefined);
  });

  return {
    async stop() {
      clearInterval(timer);
      await session.stop();
      await pipeline?.stop();
      container.innerHTML = '';
    },
  };
}
