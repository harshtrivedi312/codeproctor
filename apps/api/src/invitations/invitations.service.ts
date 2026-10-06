// One candidate invitation (FR-303, BE-06 slice 6c, ADR 0002 S-6, ADR 0006).
//
// Flow, one transaction: read the test (org scoped: another org's id is the same 404 as a missing
// one, TC-008), insert the candidate if this org has none for the address, lock that candidate row,
// refuse a second active invitation, insert the invitation, check the test is still satisfiable,
// ask the port for the INVITED session, write the audit row. Commit. Only then the mail goes out
// (a mail problem never undoes an invitation) and, when it was queued, sent_at is stamped.
//
// Locking. The invitation insert takes a KEY SHARE lock on the tests row through its foreign key.
// PATCH /tests locks that row FOR UPDATE and then refuses a test with an invitation, so an edit in
// flight makes this insert wait and an insert in flight makes the edit wait and then answer 409
// (tests.service.ts header). This service therefore NEVER locks the tests row (FU-BE-114): a lock
// stronger than KEY SHARE here would deadlock against the edit or serialize invitations. The
// satisfiability check runs AFTER the insert, so when an edit was in flight it reads the committed
// edit. Two invites for the same candidate and test are serialized by FOR NO KEY UPDATE on the
// candidate row (it does not conflict with the KEY SHARE of the invitation foreign key).
//
// Candidates are per organization (unique org_id + email). The candidate is inserted with
// ON CONFLICT DO NOTHING (raw SQL, org id in the statement) instead of "create, catch P2002,
// re-read": a unique violation aborts a Postgres transaction, so the catch could not re-read. A row
// of another organization is never visible, so the response is identical whether or not the address
// exists elsewhere.
//
// The raw token exists only in this method's local variable and in the invite URL handed to the
// mail port. The database holds its SHA-256 (hex); responses, audit rows, errors and logs never
// carry the token, the address or the name.
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { newOpaqueToken, sha256Hex } from '../auth/crypto.util';
import type { RequestContext } from '../common/request-context';
import { hitWindowCounter } from '../common/redis-counter';
import type { Env } from '../config/env';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { REDIS_CLIENT } from '../infrastructure/infrastructure.module';
import { ensureConnected } from '../infrastructure/redis-ready';
import { MailPort } from '../mail/mail.port';
import type { MailOutcome } from '../mail/mail.port';
import { TestsService } from '../tests/tests.service';
import type { Actor } from '../tests/tests.service';
import { parseInstant } from './dto/invitations.dto';
import type { CreateInvitationDto, InvitationCreatedDto } from './dto/invitations.dto';
import { INVITED_SESSION_PORT } from './invited-session.port';
import type { InvitedSessionPort } from './invited-session.port';

const DAY_MS = 86_400_000;
/** A window may not start further ahead than this: no meaning, and keeps dates in range. */
const MAX_START_AHEAD_DAYS = 366;
/** A window may not start more than this far in the past (clock skew only). */
const START_SKEW_MS = 5 * 60_000;
const RATE_WINDOW_SECONDS = 60 * 60;
const NOT_FOUND = 'Test not found.';

/** The candidate page the web reads. /t/start moves the fragment token into memory (FE-09). */
export const INVITE_PATH = '/t/start';

@Injectable()
export class InvitationsService {
  private readonly log = new Logger(InvitationsService.name);
  private readonly webOrigin: string;
  private readonly maxWindowDays: number;
  /** Per org and hour (INVITATION_RATE_LIMIT_PER_ORG_HOUR), read once in the constructor; the e2e lowers it with Reflect. */
  private readonly rateLimit: number;
  // The transaction may wait on a PATCH /tests holding the tests row FOR UPDATE (see the header).
  private readonly txTimeoutMs = 10_000;
  private readonly txMaxWaitMs = 5_000;
  // A lock wait is cut at this point, so the transaction timeout above is really enforced.
  private readonly lockTimeoutMs = 5_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
    private readonly tests: TestsService,
    private readonly mail: MailPort,
    @Inject(INVITED_SESSION_PORT) private readonly sessions: InvitedSessionPort,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.webOrigin = config.get('WEB_ORIGIN', { infer: true });
    this.maxWindowDays = config.get('INVITATION_MAX_WINDOW_DAYS', { infer: true });
    this.rateLimit = config.get('INVITATION_RATE_LIMIT_PER_ORG_HOUR', { infer: true });
  }

  async create(
    actor: Actor,
    testId: string,
    dto: CreateInvitationDto,
    ctx: RequestContext,
  ): Promise<InvitationCreatedDto> {
    const now = new Date();
    const { start, end } = this.window(dto, now);
    const slot = await this.takeSlot(actor.orgId);
    const token = newOpaqueToken();
    const tokenHash = sha256Hex(token);

    let created;
    try {
      created = await this.prisma.client.$transaction(
        async (tx) => {
          await this.orgContext.runRawSql(
            'cap lock waits of this transaction (SET LOCAL, no data access)',
            () =>
              tx.$executeRaw(
                Prisma.sql`SELECT set_config('lock_timeout', ${`${this.lockTimeoutMs}ms`}, true)`,
              ),
          );
          const test = await tx.test.findUnique({ where: { id: testId }, select: { id: true } });
          if (!test) throw new NotFoundException(NOT_FOUND);

          // Candidate: insert if absent, then lock the row (see the header).
          await this.orgContext.runRawSql(
            'insert the candidate of this organization if absent: ON CONFLICT DO NOTHING keeps the transaction usable after a lost race, same org only',
            () =>
              tx.$executeRaw(Prisma.sql`
            INSERT INTO candidates (org_id, email, full_name, external_ref)
            VALUES (${actor.orgId}::uuid, ${dto.email}::citext, ${dto.fullName}, ${dto.externalRef ?? null})
            ON CONFLICT (org_id, email) DO NOTHING`),
          );
          const rows = await this.orgContext.runRawSql(
            'lock the candidate row so two invitations for the same candidate and test serialize; FOR NO KEY UPDATE does not conflict with the foreign key share lock, same org only',
            () =>
              tx.$queryRaw<
                { id: string; erasure_requested_at: Date | null; erased_at: Date | null }[]
              >(Prisma.sql`
            SELECT id, erasure_requested_at, erased_at FROM candidates
            WHERE org_id = ${actor.orgId}::uuid AND email = ${dto.email}::citext
            FOR NO KEY UPDATE`),
          );
          const candidate = rows[0];
          if (!candidate)
            throw new InternalServerErrorException('The invitation could not be created.');
          if (candidate.erasure_requested_at !== null || candidate.erased_at !== null) {
            throw new ConflictException('This candidate cannot be invited.');
          }

          const active = await tx.invitation.findFirst({
            where: {
              testId,
              candidateId: candidate.id,
              usedAt: null,
              windowEnd: { gt: new Date() },
            },
            select: { id: true },
          });
          if (active) {
            throw new ConflictException(
              'This candidate already has an active invitation for this test.',
            );
          }

          const invitation = await tx.invitation.create({
            data: {
              orgId: actor.orgId,
              testId,
              candidateId: candidate.id,
              tokenHash,
              windowStart: start,
              windowEnd: end,
              createdById: actor.id,
            },
          });

          // After the insert on purpose: an edit that held the tests row has committed by now.
          const check = await this.tests.checkTestSatisfiable(testId, tx);
          if (!check.satisfiable) {
            throw new UnprocessableEntityException({ message: check.problems });
          }

          await this.sessions.createInvited(
            { orgId: actor.orgId, invitationId: invitation.id },
            tx,
          );

          await tx.auditLog.create({
            data: {
              orgId: actor.orgId,
              actorId: actor.id,
              action: 'INVITATION_CREATED',
              entityType: 'invitation',
              entityId: invitation.id,
              ip: ctx.ip ?? null,
              metadata: {
                testId,
                candidateId: candidate.id,
                windowStart: start.toISOString(),
                windowEnd: end.toISOString(),
              },
            },
          });
          return invitation;
        },
        { timeout: this.txTimeoutMs, maxWait: this.txMaxWaitMs },
      );
    } catch (e) {
      const failure = this.mapTimeout(e);
      // The rate slot is refunded only when the failure is the server's (5xx: lock contention,
      // timeout, port 503, bug), so a retry does not burn the hourly budget. 400, 404, 409 and 422
      // are legitimate attempts and keep their slot. Best effort; the original error is rethrown.
      const status = failure instanceof HttpException ? failure.getStatus() : 500;
      if (status >= 500) await this.refundSlot(slot);
      throw failure;
    }

    // The mail is outside the transaction: an outcome other than queued does not undo anything.
    const mail = await this.sendMail(dto.email, token, start, end);
    if (mail === 'queued') {
      try {
        await this.prisma.client.invitation.update({
          where: { id: created.id },
          data: { sentAt: new Date() },
        });
      } catch {
        // The invitation stands; only the sent marker is missing.
        this.log.warn('Could not stamp invitations.sent_at after queuing the mail.');
      }
    }
    return {
      id: created.id,
      testId: created.testId,
      candidateId: created.candidateId,
      windowStart: created.windowStart.toISOString(),
      windowEnd: created.windowEnd.toISOString(),
      createdAt: created.createdAt.toISOString(),
      mail,
    };
  }

  /** Fixed window per org and hour. Redis down is a 503 (fail closed), over the limit a 429. */
  private async takeSlot(orgId: string): Promise<string> {
    const key = `invitation:org:${orgId}:${Math.floor(Date.now() / (RATE_WINDOW_SECONDS * 1000))}`;
    let count: number;
    try {
      await ensureConnected(this.redis);
      count = (await hitWindowCounter(this.redis, key, RATE_WINDOW_SECONDS)).count;
    } catch {
      this.log.warn('Invitation rate limiter unavailable.');
      throw new ServiceUnavailableException('Invitations are temporarily unavailable.');
    }
    if (count > this.rateLimit) {
      throw new HttpException(
        'Too many invitations. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return key;
  }

  /** Gives one slot back. Never throws and never logs the key. */
  private async refundSlot(key: string): Promise<void> {
    try {
      await this.redis.decr(key);
    } catch {
      this.log.warn('Invitation rate slot could not be refunded.');
    }
  }

  /**
   * A transaction timeout (P2028) or a lock wait cut by lock_timeout (Postgres 55P03, which Prisma
   * 7 reports as P2039 with the driver code in meta) is a fixed 503; the transaction is rolled
   * back. Backend PR #216 maps these generally; this keeps the route safe until it lands.
   */
  private mapTimeout(e: unknown): unknown {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return e;
    const cause = (e.meta as { driverAdapterError?: { cause?: { code?: unknown } } } | undefined)
      ?.driverAdapterError?.cause;
    return e.code === 'P2028' || cause?.code === '55P03'
      ? new ServiceUnavailableException('The invitation could not be saved in time. Try again.')
      : e;
  }

  /** Server time is the only clock: the rules compare against `now`, never a client value. */
  private window(dto: CreateInvitationDto, now: Date): { start: Date; end: Date } {
    const start = dto.windowStart === undefined ? now : parseInstant(dto.windowStart);
    const end = parseInstant(dto.windowEnd);
    if (!start || !end) throw new BadRequestException(['the window is not a valid date-time']);
    const problems: string[] = [];
    if (end.getTime() <= start.getTime()) problems.push('windowEnd must be after windowStart');
    if (end.getTime() <= now.getTime()) problems.push('windowEnd must be in the future');
    if (end.getTime() - start.getTime() > this.maxWindowDays * DAY_MS) {
      problems.push(`the window may be at most ${this.maxWindowDays} day(s) long`);
    }
    if (now.getTime() - start.getTime() > START_SKEW_MS) {
      problems.push('windowStart may be at most 5 minutes in the past');
    }
    if (start.getTime() - now.getTime() > MAX_START_AHEAD_DAYS * DAY_MS) {
      problems.push(`windowStart may be at most ${MAX_START_AHEAD_DAYS} days ahead`);
    }
    if (problems.length) throw new BadRequestException(problems);
    return { start, end };
  }

  private async sendMail(
    to: string,
    token: string,
    windowStartsAt: Date,
    windowEndsAt: Date,
  ): Promise<MailOutcome> {
    try {
      return await this.mail.sendInvitation(to, {
        inviteUrl: `${this.webOrigin}${INVITE_PATH}#token=${token}`,
        windowStartsAt,
        windowEndsAt,
      });
    } catch {
      // Nothing from the error: it may carry the address or the link.
      this.log.warn('The invitation mail could not be queued.');
      return 'failed';
    }
  }
}
