// The database touchpoints of the retention tiers (ADR 0004 9.2, ADR 0006 8.4 and 8.6).
//
// Selection runs in `runSystem('RETENTION_ERASURE')` with one reviewed raw query per tier: it picks
// sessions of every org by date and by "no completion marker", and returns ids only. Everything
// else runs in a plain `runInOrg(orgId)` through the org-scoped client: scalar columns only, no
// nested writes, no `orgId` or scope-FK in an update (FU-DB-110), and no `sessions` row is ever
// deleted (ADR 0004 9.3; app_user has no DELETE on it).
import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { OrgContextService, PrismaService } from '../database';
import { FACE_CAP_DAYS, MARKER_ENTITY_TYPE, RETENTION_MARKER_ACTIONS } from './retention.constants';
import type { RetentionTier } from './retention.constants';

export interface DueSession {
  readonly sessionId: string;
  readonly orgId: string;
}

/**
 * Audit actions that mean "the session reached a terminal status" (ADR 0002), written by
 * SessionStateService.transition(). The face clock uses the earliest one when a session was never
 * submitted (ADR 0004 9.2). BE-07 owns the real names: this list is the one place to change them.
 */
export const TERMINAL_TRANSITION_ACTIONS: readonly string[] = [
  'SESSION_EXPIRED',
  'SESSION_DECLINED',
  'SESSION_ERASED',
];

interface Row {
  sessionId: string;
  orgId: string;
}

@Injectable()
export class RetentionRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
  ) {}

  /** Face tier: face clock + LEAST(retention_days, 90) has passed, no marker yet. No hold applies (C-35). */
  findDueFace(now: Date, limit: number): Promise<DueSession[]> {
    return this.select(
      Prisma.sql`
        COALESCE(
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
        ) + LEAST(o.retention_days, ${FACE_CAP_DAYS}) * interval '1 day' <= ${now}`,
      'FACE',
      limit,
    );
  }

  /** Media tier (R-4): anchor + retention_days (or the OQ-18 cap) has passed. A NULL anchor is a hold. */
  findDueMedia(now: Date, capDays: number | undefined, limit: number): Promise<DueSession[]> {
    return this.select(
      Prisma.sql`
        s.retention_anchor_at IS NOT NULL
        AND s.retention_anchor_at
          + LEAST(o.retention_days, COALESCE(${capDays ?? null}::int, o.retention_days)) * interval '1 day' <= ${now}`,
      'MEDIA',
      limit,
    );
  }

  private select(due: Prisma.Sql, tier: RetentionTier, limit: number): Promise<DueSession[]> {
    return this.orgContext.runSystem('RETENTION_ERASURE', () =>
      this.orgContext.runRawSql(
        'retention selection by date and marker (ADR 0004 9.2)',
        async () => {
          const rows = await this.prisma.client.$queryRaw<Row[]>(Prisma.sql`
          SELECT s.id AS "sessionId", s.org_id AS "orgId"
          FROM sessions s
          JOIN organizations o ON o.id = s.org_id
          WHERE ${due}
            AND NOT EXISTS (
              SELECT 1 FROM audit_logs m
              WHERE m.action = ${RETENTION_MARKER_ACTIONS[tier]}
                AND m.entity_type = ${MARKER_ENTITY_TYPE} AND m.entity_id = s.id::text)
          ORDER BY s.created_at, s.id
          LIMIT ${limit}`);
          return rows.map((r) => ({ sessionId: r.sessionId, orgId: r.orgId }));
        },
      ),
    );
  }

  /** The caller's org scope for one session: everything below runs through here. */
  inOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    return this.orgContext.runInOrg(orgId, fn);
  }

  /** True if the session already has this tier's marker (a concurrent run finished first). */
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
   * Face tier, after verified deletion: null the identity keys and the evidence keys, and write the
   * marker, in one transaction. `evidenceAll` is OQ-19: every event's evidence frame, not only the
   * sealed FACE_MISMATCH one.
   */
  completeFace(args: {
    orgId: string;
    sessionId: string;
    evidenceAll: boolean;
    runId: string;
  }): Promise<void> {
    const { orgId, sessionId, evidenceAll, runId } = args;
    return this.prisma.client.$transaction(async (tx) => {
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
      await tx.auditLog.create({
        data: marker('FACE', orgId, sessionId, runId),
      });
    });
  }

  /** Media tier (R-4), after verified deletion: null keys, mark chunks deleted, delete keystrokes, marker. */
  completeMedia(args: {
    orgId: string;
    sessionId: string;
    now: Date;
    runId: string;
  }): Promise<void> {
    const { orgId, sessionId, now, runId } = args;
    return this.prisma.client.$transaction(async (tx) => {
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
    });
  }

  /** One audit row per org per run, ids and counts only (the Lead's "audit row per run"). */
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
