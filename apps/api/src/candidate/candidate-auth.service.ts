// The three routes that run before a candidate token exists (ADR 0013 section 5.10): resolve the
// invitation link, send the email OTP, and exchange link plus OTP for a session token. FR-106,
// ADR 0002 L-1..L-5, ADR 0003 section 6, TC-007, TC-021, TC-022, TC-045, TC-097.
//
// The invitation token is a 32-byte secret; only its SHA-256 is stored, and the lookup is by that
// hash (unique index). An unknown token and a malformed one both answer 404 INVALID_LINK. Neither
// the token nor the OTP is ever logged or put in an error.
import { HttpStatus, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { isIP } from 'node:net';
import { DEFAULT_EVENT_SEVERITY, shouldPushToLive } from '@codeproctor/shared';
import { sha256Hex } from '../auth/crypto.util';
import { CodedHttpException } from '../common/coded.exception';
import type { CandidateProblemCode } from '../common/coded.exception';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import type { SessionStatus } from '../generated/prisma/enums.js';
import { REDIS_CLIENT } from '../infrastructure/infrastructure.module';
import { ensureConnected } from '../infrastructure/redis-ready';
import { SessionStateService } from '../session/session-state.service';
import { SessionStateConflictError } from '../session/session-state.errors';
import { LIVE_STATUSES, PRE_START_STATUSES, USED_STATUSES } from '../session/session-transitions';
import { CandidateMailPort } from './candidate-mail.port';
import { isBusyLockError } from './busy-lock-error';
import { sessionNotActive } from '../session/session-write-gate';
import { CandidateTokenService } from './candidate-token.service';
import {
  OTP_BLOCK_SECONDS,
  OTP_COOLDOWN_SECONDS,
  OTP_TTL_SECONDS,
  OtpService,
} from './otp.service';
import type { OtpPhase } from './otp.service';

export type LinkState =
  'OTP_REQUIRED' | 'ALREADY_USED' | 'EXPIRED' | 'DECLINED' | 'BLOCKED' | 'NOT_YET_OPEN';

export interface LinkView {
  readonly state: LinkState;
  readonly orgName: string;
  /** Only for DECLINED: the org's contact for alternatives or accommodations (D-17, TC-096). */
  readonly declineContact: string | null;
  /** Only for BLOCKED or NOT_YET_OPEN. */
  readonly retryAfterSeconds: number | null;
  readonly windowStart: Date;
  readonly windowEnd: Date;
}

export interface RequestInfo {
  /** Client address as Express resolved it (trust proxy hops applied). */
  readonly ip: string | undefined;
}

interface ResolvedLink {
  readonly invitation: {
    id: string;
    orgId: string;
    candidateId: string;
    testId: string;
    createdById: string | null;
    windowStart: Date;
    windowEnd: Date;
  };
  readonly session: { id: string; status: SessionStatus };
  /**
   * The candidate's name and address, loaded on demand and only where they are used (sending a
   * code, the lockout notice). The link and the refusal paths never read them: a used or erased
   * link must answer from the session status alone (L-3), and read no personal data.
   */
  readonly candidate: () => Promise<{ fullName: string; email: string }>;
  readonly testName: string;
  readonly orgName: string;
  readonly orgSettings: unknown;
}

/** The statuses a sign-in may raise the epoch of: after the first transition, never a terminal one. */
const SIGN_IN_STATUSES = ['OPENED', 'CONSENTED', 'VERIFIED', 'IN_PROGRESS', 'PAUSED'] as const;

const MAX_CONTACT_LENGTH = 500;
const INVALID_LINK = 'This invitation link is not valid.';

function invalidLink(): never {
  throw new NotFoundException({ message: INVALID_LINK });
}

function coded(
  status: HttpStatus,
  message: string,
  code: CandidateProblemCode,
  extensions: Record<string, string | number | null> = {},
): CodedHttpException {
  return new CodedHttpException(status, message, code, extensions);
}

/** `a***@example.com`: enough for the candidate to recognise the address, not to harvest it. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

export function declineContactOf(settings: unknown): string | null {
  if (typeof settings !== 'object' || settings === null) return null;
  const raw = (settings as Record<string, unknown>).consentDeclineContact;
  return typeof raw === 'string' && raw.trim().length > 0
    ? raw.trim().slice(0, MAX_CONTACT_LENGTH)
    : null;
}

@Injectable()
export class CandidateAuthService {
  private readonly logger = new Logger(CandidateAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
    private readonly otp: OtpService,
    private readonly tokens: CandidateTokenService,
    private readonly states: SessionStateService,
    private readonly mail: CandidateMailPort,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Link by token hash, then everything else inside the invitation's org. */
  private async resolve<T>(rawToken: string, then: (link: ResolvedLink) => Promise<T>): Promise<T> {
    const tokenHash = sha256Hex(rawToken);
    return this.orgContext.runSystem('AUTH_BOOTSTRAP', async () => {
      const invitation = await this.prisma.client.invitation.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          orgId: true,
          candidateId: true,
          testId: true,
          createdById: true,
          windowStart: true,
          windowEnd: true,
        },
      });
      if (invitation === null) return invalidLink();
      // Narrow to the invitation's org before any other read (system scope is only for the lookup).
      return this.orgContext.runInOrg(invitation.orgId, async () => {
        const [session, test, org] = await Promise.all([
          this.prisma.client.session.findUnique({
            where: { invitationId: invitation.id },
            select: { id: true, status: true },
          }),
          this.prisma.client.test.findUnique({
            where: { id: invitation.testId },
            select: { name: true },
          }),
          this.prisma.client.organization.findUnique({
            where: { id: invitation.orgId },
            select: { name: true, settings: true },
          }),
        ]);
        if (!session || !test || !org) return invalidLink();
        let loaded: { fullName: string; email: string } | undefined;
        return then({
          invitation,
          session,
          candidate: async () => {
            loaded ??=
              (await this.prisma.client.candidate.findUnique({
                where: { id: invitation.candidateId },
                select: { fullName: true, email: true },
              })) ?? undefined;
            if (loaded === undefined) return invalidLink();
            return loaded;
          },
          testName: test.name,
          orgName: org.name,
          orgSettings: org.settings,
        });
      });
    });
  }

  /** The link state after the expiry check (TC-022). May move an unstarted session to EXPIRED. */
  private async stateOf(link: ResolvedLink, now: Date): Promise<LinkView> {
    const base = {
      orgName: link.orgName,
      declineContact: null,
      retryAfterSeconds: null,
      windowStart: link.invitation.windowStart,
      windowEnd: link.invitation.windowEnd,
    };
    const status = link.session.status;
    if (USED_STATUSES.includes(status)) return { ...base, state: 'ALREADY_USED' };
    if (status === 'EXPIRED') return { ...base, state: 'EXPIRED' };
    if (status === 'DECLINED') {
      return { ...base, state: 'DECLINED', declineContact: declineContactOf(link.orgSettings) };
    }
    if (LIVE_STATUSES.includes(status)) return { ...base, state: 'OTP_REQUIRED' };

    // INVITED to VERIFIED. window_end applies only before the test starts (ADR 0002 L-4).
    if (now.getTime() > link.invitation.windowEnd.getTime()) {
      try {
        await this.states.transition({
          sessionId: link.session.id,
          from: PRE_START_STATUSES,
          to: 'EXPIRED',
          now,
        });
      } catch (e) {
        // Another request moved the session first (for example the expiry job). Either way the
        // window is over; a session that started meanwhile is handled by the caller's next read.
        if (!(e instanceof SessionStateConflictError)) throw e;
      }
      return { ...base, state: 'EXPIRED' };
    }
    if (now.getTime() < link.invitation.windowStart.getTime()) {
      return {
        ...base,
        state: 'NOT_YET_OPEN',
        retryAfterSeconds: Math.ceil(
          (link.invitation.windowStart.getTime() - now.getTime()) / 1000,
        ),
      };
    }
    const blocked = await this.otp.blockedSeconds(link.invitation.id);
    if (blocked > 0) return { ...base, state: 'BLOCKED', retryAfterSeconds: blocked };
    return { ...base, state: 'OTP_REQUIRED' };
  }

  /** POST /candidate/session/link: what the link page shows. Sends nothing (L-3: no OTP for a used link). */
  async resolveLink(rawToken: string, now: Date = new Date()): Promise<LinkView> {
    return this.resolve(rawToken, (link) => this.stateOf(link, now));
  }

  /** POST /candidate/session/otp: emails a new code when the link is open. */
  async sendOtp(
    rawToken: string,
    now: Date = new Date(),
  ): Promise<{ view: LinkView; sent: boolean; maskedEmail: string | null }> {
    return this.resolve(rawToken, async (link) => {
      const view = await this.stateOf(link, now);
      if (view.state !== 'OTP_REQUIRED') return { view, sent: false, maskedEmail: null };
      const phase: OtpPhase = LIVE_STATUSES.includes(link.session.status) ? 'LIVE' : 'PRE_START';
      const issued = await this.otp.issue(link.invitation.id, phase);
      if (issued.kind === 'blocked') {
        return {
          view: { ...view, state: 'BLOCKED', retryAfterSeconds: issued.retryAfterSeconds },
          sent: false,
          maskedEmail: null,
        };
      }
      if (issued.kind === 'wait') {
        throw coded(
          HttpStatus.TOO_MANY_REQUESTS,
          'A code was sent a moment ago. Wait before asking for another.',
          'OTP_COOLDOWN',
          { retryAfterSeconds: issued.retryAfterSeconds },
        );
      }
      // The candidate is read only now that a code really goes out.
      const candidate = await link.candidate();
      try {
        await this.mail.sendOtp(candidate.email, {
          code: issued.code,
          testName: link.testName,
          expiresInMinutes: OTP_TTL_SECONDS / 60,
        });
      } catch {
        // Never report OTP_SENT for a message that was not sent. The code is dropped and the
        // send cooldown cleared so the candidate can ask again at once.
        await this.otp.discard(link.invitation.id);
        this.logger.error('Candidate OTP email failed');
        throw coded(
          HttpStatus.SERVICE_UNAVAILABLE,
          'The code could not be sent. Try again shortly.',
          'MAIL_UNAVAILABLE',
        );
      }
      return { view, sent: true, maskedEmail: maskEmail(candidate.email) };
    });
  }

  /**
   * POST /candidate/session/start: link plus OTP for a session token. Every success raises
   * auth_epoch, so a token on any other device stops working (one active device, L-2).
   */
  async start(
    rawToken: string,
    code: string,
    info: RequestInfo,
    now: Date = new Date(),
  ): Promise<{ token: string; expiresAt: Date; status: SessionStatus; epoch: number }> {
    return this.resolve(rawToken, async (link) => {
      const view = await this.stateOf(link, now);
      this.refuseUnlessOpen(view);

      const live = LIVE_STATUSES.includes(link.session.status);
      const phase: OtpPhase = live ? 'LIVE' : 'PRE_START';
      const result = await this.otp.verify(link.invitation.id, code, phase);

      switch (result.kind) {
        case 'blocked':
          if (result.blockedNow) await this.onBlocked(link, info, now);
          throw coded(
            HttpStatus.TOO_MANY_REQUESTS,
            'This link is blocked for 30 minutes after too many wrong codes.',
            'LINK_BLOCKED',
            { retryAfterSeconds: result.retryAfterSeconds },
          );
        case 'busy':
        case 'cooldown':
          throw coded(
            HttpStatus.TOO_MANY_REQUESTS,
            'Wait before trying another code.',
            'OTP_COOLDOWN',
            { retryAfterSeconds: result.retryAfterSeconds },
          );
        case 'none':
          throw coded(
            HttpStatus.BAD_REQUEST,
            'No code is waiting. Ask for a new one.',
            'OTP_NOT_REQUESTED',
          );
        case 'wrong':
          if (result.blockedNow) await this.onBlocked(link, info, now);
          if (live) await this.onResumeFailure(link, now);
          // TC-007: the guess that blocks the link is answered as blocked, not as one more typo.
          if (result.blockedNow) {
            throw coded(
              HttpStatus.TOO_MANY_REQUESTS,
              'This link is blocked for 30 minutes after too many wrong codes.',
              'LINK_BLOCKED',
              { retryAfterSeconds: OTP_BLOCK_SECONDS },
            );
          }
          throw coded(HttpStatus.BAD_REQUEST, 'That code is not correct.', 'OTP_INVALID', {
            retryAfterSeconds: live ? OTP_COOLDOWN_SECONDS : null,
          });
        case 'ok':
          break;
      }

      // The code is spent. If a write below is busy (lock timeout, deadlock), the client retries
      // with the same code (503), so the code and the guess it used are put back first (DL-37).
      const sessionId = link.session.id;
      let updated: { authEpoch: number; status: SessionStatus };
      try {
        // Read the status again: it may have moved since the first read (the test was submitted,
        // expired or declined on another device), and no token is issued for that.
        const fresh = await this.prisma.client.session.findUnique({
          where: { id: sessionId },
          select: { status: true },
        });
        if (fresh === null) return invalidLink();
        this.refuseUnlessOpen(
          await this.stateOf({ ...link, session: { id: sessionId, status: fresh.status } }, now),
        );
        if (link.session.status === 'INVITED') {
          try {
            await this.states.transition({ sessionId, from: 'INVITED', to: 'OPENED', now });
          } catch (e) {
            if (!(e instanceof SessionStateConflictError)) throw e;
          }
        }
        // The epoch last: it ends every older token at once, so a busy failure before it leaves
        // the other device signed in and only an idempotent OPENED behind.
        // Atomic with the status: a session that became terminal since the read above (submitted,
        // expired, declined) is not touched, so no epoch bump and no token for it.
        const bumped = await this.prisma.client.session.updateManyAndReturn({
          where: { id: sessionId, status: { in: [...SIGN_IN_STATUSES] } },
          data: { authEpoch: { increment: 1 } },
          select: { authEpoch: true, status: true },
        });
        const row = bumped[0];
        if (row === undefined) {
          const now2 = await this.prisma.client.session.findUnique({
            where: { id: sessionId },
            select: { status: true },
          });
          if (now2 === null) return invalidLink();
          this.refuseUnlessOpen(
            await this.stateOf({ ...link, session: { id: sessionId, status: now2.status } }, now),
          );
          throw sessionNotActive(now2.status);
        }
        updated = row;
      } catch (e) {
        if (isBusyLockError(e)) {
          // Ids only in the log: never the hash.
          const back = await this.otp.restore(link.invitation.id, result, phase).catch(() => false);
          if (!back) {
            this.logger.warn(
              `OTP not restored after a busy write for invitation ${link.invitation.id}`,
            );
          }
        }
        throw e;
      }
      const issued = this.tokens.sign(
        { sid: sessionId, oid: link.invitation.orgId, epoch: updated.authEpoch },
        now,
      );
      return {
        token: issued.token,
        expiresAt: issued.expiresAt,
        status: updated.status,
        epoch: updated.authEpoch,
      };
    });
  }

  private refuseUnlessOpen(view: LinkView): void {
    switch (view.state) {
      case 'OTP_REQUIRED':
        return;
      case 'ALREADY_USED':
        throw coded(HttpStatus.CONFLICT, 'This link has already been used.', 'LINK_ALREADY_USED');
      case 'EXPIRED':
        throw coded(HttpStatus.CONFLICT, 'This link has expired.', 'LINK_EXPIRED');
      case 'DECLINED':
        throw coded(HttpStatus.CONFLICT, 'Consent was declined for this link.', 'LINK_DECLINED');
      case 'NOT_YET_OPEN':
        throw coded(HttpStatus.CONFLICT, 'The test window has not opened yet.', 'WINDOW_NOT_OPEN', {
          retryAfterSeconds: view.retryAfterSeconds,
        });
      case 'BLOCKED':
        throw coded(
          HttpStatus.TOO_MANY_REQUESTS,
          'This link is blocked for 30 minutes after too many wrong codes.',
          'LINK_BLOCKED',
          { retryAfterSeconds: view.retryAfterSeconds },
        );
    }
  }

  /** The 5th wrong code before the test: audit row (null actor) and an email to the recruiter (TC-007). */
  private async onBlocked(link: ResolvedLink, info: RequestInfo, now: Date): Promise<void> {
    await this.prisma.client.auditLog.create({
      data: {
        orgId: link.invitation.orgId,
        actorId: null,
        action: 'CANDIDATE_OTP_LOCKED',
        entityType: 'session',
        entityId: link.session.id,
        ip: info.ip !== undefined && isIP(info.ip) !== 0 ? info.ip : null,
        metadata: { invitationId: link.invitation.id, blockedSeconds: OTP_BLOCK_SECONDS },
        createdAt: now,
      },
    });
    const recruiterId = link.invitation.createdById;
    if (recruiterId === null) return;
    const recruiter = await this.prisma.client.user.findUnique({
      where: { id: recruiterId },
      select: { email: true, isActive: true },
    });
    if (!recruiter?.isActive) return;
    // The candidate's name and address are read only here, for the notice.
    const candidate = await link.candidate();
    try {
      await this.mail.sendOtpLockout(recruiter.email, {
        candidateName: candidate.fullName,
        candidateEmail: candidate.email,
        testName: link.testName,
        blockedMinutes: OTP_BLOCK_SECONDS / 60,
      });
    } catch {
      // The block and the audit row stand. No address or message text in the log.
      this.logger.error('Recruiter lockout email failed');
    }
  }

  /**
   * A wrong code during a test (D-21): a SERVER event RESUME_OTP_FAILED (never with the code) and a
   * push to the proctor on live:{orgId}. No lockout; the 30 s cooldown is already set.
   */
  private async onResumeFailure(link: ResolvedLink, now: Date): Promise<void> {
    const severity = DEFAULT_EVENT_SEVERITY.RESUME_OTP_FAILED;
    await this.prisma.client.proctorEvent.create({
      data: {
        sessionId: link.session.id,
        type: 'RESUME_OTP_FAILED',
        severity,
        source: 'SERVER',
        occurredAt: now,
        payload: {},
      },
    });
    if (!shouldPushToLive('RESUME_OTP_FAILED', severity)) return;
    try {
      await ensureConnected(this.redis);
      await this.redis.publish(
        `live:${link.invitation.orgId}`,
        JSON.stringify({
          type: 'RESUME_OTP_FAILED',
          severity,
          sessionId: link.session.id,
          occurredAt: now.toISOString(),
        }),
      );
    } catch {
      // The event row is the record; the live alert is best effort.
      this.logger.warn('Live alert for RESUME_OTP_FAILED was not published');
    }
  }
}
