/** Countdown helpers. The server clock is the source of truth (FR-505); the client only ticks. */

/**
 * Offset to add to Date.now() to get server time. Uses the midpoint of the request so network
 * latency does not skew the result.
 */
export function computeClockOffset(
  serverNowMs: number,
  requestStartMs: number,
  responseEndMs: number,
): number {
  const clientMidpoint = (requestStartMs + responseEndMs) / 2;
  return serverNowMs - clientMidpoint;
}

export function remainingMs(deadlineMs: number, clientNowMs: number, offsetMs: number): number {
  return Math.max(0, deadlineMs - (clientNowMs + offsetMs));
}

/** 75 minutes in ms -> "1:15:00"; under an hour -> "14:05". Rounds up so 0:00 means truly over. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.ceil(Math.max(0, ms) / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export type TimerWarning = 'none' | 'five-minutes' | 'one-minute' | 'expired';

/** Used to announce time left to screen readers at a few thresholds only (not every second). */
export function timerWarning(ms: number): TimerWarning {
  if (ms <= 0) return 'expired';
  if (ms <= 60_000) return 'one-minute';
  if (ms <= 300_000) return 'five-minutes';
  return 'none';
}
