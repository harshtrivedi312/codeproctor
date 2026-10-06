import { describe, expect, it } from 'vitest';
import { STEP_IDS, stepForStatus } from './steps';

describe('resume step from the server status (FR-401 to FR-406, ADR 0002)', () => {
  it('FR-404: the order is system check, identity, room scan, phone, practice, start', () => {
    expect(STEP_IDS.slice(3)).toEqual(['check', 'identity', 'room', 'phone', 'practice', 'start']);
  });
  it('FR-404: VERIFIED (only reached after the room scan) resumes at the phone step, which skips itself when not needed', () => {
    expect(stepForStatus('VERIFIED')).toBe('phone');
  });
  it('ADR 0002: a running test resumes at start, and earlier statuses at their own step', () => {
    expect(stepForStatus('IN_PROGRESS')).toBe('start');
    expect(stepForStatus('PAUSED')).toBe('start');
    expect(stepForStatus('OPENED')).toBe('consent');
    expect(stepForStatus('CONSENTED')).toBe('check');
  });
});
