import {
  effectiveSectionDeadline,
  effectiveSessionDeadline,
  proctorPauseCapMs,
} from './deadlines';
import type { DeadlineSession } from './deadlines';

const T0 = new Date('2026-10-05T10:00:00.000Z');
const at = (min: number): Date => new Date(T0.getTime() + min * 60_000);
const CAP = 30 * 60_000;

function session(over: Partial<DeadlineSession> = {}): DeadlineSession {
  return {
    deadlineAt: at(60),
    pausedMs: 0n,
    proctorPausedAt: null,
    pauseReasons: [],
    ...over,
  };
}

describe('Server deadlines (FR-505, TC-047, ADR 0002 P-2..P-4)', () => {
  it('TC-047: the deadline is the stored server value, whatever "now" a client believes', () => {
    // The function has no client input: only the stored deadline and the API clock.
    expect(effectiveSessionDeadline(session(), at(5), CAP)).toEqual(at(60));
    expect(effectiveSessionDeadline(session(), at(500), CAP)).toEqual(at(60));
  });

  it('FR-601, ADR 0002 P-2: candidate-caused pauses never move the deadline', () => {
    const s = session({
      pauseReasons: ['FULLSCREEN_EXIT', 'SCREEN_SHARE_STOPPED', 'SIDE_CAMERA_LOST'],
      proctorPausedAt: null,
    });
    expect(effectiveSessionDeadline(s, at(30), CAP)).toEqual(at(60));
  });

  it('TC-079, P-3: a running PROCTOR pause adds its elapsed time to the deadline', () => {
    const s = session({ pauseReasons: ['PROCTOR'], proctorPausedAt: at(10) });
    expect(effectiveSessionDeadline(s, at(15), CAP)).toEqual(at(65));
  });

  it('P-3: the credit stops at the org cap, counting credit already used', () => {
    const s = session({
      pauseReasons: ['PROCTOR'],
      proctorPausedAt: at(10),
      pausedMs: BigInt(25 * 60_000),
    });
    // 5 minutes of allowance left; 20 minutes have passed since the pause began.
    expect(effectiveSessionDeadline(s, at(30), CAP)).toEqual(at(65));
  });

  it('P-3: with no pause reason PROCTOR a stale proctorPausedAt is ignored', () => {
    const s = session({ pauseReasons: ['FULLSCREEN_EXIT'], proctorPausedAt: at(10) });
    expect(effectiveSessionDeadline(s, at(30), CAP)).toEqual(at(60));
  });

  it('a session that has not started has no deadline', () => {
    expect(effectiveSessionDeadline(session({ deadlineAt: null }), at(1), CAP)).toBeNull();
  });

  it('S-4: a section opened during a pause gets no credit for the time before it opened', () => {
    const s = session({ pauseReasons: ['PROCTOR'], proctorPausedAt: at(10) });
    const section = { startedAt: at(20), deadlineAt: at(50) };
    // 5 minutes of the pause fall after the section opened at minute 20.
    expect(effectiveSectionDeadline(section, s, at(25), CAP)).toEqual(at(55));
    // A section that opened before the pause gets the whole pause.
    expect(effectiveSectionDeadline({ startedAt: at(0), deadlineAt: at(50) }, s, at(25), CAP)).toEqual(
      at(65),
    );
  });

  it('ADR 0007 section 6: the cap defaults to 30 minutes and ignores junk', () => {
    expect(proctorPauseCapMs({})).toBe(CAP);
    expect(proctorPauseCapMs(null)).toBe(CAP);
    expect(proctorPauseCapMs({ maxProctorPauseMinutes: 'x' })).toBe(CAP);
    expect(proctorPauseCapMs({ maxProctorPauseMinutes: -5 })).toBe(CAP);
    expect(proctorPauseCapMs({ maxProctorPauseMinutes: 10 })).toBe(10 * 60_000);
    expect(proctorPauseCapMs({ maxProctorPauseMinutes: 0 })).toBe(0);
  });
});
