import { createDefaultMonitors } from '../index';
import { ProctorSession } from '../core/session';
import type { SendResult } from '../core/event-queue';

/**
 * Framework-agnostic demo for the /dev/proctor page (apps/web mounts this into a div; the web page
 * belongs to the web owner). Uses a local fake transport, so no API is needed, and a checkbox that
 * simulates a network drop to try TC-063. Not for production use: the key is a demo constant.
 */
const DEMO_KEY_B64 = btoa('demo-key-demo-key-demo-key-12345');

export interface DemoHandle {
  stop(): Promise<void>;
}

export function mountProctorDemo(container: HTMLElement): DemoHandle {
  container.innerHTML = `
    <div style="display:grid;gap:12px;font:14px system-ui">
      <p><button data-a="consent">1. Record consent (demo)</button></p>
      <section data-test-root style="border:1px solid #888;padding:8px">
        <b>Test area</b> (paste, copy, cut, drop and right click are blocked here)
        <textarea style="width:100%;height:80px"></textarea>
        <p>Also try: F12, Ctrl+Shift+I, Ctrl+U, switch tab, leave fullscreen, open devtools.</p>
        <button data-a="fs">Enter fullscreen</button>
        <button data-a="share">Share entire screen</button>
        <label><input type="checkbox" data-a="offline"> Simulate network drop</label>
      </section>
      <section><b>Capabilities</b><ul data-cap></ul></section>
      <section><b>Editor lock</b> <span data-lock>unlocked</span></section>
      <section><b>Metrics</b> <pre data-metrics></pre></section>
      <section><b>Events</b><ol data-events reversed></ol></section>
    </div>`;
  const q = <T extends HTMLElement>(s: string): T => container.querySelector<T>(s) as T;
  const root = q('[data-test-root]');
  const eventsEl = q('[data-events]');
  const capEl = q('[data-cap]');
  const lockEl = q('[data-lock]');
  const metricsEl = q('[data-metrics]');
  const offline = q<HTMLInputElement>('[data-a=offline]');

  const monitors = createDefaultMonitors();
  const session = new ProctorSession();
  const lockState = new Map<string, boolean>();
  session.on('event', (e) => {
    const li = document.createElement('li');
    li.textContent = `${e.occurredAt.slice(11, 23)} ${e.type} ${e.durationMs === undefined ? '' : `${e.durationMs}ms `}${JSON.stringify(e.payload)}`;
    eventsEl.prepend(li);
  });
  session.on('capability', () => {
    capEl.innerHTML = session
      .getCapabilities()
      .map((c) => `<li>${c.id}: ${c.status}${c.detail ? ` (${c.detail})` : ''}</li>`)
      .join('');
  });
  session.on('lock', (l) => {
    lockState.set(l.reason, l.locked);
    const on = [...lockState].filter(([, v]) => v).map(([k]) => k);
    lockEl.textContent = on.length ? `LOCKED: ${on.join(', ')}` : 'unlocked';
  });
  const timer = setInterval(() => {
    const m = session.getMetrics();
    const s = session.getQueueStats();
    if (m) {
      metricsEl.textContent = `main-thread busy ${m.mainThreadBusyPercent.toFixed(3)}%  long tasks ${m.longTasks.count}\nunsent batches ${s?.unsentBatches ?? 0}, sent ${s?.sentBatches ?? 0}`;
    }
  }, 1000);

  q('[data-a=consent]').addEventListener('click', () => {
    void session.start({
      sessionId: 'demo',
      hmacKeyBase64: DEMO_KEY_B64,
      root,
      consent: { recordedAt: new Date().toISOString() },
      detectors: Object.values(monitors),
      transport: {
        sendBatch: (): Promise<SendResult> => Promise.resolve(offline.checked ? 'RETRY' : 'OK'),
        heartbeat: () => Promise.resolve(!offline.checked),
      },
    });
  });
  q('[data-a=fs]').addEventListener('click', () => void monitors.fullscreen.enter());
  q('[data-a=share]').addEventListener('click', () => void monitors.screenShare.request());

  return {
    async stop() {
      clearInterval(timer);
      await session.stop();
      container.innerHTML = '';
    },
  };
}
