// TC-098 / TC-006 (FR-107, FR-103; FU-BE-64): the forgot-password counters (pwreset:ip:*,
// pwreset:email:*) and the per-org invite slot counter (invite:org:<org>:<hour>) are one atomic
// Redis script: limits are unchanged, and a counter key that has lost its TTL gets one again on
// the next hit (the old non-atomic code could leave a permanent lockout). The login limit is NOT
// one of these counters: it is the database reservation (FR-101, tc-002) and the throttler
// (nfr-04), so it is not covered here.
import { Redis } from 'ioredis';
import request from 'supertest';
import { sha256Hex } from '../../src/auth/crypto.util';
import { UserRole } from '../../src/generated/prisma/client';
import { API, boot, createUser, Harness, PASSWORD } from '../support/harness';
import { actor, call } from '../support/be03-helpers';
import { ADMIN_USERS } from '../support/be03-routes';

const WINDOW = 3600;
const INVITE_LIMIT = 3;

describe('TC-098 TC-006 (FU-BE-64): atomic window counters', () => {
  let h: Harness;
  let redis: Redis;
  beforeAll(async () => {
    h = await boot({ env: { INVITE_RATE_LIMIT_PER_ORG_HOUR: String(INVITE_LIMIT) } });
    redis = new Redis(h.infra.redis.getConnectionUrl());
  });
  afterAll(async () => {
    redis?.disconnect();
    await h?.close();
  });

  const forgot = async (email: string): Promise<request.Response> => {
    const res = await request(h.app.getHttpServer())
      .post(`${API}/auth/password/forgot`)
      .send({ email });
    await h.settle();
    return res;
  };
  const clear = async (pattern: string): Promise<void> => {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  };
  const ttlOk = (ttl: number): boolean => ttl > 0 && ttl <= WINDOW;

  it('TC-098: forgot limits are unchanged: 3 mails per email per hour (4th is a silent 202), 10 requests per IP (11th is 429); both counters carry a TTL', async () => {
    await clear('pwreset:*');
    const u = await createUser(h, { role: UserRole.AUTHOR });
    h.mails.length = 0;
    for (let i = 0; i < 3; i++) expect((await forgot(u.email)).status).toBe(202);
    expect(h.mails).toHaveLength(3);
    expect((await forgot(u.email)).status).toBe(202);
    expect(h.mails).toHaveLength(3); // over the email limit: same answer, nothing sent
    const keys = await redis.keys('pwreset:*');
    expect(keys.sort()).toHaveLength(2);
    for (const k of keys) expect(ttlOk(await redis.ttl(k))).toBe(true);
    for (let i = 0; i < 6; i++) {
      expect((await forgot(`nobody-${i}@example.com`)).status).toBe(202); // IP hits 5..10
    }
    const ipKey = keys.find((k) => k.startsWith('pwreset:ip:'));
    expect(await redis.get(ipKey ?? '')).toBe('10');
    expect((await forgot('nobody-x@example.com')).status).toBe(429);
    expect(await redis.get(ipKey ?? '')).toBe('11');
  });

  it('TC-098: a forgot counter key left without a TTL is repaired by the next hit and keeps counting exactly', async () => {
    await clear('pwreset:*');
    const u = await createUser(h, { role: UserRole.AUTHOR });
    expect((await forgot(u.email)).status).toBe(202);
    const emailKey = `pwreset:email:${sha256Hex(u.email.toLowerCase())}`;
    const ipKey = (await redis.keys('pwreset:ip:*'))[0] ?? '';
    expect(ipKey).not.toBe('');
    await redis.persist(emailKey);
    await redis.persist(ipKey);
    expect(await redis.ttl(emailKey)).toBe(-1);
    expect(await redis.ttl(ipKey)).toBe(-1);
    expect((await forgot(u.email)).status).toBe(202);
    expect(ttlOk(await redis.ttl(emailKey))).toBe(true);
    expect(ttlOk(await redis.ttl(ipKey))).toBe(true);
    expect(await redis.get(emailKey)).toBe('2');
    expect(await redis.get(ipKey)).toBe('2');
  });

  it('TC-006: the per-org invite slot allows exactly the configured number per hour, then 429; the key carries a TTL', async () => {
    const org = (await h.owner.organization.create({ data: { name: 'QA Org invite limit' } })).id;
    const admin = await actor(h, UserRole.SUPER_ADMIN, org);
    const invite = (i: number): request.Test =>
      call(h, 'POST', ADMIN_USERS, admin.token, {
        email: `qa-slot-${i}-${Date.now()}@example.com`,
        name: 'Slot',
        role: 'RECRUITER',
        currentPassword: PASSWORD,
      });
    for (let i = 0; i < INVITE_LIMIT; i++) await invite(i).expect(201);
    const keys = await redis.keys(`invite:org:${org}:*`);
    expect(keys).toHaveLength(1);
    expect(ttlOk(await redis.ttl(keys[0] ?? ''))).toBe(true);
    await invite(99).expect(429);
    expect(await redis.get(keys[0] ?? '')).toBe(String(INVITE_LIMIT + 1));
  });

  it('TC-006: an invite slot key left without a TTL is repaired by the next invite', async () => {
    const org = (await h.owner.organization.create({ data: { name: 'QA Org invite repair' } })).id;
    const admin = await actor(h, UserRole.SUPER_ADMIN, org);
    const invite = (i: number): request.Test =>
      call(h, 'POST', ADMIN_USERS, admin.token, {
        email: `qa-slot-r-${i}-${Date.now()}@example.com`,
        name: 'Slot',
        role: 'RECRUITER',
        currentPassword: PASSWORD,
      });
    await invite(0).expect(201);
    const key = (await redis.keys(`invite:org:${org}:*`))[0] ?? '';
    expect(key).not.toBe('');
    await redis.persist(key);
    expect(await redis.ttl(key)).toBe(-1);
    await invite(1).expect(201);
    expect(ttlOk(await redis.ttl(key))).toBe(true);
    expect(await redis.get(key)).toBe('2');
  });
});
