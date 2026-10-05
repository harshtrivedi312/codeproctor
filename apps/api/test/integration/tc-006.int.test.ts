// TC-006 (FR-105): audit on data access. Expected: an audit_logs row with actor, entity and IP when
// a reviewer opens a session review. The review route is BE-13, so the end-to-end case is a todo.
// What exists and is tested here: the append-only guarantee (ADR 0006 section 7, D-35) enforced by
// the database for the role the API runs as, and the shape of the rows the API already writes.
import request from 'supertest';
import { Client } from 'pg';
import { sha256Hex } from '../../src/auth/crypto.util';
import { UserRole } from '../../src/generated/prisma/client';
import { API, Body, boot, createUser, Harness, login, TOTP_SECRET } from '../support/harness';

describe('TC-006 (FR-105): audit log is append-only and records who, what, when, IP', () => {
  let h: Harness;
  let appUser: Client;
  beforeAll(async () => {
    h = await boot();
    appUser = new Client({ connectionString: h.appUserUrl });
    await appUser.connect();
  });
  afterAll(async () => {
    await appUser?.end();
    await h?.close();
  });

  async function newAuditRow(): Promise<string> {
    const r = await appUser.query<{ id: string }>(
      `INSERT INTO audit_logs (org_id, action, entity_type, entity_id, ip, metadata)
       VALUES ($1, 'QA_PROBE', 'session', 'qa-1', '203.0.113.7', '{"k":"v"}') RETURNING id::text`,
      [h.orgId],
    );
    return r.rows[0]?.id ?? '';
  }

  const denied = async (sql: string, params: unknown[] = []): Promise<string> => {
    try {
      await appUser.query(sql, params);
    } catch (e) {
      const err = e as { code?: string; message: string };
      return `${err.code}:${err.message}`;
    }
    return 'allowed';
  };

  it('TC-006: app_user can append and read audit rows', async () => {
    const id = await newAuditRow();
    const r = await appUser.query(`SELECT action, host(ip) AS ip FROM audit_logs WHERE id = $1`, [
      id,
    ]);
    expect(r.rows[0]).toMatchObject({ action: 'QA_PROBE', ip: '203.0.113.7' });
  });

  it('TC-006: app_user cannot UPDATE an audit row', async () => {
    const id = await newAuditRow();
    expect(await denied(`UPDATE audit_logs SET action = 'TAMPERED' WHERE id = $1`, [id])).toMatch(
      /^42501:/,
    );
    expect(await denied(`UPDATE audit_logs SET actor_id = NULL`)).toMatch(/^42501:/);
  });

  it('TC-006: app_user cannot DELETE or TRUNCATE audit rows', async () => {
    const id = await newAuditRow();
    expect(await denied(`DELETE FROM audit_logs WHERE id = $1`, [id])).toMatch(/^42501:/);
    expect(await denied(`TRUNCATE audit_logs`)).toMatch(/^42501:/);
    const left = await appUser.query(`SELECT 1 FROM audit_logs WHERE id = $1`, [id]);
    expect(left.rowCount).toBe(1);
  });

  it('TC-006: app_user cannot rewrite the identity column or change grants or the table itself', async () => {
    expect(
      await denied(
        `INSERT INTO audit_logs (id, org_id, action, entity_type) VALUES (1, $1, 'x', 'y')`,
        [h.orgId],
      ),
    ).toMatch(/^428C9:|^42501:/);
    // A non-owner GRANT does not error, it just grants nothing; the proof is that UPDATE still fails.
    await denied(`GRANT UPDATE ON audit_logs TO app_user`);
    expect(await denied(`UPDATE audit_logs SET action = 'X'`)).toMatch(/^42501:/);
    expect(await denied(`ALTER TABLE audit_logs DISABLE TRIGGER ALL`)).toMatch(/^42501:/);
    expect(await denied(`DROP TABLE audit_logs`)).toMatch(/^42501:/);
  });

  it('FR-105: an audit row from the API carries actor, org, action, entity type, server timestamp and the caller IP, with IDs only in metadata', async () => {
    const u = await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET });
    const code = 'ABCDEFGHJKLMNPQR';
    await h.owner.user.update({
      where: { id: u.id },
      data: { recoveryCodeHashes: [sha256Hex(code)] },
    });
    const { challengeToken } = (await login(h, u.email).expect(200)).body as Body;
    const before = Date.now();
    await request(h.app.getHttpServer())
      .post(`${API}/auth/2fa/verify`)
      .send({ challengeToken, code })
      .expect(200);
    const rows = await h.owner.auditLog.findMany({
      where: { actorId: u.id, action: 'AUTH_RECOVERY_CODE_USED' },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.orgId).toBe(h.orgId);
    expect(row?.entityType).toEqual(expect.any(String));
    expect(row?.ip).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
    expect(Math.abs((row?.createdAt.getTime() ?? 0) - before)).toBeLessThan(10_000);
    const text = JSON.stringify(row?.metadata);
    expect(text).not.toContain(code);
    expect(text).not.toContain(u.email);
  });

  it.todo(
    'TC-006: a reviewer opening GET /review/sessions/:id writes one audit_logs row with actor, entity and IP (needs BE-13 review bundle route, BE-03 audit interceptor)',
  );
});
