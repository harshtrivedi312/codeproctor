import { ExecutionContext, HttpException, UnauthorizedException } from '@nestjs/common';
import { CodedHttpException } from '../common/coded.exception';
import type { PauseReason, SessionStatus } from '../generated/prisma/enums.js';
import { SessionWritableGuard, assertWritable } from './session-write-gate';

function refusal(status: SessionStatus, pauseReasons: PauseReason[]): CodedHttpException | null {
  try {
    assertWritable({ status, pauseReasons });
    return null;
  } catch (e) {
    return e instanceof CodedHttpException ? e : (e as CodedHttpException);
  }
}

describe('assertWritable (DL-17, ADR 0002 P-2)', () => {
  it('DL-17: SCREEN_SHARE_STOPPED refuses question and draft writes with 409 SESSION_PAUSED', () => {
    const e = refusal('PAUSED', ['SCREEN_SHARE_STOPPED']);
    expect(e?.getStatus()).toBe(409);
    expect(e?.code).toBe('SESSION_PAUSED');
  });

  it('DL-17: SIDE_CAMERA_LOST refuses writes with 409 SESSION_PAUSED', () => {
    const e = refusal('PAUSED', ['SIDE_CAMERA_LOST']);
    expect(e?.getStatus()).toBe(409);
    expect(e?.code).toBe('SESSION_PAUSED');
  });

  it('DL-17: FULLSCREEN_EXIT alone is not enforced server-side (the client enforces and logs it)', () => {
    expect(refusal('PAUSED', ['FULLSCREEN_EXIT'])).toBeNull();
    expect(refusal('IN_PROGRESS', ['FULLSCREEN_EXIT'])).toBeNull();
  });

  it('DL-17: a blocking reason wins when FULLSCREEN_EXIT is active too', () => {
    expect(refusal('PAUSED', ['FULLSCREEN_EXIT', 'SCREEN_SHARE_STOPPED'])?.code).toBe(
      'SESSION_PAUSED',
    );
  });

  it('ADR 0013 CS-4.6: a PROCTOR pause stops the clock, so editing during it is refused too', () => {
    expect(refusal('PAUSED', ['PROCTOR'])?.code).toBe('SESSION_PAUSED');
  });

  it('DL-17: with no pause reason the write is allowed', () => {
    expect(refusal('IN_PROGRESS', [])).toBeNull();
  });

  it('FR-505: a session that is not running answers 409 SESSION_NOT_ACTIVE with its status', () => {
    for (const status of [
      'INVITED',
      'OPENED',
      'CONSENTED',
      'VERIFIED',
      'SUBMITTED',
      'DECLINED',
    ] as const) {
      const e = refusal(status, []);
      expect(e?.code).toBe('SESSION_NOT_ACTIVE');
      expect(e?.extensions.sessionStatus).toBe(status);
    }
  });

  it('DL-17: the guard form refuses without a candidate context and applies the same rule', () => {
    const guard = new SessionWritableGuard();
    const ctx = (candidate: unknown): ExecutionContext =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ candidate }) }),
      }) as unknown as ExecutionContext;
    expect(() => guard.canActivate(ctx(undefined))).toThrow(UnauthorizedException);
    expect(guard.canActivate(ctx({ status: 'IN_PROGRESS', pauseReasons: [] }))).toBe(true);
    expect(() =>
      guard.canActivate(ctx({ status: 'PAUSED', pauseReasons: ['SCREEN_SHARE_STOPPED'] })),
    ).toThrow(HttpException);
  });
});
