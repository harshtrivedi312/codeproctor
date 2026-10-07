// Limits of the submit route (ADR 0013 section 5.11), checked before any insert. Keys are built from
// the token's session id and the session_questions id the server resolved (CS-3), never from raw
// client input.
//   rl:submit:{sid}            SET NX PX 10000: one submit per 10 s per session
//   submits:{sid}:{sqid}       INCR: at most 20 per question; over the limit the route DECRs and
//                              answers 409 SUBMIT_LIMIT_REACHED; a failed insert DECRs too
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { CodedHttpException } from '../common/coded.exception';
import { REDIS_CLIENT } from '../infrastructure/infrastructure.module';
import { ensureConnected } from '../infrastructure/redis-ready';

export const SUBMIT_INTERVAL_MS = 10_000;
export const MAX_SUBMITS_PER_QUESTION = 20;
const COUNTER_TTL_SECONDS = 7 * 86_400;
const COUNT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
return n
`;

@Injectable()
export class SubmitLimiter {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Throws 429 or 409. On success returns a function that gives the count back (insert failed). */
  async acquire(sessionId: string, sessionQuestionId: string): Promise<() => Promise<void>> {
    await ensureConnected(this.redis);
    const gate = `rl:submit:${sessionId}`;
    const set = await this.redis.set(gate, '1', 'PX', SUBMIT_INTERVAL_MS, 'NX');
    if (set !== 'OK') {
      const ttl = await this.redis.pttl(gate);
      throw new CodedHttpException(
        HttpStatus.TOO_MANY_REQUESTS,
        'Too many requests. Try again shortly.',
        'RATE_LIMITED',
        { retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1000)) },
      );
    }
    const counter = `submits:${sessionId}:${sessionQuestionId}`;
    // INCR and EXPIRE in one script: a crash between them cannot leave a counter with no expiry.
    const count = Number(
      await this.redis.eval(COUNT_SCRIPT, 1, counter, String(COUNTER_TTL_SECONDS)),
    );
    if (count > MAX_SUBMITS_PER_QUESTION) {
      await this.redis.decr(counter);
      throw new CodedHttpException(
        HttpStatus.CONFLICT,
        'This question has reached its submission limit.',
        'SUBMIT_LIMIT_REACHED',
      );
    }
    return async () => {
      await this.redis.decr(counter).catch(() => undefined);
    };
  }
}
