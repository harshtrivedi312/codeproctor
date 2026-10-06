// Media presign and confirm (FR-701, FR-702; ADR 0013 section 5.5, ADR 0004 section 4).
//
// The browser uploads 10-second chunks straight to object storage with a 60 s presigned PUT. The
// server never sees the bytes, so integrity is layered (ADR 0013 5.5): the signed Content-Type and
// Content-Length, `If-None-Match: *` where the store supports it, a HEAD check at confirm that
// deletes a wrong object, and the ingest-close sweep (not in this file).
//
//  - The session and org come from the CandidateContext (CS-1). The object key is built here from
//    them and from validated numbers; the client never sends a key (CS-3).
//  - Recording continues through every pause, so these routes do not use assertWritable: the
//    states are listed in ADR 0013 section 5.5 (ROOM_SCAN: CONSENTED; other streams: IN_PROGRESS,
//    PAUSED, or SUBMITTED within the ingest grace).
//  - Only SessionStateService changes sessions.status; this service never writes the session.
//  - Nothing here logs a key, a URL or an ETag: session id, stream, seq and outcome only.
import { BadRequestException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { CodedHttpException } from '../common/coded.exception';
import { sessionNotActive } from '../session/session-write-gate';
import type { CandidateContext } from '../candidate/candidate.types';
import type { Env } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import type { MediaStream, PauseReason, SessionStatus } from '../generated/prisma/enums.js';
import { REDIS_CLIENT } from '../infrastructure/infrastructure.module';
import { ensureConnected } from '../infrastructure/redis-ready';
import { effectiveSessionDeadline, proctorPauseCapMs } from '../session/deadlines';
import {
  contentTypeFor,
  maxChunkBytes,
  MIN_CAP_DURATION_SECONDS,
  presignCap,
} from './media.constants';
import type { CandidateMediaStream, MediaContentType } from './media.constants';
import { mediaChunkKey } from './storage-keys';
import { StorageService, StorageUnconfiguredError } from './storage.service';

export interface PresignRequest {
  readonly stream: CandidateMediaStream;
  readonly segment: number;
  readonly seq: number;
  readonly bytes: number;
  readonly contentType: MediaContentType;
  readonly startedAt: Date;
  readonly durationMs: number;
}

export interface ChunkRef {
  readonly stream: CandidateMediaStream;
  readonly segment: number;
  readonly seq: number;
}

export type PresignOutcome =
  | {
      readonly alreadyUploaded: false;
      readonly url: string;
      readonly method: 'PUT';
      readonly headers: Readonly<Record<string, string>>;
      readonly expiresAt: Date;
    }
  | { readonly alreadyUploaded: true };

const COUNTER_TTL_SECONDS = 3 * 24 * 3600;
const ETAG_TTL_SECONDS = 14 * 24 * 3600;
const STORAGE_RETRY_AFTER_SECONDS = 5;

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService<Env, true>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** POST /candidate/session/media/presign. */
  async presign(
    ctx: CandidateContext,
    req: PresignRequest,
    now: Date = new Date(),
  ): Promise<PresignOutcome> {
    this.requireStorage();
    const session = await this.loadSession(ctx);
    this.assertState(session, req.stream, now);

    const bytesMax = maxChunkBytes(req.stream);
    if (req.bytes < 1 || req.bytes > bytesMax || req.contentType !== contentTypeFor(req.stream)) {
      // The DTO already refuses these; this keeps the rule beside the signing call.
      throw new BadRequestException('The chunk size or type is not allowed for this stream.');
    }
    const startedAt = clamp(req.startedAt, session.startedAt ?? session.createdAt, now);
    const scope = { orgId: ctx.orgId, sessionId: ctx.sessionId };
    const key = mediaChunkKey(scope, req.stream, req.segment, req.seq);

    const existing = await this.findRow(ctx.sessionId, req.stream, req.seq);
    if (existing !== null) {
      // The same (stream, seq) under another segment: the client's counters are wrong (OI-9).
      if (existing.segment !== req.segment) throw seqConflict();
      if (existing.uploadedAt !== null) {
        this.log('presign', ctx, req, 'already-uploaded');
        return { alreadyUploaded: true };
      }
    }

    await this.consumePresignQuota(ctx, req.stream, session, now);

    if (existing === null) {
      try {
        await this.prisma.client.mediaChunk.create({
          data: {
            sessionId: ctx.sessionId,
            stream: req.stream,
            segment: req.segment,
            seq: req.seq,
            objectKey: key,
            startedAt,
            durationMs: req.durationMs,
            // Pending: size_bytes holds the declared size until confirm sets the verified one.
            sizeBytes: BigInt(req.bytes),
          },
          select: { id: true },
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        // Two presigns raced for the same chunk: the other one won; judge it as a retry.
        const winner = await this.findRow(ctx.sessionId, req.stream, req.seq);
        this.log('presign', ctx, req, 'race');
        if (winner === null || winner.segment !== req.segment) throw seqConflict();
        if (winner.uploadedAt !== null) return { alreadyUploaded: true };
        await this.updatePending(ctx, req, startedAt, key);
      }
    } else {
      await this.updatePending(ctx, req, startedAt, key);
    }

    const put = await this.guardStorage(() =>
      this.storage.presignPut({
        scope,
        key,
        contentType: req.contentType,
        bytes: req.bytes,
        now,
      }),
    );
    this.log('presign', ctx, req, 'issued');
    return {
      alreadyUploaded: false,
      url: put.url,
      method: put.method,
      headers: put.headers,
      expiresAt: put.expiresAt,
    };
  }

  /** POST /candidate/session/media/confirm. Idempotent. */
  async confirm(
    ctx: CandidateContext,
    ref: ChunkRef,
    now: Date = new Date(),
  ): Promise<{ uploaded: true; sizeBytes: number }> {
    this.requireStorage();
    const session = await this.loadSession(ctx);
    this.assertState(session, ref.stream, now);

    const row = await this.findRow(ctx.sessionId, ref.stream, ref.seq);
    if (row === null || row.segment !== ref.segment || row.objectKey === null) {
      throw new CodedHttpException(
        HttpStatus.NOT_FOUND,
        'This chunk was not presigned. Presign it first.',
        'CHUNK_NOT_PRESIGNED',
      );
    }
    if (row.uploadedAt !== null) {
      return { uploaded: true, sizeBytes: Number(row.sizeBytes ?? 0n) };
    }

    const head = await this.guardStorage(() => this.storage.head(row.objectKey as string));
    if (head === null) {
      this.log('confirm', ctx, ref, 'not-found');
      throw new CodedHttpException(
        HttpStatus.CONFLICT,
        'The upload is not in storage yet. Upload it again, presigning again if the URL expired.',
        'UPLOAD_NOT_FOUND',
      );
    }
    const declared = row.sizeBytes === null ? null : Number(row.sizeBytes);
    const typeOk = head.contentType === contentTypeFor(ref.stream);
    const sizeOk =
      declared !== null &&
      head.sizeBytes === declared &&
      head.sizeBytes >= 1 &&
      head.sizeBytes <= maxChunkBytes(ref.stream);
    if (!typeOk || !sizeOk) {
      // A wrong object is removed so it can never be mistaken for the chunk; the row stays pending
      // and the client presigns again.
      await this.guardStorage(() => this.storage.delete(row.objectKey as string));
      this.log('confirm', ctx, ref, 'mismatch');
      throw new CodedHttpException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The uploaded object does not match what was presigned. Presign and upload it again.',
        'UPLOAD_MISMATCH',
      );
    }

    // Compare-and-set on the pending state: two confirms cannot both claim it.
    await this.prisma.client.mediaChunk.updateMany({
      where: { id: row.id, sessionId: ctx.sessionId, uploadedAt: null },
      data: { uploadedAt: now, sizeBytes: BigInt(head.sizeBytes) },
    });
    if (head.etag !== null) await this.rememberEtag(ctx.sessionId, ref, head.etag);
    this.log('confirm', ctx, ref, 'uploaded');
    return { uploaded: true, sizeBytes: head.sizeBytes };
  }

  // ---- internals ----

  private requireStorage(): void {
    if (!this.storage.configured) {
      throw new CodedHttpException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'Recording storage is not configured.',
        'STORAGE_UNCONFIGURED',
      );
    }
  }

  /** The session as it is now: the context status may be a few requests old. */
  private async loadSession(ctx: CandidateContext): Promise<SessionFacts> {
    const session = await this.prisma.client.session.findUnique({
      where: { id: ctx.sessionId },
      select: {
        status: true,
        submittedAt: true,
        startedAt: true,
        deadlineAt: true,
        pausedMs: true,
        proctorPausedAt: true,
        pauseReasons: true,
        createdAt: true,
      },
    });
    if (session === null) throw sessionNotActive(ctx.status);
    return session;
  }

  private assertState(session: SessionFacts, stream: MediaStream, now: Date): void {
    if (stream === 'ROOM_SCAN') {
      // The room scan runs after consent and before the test (CONSENTED, ADR 0013 5.5).
      if (session.status !== 'CONSENTED') throw sessionNotActive(session.status);
      return;
    }
    if (session.status === 'IN_PROGRESS' || session.status === 'PAUSED') return;
    if (session.status === 'SUBMITTED' && session.submittedAt !== null) {
      const graceMs = this.config.get('PROCTOR_INGEST_GRACE_SECONDS', { infer: true }) * 1000;
      if (now.getTime() <= session.submittedAt.getTime() + graceMs) return;
    }
    throw sessionNotActive(session.status);
  }

  private findRow(sessionId: string, stream: MediaStream, seq: number) {
    return this.prisma.client.mediaChunk.findUnique({
      where: { sessionId_stream_seq: { sessionId, stream, seq } },
      select: { id: true, segment: true, objectKey: true, sizeBytes: true, uploadedAt: true },
    });
  }

  /** A retry re-declares the chunk; only a pending row is touched (compare-and-set). */
  private async updatePending(
    ctx: CandidateContext,
    req: PresignRequest,
    startedAt: Date,
    key: string,
  ): Promise<void> {
    await this.prisma.client.mediaChunk.updateMany({
      where: {
        sessionId: ctx.sessionId,
        stream: req.stream,
        seq: req.seq,
        segment: req.segment,
        uploadedAt: null,
      },
      data: {
        objectKey: key,
        startedAt,
        durationMs: req.durationMs,
        sizeBytes: BigInt(req.bytes),
        deletedAt: null,
      },
    });
  }

  /**
   * At most ceil(duration / 10 s) x 1.5 + 50 presigns per stream and session (ADR 0013 5.5).
   * The duration runs to the effective deadline (a credited or running proctor pause included) plus
   * the ingest grace, so a long pause or the grace upload tail never starves a legitimate backlog.
   * INCR and EXPIRE are one MULTI, so a crash cannot leave a counter without an expiry.
   */
  private async consumePresignQuota(
    ctx: CandidateContext,
    stream: MediaStream,
    session: SessionFacts,
    now: Date,
  ): Promise<void> {
    let spanSeconds = 0;
    if (session.startedAt !== null && session.deadlineAt !== null) {
      let capMs = 0;
      if (session.pauseReasons.includes('PROCTOR')) {
        const org = await this.prisma.client.organization.findUnique({
          where: { id: ctx.orgId },
          select: { settings: true },
        });
        capMs = proctorPauseCapMs(org?.settings);
      }
      const deadline = effectiveSessionDeadline(session, now, capMs) ?? session.deadlineAt;
      spanSeconds = (deadline.getTime() - session.startedAt.getTime()) / 1000;
    }
    const grace = this.config.get('PROCTOR_INGEST_GRACE_SECONDS', { infer: true });
    const cap = presignCap(Math.max(spanSeconds + grace, MIN_CAP_DURATION_SECONDS));
    await ensureConnected(this.redis);
    const key = `presigns:${ctx.sessionId}:${stream}`;
    const results = await this.redis.multi().incr(key).expire(key, COUNTER_TTL_SECONDS).exec();
    const used = Number(results?.[0]?.[1] ?? 0);
    if (used > cap) {
      throw new CodedHttpException(
        HttpStatus.TOO_MANY_REQUESTS,
        'Too many uploads were requested for this stream.',
        'PRESIGN_QUOTA_EXCEEDED',
        { retryAfterSeconds: 60 },
      );
    }
  }

  /** `etag:{sessionId}` holds the confirm-time ETag for the ingest-close sweep (ADR 0013 5.5). */
  private async rememberEtag(sessionId: string, ref: ChunkRef, etag: string): Promise<void> {
    try {
      await ensureConnected(this.redis);
      const key = `etag:${sessionId}`;
      await this.redis.hset(key, `${ref.stream}:${String(ref.seq)}`, etag);
      await this.redis.expire(key, ETAG_TTL_SECONDS);
    } catch {
      // Redis lost it: the sweep falls back to the size check alone (ADR 0013 5.5 control 2).
    }
  }

  /** Storage failures become 503 without the SDK message, which may name the bucket and key. */
  private async guardStorage<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (e) {
      if (e instanceof StorageUnconfiguredError) {
        throw new CodedHttpException(
          HttpStatus.SERVICE_UNAVAILABLE,
          'Recording storage is not configured.',
          'STORAGE_UNCONFIGURED',
        );
      }
      this.logger.warn({
        event: 'media.storage-error',
        error: e instanceof Error ? e.name : 'unknown',
      });
      throw new CodedHttpException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'Recording storage is unavailable. Retry shortly.',
        'STORAGE_UNAVAILABLE',
        { retryAfterSeconds: STORAGE_RETRY_AFTER_SECONDS },
      );
    }
  }

  /** Session id, route, stream, seq and outcome only (ADR 0013 section 5.1). */
  private log(route: 'presign' | 'confirm', ctx: CandidateContext, ref: ChunkRef, outcome: string) {
    this.logger.log({
      event: `media.${route}`,
      sessionId: ctx.sessionId,
      stream: ref.stream,
      seq: ref.seq,
      outcome,
    });
  }
}

interface SessionFacts {
  readonly status: SessionStatus;
  readonly submittedAt: Date | null;
  readonly startedAt: Date | null;
  readonly deadlineAt: Date | null;
  readonly pausedMs: bigint;
  readonly proctorPausedAt: Date | null;
  readonly pauseReasons: readonly PauseReason[];
  readonly createdAt: Date;
}

function clamp(value: Date, min: Date, max: Date): Date {
  if (value.getTime() < min.getTime()) return min;
  if (value.getTime() > max.getTime()) return max;
  return value;
}

function seqConflict(): CodedHttpException {
  return new CodedHttpException(
    HttpStatus.CONFLICT,
    'This sequence number already belongs to another segment.',
    'SEQ_CONFLICT',
  );
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}
