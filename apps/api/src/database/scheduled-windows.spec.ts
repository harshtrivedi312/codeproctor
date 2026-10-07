// C-53 (ADR 0017 section 4.7; owner decisions C-53 and P-40/D-60; DL-44): `scheduled_windows`, the table that the
// start and stop schedules act on, and `invitations.time_zone`. Migrations 20261006204813_scheduled_windows and
// 20261006204856_invitations_time_zone.
//
// What these tests pin, against real Postgres 16 (Testcontainers; Docker is required) with the real migrations:
//   - the catalog: columns, the two enum types, the three foreign keys (the composite invitation key above all),
//     the two named CHECKs, the two indexes (one partial unique), the updated_at trigger, app_user's grants;
//   - the rules those give: a SLOT row names an invitation of its own organisation and no reviewer, a REVIEW row
//     the reverse; at most one SCHEDULED row per invitation; a SLOT row is deleted, never nulled (the CHECK);
//   - the extension: org scope filters the table; CANDIDATE scope is refused; the one cross-organisation read is
//     SCHEDULE_CAPACITY, five columns, and every other shape, reason or write is refused before any statement;
//   - invitations.time_zone is hidden from CANDIDATE reads.
import { Client } from 'pg';
import type { PrismaClient } from '../generated/prisma/client.js';
import { setCandidateFacts } from './candidate-facts';
import { createPrismaClient } from './create-prisma-client';
import { OrgScopeViolationError } from './errors';
import { OrgContextService } from './org-context';
import { createOrgScopedClient } from './org-scope.extension';
import { startMigratedDatabase } from './testing/migrated-postgres';
import type { MigratedDatabase } from './testing/migrated-postgres';
import { createTenant } from './testing/tenant-fixtures';
import type { SessionChain, TenantFixture } from './testing/tenant-fixtures';

const START = new Date('2026-11-02T09:00:00.000Z');
const hours = (n: number): Date => new Date(START.getTime() + n * 3_600_000);
const FIVE = { startsAt: true, endsAt: true, ceilingAt: true, status: true, kind: true } as const;

describe('scheduled_windows and invitations.time_zone (C-53, ADR 0017 4.7; FR-303, FR-304, FR-306, FR-307, TC-106, TC-111, TC-008)', () => {
  let db: MigratedDatabase;
  let owner: PrismaClient;
  let appUser: PrismaClient;
  let client: ReturnType<typeof createOrgScopedClient>;
  const orgContext = new OrgContextService();
  let pg: Client;
  let appPg: Client;
  let A: TenantFixture;
  let B: TenantFixture;

  const statementCount = async (): Promise<number> =>
    (await db.statements.read()).reduce((sum, s) => sum + s.calls, 0);
  const failure = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );
  const asCandidate = <R>(chain: SessionChain, fn: () => Promise<R>): Promise<R> =>
    orgContext.runAsCandidate(chain.orgId, chain.sessionId, async () => {
      setCandidateFacts(orgContext, {
        candidateId: chain.candidateId,
        invitationId: chain.invitationId,
        testId: chain.testId,
      });
      return fn();
    });

  /** Inserts a row as `as` (the owner by default) with plain SQL; returns its id. */
  async function insert(
    row: {
      orgId: string;
      kind: 'SLOT' | 'REVIEW';
      invitationId?: string | null;
      requestedBy?: string | null;
      startsAt?: Date;
      endsAt?: Date;
      ceilingAt?: Date;
      status?: 'SCHEDULED' | 'CANCELLED' | 'DONE';
    },
    as: Client = pg,
  ): Promise<string> {
    const result = await as.query<{ id: string }>(
      `INSERT INTO scheduled_windows (org_id, kind, invitation_id, requested_by, starts_at, ends_at, ceiling_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        row.orgId,
        row.kind,
        row.invitationId ?? null,
        row.requestedBy ?? null,
        row.startsAt ?? hours(0),
        row.endsAt ?? hours(2),
        row.ceilingAt ?? hours(4),
        row.status ?? 'SCHEDULED',
      ],
    );
    return (result.rows[0] as { id: string }).id;
  }
  /** The SQLSTATE a statement fails with, or undefined. */
  async function sqlState(run: Promise<unknown>): Promise<string | undefined> {
    const error = await failure(run);
    return (error as { code?: string } | undefined)?.code;
  }

  beforeAll(async () => {
    db = await startMigratedDatabase({ statementStats: true });
    owner = createPrismaClient(db.ownerUrl);
    appUser = createPrismaClient(db.appUserUrl);
    client = createOrgScopedClient(appUser, orgContext);
    pg = new Client({ connectionString: db.ownerUrl });
    await pg.connect();
    appPg = new Client({ connectionString: db.appUserUrl });
    await appPg.connect();
    // createTenant gives each tenant one SCHEDULED SLOT window of its own invitation.
    A = await createTenant(owner, 'sw-a');
    B = await createTenant(owner, 'sw-b');
    // The tenant fixture's window is SCHEDULED: cancel it, so the tests below can schedule the invitation again.
    await pg.query(`UPDATE scheduled_windows SET status = 'CANCELLED'`);
  });

  afterAll(async () => {
    await appPg?.end();
    await pg?.end();
    await appUser?.$disconnect();
    await owner?.$disconnect();
    await db?.stop();
  });

  // ---- the catalog ------------------------------------------------------------------------------

  it('TC-008 the table has the eleven columns of ADR 0017 4.7, with their types and nullability', async () => {
    const result = await pg.query<{
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, udt_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'scheduled_windows' ORDER BY ordinal_position`,
    );
    expect(result.rows.map((r) => [r.column_name, r.udt_name, r.is_nullable])).toEqual([
      ['id', 'uuid', 'NO'],
      ['org_id', 'uuid', 'NO'],
      ['kind', 'scheduled_window_kind', 'NO'],
      ['invitation_id', 'uuid', 'YES'],
      ['requested_by', 'uuid', 'YES'],
      ['starts_at', 'timestamptz', 'NO'],
      ['ends_at', 'timestamptz', 'NO'],
      ['ceiling_at', 'timestamptz', 'NO'],
      ['status', 'scheduled_window_status', 'NO'],
      ['created_at', 'timestamptz', 'NO'],
      ['updated_at', 'timestamptz', 'NO'],
    ]);
  });

  it('TC-008 the two enum types have exactly the values of ADR 0017 4.7, in order', async () => {
    const result = await pg.query<{ typname: string; labels: string[] }>(
      `SELECT t.typname, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
       WHERE t.typname IN ('scheduled_window_kind', 'scheduled_window_status') GROUP BY t.typname ORDER BY t.typname`,
    );
    expect(result.rows).toEqual([
      { typname: 'scheduled_window_kind', labels: ['SLOT', 'REVIEW'] },
      { typname: 'scheduled_window_status', labels: ['SCHEDULED', 'CANCELLED', 'DONE'] },
    ]);
  });

  it('TC-008 the foreign keys: the organisation, the composite (invitation_id, org_id) key and the staff reference, all NO ACTION', async () => {
    const result = await pg.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'scheduled_windows'::regclass AND contype = 'f' ORDER BY conname`,
    );
    expect(result.rows).toEqual([
      {
        conname: 'scheduled_windows_invitation_id_org_id_fkey',
        def: 'FOREIGN KEY (invitation_id, org_id) REFERENCES invitations(id, org_id)',
      },
      {
        conname: 'scheduled_windows_org_id_fkey',
        def: 'FOREIGN KEY (org_id) REFERENCES organizations(id)',
      },
      {
        conname: 'scheduled_windows_requested_by_fkey',
        def: 'FOREIGN KEY (requested_by) REFERENCES users(id)',
      },
    ]);
  });

  it('TC-106 the two CHECKs, by name and definition', async () => {
    const result = await pg.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'scheduled_windows'::regclass AND contype = 'c' ORDER BY conname`,
    );
    expect(result.rows.map((r) => r.conname)).toEqual([
      'scheduled_windows_kind_refs_check',
      'scheduled_windows_times_check',
    ]);
    expect(result.rows[1]?.def).toBe('CHECK (((ends_at > starts_at) AND (ceiling_at > ends_at)))');
  });

  it('TC-106 the indexes: (org_id, starts_at) and the partial unique (invitation_id) WHERE status = SCHEDULED', async () => {
    const result = await pg.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'scheduled_windows' ORDER BY indexname`,
    );
    const defs = Object.fromEntries(result.rows.map((r) => [r.indexname, r.indexdef]));
    expect(Object.keys(defs).sort()).toEqual([
      'scheduled_windows_invitation_id_scheduled_key',
      'scheduled_windows_org_id_starts_at_idx',
      'scheduled_windows_pkey',
    ]);
    expect(defs.scheduled_windows_invitation_id_scheduled_key).toContain('CREATE UNIQUE INDEX');
    expect(defs.scheduled_windows_invitation_id_scheduled_key).toContain(
      "WHERE (status = 'SCHEDULED'::scheduled_window_status)",
    );
    expect(defs.scheduled_windows_org_id_starts_at_idx).toContain('(org_id, starts_at)');
  });

  it('TC-008 invitations.time_zone is a nullable text column with no default', async () => {
    const result = await pg.query<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'invitations' AND column_name = 'time_zone'`,
    );
    expect(result.rows).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }]);
  });

  it('TC-008 app_user may SELECT, INSERT, UPDATE and DELETE scheduled_windows (retention deletes SLOT rows)', async () => {
    const result = await pg.query<Record<string, boolean>>(
      `SELECT has_table_privilege('app_user', 'scheduled_windows', 'SELECT') AS s,
              has_table_privilege('app_user', 'scheduled_windows', 'INSERT') AS i,
              has_table_privilege('app_user', 'scheduled_windows', 'UPDATE') AS u,
              has_table_privilege('app_user', 'scheduled_windows', 'DELETE') AS d,
              has_table_privilege('app_user', 'scheduled_windows', 'TRUNCATE') AS t`,
    );
    expect(result.rows[0]).toEqual({ s: true, i: true, u: true, d: true, t: false });
  });

  // ---- the rules of the constraints ----------------------------------------------------------------------

  it('TC-106 a valid SLOT row and a valid REVIEW row are accepted', async () => {
    await expect(
      insert({ orgId: A.orgId, kind: 'SLOT', invitationId: A.chain.invitationId }),
    ).resolves.toEqual(expect.any(String));
    await expect(
      insert({ orgId: A.orgId, kind: 'REVIEW', requestedBy: A.userId }),
    ).resolves.toEqual(expect.any(String));
    await pg.query(`UPDATE scheduled_windows SET status = 'CANCELLED' WHERE org_id = $1`, [
      A.orgId,
    ]);
  });

  it.each([
    ['a SLOT row without an invitation', { kind: 'SLOT' as const }],
    ['a REVIEW row without a reviewer', { kind: 'REVIEW' as const }],
    [
      'a SLOT row that also names a reviewer',
      { kind: 'SLOT' as const, withInvitation: true, withReviewer: true },
    ],
    [
      'a REVIEW row that also names an invitation',
      { kind: 'REVIEW' as const, withInvitation: true, withReviewer: true },
    ],
  ])('TC-106 %s is refused by scheduled_windows_kind_refs_check', async (_what, shape) => {
    const state = await sqlState(
      insert({
        orgId: A.orgId,
        kind: shape.kind,
        invitationId: 'withInvitation' in shape ? A.chain.invitationId : null,
        requestedBy: 'withReviewer' in shape ? A.userId : null,
        status: 'CANCELLED',
      }),
    );
    expect(state).toBe('23514');
  });

  it.each([
    ['an end at its start', { endsAt: hours(0) }],
    ['an end before its start', { endsAt: hours(-1) }],
    ['a ceiling at its end', { ceilingAt: hours(2) }],
    ['a ceiling before its end', { ceilingAt: hours(1) }],
  ])('TC-106 %s is refused by scheduled_windows_times_check', async (_what, times) => {
    const state = await sqlState(
      insert({ orgId: A.orgId, kind: 'REVIEW', requestedBy: A.userId, ...times }),
    );
    expect(state).toBe('23514');
  });

  it('TC-106 at most one SCHEDULED window per invitation; a CANCELLED or DONE one does not count; REVIEW rows never collide', async () => {
    const first = await insert({
      orgId: B.orgId,
      kind: 'SLOT',
      invitationId: B.chain.invitationId,
    });
    expect(
      await sqlState(insert({ orgId: B.orgId, kind: 'SLOT', invitationId: B.chain.invitationId })),
    ).toBe('23505');
    await expect(
      insert({ orgId: B.orgId, kind: 'SLOT', invitationId: B.chain.invitationId, status: 'DONE' }),
    ).resolves.toEqual(expect.any(String));
    // A reschedule: cancel the live window, then schedule the new one.
    await pg.query(`UPDATE scheduled_windows SET status = 'CANCELLED' WHERE id = $1`, [first]);
    await expect(
      insert({
        orgId: B.orgId,
        kind: 'SLOT',
        invitationId: B.chain.invitationId,
        startsAt: hours(24),
        endsAt: hours(26),
        ceilingAt: hours(28),
      }),
    ).resolves.toEqual(expect.any(String));
    await insert({ orgId: B.orgId, kind: 'REVIEW', requestedBy: B.userId });
    await expect(
      insert({ orgId: B.orgId, kind: 'REVIEW', requestedBy: B.userId }),
    ).resolves.toEqual(expect.any(String));
    await pg.query(`UPDATE scheduled_windows SET status = 'CANCELLED' WHERE org_id = $1`, [
      B.orgId,
    ]);
  });

  it('TC-008 the composite key refuses a SLOT row whose invitation belongs to another organisation', async () => {
    expect(
      await sqlState(
        insert({
          orgId: A.orgId,
          kind: 'SLOT',
          invitationId: B.chain.invitationId,
          status: 'CANCELLED',
        }),
      ),
    ).toBe('23503');
  });

  it('TC-106 a SLOT row is deleted, not nulled: app_user can delete it, and nulling its invitation fails the CHECK', async () => {
    const id = await insert(
      { orgId: A.orgId, kind: 'SLOT', invitationId: A.chain.invitationId, status: 'DONE' },
      appPg,
    );
    expect(
      await sqlState(
        appPg.query(`UPDATE scheduled_windows SET invitation_id = NULL WHERE id = $1`, [id]),
      ),
    ).toBe('23514');
    const deleted = await appPg.query(`DELETE FROM scheduled_windows WHERE id = $1`, [id]);
    expect(deleted.rowCount).toBe(1);
  });

  it('TC-008 updated_at is kept by the database (the set_updated_at trigger)', async () => {
    const id = await insert({
      orgId: A.orgId,
      kind: 'REVIEW',
      requestedBy: A.userId,
      status: 'CANCELLED',
    });
    await pg.query(
      `UPDATE scheduled_windows SET updated_at = '2020-01-01T00:00:00Z' WHERE id = $1`,
      [id],
    );
    // The trigger overwrites any value set by the update itself, so the row carries the time of the update.
    const after = await pg.query<{ updated_at: Date }>(
      `SELECT updated_at FROM scheduled_windows WHERE id = $1`,
      [id],
    );
    expect((after.rows[0] as { updated_at: Date }).updated_at.getTime()).toBeGreaterThan(
      new Date('2025-01-01T00:00:00Z').getTime(),
    );
  });

  // ---- the extension ----------------------------------------------------------------------------------

  it('TC-008 org scope filters the table: each organisation sees its own windows only', async () => {
    const seenByA = await orgContext.runInOrg(A.orgId, () =>
      client.scheduledWindow.findMany({ select: { id: true, orgId: true } }),
    );
    expect(seenByA.length).toBeGreaterThan(0);
    expect(new Set(seenByA.map((row) => row.orgId))).toEqual(new Set([A.orgId]));
  });

  it('TC-008 an org-scoped create with another organisation’s invitation is refused', async () => {
    const error = await failure(
      orgContext.runInOrg(A.orgId, () =>
        client.scheduledWindow.create({
          data: {
            orgId: A.orgId,
            kind: 'SLOT',
            invitationId: B.chain.invitationId,
            startsAt: hours(0),
            endsAt: hours(2),
            ceilingAt: hours(4),
            status: 'CANCELLED',
          },
        }),
      ),
    );
    expect(error).toBeDefined();
  });

  it('TC-008 CANDIDATE scope cannot touch scheduled_windows', async () => {
    const error = await failure(
      asCandidate(A.chain, () => client.scheduledWindow.findMany({ select: FIVE })),
    );
    expect(error).toBeInstanceOf(OrgScopeViolationError);
  });

  it('TC-111 SCHEDULE_CAPACITY reads every organisation’s windows, in the five columns only', async () => {
    const rows = await orgContext.runSystem('SCHEDULE_CAPACITY', () =>
      client.scheduledWindow.findMany({ select: FIVE, orderBy: { startsAt: 'asc' } }),
    );
    const total = await pg.query<{ n: string }>(`SELECT count(*) AS n FROM scheduled_windows`);
    expect(rows).toHaveLength(Number((total.rows[0] as { n: string }).n));
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(Object.keys(FIVE).sort());
    const counted = await orgContext.runSystem('SCHEDULE_CAPACITY', () =>
      client.scheduledWindow.count({ where: { status: { in: ['SCHEDULED', 'DONE'] } } }),
    );
    const live = await pg.query<{ n: string }>(
      `SELECT count(*) AS n FROM scheduled_windows WHERE status IN ('SCHEDULED', 'DONE')`,
    );
    expect(counted).toBe(Number((live.rows[0] as { n: string }).n));
  });

  it.each([
    [
      'a select of orgId',
      () => client.scheduledWindow.findMany({ select: { startsAt: true, orgId: true } }),
    ],
    ['no select', () => client.scheduledWindow.findMany()],
    [
      'a where on invitationId',
      () => client.scheduledWindow.count({ where: { invitationId: { not: null } } }),
    ],
    [
      'a groupBy of orgId',
      () => client.scheduledWindow.groupBy({ by: ['orgId'], _count: { _all: true } }),
    ],
    ['findFirst', () => client.scheduledWindow.findFirst({ select: FIVE })],
    ['a write', () => client.scheduledWindow.deleteMany({ where: { status: 'CANCELLED' } })],
    ['another model', () => client.session.findMany({ select: { id: true } })],
  ])('TC-008 under SCHEDULE_CAPACITY, %s is refused before any statement', async (_what, run) => {
    const before = await statementCount();
    const error = await failure(
      orgContext.runSystem('SCHEDULE_CAPACITY', run as () => Promise<unknown>),
    );
    expect(error).toBeInstanceOf(OrgScopeViolationError);
    expect(await statementCount()).toBe(before);
  });

  it.each(['BACKGROUND_JOB', 'RETENTION_ERASURE', 'AUTH_BOOTSTRAP'] as const)(
    'TC-008 a %s system scope cannot read or write scheduled_windows (writes run in an org scope)',
    async (reason) => {
      const before = await statementCount();
      expect(
        await failure(
          orgContext.runSystem(reason, () => client.scheduledWindow.findMany({ select: FIVE })),
        ),
      ).toBeInstanceOf(OrgScopeViolationError);
      expect(
        await failure(
          orgContext.runSystem(reason, () =>
            client.scheduledWindow.deleteMany({ where: { kind: 'SLOT' } }),
          ),
        ),
      ).toBeInstanceOf(OrgScopeViolationError);
      expect(await statementCount()).toBe(before);
    },
  );

  it('TC-008 invitations.time_zone is never returned to a CANDIDATE, even when set', async () => {
    await pg.query(`UPDATE invitations SET time_zone = 'Europe/Berlin' WHERE id = $1`, [
      A.chain.invitationId,
    ]);
    const read = await asCandidate(A.chain, () =>
      client.invitation.findFirst({ where: { id: A.chain.invitationId } }),
    );
    expect(read).not.toBeNull();
    expect(read as object).not.toHaveProperty('timeZone');
    const staff = await orgContext.runInOrg(A.orgId, () =>
      client.invitation.findUnique({
        where: { id: A.chain.invitationId },
        select: { timeZone: true },
      }),
    );
    expect(staff).toEqual({ timeZone: 'Europe/Berlin' });
  });
});
