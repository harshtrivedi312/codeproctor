// Consent document (FR-401, D-17, C-07, C-30; TC-030, TC-095, TC-096). Every session needs its own
// signature; a resumed session keeps its signature. Nothing here starts a device, a recording or an
// upload: before CONSENTED the other candidate routes refuse (SESSION_NOT_ACTIVE).
//
// The server decides which document is signed: `consentTextId` in the body must equal the org's
// current text, otherwise 409 CONSENT_TEXT_CHANGED, so a stale page cannot sign an old version. The
// time is the server's. The 18+ confirmation (C-30) is required to sign; the consents table has no
// column for it yet, so it is recorded in the audit row and printed in the signed PDF (see the
// follow-up FU-BEB-17 for the schema question).
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../generated/prisma/client.js';
import { isIP } from 'node:net';
import { CodedHttpException } from '../common/coded.exception';
import type { CandidateProblemCode } from '../common/coded.exception';
import type { Env } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import { SessionStateService } from '../session/session-state.service';
import { SessionStateConflictError } from '../session/session-state.errors';
import { declineContactOf } from './candidate-auth.service';
import type { RequestInfo } from './candidate-auth.service';
import type { CandidateContext } from './candidate.types';
import { SessionJobsService } from './session-jobs.service';

const MAX_USER_AGENT = 512;
const MIN_NAME = 2;
const MAX_NAME = 200;

export interface ConsentView {
  readonly consentTextId: string;
  readonly version: string;
  readonly bodyMd: string;
  /** False for a placeholder text. Pilot and production refuse to serve one (D-17). */
  readonly legalApproved: boolean;
  readonly signed: boolean;
  readonly signedAt: Date | null;
}

function coded(
  status: HttpStatus,
  message: string,
  code: CandidateProblemCode,
  extensions: Record<string, string | number | null> = {},
): CodedHttpException {
  return new CodedHttpException(status, message, code, extensions);
}

/** NFC, collapsed inner whitespace, no control characters. Returns null when unusable. */
export function normalizeSignedName(raw: string): string | null {
  const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) return null;
  if (name.length < MIN_NAME || name.length > MAX_NAME) return null;
  return /\p{L}/u.test(name) ? name : null;
}

function inet(ip: string | undefined): string | null {
  return ip !== undefined && isIP(ip) !== 0 ? ip : null;
}

@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly states: SessionStateService,
    private readonly jobs: SessionJobsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private requireApproval(): boolean {
    return this.config.get('REQUIRE_LEGAL_APPROVED_CONSENT', { infer: true });
  }

  private async currentTextId(orgId: string): Promise<string | null> {
    const org = await this.prisma.client.organization.findUnique({
      where: { id: orgId },
      select: { currentConsentTextId: true },
    });
    return org?.currentConsentTextId ?? null;
  }

  /** GET /candidate/session/consent. */
  async get(ctx: CandidateContext): Promise<ConsentView> {
    if (!['OPENED', 'CONSENTED', 'VERIFIED', 'IN_PROGRESS', 'PAUSED'].includes(ctx.status)) {
      throw new SessionStateConflictError(ctx.status);
    }
    const existing = await this.prisma.client.consent.findUnique({
      where: { sessionId: ctx.sessionId },
      select: { consentTextId: true, signedAt: true },
    });
    const textId = existing?.consentTextId ?? (await this.currentTextId(ctx.orgId));
    if (textId === null) {
      throw coded(HttpStatus.CONFLICT, 'No consent document is configured.', 'CONSENT_NOT_CONFIGURED');
    }
    const text = await this.prisma.client.consentText.findUnique({
      where: { id: textId },
      select: { id: true, version: true, bodyMd: true, legalApprovedAt: true },
    });
    if (text === null) {
      throw coded(HttpStatus.CONFLICT, 'No consent document is configured.', 'CONSENT_NOT_CONFIGURED');
    }
    const approved = text.legalApprovedAt !== null;
    // A text already signed was served under the same rule; only an unsigned view is gated.
    if (existing?.signedAt == null && this.requireApproval() && !approved) {
      throw coded(
        HttpStatus.CONFLICT,
        'The consent document has not been approved yet.',
        'CONSENT_NOT_APPROVED',
      );
    }
    return {
      consentTextId: text.id,
      version: text.version,
      bodyMd: text.bodyMd,
      legalApproved: approved,
      signed: existing?.signedAt != null,
      signedAt: existing?.signedAt ?? null,
    };
  }

  /** POST /candidate/session/consent/sign. OPENED to CONSENTED, then the PDF job. */
  async sign(
    ctx: CandidateContext,
    input: { consentTextId: string; signedName: string; confirmedAge18: boolean },
    info: RequestInfo & { userAgent: string | undefined },
    now: Date = new Date(),
  ): Promise<{ status: 'CONSENTED'; signedAt: Date }> {
    if (input.confirmedAge18 !== true) {
      throw coded(
        HttpStatus.BAD_REQUEST,
        'You must confirm that you are 18 years of age or older to continue.',
        'AGE_CONFIRMATION_REQUIRED',
      );
    }
    const signedName = normalizeSignedName(input.signedName);
    if (signedName === null) {
      throw coded(HttpStatus.BAD_REQUEST, 'Type your full legal name.', 'SIGNED_NAME_INVALID');
    }
    return this.performSign(ctx, input.consentTextId, signedName, info, now);
  }

  private async performSign(
    ctx: CandidateContext,
    consentTextId: string,
    signedName: string,
    info: RequestInfo & { userAgent: string | undefined },
    now: Date,
  ): Promise<{ status: 'CONSENTED'; signedAt: Date }> {
    const currentId = await this.currentTextId(ctx.orgId);
    if (currentId === null) {
      throw coded(HttpStatus.CONFLICT, 'No consent document is configured.', 'CONSENT_NOT_CONFIGURED');
    }
    if (consentTextId !== currentId) {
      throw coded(
        HttpStatus.CONFLICT,
        'The consent document changed. Reload it and read it again.',
        'CONSENT_TEXT_CHANGED',
      );
    }
    const text = await this.prisma.client.consentText.findUnique({
      where: { id: currentId },
      select: { id: true, legalApprovedAt: true },
    });
    if (text === null) {
      throw coded(HttpStatus.CONFLICT, 'No consent document is configured.', 'CONSENT_NOT_CONFIGURED');
    }
    if (this.requireApproval() && text.legalApprovedAt === null) {
      throw coded(
        HttpStatus.CONFLICT,
        'The consent document has not been approved yet.',
        'CONSENT_NOT_APPROVED',
      );
    }

    try {
      await this.prisma.client.$transaction(async (tx) => {
        await this.states.transition({
          sessionId: ctx.sessionId,
          from: 'OPENED',
          to: 'CONSENTED',
          now,
          db: tx,
        });
        await tx.consent.create({
          data: {
            sessionId: ctx.sessionId,
            consentTextId: currentId,
            signedName,
            signedAt: now,
            ip: inet(info.ip),
            userAgent: info.userAgent?.slice(0, MAX_USER_AGENT) ?? null,
          },
        });
        await tx.auditLog.create({
          data: {
            orgId: ctx.orgId,
            actorId: null,
            action: 'CANDIDATE_CONSENT_SIGNED',
            entityType: 'session',
            entityId: ctx.sessionId,
            ip: inet(info.ip),
            // The typed name is not copied into the audit log; the consents row holds it.
            metadata: { consentTextId: currentId, ageConfirmed18: true },
            createdAt: now,
          },
        });
      });
    } catch (e) {
      if (e instanceof SessionStateConflictError || this.isUniqueViolation(e)) {
        throw coded(
          HttpStatus.CONFLICT,
          'This session has already answered the consent document.',
          'ALREADY_SIGNED',
          {
            sessionStatus:
              e instanceof SessionStateConflictError ? (e.extensions.sessionStatus ?? null) : null,
          },
        );
      }
      throw e;
    }

    // After the commit: the signature stands even if the queue is down. The sweep re-enqueues.
    try {
      await this.jobs.enqueueConsentPdf(ctx.sessionId, ctx.orgId);
    } catch {
      this.logger.error('Consent PDF job could not be queued; the sweep will retry');
    }
    return { status: 'CONSENTED', signedAt: now };
  }

  private isUniqueViolation(e: unknown): boolean {
    return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
  }

  /** POST /candidate/session/consent/decline. OPENED to DECLINED: no device access, no recording. */
  async decline(
    ctx: CandidateContext,
    info: RequestInfo & { userAgent: string | undefined },
    now: Date = new Date(),
  ): Promise<{ status: 'DECLINED'; declineContact: string | null }> {
    const currentId = await this.currentTextId(ctx.orgId);
    try {
      await this.prisma.client.$transaction(async (tx) => {
        await this.states.transition({
          sessionId: ctx.sessionId,
          from: 'OPENED',
          to: 'DECLINED',
          now,
          db: tx,
        });
        // consents.consent_text_id is NOT NULL: with no configured text there is no row to keep,
        // and the candidate can still decline.
        if (currentId !== null) {
          await tx.consent.create({
            data: {
              sessionId: ctx.sessionId,
              consentTextId: currentId,
              declinedAt: now,
              ip: inet(info.ip),
              userAgent: info.userAgent?.slice(0, MAX_USER_AGENT) ?? null,
            },
          });
        }
        await tx.auditLog.create({
          data: {
            orgId: ctx.orgId,
            actorId: null,
            action: 'CANDIDATE_CONSENT_DECLINED',
            entityType: 'session',
            entityId: ctx.sessionId,
            ip: inet(info.ip),
            metadata: { consentTextId: currentId },
            createdAt: now,
          },
        });
      });
    } catch (e) {
      if (e instanceof SessionStateConflictError || this.isUniqueViolation(e)) {
        throw coded(
          HttpStatus.CONFLICT,
          'This session has already answered the consent document.',
          'ALREADY_SIGNED',
        );
      }
      throw e;
    }
    const org = await this.prisma.client.organization.findUnique({
      where: { id: ctx.orgId },
      select: { settings: true },
    });
    return { status: 'DECLINED', declineContact: declineContactOf(org?.settings) };
  }
}
