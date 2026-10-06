// Candidate email OTP (FR-106, ADR 0003 sections 2 and 6, TC-007, TC-097). All state is in Redis.
//
//   otp:{invitationId}           HMAC-SHA256(OTP_PEPPER, invitationId:code), TTL 10 minutes
//   otp-attempts:{invitationId}  wrong-or-pending guesses before the test, TTL 30 minutes
//   otp-block:{invitationId}     set on the 5th wrong guess before the test, TTL 30 minutes
//   otp-cooldown:{invitationId}  during IN_PROGRESS or PAUSED: one guess per 30 seconds
//   otp-send:{invitationId}      one email per 30 seconds
//
// Every guess is RESERVED by a Lua script before the code is compared, so concurrent requests
// cannot all pass a check and then all spend an attempt (the FU-BE-26 check-then-act race): at most
// 5 comparisons can ever happen before the block, and at most one per 30 s during a test. The
// comparison itself runs in Node with timingSafeEqual. A correct code is spent by a compare-and-
// delete, so two concurrent correct submissions cannot both succeed. The code and its hash are
// never logged. Keys are per invitation, not per IP (ADR 0003 A-27).
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { CodedHttpException } from '../common/coded.exception';
import type { Env } from '../config/env';
import { REDIS_CLIENT } from '../infrastructure/infrastructure.module';
import { ensureConnected } from '../infrastructure/redis-ready';

export const OTP_TTL_SECONDS = 600;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_BLOCK_SECONDS = 1800;
export const OTP_COOLDOWN_SECONDS = 30;
export const OTP_SEND_COOLDOWN_SECONDS = 30;
/** How long a spent code stays restorable. */
const SPENT_MARKER_MS = 60_000;

export type OtpPhase = 'PRE_START' | 'LIVE';

export type OtpIssue =
  | { readonly kind: 'issued'; readonly code: string }
  | { readonly kind: 'blocked'; readonly retryAfterSeconds: number }
  | { readonly kind: 'wait'; readonly retryAfterSeconds: number };

/** What verify() saw before it spent the code: enough to put the code back exactly (DL-37). */
export interface OtpRestoreState {
  readonly hash: string;
  /** The code's remaining life in ms when it was spent. */
  readonly codeLeftMs: number;
  /** The wrong-guess count at that moment, this guess included (it is not forgiven). */
  readonly attempts: number;
  readonly attemptsLeftMs: number;
}

export type OtpVerification =
  /** `hash` lets the caller put the code back (restore) when a later write is busy (DL-37). */
  | ({ readonly kind: 'ok' } & OtpRestoreState)
  /** `blockedNow`: this guess was the one that blocked the link (notify the recruiter once). */
  | { readonly kind: 'wrong'; readonly blockedNow: boolean }
  | { readonly kind: 'blocked'; readonly retryAfterSeconds: number; readonly blockedNow: boolean }
  | { readonly kind: 'cooldown'; readonly retryAfterSeconds: number }
  | { readonly kind: 'none' };

// KEYS: 1 otp, 2 send cooldown, 3 block, 4 spent marker. ARGV: 1 hash, 2 otp ttl, 3 send cooldown s, 4 phase.
const ISSUE = `
if ARGV[4] == 'PRE_START' then
  local blocked = redis.call('PTTL', KEYS[3])
  if blocked > 0 then return {'blocked', blocked} end
end
local wait = redis.call('PTTL', KEYS[2])
if wait > 0 then return {'wait', wait} end
redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
-- A newer code makes any older spent code unrestorable.
redis.call('DEL', KEYS[4])
return {'issued', 0}
`;

// KEYS: 1 otp, 2 attempts, 3 block, 4 cooldown.
// ARGV: 1 phase, 2 max attempts, 3 block s, 4 attempts ttl s, 5 cooldown ms.
const RESERVE = `
if ARGV[1] == 'PRE_START' then
  local blocked = redis.call('PTTL', KEYS[3])
  if blocked > 0 then return {'blocked', blocked, 0} end
else
  local took = redis.call('SET', KEYS[4], '1', 'PX', ARGV[5], 'NX')
  if not took then return {'cooldown', redis.call('PTTL', KEYS[4]), 0} end
end
local hash = redis.call('GET', KEYS[1])
if not hash then
  if ARGV[1] == 'LIVE' then redis.call('DEL', KEYS[4]) end
  return {'none', 0, 0}
end
if ARGV[1] == 'PRE_START' then
  local n = redis.call('INCR', KEYS[2])
  if n == 1 then redis.call('EXPIRE', KEYS[2], ARGV[4]) end
  if n > tonumber(ARGV[2]) then
    local fresh = redis.call('SET', KEYS[3], '1', 'EX', ARGV[3], 'NX')
    redis.call('DEL', KEYS[1])
    return {'blocked', redis.call('PTTL', KEYS[3]), fresh and 1 or 0}
  end
  return {'ok', hash, n}
end
return {'ok', hash, 0}
`;

// KEYS: 1 otp, 2 attempts, 3 cooldown, 4 spent marker. ARGV: 1 the hash that was compared,
// 2 marker life in ms. Returns {1, remaining code life ms, wrong-guess count, its remaining ms}: the
// state the caller needs to put everything back if a later write is busy (DL-37), or {0, 0, 0, 0}.
const CONSUME = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  local otpLeft = redis.call('PTTL', KEYS[1])
  local attempts = tonumber(redis.call('GET', KEYS[2])) or 0
  local attemptsLeft = redis.call('PTTL', KEYS[2])
  redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
  redis.call('SET', KEYS[4], ARGV[1], 'PX', ARGV[2])
  return {1, otpLeft, attempts, attemptsLeft}
end
return {0, 0, 0, 0}
`;

// KEYS: 1 otp, 2 attempts, 3 spent marker, 4 block.
// ARGV: 1 hash, 2 code life left ms, 3 wrong-guess count, 4 its life left ms, 5 phase.
// Restores only while the spent marker still names THIS code (so an older code never returns after
// a newer one was issued or used), only with the life it had left, and never touches the cooldown.
const RESTORE = `
if redis.call('GET', KEYS[3]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[3])
if tonumber(ARGV[2]) <= 0 then return 0 end
if redis.call('PTTL', KEYS[4]) > 0 then return 0 end
if not redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then return 0 end
if ARGV[5] == 'PRE_START' and tonumber(ARGV[3]) > 0 then
  local cur = tonumber(redis.call('GET', KEYS[2])) or 0
  if cur < tonumber(ARGV[3]) then
    if cur > 0 then
      redis.call('SET', KEYS[2], ARGV[3], 'KEEPTTL')
    else
      redis.call('SET', KEYS[2], ARGV[3], 'PX', math.max(tonumber(ARGV[4]), 1000))
    end
  end
end
return 1
`;

// KEYS: 1 otp, 2 attempts, 3 block. ARGV: 1 block s.
const BLOCK = `
local fresh = redis.call('SET', KEYS[3], '1', 'EX', ARGV[1], 'NX')
redis.call('DEL', KEYS[1], KEYS[2])
if fresh then return 1 end
return 0
`;

function ceilSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

@Injectable()
export class OtpService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private pepper(): string {
    const pepper = this.config.get('OTP_PEPPER', { infer: true });
    if (pepper === undefined) {
      throw new CodedHttpException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'The candidate portal is not configured.',
        'CANDIDATE_PORTAL_UNCONFIGURED',
      );
    }
    return pepper;
  }

  /** HMAC-SHA256 keyed with the server pepper, bound to the invitation (hex). */
  hashCode(invitationId: string, code: string): string {
    return createHmac('sha256', this.pepper()).update(`${invitationId}:${code}`).digest('hex');
  }

  private static key(prefix: string, invitationId: string): string {
    return `${prefix}:${invitationId}`;
  }

  /** A fresh 6-digit code from the CSPRNG, replacing any earlier one for this invitation. */
  async issue(invitationId: string, phase: OtpPhase): Promise<OtpIssue> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await ensureConnected(this.redis);
    const [kind, value] = (await this.redis.eval(
      ISSUE,
      4,
      OtpService.key('otp', invitationId),
      OtpService.key('otp-send', invitationId),
      OtpService.key('otp-block', invitationId),
      OtpService.key('otp-spent', invitationId),
      this.hashCode(invitationId, code),
      String(OTP_TTL_SECONDS),
      String(OTP_SEND_COOLDOWN_SECONDS),
      phase,
    )) as [string, number];
    if (kind === 'blocked') return { kind, retryAfterSeconds: ceilSeconds(value) };
    if (kind === 'wait') return { kind, retryAfterSeconds: ceilSeconds(value) };
    return { kind: 'issued', code };
  }

  /** Drops a code that could not be emailed and clears the send cooldown, so a retry is allowed. */
  async discard(invitationId: string): Promise<void> {
    await ensureConnected(this.redis);
    await this.redis.del(
      OtpService.key('otp', invitationId),
      OtpService.key('otp-send', invitationId),
    );
  }

  /**
   * Puts a code that verify() spent back, for a request whose later database write was busy (503;
   * the client retries with the same code, DL-37). It restores the exact state verify() saw: the
   * code with the life it had left, and before the test the wrong-guess count with its life (this
   * guess included, so nothing is forgiven). It never touches the cooldown, never overwrites a
   * newer code or a larger counter, does nothing when the code would have expired or the link is
   * blocked, and works only while the spent marker still names this code (an older code never
   * returns after a newer one was issued). Returns whether the code came back.
   */
  async restore(invitationId: string, state: OtpRestoreState, phase: OtpPhase): Promise<boolean> {
    await ensureConnected(this.redis);
    const restored = (await this.redis.eval(
      RESTORE,
      4,
      OtpService.key('otp', invitationId),
      OtpService.key('otp-attempts', invitationId),
      OtpService.key('otp-spent', invitationId),
      OtpService.key('otp-block', invitationId),
      state.hash,
      String(state.codeLeftMs),
      String(state.attempts),
      String(state.attemptsLeftMs),
      phase,
    )) as number;
    return restored === 1;
  }

  /** Seconds the link stays blocked before the test starts, or 0. */
  async blockedSeconds(invitationId: string): Promise<number> {
    await ensureConnected(this.redis);
    const ms = await this.redis.pttl(OtpService.key('otp-block', invitationId));
    return ms > 0 ? ceilSeconds(ms) : 0;
  }

  async verify(invitationId: string, code: string, phase: OtpPhase): Promise<OtpVerification> {
    const expected = this.hashCode(invitationId, code);
    await ensureConnected(this.redis);
    const keys = [
      OtpService.key('otp', invitationId),
      OtpService.key('otp-attempts', invitationId),
      OtpService.key('otp-block', invitationId),
      OtpService.key('otp-cooldown', invitationId),
    ];
    const [kind, value, extra] = (await this.redis.eval(
      RESERVE,
      4,
      ...keys,
      phase,
      String(OTP_MAX_ATTEMPTS),
      String(OTP_BLOCK_SECONDS),
      String(OTP_BLOCK_SECONDS),
      String(OTP_COOLDOWN_SECONDS * 1000),
    )) as [string, string | number, number];

    if (kind === 'none') return { kind: 'none' };
    if (kind === 'blocked') {
      return { kind, retryAfterSeconds: ceilSeconds(Number(value)), blockedNow: extra === 1 };
    }
    if (kind === 'cooldown') return { kind, retryAfterSeconds: ceilSeconds(Number(value)) };

    const stored = Buffer.from(String(value), 'utf8');
    const candidate = Buffer.from(expected, 'utf8');
    const matches = stored.length === candidate.length && timingSafeEqual(stored, candidate);
    if (matches) {
      const [spent, codeLeftMs, attempts, attemptsLeftMs] = (await this.redis.eval(
        CONSUME,
        4,
        keys[0] as string,
        keys[1] as string,
        keys[3] as string,
        OtpService.key('otp-spent', invitationId),
        String(value),
        String(SPENT_MARKER_MS),
      )) as [number, number, number, number];
      // 0: a concurrent request spent this code first (or a block removed it). Only one wins, and
      // the loser is not a wrong guess: it is told there is no code waiting, and nothing is logged.
      return spent === 1
        ? { kind: 'ok', hash: String(value), codeLeftMs, attempts, attemptsLeftMs }
        : { kind: 'none' };
    }

    const attempt = Number(extra);
    if (phase === 'PRE_START' && attempt >= OTP_MAX_ATTEMPTS) {
      const fresh = (await this.redis.eval(
        BLOCK,
        3,
        keys[0] as string,
        keys[1] as string,
        keys[2] as string,
        String(OTP_BLOCK_SECONDS),
      )) as number;
      return { kind: 'wrong', blockedNow: fresh === 1 };
    }
    return { kind: 'wrong', blockedNow: false };
  }
}
