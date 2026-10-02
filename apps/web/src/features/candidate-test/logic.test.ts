import { describe, expect, it } from 'vitest';
import { cooldownRemainingMs, cooldownSeconds, RUN_COOLDOWN_MS } from './cooldown';
import { initialLockState, isEditorReadOnly, lockReducer, type LockState } from './lock-state';
import { computeClockOffset, formatClock, remainingMs, timerWarning } from './timer';

describe('timer (FR-505)', () => {
  it('TC-046 helper: remaining time never goes below zero', () => {
    expect(remainingMs(10_000, 20_000, 0)).toBe(0);
  });
  it('uses the request midpoint so latency does not skew the server offset', () => {
    // Server says 1_000_000 while the client sent at 100 and received at 300 (midpoint 200).
    expect(computeClockOffset(1_000_000, 100, 300)).toBe(999_800);
  });
  it('applies the offset to the countdown', () => {
    const offset = computeClockOffset(5_000, 0, 0); // client clock is 5 s behind the server
    expect(remainingMs(65_000, 0, offset)).toBe(60_000);
  });
  it('formats clocks', () => {
    expect(formatClock(75 * 60_000)).toBe('1:15:00');
    expect(formatClock(14 * 60_000 + 5_000)).toBe('14:05');
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(1)).toBe('0:01');
  });
  it('announces only at thresholds', () => {
    expect(timerWarning(600_000)).toBe('none');
    expect(timerWarning(300_000)).toBe('five-minutes');
    expect(timerWarning(60_000)).toBe('one-minute');
    expect(timerWarning(0)).toBe('expired');
  });
});

describe('run cooldown (FR-502)', () => {
  it('has no cooldown before the first run', () => {
    expect(cooldownRemainingMs(null, 1000)).toBe(0);
  });
  it('allows one run per 5 seconds', () => {
    expect(RUN_COOLDOWN_MS).toBe(5000);
    expect(cooldownRemainingMs(1000, 1000)).toBe(5000);
    expect(cooldownRemainingMs(1000, 3500)).toBe(2500);
    expect(cooldownRemainingMs(1000, 6000)).toBe(0);
    expect(cooldownSeconds(2500)).toBe(3);
  });
});

describe('fullscreen lock (FR-601 UI, ADR 0002 P-2)', () => {
  const running = (fullscreen = true): LockState =>
    lockReducer(initialLockState, { type: 'start', fullscreen });

  it('starts at the gate, read-only', () => {
    expect(initialLockState.phase).toBe('gate');
    expect(isEditorReadOnly(initialLockState, false)).toBe(true);
  });
  it('locks the editor and counts a warning on fullscreen exit', () => {
    const s = lockReducer(running(), { type: 'fullscreen-exited' });
    expect(s.locked).toBe(true);
    expect(s.warnings).toBe(1);
    expect(isEditorReadOnly(s, false)).toBe(true);
  });
  it('does not double count while already locked', () => {
    const s = lockReducer(lockReducer(running(), { type: 'fullscreen-exited' }), {
      type: 'fullscreen-exited',
    });
    expect(s.warnings).toBe(1);
  });
  it('unlocks when fullscreen returns and keeps the warning count', () => {
    const s = lockReducer(lockReducer(running(), { type: 'fullscreen-exited' }), {
      type: 'fullscreen-restored',
    });
    expect(s.locked).toBe(false);
    expect(s.warnings).toBe(1);
    expect(isEditorReadOnly(s, false)).toBe(false);
  });
  it('ignores real exits before the test starts', () => {
    expect(lockReducer(initialLockState, { type: 'fullscreen-exited' })).toBe(initialLockState);
  });
  it('ignores real exits when the demo continued without fullscreen, but allows the simulated one', () => {
    const s = running(false);
    expect(lockReducer(s, { type: 'fullscreen-exited' })).toBe(s);
    expect(lockReducer(s, { type: 'fullscreen-exited', simulated: true }).locked).toBe(true);
  });
  it('keeps the editor read-only after time expires even when unlocked', () => {
    expect(isEditorReadOnly(running(), true)).toBe(true);
  });
});
