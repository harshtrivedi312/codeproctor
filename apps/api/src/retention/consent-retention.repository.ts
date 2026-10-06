// ConsentRetentionRepository (ADR 0004 9.3, rule R-9; C-04, C-17; FR-704, NFR-05): the ONLY place
// in the API that reads or deletes `consents`. It selects with a fixed column list (never
// `signed_name`, `ip` or `user_agent`) and never loads the row through an `include`, because SERVICE
// scope has no column limits (ADR 0004 9.5 "System carve-out"). `consent-access.spec.ts` fails on
// any other consent access. Raw SQL on `consents` is allowed here and nowhere else.
import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { OrgContextService, PrismaService } from '../database';
import { CONSENT_YEARS, SESSION_ENTITY_TYPE } from './retention.constants';

export interface DueConsent {
  readonly consentId: string;
  readonly sessionId: string;
  readonly orgId: string;
  /** The clock value (signing or declining time) to the microsecond, as text, for the keyset cursor. */
  readonly clockCursor: string;
}

/** A page boundary: rows strictly after this (clock, consent id). */
export interface ConsentCursor {
  readonly clockCursor: string;
  readonly consentId: string;
}

/** What the retention job may know about a consent record: ids, the clock times and the PDF key. Nothing personal. */
export interface ConsentRetentionRow {
  readonly id: string;
  readonly sessionId: string;
  readonly signedAt: Date | null;
  readonly declinedAt: Date | null;
  readonly pdfKey: string | null;
}

/** Audit action for a deleted consent record: ids only. Not a marker: the row's absence is the proof. */
export const CONSENT_DELETED_ACTION = 'CONSENT_RECORD_DELETED';

const HELD_STATUSES = ['UNDER_REVIEW', 'APPEALED'];

interface Row {
  consentId: string;
  sessionId: string;
  orgId: string;
  clockCursor: string;
}

@Injectable()
export class ConsentRetentionRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
  ) {}

  /**
   * Consent records due for deletion: signed_at + 3 years (C-04, C-17), or declined_at + 3 years when
   * `declinedExpire` (OQ-11). A record whose own session is UNDER_REVIEW or APPEALED, or has an OPEN
   * appeal, is skipped (ADR 0004 9.3 "Skip"). Selection only: ids and the clock value.
   */
  findDue(
    now: Date,
    declinedExpire: boolean,
    limit: number,
    after?: ConsentCursor,
  ): Promise<DueConsent[]> {
    const clock = declinedExpire
      ? Prisma.sql`COALESCE(c.signed_at, c.declined_at)`
      : Prisma.sql`c.signed_at`;
    const cursor = after
      ? Prisma.sql`AND (${clock}, c.id) > (${after.clockCursor}::timestamptz, ${after.consentId}::uuid)`
      : Prisma.empty;
    return this.orgContext.runSystem('RETENTION_ERASURE', () =>
      this.orgContext.runRawSql(
        'consent retention selection by clock (ADR 0004 9.3, R-9)',
        async () => {
          const rows = await this.prisma.client.$queryRaw<Row[]>(Prisma.sql`
          SELECT c.id AS "consentId", s.id AS "sessionId", s.org_id AS "orgId",
                 to_char(${clock} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "clockCursor"
          FROM consents c
          JOIN sessions s ON s.id = c.session_id
          WHERE ${clock} IS NOT NULL
            AND ((${clock} AT TIME ZONE 'UTC') + ${Prisma.raw(`interval '${CONSENT_YEARS} years'`)}) AT TIME ZONE 'UTC' <= ${now}
            AND s.status NOT IN (${Prisma.join(HELD_STATUSES)})
            AND NOT EXISTS (
              SELECT 1 FROM appeals ap JOIN session_reviews sr ON sr.id = ap.session_review_id
              WHERE sr.session_id = s.id AND ap.status = 'OPEN')
            ${cursor}
          ORDER BY ${clock}, c.id
          LIMIT ${limit}`);
          return rows.map((r) => ({
            consentId: r.consentId,
            sessionId: r.sessionId,
            orgId: r.orgId,
            clockCursor: r.clockCursor,
          }));
        },
      ),
    );
  }

  inOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    return this.orgContext.runInOrg(orgId, fn);
  }

  /** The record as the job may see it: a fixed select, never the signature, IP or user agent. */
  async read(consentId: string): Promise<ConsentRetentionRow | null> {
    return this.prisma.client.consent.findUnique({
      where: { id: consentId },
      select: { id: true, sessionId: true, signedAt: true, declinedAt: true, pdfKey: true },
    });
  }

  /** R-9 skip rule, read again right before deleting: the session is not held and has no open appeal. */
  async sessionNotHeld(sessionId: string): Promise<boolean> {
    const session = await this.prisma.client.session.findUnique({
      where: { id: sessionId },
      select: { status: true },
    });
    if (session === null || HELD_STATUSES.includes(session.status)) return false;
    const open = await this.prisma.client.appeal.count({
      where: { status: 'OPEN', sessionReview: { sessionId } },
    });
    return open === 0;
  }

  /**
   * Deletes the consent row (only after the PDF prefix is verified empty) and writes one audit row
   * with ids only, in one transaction. `deleteMany` returns a count, never the row.
   */
  deleteRow(args: {
    orgId: string;
    sessionId: string;
    consentId: string;
    runId: string;
  }): Promise<boolean> {
    const { orgId, sessionId, consentId, runId } = args;
    return this.prisma.client.$transaction(async (tx) => {
      const { count } = await tx.consent.deleteMany({ where: { id: consentId } });
      if (count === 0) return false;
      await tx.auditLog.create({
        data: {
          orgId,
          actorId: null,
          action: CONSENT_DELETED_ACTION,
          entityType: SESSION_ENTITY_TYPE,
          entityId: sessionId,
          metadata: { consentId, runId },
        },
      });
      return true;
    });
  }
}
