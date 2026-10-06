// ADR 0015 section 4 (waived identity check; FR-305, FR-403): the database guards of an
// identity_checks row. Migrations 20261005235956_identity_check_waived_enum and
// 20261005235957_identity_check_waiver_columns add the WAIVED status, the three video_check columns,
// the video_check_by foreign key and two CHECK constraints (identity_checks_waived_check and
// identity_checks_video_check_check). The existing identity_checks_check is unchanged.
//
// Real Postgres 16 (Testcontainers; Docker is required) with the real migrations applied by
// `prisma migrate deploy`. The constraint tests send plain SQL as the schema owner and read the
// SQLSTATE and constraint name from Postgres, so each test shows which constraint refused the row.
// Constraints bind every role, so the owner is enough; one test goes through the model API as
// app_user, the way ADR 0015 section 6's invite write does.
import { randomUUID } from 'node:crypto';
import { Client, DatabaseError } from 'pg';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from './create-prisma-client';
import { startMigratedDatabase } from './testing/migrated-postgres';
import type { MigratedDatabase } from './testing/migrated-postgres';
import { createTenant } from './testing/tenant-fixtures';
import type { TenantFixture } from './testing/tenant-fixtures';

const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const WAIVED_CHECK = 'identity_checks_waived_check';
const VIDEO_CHECK_CHECK = 'identity_checks_video_check_check';
const STATUS_CHECK = 'identity_checks_check';
const VIDEO_CHECK_FK = 'identity_checks_video_check_by_fkey';

const NOW = new Date('2026-10-05T12:00:00.000Z');

type Values = Record<string, unknown>;

interface Refusal {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
}

describe('identity_checks waiver constraints (FR-305, FR-403; ADR 0015 section 4)', () => {
  let db: MigratedDatabase;
  let owner: PrismaClient;
  let appUser: PrismaClient;
  let pg: Client;
  let A: TenantFixture;
  let B: TenantFixture;
  let testId: string;
  let candidateId: string;

  /** A new session, so each test has its own (session_id, attempt) space. */
  async function newSession(): Promise<string> {
    const invitation = await owner.invitation.create({
      data: {
        orgId: A.orgId,
        testId,
        candidateId,
        tokenHash: `inv-${randomUUID()}`,
        windowStart: NOW,
        windowEnd: new Date(NOW.getTime() + 86_400_000),
      },
    });
    const session = await owner.session.create({
      data: { orgId: A.orgId, invitationId: invitation.id },
    });
    return session.id;
  }

  async function newUser(orgId: string, label: string): Promise<string> {
    const user = await owner.user.create({
      data: {
        orgId,
        email: `${label}-${randomUUID()}@example.test`,
        fullName: `Staff ${label}`,
        passwordHash: 'not-a-real-hash',
        role: 'RECRUITER',
      },
    });
    return user.id;
  }

  /** INSERT with the given columns (names come from this file, never from input). Returns the id. */
  async function insertRow(sessionId: string, values: Values = {}): Promise<string> {
    const columns = ['session_id', ...Object.keys(values)];
    const params: unknown[] = [sessionId, ...Object.values(values)];
    const placeholders = params.map((_, index) => `$${index + 1}`).join(', ');
    const result = await pg.query<{ id: string }>(
      `INSERT INTO identity_checks (${columns.join(', ')}) VALUES (${placeholders}) RETURNING id`,
      params,
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('INSERT returned no id');
    return id;
  }

  async function updateRow(id: string, values: Values): Promise<void> {
    const columns = Object.keys(values);
    const assignments = columns.map((column, index) => `${column} = $${index + 1}`).join(', ');
    await pg.query(`UPDATE identity_checks SET ${assignments} WHERE id = $${columns.length + 1}`, [
      ...Object.values(values),
      id,
    ]);
  }

  async function rowOf(id: string): Promise<Record<string, unknown> | undefined> {
    const result = await pg.query<Record<string, unknown>>(
      'SELECT * FROM identity_checks WHERE id = $1',
      [id],
    );
    return result.rows[0];
  }

  /** The SQLSTATE and constraint name Postgres reports for a statement it refuses. */
  async function refusal(run: Promise<unknown>): Promise<Refusal> {
    try {
      await run;
    } catch (error) {
      if (error instanceof DatabaseError) {
        return { code: error.code, constraint: error.constraint };
      }
      throw error;
    }
    throw new Error('The database accepted the statement; a refusal was expected.');
  }

  /** Every column ADR 0015 section 4's waived_check lists, with a value that is valid for it. */
  const LISTED: ReadonlyArray<readonly [column: string, value: () => unknown]> = [
    ['id_image_key', () => 'identity/synthetic-id.jpg'],
    ['selfie_key', () => 'identity/synthetic-selfie.jpg'],
    ['face_match_score', () => '0.9100'],
    ['model_id', () => 'synthetic-model'],
    ['threshold', () => '0.6000'],
    ['liveness_passed', () => true],
    ['review_reason', () => 'BELOW_THRESHOLD'],
    ['manual_decision', () => 'MATCH'],
    ['reviewed_by', () => A.userId],
    ['reviewed_at', () => NOW],
    ['review_note', () => 'synthetic note'],
  ];
  const listedValue = (column: string): unknown => {
    const entry = LISTED.find(([name]) => name === column);
    if (entry === undefined) throw new Error(`${column} is not a listed column`);
    return entry[1]();
  };

  const VIDEO_VALUES = (userId: string, done = true): Values => ({
    video_check_done: done,
    video_check_by: userId,
    video_check_at: NOW,
  });

  /** What a row of each pre-existing status needs to be valid at all. */
  const baseFor = (status: string): Values =>
    status === 'REVIEWED'
      ? { status, manual_decision: 'MATCH', reviewed_by: A.userId, reviewed_at: NOW }
      : { status };

  beforeAll(async () => {
    db = await startMigratedDatabase();
    owner = createPrismaClient(db.ownerUrl);
    appUser = createPrismaClient(db.appUserUrl);
    pg = new Client({ connectionString: db.ownerUrl });
    await pg.connect();
    A = await createTenant(owner, 'a');
    B = await createTenant(owner, 'b');
    testId = (await owner.test.findFirstOrThrow({ where: { orgId: A.orgId } })).id;
    candidateId = (await owner.candidate.findFirstOrThrow({ where: { orgId: A.orgId } })).id;
  });

  afterAll(async () => {
    await pg?.end();
    await appUser?.$disconnect();
    await owner?.$disconnect();
    await db?.stop();
  });

  // ---- the migrations -------------------------------------------------------------------------

  describe('what the migrations created', () => {
    it('FR-305 WAIVED is the last value of identity_check_status, after the five that existed', async () => {
      const result = await pg.query<{ labels: string[] }>(
        `SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
         FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'identity_check_status'`,
      );
      expect(result.rows[0]?.labels).toEqual([
        'PENDING',
        'PASSED',
        'LOW_CONFIDENCE',
        'MANUAL_REVIEW',
        'REVIEWED',
        'WAIVED',
      ]);
    });

    it('FR-305 the two new CHECK constraints are exactly the ADR 0015 section 4 definitions, and identity_checks_check is unchanged', async () => {
      const result = await pg.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = 'identity_checks'::regclass AND contype = 'c' ORDER BY conname`,
      );
      expect(Object.fromEntries(result.rows.map((row) => [row.conname, row.def]))).toEqual({
        identity_checks_attempt_check: 'CHECK (((attempt >= 1) AND (attempt <= 2)))',
        [STATUS_CHECK]:
          "CHECK (((status = 'REVIEWED'::identity_check_status) = ((manual_decision IS NOT NULL) AND (reviewed_by IS NOT NULL) AND (reviewed_at IS NOT NULL))))",
        [VIDEO_CHECK_CHECK]:
          "CHECK ((((video_check_done IS NULL) = (video_check_by IS NULL)) AND ((video_check_done IS NULL) = (video_check_at IS NULL)) AND ((video_check_done IS NULL) OR (status = 'WAIVED'::identity_check_status))))",
        [WAIVED_CHECK]:
          "CHECK (((status <> 'WAIVED'::identity_check_status) OR ((attempt = 1) AND (id_image_key IS NULL) AND (selfie_key IS NULL) AND (face_match_score IS NULL) AND (model_id IS NULL) AND (threshold IS NULL) AND (liveness_passed IS NULL) AND (review_reason IS NULL) AND (manual_decision IS NULL) AND (reviewed_by IS NULL) AND (reviewed_at IS NULL) AND (review_note IS NULL))))",
      });
    });

    it('FR-305 the three video_check columns are nullable, have no default, and have the ADR types', async () => {
      const result = await pg.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
         WHERE table_name = 'identity_checks' AND column_name LIKE 'video\\_check\\_%'
         ORDER BY column_name`,
      );
      expect(result.rows).toEqual([
        {
          column_name: 'video_check_at',
          data_type: 'timestamp with time zone',
          is_nullable: 'YES',
          column_default: null,
        },
        {
          column_name: 'video_check_by',
          data_type: 'uuid',
          is_nullable: 'YES',
          column_default: null,
        },
        {
          column_name: 'video_check_done',
          data_type: 'boolean',
          is_nullable: 'YES',
          column_default: null,
        },
      ]);
    });

    it('FR-305 video_check_by is a single-column foreign key to users(id) with NO ACTION on delete and update (not org-composite)', async () => {
      const result = await pg.query<{
        conname: string;
        confdeltype: string;
        confupdtype: string;
        target: string;
        columns: string[];
        target_columns: string[];
      }>(
        `SELECT c.conname, c.confdeltype, c.confupdtype, c.confrelid::regclass::text AS target,
                (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns,
                (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS target_columns
         FROM pg_constraint c
         WHERE c.conrelid = 'identity_checks'::regclass AND c.contype = 'f' AND c.conname = $1`,
        [VIDEO_CHECK_FK],
      );
      expect(result.rows).toEqual([
        {
          conname: VIDEO_CHECK_FK,
          confdeltype: 'a', // NO ACTION
          confupdtype: 'a',
          target: 'users',
          columns: ['video_check_by'],
          target_columns: ['id'],
        },
      ]);
    });

    it('FR-305 app_user creates a WAIVED row and records a video check through the model API, as the invite and video-check writes of ADR 0015 section 6 do', async () => {
      const sessionId = await newSession();
      const created = await appUser.identityCheck.create({
        data: { sessionId, attempt: 1, status: 'WAIVED' },
      });
      expect(created).toMatchObject({
        status: 'WAIVED',
        attempt: 1,
        videoCheckDone: null,
        videoCheckById: null,
        videoCheckAt: null,
      });
      const recorded = await appUser.identityCheck.updateMany({
        where: { sessionId, status: 'WAIVED' },
        data: { videoCheckDone: true, videoCheckById: A.userId, videoCheckAt: NOW },
      });
      expect(recorded.count).toBe(1);
      const row = await appUser.identityCheck.findUniqueOrThrow({
        where: { sessionId_attempt: { sessionId, attempt: 1 } },
        include: { videoCheckBy: { select: { id: true } }, reviewedBy: { select: { id: true } } },
      });
      expect(row.videoCheckDone).toBe(true);
      expect(row.videoCheckBy?.id).toBe(A.userId);
      expect(row.reviewedBy).toBeNull();
      // The model API cannot write a WAIVED attempt 2 either.
      await expect(
        appUser.identityCheck.create({ data: { sessionId, attempt: 2, status: 'WAIVED' } }),
      ).rejects.toThrow();
    });
  });

  // ---- identity_checks_waived_check -----------------------------------------------------------

  describe('identity_checks_waived_check', () => {
    it('FR-305 a WAIVED row with attempt 1 and every listed column NULL is accepted', async () => {
      const id = await insertRow(await newSession(), { status: 'WAIVED', attempt: 1 });
      const row = await rowOf(id);
      expect(row).toMatchObject({
        status: 'WAIVED',
        attempt: 1,
        id_image_key: null,
        selfie_key: null,
        face_match_score: null,
        model_id: null,
        threshold: null,
        liveness_passed: null,
        review_reason: null,
        manual_decision: null,
        reviewed_by: null,
        reviewed_at: null,
        review_note: null,
        video_check_done: null,
        video_check_by: null,
        video_check_at: null,
      });
    });

    it('FR-305 the attempt defaults to 1, so a WAIVED row without an attempt is accepted', async () => {
      const id = await insertRow(await newSession(), { status: 'WAIVED' });
      expect(await rowOf(id)).toMatchObject({ status: 'WAIVED', attempt: 1 });
    });

    it.each(LISTED.map(([column]) => column))(
      'FR-305 a WAIVED row with %s set is refused by identity_checks_waived_check',
      async (column) => {
        const sessionId = await newSession();
        expect(
          await refusal(insertRow(sessionId, { status: 'WAIVED', [column]: listedValue(column) })),
        ).toEqual({ code: CHECK_VIOLATION, constraint: WAIVED_CHECK });
        // The refused row left nothing behind.
        const count = await pg.query('SELECT 1 FROM identity_checks WHERE session_id = $1', [
          sessionId,
        ]);
        expect(count.rowCount).toBe(0);
      },
    );

    it('FR-305 a WAIVED row with attempt 2 is refused by identity_checks_waived_check', async () => {
      expect(
        await refusal(insertRow(await newSession(), { status: 'WAIVED', attempt: 2 })),
      ).toEqual({ code: CHECK_VIOLATION, constraint: WAIVED_CHECK });
    });

    it('FR-403 a WAIVED row cannot be updated to carry an identity value, and an existing row that holds one cannot become WAIVED', async () => {
      const waived = await insertRow(await newSession(), { status: 'WAIVED' });
      expect(await refusal(updateRow(waived, { selfie_key: 'identity/late-selfie.jpg' }))).toEqual({
        code: CHECK_VIOLATION,
        constraint: WAIVED_CHECK,
      });
      const pending = await insertRow(await newSession(), { id_image_key: 'identity/id.jpg' });
      expect(await refusal(updateRow(pending, { status: 'WAIVED' }))).toEqual({
        code: CHECK_VIOLATION,
        constraint: WAIVED_CHECK,
      });
      // A row with nothing in the listed columns can become WAIVED.
      const empty = await insertRow(await newSession());
      await updateRow(empty, { status: 'WAIVED' });
      expect(await rowOf(empty)).toMatchObject({ status: 'WAIVED' });
    });

    describe('non-WAIVED rows are unaffected', () => {
      const OLD_STATUSES = ['PENDING', 'PASSED', 'LOW_CONFIDENCE', 'MANUAL_REVIEW'] as const;

      it.each(OLD_STATUSES)(
        'FR-403 a %s row takes attempt 2 and every identity column the ADR lists',
        async (status) => {
          const id = await insertRow(await newSession(), {
            status,
            attempt: 2,
            id_image_key: 'identity/id.jpg',
            selfie_key: 'identity/selfie.jpg',
            face_match_score: '0.4100',
            model_id: 'synthetic-model',
            threshold: '0.6000',
            liveness_passed: false,
            review_reason: 'BELOW_THRESHOLD',
            review_note: 'synthetic note',
          });
          expect(await rowOf(id)).toMatchObject({
            status,
            attempt: 2,
            model_id: 'synthetic-model',
          });
        },
      );

      it('FR-403 a REVIEWED row takes attempt 2 and every identity column, with the manual decision it needs', async () => {
        const id = await insertRow(await newSession(), {
          ...baseFor('REVIEWED'),
          attempt: 2,
          id_image_key: 'identity/id.jpg',
          selfie_key: 'identity/selfie.jpg',
          face_match_score: '0.5500',
          model_id: 'synthetic-model',
          threshold: '0.6000',
          liveness_passed: true,
          review_reason: 'BELOW_THRESHOLD',
          review_note: 'synthetic note',
        });
        expect(await rowOf(id)).toMatchObject({ status: 'REVIEWED', attempt: 2 });
      });

      it.each([...OLD_STATUSES, 'REVIEWED'] as const)(
        'FR-403 a %s row with NULL in the three new columns, which is every row that existed before the migration, satisfies both new constraints',
        async (status) => {
          const id = await insertRow(await newSession(), baseFor(status));
          expect(await rowOf(id)).toMatchObject({
            status,
            video_check_done: null,
            video_check_by: null,
            video_check_at: null,
          });
        },
      );
    });
  });

  // ---- the existing identity_checks_check, for WAIVED -----------------------------------------

  describe('identity_checks_check still holds for WAIVED', () => {
    it('FR-403 a WAIVED row is not REVIEWED and has a NULL manual_decision, and the existing constraint accepts it', async () => {
      const id = await insertRow(await newSession(), { status: 'WAIVED' });
      expect(await rowOf(id)).toMatchObject({
        status: 'WAIVED',
        manual_decision: null,
        reviewed_by: null,
        reviewed_at: null,
      });
    });

    it('FR-403 a WAIVED row cannot become REVIEWED without a manual decision, a reviewer and a time (a reviewer cannot change WAIVED into REVIEWED)', async () => {
      const id = await insertRow(await newSession(), { status: 'WAIVED' });
      expect(await refusal(updateRow(id, { status: 'REVIEWED' }))).toEqual({
        code: CHECK_VIOLATION,
        constraint: STATUS_CHECK,
      });
    });

    it('FR-403 a WAIVED row that carries a manual decision, a reviewer and a time is refused', async () => {
      const refused = await refusal(
        insertRow(await newSession(), {
          status: 'WAIVED',
          manual_decision: 'MATCH',
          reviewed_by: A.userId,
          reviewed_at: NOW,
        }),
      );
      // Both constraints refuse it; Postgres reports the first one in name order.
      expect(refused.code).toBe(CHECK_VIOLATION);
      expect([STATUS_CHECK, WAIVED_CHECK]).toContain(refused.constraint);
    });

    it('FR-403 a REVIEWED row still needs all three review columns', async () => {
      expect(
        await refusal(
          insertRow(await newSession(), { status: 'REVIEWED', manual_decision: 'MATCH' }),
        ),
      ).toEqual({ code: CHECK_VIOLATION, constraint: STATUS_CHECK });
    });
  });

  // ---- identity_checks_video_check_check ------------------------------------------------------

  describe('identity_checks_video_check_check', () => {
    const ALL_STATUSES = [
      'PENDING',
      'PASSED',
      'LOW_CONFIDENCE',
      'MANUAL_REVIEW',
      'REVIEWED',
      'WAIVED',
    ] as const;

    it.each(ALL_STATUSES)(
      'FR-305 a %s row with all three video check columns NULL is accepted',
      async (status) => {
        const id = await insertRow(await newSession(), baseFor(status));
        expect(await rowOf(id)).toMatchObject({ video_check_done: null });
      },
    );

    it.each([true, false])(
      'FR-305 all three set (video_check_done = %s) is accepted on a WAIVED row; "not done" is a recorded value, not NULL',
      async (done) => {
        const id = await insertRow(await newSession(), {
          status: 'WAIVED',
          ...VIDEO_VALUES(A.userId, done),
        });
        expect(await rowOf(id)).toMatchObject({
          status: 'WAIVED',
          video_check_done: done,
          video_check_by: A.userId,
        });
      },
    );

    it.each(ALL_STATUSES.filter((status) => status !== 'WAIVED'))(
      'FR-305 all three set on a %s row is refused by identity_checks_video_check_check',
      async (status) => {
        expect(
          await refusal(
            insertRow(await newSession(), { ...baseFor(status), ...VIDEO_VALUES(A.userId) }),
          ),
        ).toEqual({ code: CHECK_VIOLATION, constraint: VIDEO_CHECK_CHECK });
      },
    );

    it.each([
      ['only video_check_done', ['video_check_done']],
      ['only video_check_by', ['video_check_by']],
      ['only video_check_at', ['video_check_at']],
      ['video_check_done and video_check_by', ['video_check_done', 'video_check_by']],
      ['video_check_done and video_check_at', ['video_check_done', 'video_check_at']],
      ['video_check_by and video_check_at', ['video_check_by', 'video_check_at']],
    ] as const)(
      'FR-305 a partial set (%s) on a WAIVED row is refused by identity_checks_video_check_check',
      async (_name, columns) => {
        const all = VIDEO_VALUES(A.userId);
        const partial = Object.fromEntries(columns.map((column) => [column, all[column]]));
        expect(
          await refusal(insertRow(await newSession(), { status: 'WAIVED', ...partial })),
        ).toEqual({
          code: CHECK_VIOLATION,
          constraint: VIDEO_CHECK_CHECK,
        });
      },
    );

    it('FR-305 the video check is recorded on an existing WAIVED row, and the value may be changed later', async () => {
      const id = await insertRow(await newSession(), { status: 'WAIVED' });
      await updateRow(id, VIDEO_VALUES(A.userId, false));
      expect(await rowOf(id)).toMatchObject({ video_check_done: false, video_check_by: A.userId });
      await updateRow(id, VIDEO_VALUES(A.userId, true));
      expect(await rowOf(id)).toMatchObject({ video_check_done: true });
    });

    it('FR-305 a recorded video check cannot be half cleared, and cannot stay on a row that stops being WAIVED', async () => {
      const id = await insertRow(await newSession(), {
        status: 'WAIVED',
        ...VIDEO_VALUES(A.userId),
      });
      expect(await refusal(updateRow(id, { video_check_done: null }))).toEqual({
        code: CHECK_VIOLATION,
        constraint: VIDEO_CHECK_CHECK,
      });
      expect(await refusal(updateRow(id, { status: 'PASSED' }))).toEqual({
        code: CHECK_VIOLATION,
        constraint: VIDEO_CHECK_CHECK,
      });
      // Clearing all three together is allowed (the removal of a waiver deletes the row, but the
      // constraint itself only needs the three to agree).
      await updateRow(id, { video_check_done: null, video_check_by: null, video_check_at: null });
      expect(await rowOf(id)).toMatchObject({ status: 'WAIVED', video_check_done: null });
    });

    it('FR-305 recording a video check on a row that is not WAIVED is refused, by update as well', async () => {
      const id = await insertRow(await newSession(), { status: 'PASSED' });
      expect(await refusal(updateRow(id, VIDEO_VALUES(A.userId)))).toEqual({
        code: CHECK_VIOLATION,
        constraint: VIDEO_CHECK_CHECK,
      });
    });
  });

  // ---- identity_checks_video_check_by_fkey ----------------------------------------------------

  describe('identity_checks_video_check_by_fkey', () => {
    it('FR-305 an unknown user id is refused by the foreign key', async () => {
      expect(
        await refusal(
          insertRow(await newSession(), { status: 'WAIVED', ...VIDEO_VALUES(randomUUID()) }),
        ),
      ).toEqual({ code: FOREIGN_KEY_VIOLATION, constraint: VIDEO_CHECK_FK });
    });

    it('FR-305 deleting a user that video_check_by references is refused (NO ACTION), and the row and the user stay', async () => {
      const userId = await newUser(A.orgId, 'video');
      const id = await insertRow(await newSession(), { status: 'WAIVED', ...VIDEO_VALUES(userId) });
      expect(await refusal(pg.query('DELETE FROM users WHERE id = $1', [userId]))).toEqual({
        code: FOREIGN_KEY_VIOLATION,
        constraint: VIDEO_CHECK_FK,
      });
      expect(await rowOf(id)).toMatchObject({ video_check_by: userId });
      expect((await pg.query('SELECT 1 FROM users WHERE id = $1', [userId])).rowCount).toBe(1);
    });

    it('FR-305 once the row no longer references the user, the user can be deleted', async () => {
      const userId = await newUser(A.orgId, 'video-cleared');
      const sessionId = await newSession();
      const id = await insertRow(sessionId, { status: 'WAIVED', ...VIDEO_VALUES(userId) });
      await pg.query('DELETE FROM identity_checks WHERE id = $1', [id]);
      await pg.query('DELETE FROM users WHERE id = $1', [userId]);
      expect((await pg.query('SELECT 1 FROM users WHERE id = $1', [userId])).rowCount).toBe(0);
    });

    it("TC-008 the database does not check the org of video_check_by: another org's user is accepted, so rule (i) is the service's job (ADR 0015 section 4)", async () => {
      // The key is single-column, not (id, org_id). The service loads the user through the scoped
      // client first (org-scope-relations.ts, IdentityCheck.videoCheckBy). This pins the gap.
      const id = await insertRow(await newSession(), {
        status: 'WAIVED',
        ...VIDEO_VALUES(B.userId),
      });
      expect(await rowOf(id)).toMatchObject({ video_check_by: B.userId });
    });
  });
});
