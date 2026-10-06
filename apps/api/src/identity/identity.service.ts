// The candidate's identity check, API side (FR-403, ADR 0004 sections 1 and 2, ADR 0013 5.6, 5.7,
// ADR 0015 sections 3 and 6, owner decisions C-02, C-18, C-19, C-25, C-34, DL-30). Design notes:
// docs/briefs/BE-08b-design.md. The rules it enforces:
//   - the check never rejects anyone: every outcome is PASSED, LOW_CONFIDENCE or MANUAL_REVIEW;
//   - a waived check answers 409 whatever the state, on a repeat POST too, and deletes the images
//     already uploaded for the names it refuses (N3) instead of waiting for a sweep;
//   - the browser sends names this server issued, never object keys; names are single use;
//   - idempotency is keyed on the two names, so a retry with new names after LOW_CONFIDENCE reaches
//     attempt 2, and a repeat of an accepted POST returns its row;
//   - the candidate sees status only, never a score, a threshold, a model id or a reason;
//   - sealed images and rows are deleted when a waiver lands later (DL-30).
// Nothing here logs a key, a URL, a name or a score: session id, route and outcome only.
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { CodedHttpException } from '../common/coded.exception';
import { SessionRateLimiter } from '../candidate/session-rate-limiter';
import { newUlid } from '../candidate/ulid';
import type { CandidateContext } from '../candidate/candidate.types';
import { PrismaService } from '../database/prisma.service';
import type { SessionScope } from '../media/storage-keys';
import { sessionNotActive } from '../session/session-write-gate';
import type {
  IdentityPresignedDto,
  IdentityStatusDto,
  IdentityStatusView,
} from './dto/identity.dto';
import { IdentityFacts } from './identity-facts';
import { IdentityMedia, KIND_OF } from './identity-media';
import type { ImageKind } from './identity-media';
import { IdentityNamesStore } from './identity-names.store';
import { IdentityPurgeService } from './identity-purge.service';
import { FaceMatchQueue } from './identity-ports';
import {
  IDENTITY_IMAGE_MAX_BYTES,
  IDENTITY_IMAGE_TYPE,
  IDENTITY_NAME,
  MAX_ATTEMPTS,
} from './identity.constants';
import type { IdentityPurpose } from './identity.constants';

export interface ParsedName {
  readonly attempt: number;
  readonly kind: ImageKind;
  readonly ulid: string;
}

export function parseName(name: string, expected: ImageKind): ParsedName | null {
  const m = IDENTITY_NAME.exec(name);
  if (m === null) return null;
  const kind = m[2] as ImageKind;
  return kind === expected ? { attempt: Number(m[1]), kind, ulid: m[3] as string } : null;
}

function problem(
  status: HttpStatus,
  message: string,
  code: ConstructorParameters<typeof CodedHttpException>[2],
): CodedHttpException {
  return new CodedHttpException(status, message, code);
}

const waived = (): CodedHttpException =>
  problem(
    HttpStatus.CONFLICT,
    'The identity check is not required for this session.',
    'IDENTITY_CHECK_WAIVED',
  );
const nameInvalid = (): CodedHttpException =>
  problem(
    HttpStatus.BAD_REQUEST,
    'The upload names are not valid for this attempt.',
    'IDENTITY_NAME_INVALID',
  );

interface LatestRow {
  readonly attempt: number;
  readonly status: string;
}

@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: IdentityMedia,
    private readonly names: IdentityNamesStore,
    private readonly facts: IdentityFacts,
    private readonly queue: FaceMatchQueue,
    private readonly limiter: SessionRateLimiter,
    private readonly purge: IdentityPurgeService,
  ) {}

  // ---- presign: issue single-use names ----

  /** POST /candidate/session/identity/presign. */
  async presign(
    ctx: CandidateContext,
    input: { purpose: IdentityPurpose; bytes: number },
    now: Date = new Date(),
  ): Promise<IdentityPresignedDto> {
    await this.limiter.hit('identity-presign', ctx.sessionId, 20, 60);
    if (input.bytes < 1 || input.bytes > IDENTITY_IMAGE_MAX_BYTES) throw nameInvalid();
    if ((await this.facts.policy(ctx.sessionId)).waived) throw waived();
    if (ctx.status !== 'CONSENTED') throw sessionNotActive(ctx.status);

    const attempt = this.expectedAttempt(await this.latest(ctx.sessionId));
    const kind = KIND_OF[input.purpose];
    const ulid = newUlid(now);
    const scope: SessionScope = { orgId: ctx.orgId, sessionId: ctx.sessionId };
    const put = await this.media.presignPut(
      scope,
      this.media.uploadKey(scope, attempt, kind, ulid),
      input.bytes,
    );
    const name = `identity/${String(attempt)}/${kind}-${ulid}.jpg`;
    await this.names.issue(ctx.sessionId, name, input.purpose);
    this.log('presign', ctx, 'issued');
    return {
      url: put.url,
      method: 'PUT',
      headers: { ...put.headers },
      name,
      attempt,
      expiresAt: put.expiresAt.toISOString(),
    };
  }

  // ---- submit ----

  /** POST /candidate/session/identity. 202 with the row's status (PENDING for a new attempt). */
  async submit(
    ctx: CandidateContext,
    input: { idImageName: string; selfieName: string; livenessConfirmed: boolean },
  ): Promise<IdentityStatusDto> {
    const id = parseName(input.idImageName, 'id');
    const selfie = parseName(input.selfieName, 'selfie');
    if (id === null || selfie === null || id.attempt !== selfie.attempt) throw nameInvalid();
    const scope: SessionScope = { orgId: ctx.orgId, sessionId: ctx.sessionId };
    const refs: NameRef[] = [
      { name: input.idImageName, purpose: 'ID_IMAGE', parsed: id },
      { name: input.selfieName, purpose: 'SELFIE', parsed: selfie },
    ];

    // 2. Waiver first, before any state check and even on a repeat POST (ADR 0015, N3).
    if ((await this.facts.policy(ctx.sessionId)).waived) {
      await this.refuse(ctx, scope, refs);
      this.log('submit', ctx, 'waived');
      throw waived();
    }

    // 3. Idempotency keyed on the names: the same two names return their row with its real status.
    const sealedId = this.media.sealedKey(scope, id.attempt, 'id', id.ulid);
    const sealedSelfie = this.media.sealedKey(scope, id.attempt, 'selfie', selfie.ulid);
    const existing = await this.byNames(ctx, id.attempt, refs);
    if (existing !== null) return this.repeat(ctx, scope, refs, existing);

    // 4. A new attempt needs CONSENTED.
    if (ctx.status !== 'CONSENTED') throw sessionNotActive(ctx.status);

    // 5. Which attempt is next. New names while attempt 1 is pending, or after it ended, are refused
    //    and their uploads are removed.
    const latest = await this.latest(ctx.sessionId);
    const next = this.nextAttempt(latest);
    if (next === null) {
      await this.refuse(ctx, scope, refs);
      throw this.cannotAttempt(latest);
    }
    if (id.attempt !== next) throw nameInvalid();

    // 6(0). Both names must be ours, for the right purpose, and still unused.
    for (const r of refs) {
      const state = await this.names.state(ctx.sessionId, r.name, r.purpose);
      if (state === 'ISSUED') continue;
      if (state === 'USED') {
        // An identical POST holds the names (or finished): give its row a moment, then judge.
        const same = await this.waitForRow(ctx, id.attempt, refs);
        if (same !== null) return this.repeat(ctx, scope, refs, same);
      }
      throw nameInvalid();
    }
    const uploads = refs.map((r) =>
      this.media.uploadKey(scope, id.attempt, r.parsed.kind, r.parsed.ulid),
    );
    // (a) HEAD both: missing leaves the names ISSUED (the client uploads again); a wrong object is
    //     removed and its name is spent.
    const heads = await Promise.all(uploads.map((key) => this.media.head(key)));
    for (const [i, head] of heads.entries()) {
      if (head === null) {
        // A concurrent identical POST may have finished and deleted the originals: that is a repeat.
        const done = await this.byNames(ctx, id.attempt, refs);
        if (done !== null) return this.repeat(ctx, scope, refs, done);
        throw problem(
          HttpStatus.CONFLICT,
          'The upload is not in storage yet. Upload it again.',
          'UPLOAD_NOT_FOUND',
        );
      }
      if (
        head.contentType !== IDENTITY_IMAGE_TYPE ||
        head.sizeBytes < 1 ||
        head.sizeBytes > IDENTITY_IMAGE_MAX_BYTES
      ) {
        await this.expire(ctx, refs[i] as NameRef, uploads[i] as string);
        throw problem(
          HttpStatus.BAD_REQUEST,
          'The image is not an accepted JPEG.',
          'IDENTITY_IMAGE_REJECTED',
        );
      }
    }
    // (b) CopyObject both to the sealed keys; a failure deletes every partial copy.
    const sealed = [sealedId, sealedSelfie];
    try {
      for (const [i, key] of uploads.entries()) await this.media.copy(key, sealed[i] as string);
    } catch (e) {
      await this.dropSealedUnlessClaimed(ctx, refs, sealedId, sealedSelfie);
      throw e;
    }
    // (c) Claim both names, then insert the row. A failure releases the claims and removes the
    //     sealed copies before the race rules below judge what happened.
    const liveness = input.livenessConfirmed === true; // client-reported (R-05); a plain value
    const claimed: NameRef[] = [];
    try {
      for (const r of refs) {
        if (!(await this.names.transition(ctx.sessionId, r.name, r.purpose, 'ISSUED', 'USED'))) {
          throw new ClaimLost();
        }
        claimed.push(r);
      }
      await this.prisma.client.identityCheck.create({
        data: {
          sessionId: ctx.sessionId,
          attempt: id.attempt,
          idImageKey: sealedId,
          selfieKey: sealedSelfie,
          livenessPassed: liveness,
          status: 'PENDING',
        },
        select: { id: true },
      });
    } catch (e) {
      await this.release(ctx, claimed);
      if (!(e instanceof ClaimLost) && !isUniqueViolation(e)) {
        await this.dropSealedUnlessClaimed(ctx, refs, sealedId, sealedSelfie);
        throw e;
      }
      return this.lostRace(ctx, scope, refs, id.attempt, sealedId, sealedSelfie);
    }
    // (d) After the commit: the originals go, the job is queued. A lost enqueue is recovered by a
    //     repeat POST or the reconciler (a PENDING row with no job), so it is not an error here.
    await this.media.deleteQuietly(...uploads);
    await this.enqueue(ctx, id.attempt);
    this.log('submit', ctx, 'accepted');
    return { attempt: id.attempt, status: 'PENDING', canRetry: false };
  }

  // ---- status ----

  /** GET /candidate/session/identity: status only (NFR-05). */
  async status(ctx: CandidateContext): Promise<IdentityStatusDto> {
    if ((await this.facts.policy(ctx.sessionId)).waived) {
      return { attempt: 0, status: 'WAIVED', canRetry: false };
    }
    const latest = await this.latest(ctx.sessionId);
    if (latest === null) return { attempt: 0, status: 'NOT_STARTED', canRetry: false };
    return viewOf(latest);
  }

  // ---- DL-30: a waiver after a match ----

  /** BE-06 calls this after it commits a waiver; see IdentityPurgeService. */
  purgeAfterWaiver(orgId: string, sessionId: string): Promise<{ deleted: boolean }> {
    return this.purge.purgeAfterWaiver(orgId, sessionId);
  }

  // ---- helpers ----

  private async repeat(
    ctx: CandidateContext,
    scope: SessionScope,
    refs: readonly NameRef[],
    row: LatestRow,
  ): Promise<IdentityStatusDto> {
    // A PENDING row may have lost its job (a crash or a Redis outage after the commit): queue it
    // again under the same job id, which BullMQ ignores when the job still exists.
    if (row.status === 'PENDING') await this.enqueue(ctx, row.attempt);
    // The previous request may have failed to delete the originals: retry that too.
    await this.media.deleteQuietly(
      ...refs.map((r) => this.media.uploadKey(scope, row.attempt, r.parsed.kind, r.parsed.ulid)),
    );
    this.log('submit', ctx, 'repeat');
    return viewOf(row);
  }

  /**
   * Rules for losing the claim or the insert (design notes step 7). Always throws or returns a row.
   * The sealed copies of identical names are the winner's: they are deleted only when no row
   * references them.
   */
  private async lostRace(
    ctx: CandidateContext,
    scope: SessionScope,
    refs: readonly NameRef[],
    attempt: number,
    sealedId: string,
    sealedSelfie: string,
  ): Promise<IdentityStatusDto> {
    if ((await this.facts.policy(ctx.sessionId)).waived) {
      await this.dropSealedUnlessClaimed(ctx, refs, sealedId, sealedSelfie);
      await this.refuse(ctx, scope, refs);
      throw waived();
    }
    // A concurrent identical POST holds the names: give it a moment to commit its row.
    const same = await this.waitForRow(ctx, attempt, refs);
    if (same !== null) return this.repeat(ctx, scope, refs, same);
    await this.dropSealedUnlessClaimed(ctx, refs, sealedId, sealedSelfie);
    const latest = await this.latest(ctx.sessionId);
    if (latest !== null) {
      await this.refuse(ctx, scope, refs);
      throw this.cannotAttempt(latest);
    }
    throw nameInvalid();
  }

  /** The row of an identical concurrent POST, waiting up to about 2 s for it to commit. */
  private async waitForRow(
    ctx: CandidateContext,
    attempt: number,
    refs: readonly NameRef[],
  ): Promise<LatestRow | null> {
    for (let i = 0; i < RACE_POLLS; i++) {
      const row = await this.byNames(ctx, attempt, refs);
      if (row !== null) return row;
      if (i < RACE_POLLS - 1) await new Promise((r) => setTimeout(r, RACE_POLL_MS));
    }
    return null;
  }

  /**
   * Deletes the sealed pair unless an identical request holds the names (USED): those copies are
   * its own and a row will point at them. Best effort: a request between its copy and its claim
   * is not visible here, and the ingest-close sweep removes any sealed object no row references.
   */
  private async dropSealedUnlessClaimed(
    ctx: CandidateContext,
    refs: readonly NameRef[],
    sealedId: string,
    sealedSelfie: string,
  ): Promise<void> {
    for (const r of refs) {
      if ((await this.names.state(ctx.sessionId, r.name, r.purpose)) === 'USED') return;
    }
    await this.media.deleteQuietly(sealedId, sealedSelfie);
  }

  /** Spends the names (compare-and-set ISSUED to EXPIRED) and deletes the originals this call won. */
  private async refuse(
    ctx: CandidateContext,
    scope: SessionScope,
    refs: readonly NameRef[],
  ): Promise<void> {
    for (const r of refs) {
      const key = this.media.uploadKey(scope, r.parsed.attempt, r.parsed.kind, r.parsed.ulid);
      await this.expire(ctx, r, key);
    }
  }

  private async expire(ctx: CandidateContext, ref: NameRef, uploadKey: string): Promise<void> {
    const won = await this.names.transition(
      ctx.sessionId,
      ref.name,
      ref.purpose,
      'ISSUED',
      'EXPIRED',
    );
    if (won) await this.media.deleteQuietly(uploadKey);
  }

  private async release(ctx: CandidateContext, claimed: readonly NameRef[]): Promise<void> {
    for (const r of claimed) {
      try {
        await this.names.transition(ctx.sessionId, r.name, r.purpose, 'USED', 'ISSUED');
      } catch {
        // Redis down: the original error matters more, and the name record expires on its own.
        this.logger.warn({ event: 'identity.release-failed', sessionId: ctx.sessionId });
      }
    }
  }

  private async enqueue(ctx: CandidateContext, attempt: number): Promise<void> {
    try {
      await this.queue.enqueue(ctx.orgId, ctx.sessionId, attempt);
    } catch {
      this.log('submit', ctx, 'enqueue-failed'); // the row stays PENDING; the reconciler requeues it
    }
  }

  /** Candidate scope reads only attempt and status of an identity row (ADR 0013 CS-4.4). */
  private latest(sessionId: string): Promise<LatestRow | null> {
    return this.prisma.client.identityCheck.findFirst({
      where: { sessionId },
      orderBy: { attempt: 'desc' },
      select: { attempt: true, status: true },
    });
  }

  /**
   * The row an identical POST created: both names are USED (a name is claimed only by the request
   * that then inserts the row, and released if the insert fails) and a row exists for that attempt.
   * Keyed on the names, not on the stored keys, so the candidate scope reads no hidden column.
   */
  private async byNames(
    ctx: CandidateContext,
    attempt: number,
    refs: readonly NameRef[],
  ): Promise<LatestRow | null> {
    for (const r of refs) {
      if ((await this.names.state(ctx.sessionId, r.name, r.purpose)) !== 'USED') return null;
    }
    return this.prisma.client.identityCheck.findFirst({
      where: { sessionId: ctx.sessionId, attempt },
      select: { attempt: true, status: true },
    });
  }

  /** The attempt a new upload would be, or null when none is open. */
  private nextAttempt(latest: LatestRow | null): number | null {
    if (latest === null) return 1;
    return latest.attempt < MAX_ATTEMPTS && latest.status === 'LOW_CONFIDENCE'
      ? latest.attempt + 1
      : null;
  }

  private expectedAttempt(latest: LatestRow | null): number {
    const next = this.nextAttempt(latest);
    if (next === null) throw this.cannotAttempt(latest);
    return next;
  }

  private cannotAttempt(latest: LatestRow | null): CodedHttpException {
    if (latest?.status === 'PENDING') {
      return problem(
        HttpStatus.CONFLICT,
        'The identity check is still being processed.',
        'IDENTITY_CHECK_PENDING',
      );
    }
    return problem(
      HttpStatus.CONFLICT,
      'No further identity attempt is open.',
      'IDENTITY_ATTEMPTS_EXHAUSTED',
    );
  }

  private log(route: string, ctx: CandidateContext, outcome: string): void {
    this.logger.log({ event: `identity.${route}`, sessionId: ctx.sessionId, outcome });
  }
}

interface NameRef {
  readonly name: string;
  readonly purpose: IdentityPurpose;
  readonly parsed: ParsedName;
}

class ClaimLost extends Error {}

/** How long a loser waits for an identical concurrent POST to commit its row. */
const RACE_POLLS = 20;
const RACE_POLL_MS = 100;

function viewOf(row: LatestRow): IdentityStatusDto {
  return {
    attempt: row.attempt,
    status: row.status as IdentityStatusView,
    canRetry: row.attempt === 1 && row.status === 'LOW_CONFIDENCE',
  };
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}
