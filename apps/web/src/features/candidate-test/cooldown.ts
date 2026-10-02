/** FR-502: one run per 5 seconds per candidate. */
export const RUN_COOLDOWN_MS = 5000;

export function cooldownRemainingMs(
  lastRunAtMs: number | null,
  nowMs: number,
  cooldownMs: number = RUN_COOLDOWN_MS,
): number {
  if (lastRunAtMs === null) return 0;
  return Math.max(0, lastRunAtMs + cooldownMs - nowMs);
}

export function cooldownSeconds(remainingMs: number): number {
  return Math.ceil(remainingMs / 1000);
}
