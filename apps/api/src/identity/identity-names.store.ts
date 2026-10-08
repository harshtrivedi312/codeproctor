// Single-use upload names for the identity images (ADR 0013 5.2, 5.6, ADR 0013 CS-3).
//
// The browser never sends an object key: it sends a session-relative NAME that this server issued
// for one purpose (ID_IMAGE or SELFIE). The Redis hash `evidence:{sessionId}` maps each name to
// `{ purpose, state }` and every state change is one atomic compare-and-set (a Lua script), the same
// shape ADR 0013 5.2 defines for evidence names so BE-10 can share the hash. States used here:
// ISSUED -> USED (claimed by a submit), ISSUED -> EXPIRED (refused or rejected), USED -> ISSUED
// (a claim released after a failed insert).
//
// Where name state lives (Redis here, as for evidence names) is hub question 3; this class is the
// one seam to change if the hub chooses Postgres.
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../infrastructure/infrastructure.module';
import { ensureConnected } from '../infrastructure/redis-ready';
import { NAME_TTL_SECONDS } from './identity.constants';
import type { IdentityPurpose } from './identity.constants';

export type NameState = 'ISSUED' | 'USED' | 'EXPIRED';

// Returns 1 when swapped, 0 when the name is unknown or has another purpose, -1 when its state is
// not the expected one.
const CAS = `
local v = redis.call('HGET', KEYS[1], ARGV[1])
if not v then return 0 end
local o = cjson.decode(v)
if o.purpose ~= ARGV[2] then return 0 end
if o.state ~= ARGV[3] then return -1 end
o.state = ARGV[4]
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(o))
return 1
`;

@Injectable()
export class IdentityNamesStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private key(sessionId: string): string {
    return `evidence:${sessionId}`;
  }

  async issue(sessionId: string, name: string, purpose: IdentityPurpose): Promise<void> {
    await ensureConnected(this.redis);
    const key = this.key(sessionId);
    await this.redis
      .multi()
      .hset(key, name, JSON.stringify({ purpose, state: 'ISSUED' }))
      .expire(key, NAME_TTL_SECONDS)
      .exec();
  }

  /** The current state, or null for an unknown name or one issued for another purpose. */
  async state(
    sessionId: string,
    name: string,
    purpose: IdentityPurpose,
  ): Promise<NameState | null> {
    await ensureConnected(this.redis);
    const raw = await this.redis.hget(this.key(sessionId), name);
    if (raw === null) return null;
    try {
      const o = JSON.parse(raw) as { purpose?: string; state?: string };
      if (o.purpose !== purpose) return null;
      return o.state === 'ISSUED' || o.state === 'USED' || o.state === 'EXPIRED' ? o.state : null;
    } catch {
      return null;
    }
  }

  /** One atomic compare-and-set. False when the name is not in `from` (or is not this purpose). */
  async transition(
    sessionId: string,
    name: string,
    purpose: IdentityPurpose,
    from: NameState,
    to: NameState,
  ): Promise<boolean> {
    await ensureConnected(this.redis);
    const result = await this.redis.eval(CAS, 1, this.key(sessionId), name, purpose, from, to);
    return result === 1;
  }
}
