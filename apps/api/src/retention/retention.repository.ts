// The database touchpoints of the retention tiers (ADR 0004 9.2, ADR 0006 8.4 and 8.6).
//
// Selection runs in `runSystem('RETENTION_ERASURE')` with one reviewed raw query per tier: it picks
// sessions of every org by date and by "no completion marker", and returns ids only. Everything
// else runs in a plain `runInOrg(orgId)` through the org-scoped client: scalar columns only, no
// nested writes, no `orgId` or scope-FK in an update (FU-DB-110), and no `sessions` row is ever
// deleted or its status changed (ADR 0004 9.3; the fence is BE-07's SessionStateService).
import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { OrgContextService, PrismaService } from '../database';
import { FACE_CAP_DAYS, MARKER_ENTITY_TYPE, RETENTION_MARKER_ACTIONS } from './retention.constants';
import type { RetentionTier } from './retention.constants';

export interface DueSession {
  readonly sessionId: string;
  readonly orgId: string;
  /**
   * `created_at` to the microsecond, as text. A JS Date cuts it to milliseconds, and rows made in
   * one statement share the exact same value: a cut cursor would return the same rows again.
   */
  readonly createdAtCursor: string;
}

/** A page boundary: rows strictly after this (created_at, id). */
export interface Cursor {
  readonly createdAtCursor: string;
  readonly sessionId: string;
}

/**
 * Audit actions that mean "the session reached a terminal status" (ADR 0002), written by
 * SessionStateService.transition() with `entity_type 'session'`. The face clock uses the earliest
 * one when a session was never submitted (ADR 0004 9.2). BE-07 owns the real names (they are to be
 * exported as one constant): this list is the one place to change them.
 */
export const TERMINAL_TRANSITION_ACTIONS: readonly string[] = [
  'SESSION_EXPIRED',
  'SESSION_DECLINED',
  'SESSION_ERASED',
];

/** Sessions that can still capture a face image or start recording: the face tier never visits them (B1). */
export const LIVE_STATUSES = [
  'INVITED',
  'OPENED',
  'CONSENTED',
  'VERIFIED',
  'IN_PROGRESS',
  'PAUSED',
];
/** Every other status: the session can no longer capture (a spec pins both lists to the enum). */
export const POST_CAPTURE_STATUSES = [
  'SUBMITTED',
  'GRADED',
  'UNDER_REVIEW',
  'COMPLETED',
  'EXPIRED',
  'APPEALED',
  'DECLINED',
];
/** A review or appeal is open: the media tier never visits them (ADR 0004 R-2, re-checked here). */
const HELD_STATUSES = ['UNDER_REVIEW', 'APPEALED'];

/**
 * The shortest `retention_days` bounds how young a due session can be (a scan limit). It depends on
 * the `organizations_retention_days_check` CHECK (7..730) and on RETENTION_MEDIA_CAP_DAYS >= 7.
 */
const MIN_RETENTION_DAYS = 7;

interface Row {
  sessionId: string;
  orgId: string;
  createdAtCursor: string;
}

/** The marker action goes into SQL as a literal; it is a code constant, and this keeps it that way. */
const SAFE_ACTION = /^[A-Z_]+$/;

/** Exactly `n * 24 hours`, so the SQL clock matches the UTC arithmetic of clocks.ts across a DST change. */
const days = (n: Prisma.Sql): Prisma.Sql => Prisma.sql`(${n}) * interval '24 hours'`;

@Injectable()
export class RetentionRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
  ) {}

  /**
   * Face tier: face clock + LEAST(retention_days, 90) has passed, no marker yet. No hold applies
   * (C-35). Only sessions that can no longer capture: a marker on a session that is still INVITED
   * or IN_PROGRESS would end the tier before any face image exists.
   */
  findDueFace(now: Date, limit: number, after?: Cursor): Promise<DueSession[]> {
    return this.select(
      Prisma.sql`
        s.status NOT IN (${Prisma.join(LIVE_STATUSES)})
        AND COALESCE(
          s.submitted_at,
          GREATEST(
            (SELECT max(ic.created_at) FROM identity_checks ic WHERE ic.session_id = s.id),
            (SELECT max(pe.occurred_at) FROM proctor_events pe
              WHERE pe.session_id = s.id AND pe.type = 'FACE_MISMATCH')
          ),
          (SELECT min(a.created_at) FROM audit_logs a
            WHERE a.entity_type = ${MARKER_ENTITY_TYPE} AND a.entity_id = s.id::text
              AND a.action IN (${Prisma.join(TERMINAL_TRANSITION_ACTIONS)})),
          s.created_at
        ) + ${days(Prisma.sql`LEAST(o.retention_days, ${FACE_CAP_DAYS})`)} <= ${now}`,
      'FACE',
      now,
      limit,
      after,
    );
  }

  /**
   * Media tier (R-4): anchor + retention_days (or the OQ-18 cap) has passed. A NULL anchor is a
   * hold, and so is a review or appeal that is open (R-2: the job re-checks those states).
   */
  findDueMedia(
    now: Date,
    capDays: number | undefined,
    limit: number,
    after?: Cursor,
  ): Promise<DueSession[]> {
    return this.select(
      Prisma.sql`
        s.retention_anchor_at IS NOT NULL
        AND s.status NOT IN (${Prisma.join(HELD_STATUSES)})
        AND NOT EXISTS (
          SELECT 1 FROM appeals ap JOIN session_reviews sr ON sr.id = ap.session_review_id
          WHERE sr.session_id = s.id AND ap.status = 'OPEN')
        AND s.retention_anchor_at
          + ${days(Prisma.sql`LEAST(o.retention_days, COALESCE(${capDays ?? null}::int, o.retention_days))`)} <= ${now}`,
      'MEDIA',
      now,
      limit,
      after,
    );
  }

  private select(
    due: Prisma.Sql,
    tier: RetentionTier,
    now: Date,
    limit: number,
    after: Cursor | undefined,
  ): Promise<DueSession[]> {
    // The marker action is a code constant, written as a literal so the planner can match the
    // partial index (a bind parameter cannot be proved to satisfy its predicate on a generic plan).
    const name = RETENTION_MARKER_ACTIONS[tier];
    if (!SAFE_ACTION.test(name)) throw new Error('unsafe marker action');
    const action = Prisma.raw(`'${name}'`);
    const cursor = after
      ? Prisma.sql`AND (s.created_at, s.id) > (${after.createdAtCursor}::timestamptz, ${after.sessionId}::uuid)`
      : Prisma.empty;
    return this.orgContext.runSystem('RETENTION_ERASURE', () =>
      this.orgContext.runRawSql(
        'retention selection by date and marker (ADR 0004 9.2)',
        async () => {
          const rows = await this.prisma.client.$queryRaw<Row[]>(Prisma.sql`
          SELECT s.id AS "sessionId", s.org_id AS "orgId",
                 to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAtCursor"
          FROM sessions s
          JOIN organizations o ON o.id = s.org_id
          WHERE s.created_at <= ${now}::timestamptz - ${days(Prisma.sql`${MIN_RETENTION_DAYS}`)}
            AND ${due}
            AND NOT EXISTS (
              SELECT 1 FROM audit_logs m
              WHERE m.action = ${action}
                AND m.entity_type = ${MARKER_ENTITY_TYPE} AND m.entity_id = s.id::text
                AND m.org_id = s.org_id)
            ${cursor}
          ORDER BY s.created_at, s.id
          LIMIT ${limit}`);
          return rows.map((r) => ({
            sessionId: r.sessionId,
            orgId: r.orgId,
            createdAtCursor: r.createdAtCursor,
          }));
        },
      ),
    );
  }

  /** The caller's org scope for one session: everything below runs through here. */
  inOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    return this.orgContext.runInOrg(orgId, fn);
  }

  /** True if the session already has this tier's marker. */
  async hasMarker(tier: RetentionTier, sessionId: string): Promise<boolean> {
    const row = await this.prisma.client.auditLog.findFirst({
      where: {
        action: RETENTION_MARKER_ACTIONS[tier],
        entityType: MARKER_ENTITY_TYPE,
        entityId: sessionId,
      },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * R-2, re-checked just before the media tier deletes (selection may be stale, or R-1 may have a
   * bug): the anchor is set, the session is not UNDER_REVIEW or APPEALED, and no appeal is open.
   */
  async mediaStillEligible(sessionId: string): Promise<boolean> {
    const session = await this.prisma.client.session.findUnique({
      where: { id: sessionId },
      select: { status: true, retentionAnchorAt: true },
    });
    if (session === null || session.retentionAnchorAt === null) return false;
    if (HELD_STATUSES.includes(session.status)) return false;
    const open = await this.prisma.client.appeal.count({
      where: { status: 'OPEN', sessionReview: { sessionId } },
    });
    return open === 0;
  }

  /**
   * True if a stored key lies outside the prefixes this tier deletes. Such a key would be nulled
   * without its object ever being deleted, so the tier treats the session as not verified and a
   * person looks at it. Face tier: identity keys must be under `identity/`, and the evidence keys it
   * nulls (FACE_MISMATCH, or all with OQ-19) under `evidence/sealed/` (or `evidence/`). Media tier:
   * every key must be under the session prefix.
   */
  async hasKeyOutside(
    root: string,
    sessionId: string,
    tier: Extract<RetentionTier, 'FACE' | 'MEDIA'>,
    evidenceAll: boolean,
  ): Promise<boolean> {
    const identityRoot = tier === 'FACE' ? `${root}identity/` : root;
    const evidenceRoot =
      tier === 'FACE' ? (evidenceAll ? `${root}evidence/` : `${root}evidence/sealed/`) : root;
    const outside = (field: 'idImageKey' | 'selfieKey') => ({
      sessionId,
      AND: [{ [field]: { not: null } }, { NOT: { [field]: { startsWith: identityRoot } } }],
    });
    const evidenceScope = tier === 'FACE' && !evidenceAll ? { type: 'FACE_MISMATCH' as const } : {};
    const checks = await Promise.all([
      this.prisma.client.identityCheck.count({ where: outside('idImageKey') }),
      this.prisma.client.identityCheck.count({ where: outside('selfieKey') }),
      this.prisma.client.proctorEvent.count({
        where: {
          sessionId,
          ...evidenceScope,
          AND: [
            { evidenceKey: { not: null } },
            { NOT: { evidenceKey: { startsWith: evidenceRoot } } },
          ],
        },
      }),
      tier === 'MEDIA'
        ? this.prisma.client.mediaChunk.count({
            where: {
              sessionId,
              AND: [{ objectKey: { not: null } }, { NOT: { objectKey: { startsWith: root } } }],
            },
          })
        : Promise.resolve(0),
    ]);
    return checks.some((n) => n > 0);
  }

  /**
   * Face tier, after verified deletion: null the identity keys and the evidence keys, and write the
   * marker, in one transaction. `evidenceAll` is OQ-19: every event's evidence frame, not only the
   * sealed FACE_MISMATCH one. Returns false if another run wrote the marker first.
   */
  completeFace(args: {
    orgId: string;
    sessionId: string;
    evidenceAll: boolean;
    runId: string;
  }): Promise<boolean> {
    const { orgId, sessionId, evidenceAll, runId } = args;
    return this.prisma.client.$transaction(async (tx) => {
      if (!(await this.lockAndCheck(tx, 'FACE', sessionId))) return false;
      await tx.identityCheck.updateMany({
        where: { sessionId },
        data: { idImageKey: null, selfieKey: null },
      });
      await tx.proctorEvent.updateMany({
        where: evidenceAll
          ? { sessionId, evidenceKey: { not: null } }
          : { sessionId, type: 'FACE_MISMATCH' },
        data: { evidenceKey: null },
      });
      await tx.auditLog.create({ data: marker('FACE', orgId, sessionId, runId) });
      return true;
    });
  }

  /** Media tier (R-4), after verified deletion: null keys, mark chunks deleted, delete keystrokes, marker. */
  completeMedia(args: {
    orgId: string;
    sessionId: string;
    now: Date;
    runId: string;
  }): Promise<boolean> {
    const { orgId, sessionId, now, runId } = args;
    return this.prisma.client.$transaction(async (tx) => {
      if (!(await this.lockAndCheck(tx, 'MEDIA', sessionId))) return false;
      await tx.mediaChunk.updateMany({
        where: { sessionId, objectKey: { not: null } },
        data: { objectKey: null, deletedAt: now },
      });
      await tx.proctorEvent.updateMany({
        where: { sessionId, evidenceKey: { not: null } },
        data: { evidenceKey: null },
      });
      await tx.identityCheck.updateMany({
        where: { sessionId },
        data: { idImageKey: null, selfieKey: null },
      });
      await tx.keystrokeBatch.deleteMany({ where: { sessionId } });
      await tx.auditLog.create({ data: marker('MEDIA', orgId, sessionId, runId) });
      return true;
    });
  }

  /**
   * Serialises two runs on one session and tier (a scheduler retry, two replicas): a transaction
   * advisory lock (ADR 0006 8.5), then the marker is looked for again inside the transaction.
   * `audit_logs` is append-only, so a duplicate marker could never be removed. The R-2 hold check is
   * not repeated here: by now the objects are deleted, so there is nothing left to protect. The
   * `::text` cast is there because Prisma cannot decode the `void` result of the lock call.
   */
  private async lockAndCheck(tx: Tx, tier: RetentionTier, sessionId: string): Promise<boolean> {
    await this.orgContext.runRawSql(
      'per-session retention advisory lock (ADR 0006 8.5)',
      () =>
        tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('codeproctor/retention'), hashtext(${`${tier}:${sessionId}`}))::text AS locked`,
    );
    const existing = await tx.auditLog.findFirst({
      where: {
        action: RETENTION_MARKER_ACTIONS[tier],
        entityType: MARKER_ENTITY_TYPE,
        entityId: sessionId,
      },
      select: { id: true },
    });
    return existing === null;
  }

  /** One audit row per org per run, ids and counts only. */
  writeRunSummary(orgId: string, runId: string, counts: Record<string, number>): Promise<unknown> {
    return this.prisma.client.auditLog.create({
      data: {
        orgId,
        actorId: null,
        action: 'RETENTION_RUN',
        entityType: 'retention_run',
        entityId: runId,
        metadata: { runId, ...counts },
      },
    });
  }
}

type Tx = Parameters<Parameters<PrismaService['client']['$transaction']>[0]>[0];

function marker(tier: RetentionTier, orgId: string, sessionId: string, runId: string) {
  return {
    orgId,
    actorId: null,
    action: RETENTION_MARKER_ACTIONS[tier],
    entityType: MARKER_ENTITY_TYPE,
    entityId: sessionId,
    metadata: { tier, runId },
  };
}
