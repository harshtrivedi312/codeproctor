// The database touchpoints of the retention tiers (ADR 0004 9.2, ADR 0006 8.4 and 8.6).
//
// Selection runs in `runSystem('RETENTION_ERASURE')` with one reviewed raw query per tier: it picks
// sessions of every org by date and by "no completion marker", and returns ids only. Everything
// else runs in a plain `runInOrg(orgId)` through the org-scoped client: scalar columns only, no
// nested writes, no `orgId` or scope-FK in an update (FU-DB-110), and no `sessions` row is ever
// deleted or its status changed (ADR 0004 9.3; the fence is BE-07's SessionStateService).
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { reduceAccommodations, reduceWaiverOnly, redactReasonNote } from './accommodations';
import { resultsDue } from './clocks';
import type { Json } from './accommodations';
import { OrgContextService, PrismaService } from '../database';
import {
  CANDIDATE_ERASURE_LOCK,
  FACE_CAP_DAYS,
  MARKER_ENTITY_TYPE,
  RETENTION_MARKER_ACTIONS,
} from './retention.constants';
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
  'ERASED',
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
  private readonly log = new Logger(RetentionRepository.name);

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
          -- A session that was never submitted (EXPIRED, DECLINED, erased while live) has no review hold:
          -- BE-07's transition stamps retention_anchor_at when it reaches that terminal status and the
          -- erasure fence keeps or sets it, so the anchor IS its first terminal time (ADR 0004 9.2).
          s.retention_anchor_at,
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

  /**
   * Results tier (R-10, C-26): one year after the anchor (OQ-20: or after submission). The same
   * review and appeal holds as the media tier. R-10 does not wait for the face or media markers: its
   * own whole-prefix verification covers them. `created_at` is at or before every clock, and a year
   * is at least 365 days, so the scan bound cannot drop an eligible row.
   */
  findDueResults(
    now: Date,
    clock: 'anchor' | 'submitted',
    limit: number,
    after?: Cursor,
  ): Promise<DueSession[]> {
    // OQ-20 'submitted': a session that was never submitted (EXPIRED, DECLINED) falls back to its
    // anchor, or its rows and its candidate would never be purged.
    const start =
      clock === 'submitted'
        ? Prisma.sql`COALESCE(s.submitted_at, s.retention_anchor_at)`
        : Prisma.sql`s.retention_anchor_at`;
    return this.select(
      Prisma.sql`
        ${start} IS NOT NULL
        AND s.status NOT IN (${Prisma.join(HELD_STATUSES)})
        AND NOT EXISTS (
          SELECT 1 FROM appeals ap JOIN session_reviews sr ON sr.id = ap.session_review_id
          WHERE sr.session_id = s.id AND ap.status = 'OPEN')
        AND ((${start} AT TIME ZONE 'UTC') + interval '1 year') AT TIME ZONE 'UTC' <= ${now}`,
      'RESULTS',
      now,
      limit,
      after,
      365,
    );
  }

  private select(
    due: Prisma.Sql,
    tier: RetentionTier,
    now: Date,
    limit: number,
    after: Cursor | undefined,
    minAgeDays: number = MIN_RETENTION_DAYS,
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
          WHERE s.created_at <= ${now}::timestamptz - ${days(Prisma.sql`${minAgeDays}`)}
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
   * R-2, re-checked just before the media or results tier deletes (selection may be stale, or R-1
   * may have a bug): the clock's start is set, the session is not UNDER_REVIEW or APPEALED, and no
   * appeal is open. `clock` is the OQ-20 switch for the results tier; the media tier always uses the anchor.
   */
  async stillEligible(
    sessionId: string,
    clock: 'anchor' | 'submitted' = 'anchor',
    results?: { now: Date },
  ): Promise<boolean> {
    const session = await this.prisma.client.session.findUnique({
      where: { id: sessionId },
      select: { status: true, retentionAnchorAt: true, submittedAt: true },
    });
    if (session === null) return false;
    const start =
      clock === 'anchor'
        ? session.retentionAnchorAt
        : (session.submittedAt ?? session.retentionAnchorAt);
    if (start === null) return false;
    // R-10 only: the clock date itself, BEFORE anything is deleted (the whole prefix includes reports/,
    // which nothing but R-10 may remove). An anchor cleared and set again after selection fails here.
    if (results !== undefined) {
      const dueAt = resultsDue(session.retentionAnchorAt, session.submittedAt, {
        RETENTION_RESULTS_CLOCK: clock,
      });
      if (dueAt === null || dueAt > results.now) return false;
    }
    if (HELD_STATUSES.includes(session.status)) return false;
    const open = await this.prisma.client.appeal.count({
      where: { status: 'OPEN', sessionReview: { sessionId } },
    });
    return open === 0;
  }

  mediaStillEligible(sessionId: string): Promise<boolean> {
    return this.stillEligible(sessionId, 'anchor');
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
    tier: Extract<RetentionTier, 'FACE' | 'MEDIA' | 'RESULTS'>,
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
      tier !== 'FACE'
        ? this.prisma.client.mediaChunk.count({
            where: {
              sessionId,
              AND: [{ objectKey: { not: null } }, { NOT: { objectKey: { startsWith: root } } }],
            },
          })
        : Promise.resolve(0),
      tier === 'RESULTS'
        ? this.prisma.client.session.count({
            where: {
              id: sessionId,
              AND: [{ reportKey: { not: null } }, { NOT: { reportKey: { startsWith: root } } }],
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
      // One table order in every tier (proctor_events, batches, keystrokes, media, identity), so two
      // replicas on different tiers of one session cannot deadlock on row locks.
      await tx.proctorEvent.updateMany({
        where: evidenceAll
          ? { sessionId, evidenceKey: { not: null } }
          : { sessionId, type: 'FACE_MISMATCH' },
        data: { evidenceKey: null },
      });
      await tx.identityCheck.updateMany({
        where: { sessionId },
        data: { idImageKey: null, selfieKey: null },
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
      if (!(await this.holdsInTx(tx, sessionId, { tier: 'MEDIA' }))) return false;
      await tx.proctorEvent.updateMany({
        where: { sessionId, evidenceKey: { not: null } },
        data: { evidenceKey: null },
      });
      await tx.keystrokeBatch.deleteMany({ where: { sessionId } });
      await tx.mediaChunk.updateMany({
        where: { sessionId, objectKey: { not: null } },
        data: { objectKey: null, deletedAt: now },
      });
      await tx.identityCheck.updateMany({
        where: { sessionId },
        data: { idImageKey: null, selfieKey: null },
      });
      // ADR 0015 section 7: R-4 removes the waiver's reason note (health details), compare-and-set.
      await this.casAccommodations(tx, sessionId, redactReasonNote);
      await tx.auditLog.create({ data: marker('MEDIA', orgId, sessionId, runId) });
      return true;
    });
  }

  /**
   * The R-2 holds, read again INSIDE the completion transaction, under the per-session lock: the
   * clock's start is set, the session is not UNDER_REVIEW or APPEALED, no appeal is open, and for
   * R-10 the clock date has really passed (an anchor cleared and set again after selection must not
   * make results go early). The objects are gone by now, but the rows (verdict, notes, the appeal
   * itself) are not, and they are what a review or appeal protects.
   */
  private async holdsInTx(
    tx: Tx,
    sessionId: string,
    check: { tier: 'MEDIA' } | { tier: 'RESULTS'; clock: 'anchor' | 'submitted'; now: Date },
  ): Promise<boolean> {
    const session = await tx.session.findUnique({
      where: { id: sessionId },
      select: { status: true, retentionAnchorAt: true, submittedAt: true },
    });
    if (session === null || HELD_STATUSES.includes(session.status)) return false;
    if (session.retentionAnchorAt === null && check.tier === 'MEDIA') return false;
    if (check.tier === 'RESULTS') {
      const dueAt = resultsDue(session.retentionAnchorAt, session.submittedAt, {
        RETENTION_RESULTS_CLOCK: check.clock,
      });
      if (dueAt === null || dueAt > check.now) return false;
    }
    const open = await tx.appeal.count({ where: { status: 'OPEN', sessionReview: { sessionId } } });
    return open === 0;
  }

  /**
   * Results tier (R-10, ADR 0004 9.4), after verified deletion of the whole session prefix: delete
   * the event, batch, identity, media and keystroke rows, the submissions and the appeals; blank code
   * and answers; null review notes and verdicts, scores, risk and the report key; clear device_info;
   * reduce the accommodations (OQ-12: the whole value, or only the waiver when the switch is off); write
   * the marker; and, when this was the candidate's last session with results, anonymise the candidate,
   * all in ONE transaction (a crash can never leave results gone and the candidate still named). The
   * `sessions` row, the reviews and `scored_by` / `scored_at` stay (a CHECK ties those to MANUAL scoring).
   * Lock order (ADR 0004 9.4): the per-candidate lock first, then the per-session lock, then rows.
   */
  completeResults(args: {
    orgId: string;
    sessionId: string;
    reduceAccommodationsOnRun: boolean;
    clock: 'anchor' | 'submitted';
    now: Date;
    runId: string;
  }): Promise<
    { kind: 'done'; anonymised: boolean } | { kind: 'alreadyDone' } | { kind: 'notEligible' }
  > {
    const { orgId, sessionId, reduceAccommodationsOnRun, clock, now, runId } = args;
    return this.prisma.client.$transaction(async (tx) => {
      // A plain read takes no row lock, so the candidate lock below is still the first lock.
      const owner = await tx.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: { invitation: { select: { candidateId: true } } },
      });
      const candidateId = owner.invitation.candidateId;
      await this.candidateLock(tx, candidateId);
      if (!(await this.lockAndCheck(tx, 'RESULTS', sessionId))) return { kind: 'alreadyDone' };
      if (!(await this.holdsInTx(tx, sessionId, { tier: 'RESULTS', clock, now })))
        return { kind: 'notEligible' };
      // Events cascade to their flag decisions.
      await tx.proctorEvent.deleteMany({ where: { sessionId } });
      await tx.proctorEventBatch.deleteMany({ where: { sessionId } });
      await tx.keystrokeBatch.deleteMany({ where: { sessionId } });
      await tx.mediaChunk.deleteMany({ where: { sessionId } });
      await tx.identityCheck.deleteMany({ where: { sessionId } });
      // `appeals` has no cascade from the review (its CHECK ties new_verdict to its status).
      await tx.appeal.deleteMany({ where: { sessionReview: { sessionId } } });
      await tx.sessionReview.updateMany({
        where: { sessionId },
        data: { notes: null, verdict: null },
      });
      await tx.submission.deleteMany({ where: { sessionQuestion: { sessionId } } });
      await tx.sessionQuestion.updateMany({
        where: { sessionId },
        data: { finalCode: null, answer: Prisma.DbNull, scoringNote: null, score: null },
      });
      await tx.session.update({
        where: { id: sessionId },
        data: {
          deviceInfo: {},
          reportKey: null,
          totalScore: null,
          riskScore: null,
          riskBand: null,
        },
        select: { id: true },
      });
      // The waiver always reduces to the fact of it (ADR 0015 section 7); OQ-12 decides about the rest.
      await this.casAccommodations(
        tx,
        sessionId,
        reduceAccommodationsOnRun ? reduceAccommodations : reduceWaiverOnly,
      );
      await tx.auditLog.create({ data: marker('RESULTS', orgId, sessionId, runId) });
      const anonymised = await this.anonymiseInTx(tx, { orgId, candidateId, now, runId });
      return { kind: 'done', anonymised };
    });
  }

  /** The per-candidate lock R-10 and erasure both take: one candidate per transaction, before any row lock (ADR 0004 9.4). */
  private async candidateLock(tx: Tx, candidateId: string): Promise<void> {
    await this.orgContext.runRawSql(
      'per-candidate erasure advisory lock (ADR 0004 9.4)',
      () =>
        tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${CANDIDATE_ERASURE_LOCK}), hashtext(${candidateId}))::text AS locked`,
    );
  }

  /**
   * Anonymises the candidate (ADR 0004 9.4 "Candidate row") once at least one of their sessions
   * exists and every one has its RESULTS marker (the caller's own marker counts: same transaction).
   * A pending erasure request is left to erasure, which also sends the notice (R-10 sends none).
   * The caller holds the candidate lock. Writes one ids-only audit row.
   */
  private async anonymiseInTx(
    tx: Tx,
    args: { orgId: string; candidateId: string; now: Date; runId: string },
  ): Promise<boolean> {
    const { orgId, candidateId, now, runId } = args;
    const candidate = await tx.candidate.findUnique({
      where: { id: candidateId },
      select: { erasedAt: true, erasureRequestedAt: true },
    });
    if (candidate === null || candidate.erasedAt !== null || candidate.erasureRequestedAt !== null)
      return false;
    const sessions = await tx.session.findMany({
      where: { invitation: { candidateId } },
      select: { id: true },
    });
    if (sessions.length === 0) return false;
    // Distinct sessions, not marker rows: `audit_logs` has no unique index on markers, and a duplicate
    // on one session must not stand in for another session's marker.
    const marked = await tx.auditLog.findMany({
      where: {
        action: RETENTION_MARKER_ACTIONS.RESULTS,
        entityType: MARKER_ENTITY_TYPE,
        entityId: { in: sessions.map((x) => x.id) },
      },
      select: { entityId: true },
      distinct: ['entityId'],
    });
    if (marked.length < sessions.length) return false;
    await tx.candidate.update({
      where: { id: candidateId },
      data: {
        email: `erased+${candidateId}@invalid`,
        fullName: 'Erased',
        externalRef: null,
        erasedAt: now,
      },
      select: { id: true },
    });
    await tx.auditLog.create({
      data: {
        orgId,
        actorId: null,
        action: 'CANDIDATE_ANONYMISED',
        entityType: 'candidate',
        entityId: candidateId,
        metadata: { runId },
      },
    });
    return true;
  }

  /**
   * A daily backstop for the case the atomic path cannot cover (a candidate whose last session got its
   * marker before this code existed, or a session added to a candidate afterwards): candidates, not yet
   * anonymised and with no pending erasure request, who have sessions that ALL carry a results marker.
   * Selection only; each candidate is then anonymised in their own org scope.
   */
  findCandidatesToAnonymise(
    limit: number,
    afterId?: string,
  ): Promise<{ candidateId: string; orgId: string; sessionId: string }[]> {
    for (const literal of [RETENTION_MARKER_ACTIONS.RESULTS, MARKER_ENTITY_TYPE]) {
      if (!SAFE_ACTION.test(literal.toUpperCase())) throw new Error('unsafe literal');
    }
    const action = Prisma.raw(`'${RETENTION_MARKER_ACTIONS.RESULTS}'`);
    const entityType = Prisma.raw(`'${MARKER_ENTITY_TYPE}'`);
    const after = afterId ? Prisma.sql`AND c.id > ${afterId}::uuid` : Prisma.empty;
    return this.orgContext.runSystem('RETENTION_ERASURE', () =>
      this.orgContext.runRawSql(
        'candidate anonymisation backstop selection (ADR 0004 9.4)',
        async () => {
          return this.prisma.client.$queryRaw<
            { candidateId: string; orgId: string; sessionId: string }[]
          >(Prisma.sql`
          SELECT c.id AS "candidateId", c.org_id AS "orgId",
                 (SELECT s.id FROM invitations i JOIN sessions s ON s.invitation_id = i.id
                   WHERE i.candidate_id = c.id ORDER BY s.created_at, s.id LIMIT 1) AS "sessionId"
          FROM candidates c
          WHERE c.erased_at IS NULL AND c.erasure_requested_at IS NULL
            AND EXISTS (SELECT 1 FROM invitations i JOIN sessions s ON s.invitation_id = i.id WHERE i.candidate_id = c.id)
            AND NOT EXISTS (
              SELECT 1 FROM invitations i JOIN sessions s ON s.invitation_id = i.id
              WHERE i.candidate_id = c.id
                AND NOT EXISTS (
                  SELECT 1 FROM audit_logs m
                  WHERE m.action = ${action} AND m.entity_type = ${entityType}
                    AND m.entity_id = s.id::text AND m.org_id = s.org_id))
            ${after}
          ORDER BY c.id
          LIMIT ${limit}`);
        },
      ),
    );
  }

  /** Anonymises one candidate in their own transaction (the backstop path). */
  anonymiseCandidateIfDone(args: {
    orgId: string;
    candidateId: string;
    now: Date;
    runId: string;
  }): Promise<boolean> {
    return this.prisma.client.$transaction(async (tx) => {
      await this.candidateLock(tx, args.candidateId);
      return this.anonymiseInTx(tx, args);
    });
  }

  /**
   * Rewrites the session's invitation accommodations with `transform` as a compare-and-set: the
   * write names the value it read, so a PATCH that changed it in between is never overwritten
   * (ADR 0015 section 7 "Concurrency"). `equals` on a jsonb column is jsonb equality (key order and
   * spacing do not matter). A lost race is logged (ids only), retried, then fails the transaction.
   * An integer above 2^53 inside the value would not survive the JS round trip and would make this
   * fail every day: accommodations hold small settings only. Public so a test can race it.
   */
  async casAccommodations(
    tx: Tx,
    sessionId: string,
    transform: (
      value: unknown,
    ) => Record<string, Json> | null | Promise<Record<string, Json> | null>,
  ): Promise<void> {
    const session = await tx.session.findUnique({
      where: { id: sessionId },
      select: { invitationId: true },
    });
    if (session === null) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const invitation = await tx.invitation.findUnique({
        where: { id: session.invitationId },
        select: { accommodations: true },
      });
      if (invitation === null) return;
      const next = await transform(invitation.accommodations);
      if (next === null) return; // nothing to change: no write
      const result = await tx.invitation.updateMany({
        where: {
          id: session.invitationId,
          accommodations: { equals: invitation.accommodations as Prisma.InputJsonValue },
        },
        data: { accommodations: next },
      });
      if (result.count === 1) return;
      // ADR 0015 section 6: an unlisted writer may exist. Ids only.
      this.log.warn(
        `retention accommodations changed under a compare-and-set for session ${sessionId}`,
      );
    }
    throw new Error('accommodations changed while retention was rewriting them');
  }

  /**
   * Serialises two runs on one session and tier (a scheduler retry, two replicas): a transaction
   * advisory lock (ADR 0006 8.5), then the marker is looked for again inside the transaction.
   * `audit_logs` is append-only, so a duplicate marker could never be removed. The R-2 hold check
   * is repeated right after, still under this lock (`holdsInTx`): the rows a review or appeal protects
   * are still there. The
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

export type Tx = Parameters<Parameters<PrismaService['client']['$transaction']>[0]>[0];

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
