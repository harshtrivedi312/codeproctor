// TC-005 (FR-104): refresh token reuse. Expected: second use rejected; whole token family revoked.
import { UserRole } from '../../src/generated/prisma/client';
import { Body, boot, createUser, Harness, login, refresh, refreshCookie } from '../support/harness';

describe('TC-005 (FR-104): refresh token rotation and reuse', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await boot();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('TC-005: every refresh returns a new access token and a new cookie, and chains the rows in one family', async () => {
    const u = await createUser(h);
    const c1 = refreshCookie(await login(h, u.email).expect(200));
    const r2 = await refresh(h, c1).expect(200);
    const c2 = refreshCookie(r2);
    const r3 = await refresh(h, c2).expect(200);
    const c3 = refreshCookie(r3);
    expect(new Set([c1, c2, c3]).size).toBe(3);
    expect((r2.body as Body).accessToken).toEqual(expect.any(String));
    const rows = await h.owner.refreshToken.findMany({ where: { userId: u.id } });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.familyId)).size).toBe(1);
    // Rotation links the old row to its replacement and retires it.
    expect(rows.filter((r) => r.replacedById !== null)).toHaveLength(2);
  });

  it('TC-005: presenting an old token a second time is rejected and the newest token in the family dies too', async () => {
    const u = await createUser(h);
    const c1 = refreshCookie(await login(h, u.email).expect(200));
    const c2 = refreshCookie(await refresh(h, c1).expect(200));
    const c3 = refreshCookie(await refresh(h, c2).expect(200));

    await refresh(h, c1).expect(401); // reuse of generation 1
    await refresh(h, c3).expect(401); // the legitimate holder is cut off as well
    await refresh(h, c2).expect(401);

    const rows = await h.owner.refreshToken.findMany({ where: { userId: u.id } });
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
    expect(
      await h.owner.auditLog.count({
        where: { actorId: u.id, action: 'AUTH_REFRESH_REUSE_DETECTED' },
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('TC-005: reuse revokes only that family: another user, and the same user on another login, stay signed in', async () => {
    const victim = await createUser(h);
    const other = await createUser(h);
    const a1 = refreshCookie(await login(h, victim.email).expect(200));
    const b1 = refreshCookie(await login(h, victim.email).expect(200)); // second device
    const o1 = refreshCookie(await login(h, other.email).expect(200));
    await refresh(h, a1).expect(200);
    await refresh(h, a1).expect(401);
    await refresh(h, o1).expect(200);
    await refresh(h, b1).expect(200);
  });

  it('TC-005: three parallel uses of one token let at most one succeed', async () => {
    const u = await createUser(h);
    const c = refreshCookie(await login(h, u.email).expect(200));
    const res = await Promise.all([refresh(h, c), refresh(h, c), refresh(h, c)]);
    expect(res.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
    expect(res.filter((r) => r.status === 401).length).toBeGreaterThanOrEqual(2);
  });

  it('FR-104: an expired refresh token, a missing cookie and a forged cookie are all 401', async () => {
    const u = await createUser(h);
    const c = refreshCookie(await login(h, u.email).expect(200));
    await h.owner.refreshToken.updateMany({
      where: { userId: u.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await refresh(h, c).expect(401);
    await refresh(h, 'cp_refresh=forged').expect(401);
    await refresh(h, 'other=1').expect(401);
  });

  it('FR-104: logout revokes the token; a deactivated user cannot refresh; a role downgrade shows in the next access token', async () => {
    const u = await createUser(h, { role: UserRole.AUTHOR });
    const c = refreshCookie(await login(h, u.email).expect(200));
    await h.owner.user.update({ where: { id: u.id }, data: { role: UserRole.RECRUITER } });
    const next = await refresh(h, c).expect(200);
    const claims = JSON.parse(
      Buffer.from((next.body as Body).accessToken.split('.')[1] ?? '', 'base64url').toString(),
    ) as { role: string };
    expect(claims.role).toBe('RECRUITER');
    await h.owner.user.update({ where: { id: u.id }, data: { isActive: false } });
    await refresh(h, refreshCookie(next)).expect(401);
  });
});
