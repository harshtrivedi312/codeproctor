import type { ProctorSession } from '../core/session';
import type { VisionMonitor } from '../detectors/vision-monitor';

const VISION_TYPES = new Set([
  'NO_FACE',
  'MULTIPLE_FACES',
  'FACE_MISMATCH',
  'GAZE_AWAY',
  'PHONE_DETECTED',
  'BOOK_DETECTED',
  'SPEECH_DETECTED',
  'DETECTOR_UNAVAILABLE',
]);

/**
 * Calibration panel for /dev/proctor: live detector output (which models run, worker CPU, skipped
 * frames, main-thread busy share) and the vision and voice events as they fire. Plain DOM.
 */
export function mountCalibrationPanel(
  container: HTMLElement,
  session: ProctorSession,
  vision: VisionMonitor,
): { stop(): void } {
  container.innerHTML = `<div style="font:14px system-ui"><b>Calibration</b><pre data-stats></pre><ol data-log reversed></ol></div>`;
  const stats = container.querySelector<HTMLElement>('[data-stats]');
  const log = container.querySelector<HTMLElement>('[data-log]');
  const off = session.on('event', (e) => {
    if (!VISION_TYPES.has(e.type) || !log) return;
    const li = document.createElement('li');
    li.textContent = `${e.occurredAt.slice(11, 23)} ${e.type} ${e.durationMs === undefined ? '' : `${e.durationMs}ms `}${e.confidence === undefined ? '' : `conf ${e.confidence.toFixed(2)} `}${e.evidenceKey ? 'snapshot attached ' : ''}${JSON.stringify(e.payload)}`;
    log.prepend(li);
  });
  const timer = setInterval(() => {
    const v = vision.getStats();
    const m = session.getMetrics();
    if (stats) {
      stats.textContent = [
        `models running: ${v.tasks.join(', ') || 'none'}`,
        `worker busy: ${v.workerBusyPercent.toFixed(1)}% of one core, frames ${v.frames}, skipped ${v.skippedFrames}`,
        `main thread busy: ${m ? m.mainThreadBusyPercent.toFixed(3) : '-'}%, long tasks ${m?.longTasks.count ?? '-'}`,
      ].join('\n');
    }
  }, 1000);
  return {
    stop() {
      clearInterval(timer);
      off();
      container.innerHTML = '';
    },
  };
}
