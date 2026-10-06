// Deadlines from the server clock only (FR-505, TC-047). `now` is always passed in by the caller
// from `new Date()` on the API; nothing here reads a client timestamp.
//
// ADR 0002 P-3: a PROCTOR pause stops the clock. The credit is written into `deadline_at` and
// `paused_ms` only when the proctor resumes, so while the pause is active the stored deadline is
// stale and the effective deadline adds the running credit, capped by the org's allowance.
import type { PauseReason } from '../generated/prisma/enums.js';

export const DEFAULT_MAX_PROCTOR_PAUSE_MINUTES = 30;

export interface DeadlineSession {
  readonly deadlineAt: Date | null;
  readonly pausedMs: bigint;
  readonly proctorPausedAt: Date | null;
  readonly pauseReasons: readonly PauseReason[];
}

export interface DeadlineSection {
  readonly startedAt: Date | null;
  readonly deadlineAt: Date | null;
}

/** `maxProctorPauseMinutes` from `organizations.settings`, with the ADR 0007 default. */
export function proctorPauseCapMs(settings: unknown): number {
  const raw =
    typeof settings === 'object' && settings !== null
      ? (settings as Record<string, unknown>).maxProctorPauseMinutes
      : undefined;
  const minutes =
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
      ? raw
      : DEFAULT_MAX_PROCTOR_PAUSE_MINUTES;
  return Math.floor(minutes * 60_000);
}

function activeProctorPause(session: DeadlineSession): Date | null {
  return session.pauseReasons.includes('PROCTOR') ? session.proctorPausedAt : null;
}

/** Session deadline including the credit of a proctor pause that is running now. */
export function effectiveSessionDeadline(
  session: DeadlineSession,
  now: Date,
  capMs: number,
): Date | null {
  if (session.deadlineAt === null) return null;
  const pausedAt = activeProctorPause(session);
  if (pausedAt === null) return session.deadlineAt;
  const running = Math.max(0, now.getTime() - pausedAt.getTime());
  const room = Math.max(0, capMs - Number(session.pausedMs));
  return new Date(session.deadlineAt.getTime() + Math.min(running, room));
}

/**
 * Open section deadline. Only the pause time after the section opened counts (ADR 0002 S-4): a
 * section opened during a pause gets no credit for the part before it opened.
 */
export function effectiveSectionDeadline(
  section: DeadlineSection,
  session: DeadlineSession,
  now: Date,
  capMs: number,
): Date | null {
  if (section.deadlineAt === null) return null;
  const pausedAt = activeProctorPause(session);
  if (pausedAt === null) return section.deadlineAt;
  const base = Math.max(pausedAt.getTime(), section.startedAt?.getTime() ?? 0);
  const before = base - pausedAt.getTime();
  const running = Math.max(0, now.getTime() - base);
  const room = Math.max(0, capMs - Number(session.pausedMs) - before);
  return new Date(section.deadlineAt.getTime() + Math.min(running, room));
}
