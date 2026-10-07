// Signed proctor batches (BE-10; FR-608, FR-801, NFR-04; ADR 0013 sections 2 and 5.2; TC-050, TC-055,
// TC-063, TC-065). The handler order follows ADR 0013 "Verification order":
//   1. the candidate guard (token, epoch)            -> CandidateSessionGuard
//   2. the state check                               -> `open`
//   3. the size limit, while streaming               -> readBatchBody (controller)
//   4. the signature on the received bytes           -> `verify`
//   5. strict UTF-8, JSON, the shared zod schema     -> `parseEvents`, `parseKeystrokes`
//   6. one transaction: batch row + events, with the (session_id, seq) duplicate rule -> `store*`
// The session comes from the CandidateContext only (CS-1); a session id in the body is stripped by
// the schema. Severity is assigned here from the type (ADR 0005); a client severity never arrives.
// Never logged: bodies, keystroke text, signatures, keys.
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_EVENT_SEVERITY,
  isClientEventType,
  keystrokeBatchSchema,
  proctorEventBatchSchema,
  shouldPushToLive,
} from '@codeproctor/shared';
import type {
  ClientProctorEvent,
  KeystrokeBatch,
  ProctorEventBatch,
  Severity,
} from '@codeproctor/shared';
import type { Redis } from 'ioredis';
import { CodedHttpException } from '../common/coded.exception';
import type { Env } from '../config/env';
import { CandidateScope } from '../candidate/candidate-scope';
import type { CandidateContext } from '../candidate/candidate.types';
import { Prisma } from '../generated/prisma/client.js';
import type { PauseReason, SessionStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../database/prisma.service';
import type { OrgScopedPrismaClient } from '../database/org-scope.extension';
import { REDIS_CLIENT } from '../infrastructure/infrastructure.module';
import { SessionKeyService } from '../session/session-key.service';
import { SessionStateService } from '../session/session-state.service';
import { SessionStateConflictError } from '../session/session-state.errors';
import { LIVE_STATUSES } from '../session/session-transitions';
import { sessionNotActive } from '../session/session-write-gate';
import { EPOCH_WINDOW, SIGNATURE_FORMAT, hmacOf, sameBytes } from './signature';

/** The scoped client, or the client a `$transaction` callback receives. */
type BatchDb = Pick<OrgScopedPrismaClient, 'proctorEventBatch' | 'proctorEvent' | 'keystrokeBatch'>;

/** What the routes need of the session row, read once per request (org scope: the key column). */
export interface IngestSession {
  readonly status: SessionStatus;
  readonly pauseReasons: readonly PauseReason[];
  readonly startedAt: Date | null;
  readonly hmacKeyEnc: string;
}

export interface BatchAck {
  readonly seq: number;
  readonly duplicate: boolean;
}

/** Candidate-caused pauses (ADR 0002 section 5; DL-17). The clock does not stop for any of them. */
const PAUSE_ADD: Readonly<Partial<Record<ClientProctorEvent['type'], PauseReason>>> = {
  SCREEN_SHARE_STOPPED: 'SCREEN_SHARE_STOPPED',
  FULLSCREEN_EXIT: 'FULLSCREEN_EXIT',
  SIDE_CAMERA_DISCONNECTED: 'SIDE_CAMERA_LOST',
};
const PAUSE_REMOVE: Readonly<Partial<Record<ClientProctorEvent['type'], PauseReason>>> = {
  SCREEN_SHARE_RESUMED: 'SCREEN_SHARE_STOPPED',
  FULLSCREEN_RESTORED: 'FULLSCREEN_EXIT',
  SIDE_CAMERA_RECONNECTED: 'SIDE_CAMERA_LOST',
};

function coded(
  status: HttpStatus,
  message: string,
  code: ConstructorParameters<typeof CodedHttpException>[2],
  extensions: Record<string, string | number | null> = {},
): CodedHttpException {
  return new CodedHttpException(status, message, code, extensions);
}

function clamp(value: Date, low: Date | null, high: Date): Date {
  if (value.getTime() > high.getTime()) return high;
  if (low !== null && value.getTime() < low.getTime()) return low;
  return value;
}

/** The field paths of a zod failure, never the values (TB-1: nothing the client sent is echoed). */
function failedFields(paths: ReadonlyArray<ReadonlyArray<PropertyKey>>): string {
  const names = new Set(
    paths.map((p) => p.map((k) => (typeof k === 'number' ? '*' : String(k))).join('.')),
  );
  return [...names].slice(0, 5).join(',');
}

@Injectable()
export class ProctorEventsService {
  private readonly log = new Logger(ProctorEventsService.name);

  constructor(
    private readonly scope: CandidateScope,
    private readonly prisma: PrismaService,
    private readonly keys: SessionKeyService,
    private readonly states: SessionStateService,
    private readonly config: ConfigService<Env, true>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  // ---------- 2. state ----------

  /**
   * Only IN_PROGRESS and PAUSED accept batches, and SUBMITTED for the ingest grace after the
   * submit (late batches after an outage, TC-063). Everything later, or a session whose key is
   * gone, answers 409 SESSION_NOT_ACTIVE.
   */
  async open(ctx: CandidateContext, now: Date = new Date()): Promise<IngestSession> {
    const row = await this.scope.asOrg(ctx, () =>
      this.prisma.client.session.findUnique({
        where: { id: ctx.sessionId },
        select: {
          status: true,
          pauseReasons: true,
          startedAt: true,
          submittedAt: true,
          hmacKeyEnc: true,
        },
      }),
    );
    if (row === null) throw sessionNotActive(ctx.status);
    const graceMs = this.config.get('PROCTOR_INGEST_GRACE_SECONDS', { infer: true }) * 1000;
    const live = LIVE_STATUSES.includes(row.status);
    const inGrace =
      row.status === 'SUBMITTED' &&
      row.submittedAt !== null &&
      now.getTime() - row.submittedAt.getTime() <= graceMs;
    if ((!live && !inGrace) || row.hmacKeyEnc === null) throw sessionNotActive(row.status);
    return {
      status: row.status,
      pauseReasons: row.pauseReasons,
      startedAt: row.startedAt,
      hmacKeyEnc: row.hmacKeyEnc,
    };
  }

  // ---------- 4. signature ----------

  /**
   * Checks `X-Signature` against HMAC(K_current, raw). A mismatch that matches one of the previous
   * 8 epoch keys is 409 KEY_EPOCH_STALE (the SDK re-signs); anything else is 403 SIGNATURE_INVALID
   * (TC-065). Returns the keys of the epoch window (current first) for the duplicate rule.
   */
  verify(
    ctx: CandidateContext,
    session: IngestSession,
    raw: Buffer,
    signature: string | undefined,
  ): { received: Buffer; windowKeys: Buffer[] } {
    const master = this.unwrap(ctx, session);
    const windowKeys: Buffer[] = [];
    try {
      for (let back = 0; back <= EPOCH_WINDOW; back += 1) {
        const epoch = ctx.epoch - back;
        if (epoch < 0) break;
        windowKeys.push(this.keys.deriveBatchKey(master, ctx.sessionId, epoch));
      }
    } finally {
      master.fill(0);
    }
    const invalid = (): CodedHttpException =>
      coded(HttpStatus.FORBIDDEN, 'The batch signature is not valid.', 'SIGNATURE_INVALID');
    if (signature === undefined || !SIGNATURE_FORMAT.test(signature)) {
      this.wipe(windowKeys);
      throw invalid();
    }
    const received = Buffer.from(signature, 'hex');
    const [current, ...older] = windowKeys;
    if (current === undefined) throw invalid();
    if (sameBytes(hmacOf(current, raw), received)) return { received, windowKeys };
    const stale = older.some((k) => sameBytes(hmacOf(k, raw), received));
    this.wipe(windowKeys);
    if (stale) {
      throw coded(
        HttpStatus.CONFLICT,
        'The batch was signed with an older key. Sign it again with the current key.',
        'KEY_EPOCH_STALE',
      );
    }
    throw invalid();
  }

  private unwrap(ctx: CandidateContext, session: IngestSession): Buffer {
    try {
      return this.keys.unwrap(session.hmacKeyEnc, ctx.sessionId);
    } catch {
      // A key that cannot be unwrapped (wrong wrapping key, tampered row) is a server fault, never
      // the candidate's: 503 without detail.
      throw coded(
        HttpStatus.SERVICE_UNAVAILABLE,
        'The candidate portal is not configured.',
        'CANDIDATE_PORTAL_UNCONFIGURED',
      );
    }
  }

  private wipe(keys: Buffer[]): void {
    for (const k of keys) k.fill(0);
  }

  // ---------- 5. parse ----------

  private decode(raw: Buffer): unknown {
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown;
    } catch {
      throw coded(HttpStatus.BAD_REQUEST, 'The batch is not valid JSON.', 'VALIDATION_FAILED');
    }
  }

  private invalidBatch(
    issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>,
  ): CodedHttpException {
    return coded(HttpStatus.BAD_REQUEST, 'The batch failed validation.', 'VALIDATION_FAILED', {
      fields: failedFields(issues.map((i) => i.path)),
    });
  }

  parseEvents(raw: Buffer): ProctorEventBatch {
    const result = proctorEventBatchSchema.safeParse(this.decode(raw));
    if (!result.success) throw this.invalidBatch(result.error.issues);
    return result.data;
  }

  parseKeystrokes(raw: Buffer): KeystrokeBatch {
    const result = keystrokeBatchSchema.safeParse(this.decode(raw));
    if (!result.success) throw this.invalidBatch(result.error.issues);
    return result.data;
  }

  // ---------- 6. store ----------

  async ingestEvents(
    ctx: CandidateContext,
    session: IngestSession,
    raw: Buffer,
    signature: string | undefined,
    now: Date = new Date(),
  ): Promise<BatchAck> {
    const { received, windowKeys } = this.verify(ctx, session, raw, signature);
    try {
      const batch = this.parseEvents(raw);
      const events = batch.events.filter((e) => isClientEventType(e.type));
      const rows = events.map((e) => ({
        sessionId: ctx.sessionId,
        batchSeq: batch.seq,
        type: e.type,
        severity: DEFAULT_EVENT_SEVERITY[e.type],
        source: 'CLIENT' as const,
        occurredAt: clamp(new Date(e.occurredAt), session.startedAt, now),
        durationMs: e.durationMs ?? null,
        confidence: e.confidence ?? null,
        payload: e.payload,
        // Evidence names are single-use and tied to the evidence presign state (ADR 0013 section
        // 5.2, BE-09). Until that registry exists no name can be vouched for, so none is stored.
        evidenceKey: null,
      }));
      const stored = await this.storeOnce(
        ctx,
        batch.seq,
        received,
        raw,
        windowKeys,
        async (db) => {
          await db.proctorEventBatch.create({
            data: {
              sessionId: ctx.sessionId,
              seq: batch.seq,
              signature: Uint8Array.from(received),
              eventCount: rows.length,
            },
          });
          await db.proctorEvent.createMany({ data: rows });
        },
        (db) =>
          db.proctorEventBatch
            .findUnique({
              where: { sessionId_seq: { sessionId: ctx.sessionId, seq: batch.seq } },
              select: { signature: true },
            })
            .then((r) => r?.signature ?? null),
      );
      if (!stored.duplicate) {
        await this.afterEvents(
          ctx,
          session,
          events,
          rows.map((r) => r.severity),
          now,
        );
        this.log.log(
          `events stored session=${ctx.sessionId} seq=${String(batch.seq)} n=${String(rows.length)}`,
        );
      }
      return stored;
    } finally {
      this.wipe(windowKeys);
    }
  }

  async ingestKeystrokes(
    ctx: CandidateContext,
    session: IngestSession,
    raw: Buffer,
    signature: string | undefined,
    now: Date = new Date(),
  ): Promise<BatchAck> {
    const { received, windowKeys } = this.verify(ctx, session, raw, signature);
    try {
      const batch = this.parseKeystrokes(raw);
      // CS-2: the question must belong to this session; anything else is 404, like a cross-org read.
      const question = await this.scope.asOrg(ctx, () =>
        this.prisma.client.sessionQuestion.findFirst({
          where: { id: batch.sessionQuestionId, sessionId: ctx.sessionId },
          select: { id: true },
        }),
      );
      if (question === null) {
        throw coded(HttpStatus.NOT_FOUND, 'Not found.', 'NOT_FOUND');
      }
      const stored = await this.storeOnce(
        ctx,
        batch.seq,
        received,
        raw,
        windowKeys,
        async (db) => {
          await db.keystrokeBatch.create({
            data: {
              sessionId: ctx.sessionId,
              sessionQuestionId: batch.sessionQuestionId,
              seq: batch.seq,
              signature: Uint8Array.from(received),
              startedAt: clamp(new Date(batch.startedAt), session.startedAt, now),
              events: batch.events as Prisma.InputJsonValue,
            },
          });
        },
        (db) =>
          db.keystrokeBatch
            .findUnique({
              where: { sessionId_seq: { sessionId: ctx.sessionId, seq: batch.seq } },
              select: { signature: true },
            })
            .then((r) => r?.signature ?? null),
      );
      if (!stored.duplicate) {
        this.log.log(`keystrokes stored session=${ctx.sessionId} seq=${String(batch.seq)}`);
      }
      return stored;
    } finally {
      this.wipe(windowKeys);
    }
  }

  /**
   * One transaction: look for the (session, seq) row first, create the batch and its events when it
   * is new. An existing row is a retry when its stored signature equals the received one, or equals
   * HMAC(K_e, raw) for a key of the epoch window (a re-signed retry); otherwise 409 SEQ_CONFLICT
   * (TC-065). A concurrent insert of the same seq (unique violation) is judged by the same rule.
   */
  private async storeOnce(
    ctx: CandidateContext,
    seq: number,
    received: Buffer,
    raw: Buffer,
    windowKeys: readonly Buffer[],
    create: (db: BatchDb) => Promise<void>,
    readStored: (db: BatchDb) => Promise<Uint8Array | null>,
  ): Promise<BatchAck> {
    const attempt = (): Promise<Uint8Array | null> =>
      this.scope.asOrg(ctx, () =>
        this.prisma.client.$transaction(async (db) => {
          const existing = await readStored(db);
          if (existing !== null) return existing;
          await create(db);
          return null;
        }),
      );
    let existing: Uint8Array | null;
    try {
      existing = await attempt();
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e;
      existing = await this.scope.asOrg(ctx, () => readStored(this.prisma.client));
      if (existing === null) throw e;
    }
    if (existing === null) return { seq, duplicate: false };
    const sameSignature =
      sameBytes(existing, received) || windowKeys.some((k) => sameBytes(hmacOf(k, raw), existing));
    if (sameSignature) return { seq, duplicate: true };
    throw coded(
      HttpStatus.CONFLICT,
      'A different batch with this sequence number is already stored.',
      'SEQ_CONFLICT',
    );
  }

  // ---------- after commit ----------

  private async afterEvents(
    ctx: CandidateContext,
    session: IngestSession,
    events: ProctorEventBatch['events'],
    severities: ReadonlyArray<Severity>,
    now: Date,
  ): Promise<void> {
    await this.publishLive(ctx, events, severities, now);
    if (LIVE_STATUSES.includes(session.status)) await this.applyPauseEffects(ctx, events, now);
  }

  /** HIGH events (and forced types) go to `live:{orgId}` for the live view (Step 13). Best effort. */
  private async publishLive(
    ctx: CandidateContext,
    events: ProctorEventBatch['events'],
    severities: ReadonlyArray<Severity>,
    now: Date,
  ): Promise<void> {
    try {
      const live = events.filter((e, i) => {
        const severity = severities[i];
        return severity !== undefined && shouldPushToLive(e.type, severity);
      });
      for (const e of live) {
        await this.redis.publish(
          `live:${ctx.orgId}`,
          JSON.stringify({
            sessionId: ctx.sessionId,
            type: e.type,
            severity: DEFAULT_EVENT_SEVERITY[e.type],
            occurredAt: clamp(new Date(e.occurredAt), null, now).toISOString(),
          }),
        );
      }
    } catch {
      this.log.warn(`live publish failed session=${ctx.sessionId}`);
    }
  }

  /**
   * ADR 0002 section 5 / backend.md Step 10: SCREEN_SHARE_STOPPED, FULLSCREEN_EXIT and
   * SIDE_CAMERA_DISCONNECTED add a pause reason (IN_PROGRESS to PAUSED); the matching resume events
   * remove it, and the session returns to IN_PROGRESS when no reason is left. The clock does not
   * change (deadline_at and paused_ms are untouched). A lost race with another state change is not
   * an error: the batch is already stored.
   */
  private async applyPauseEffects(
    ctx: CandidateContext,
    events: ProctorEventBatch['events'],
    now: Date,
  ): Promise<void> {
    const ordered = [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    if (!ordered.some((e) => e.type in PAUSE_ADD || e.type in PAUSE_REMOVE)) return;
    try {
      await this.scope.asOrg(ctx, async () => {
        const current = await this.prisma.client.session.findUnique({
          where: { id: ctx.sessionId },
          select: { status: true, pauseReasons: true },
        });
        if (current === null || !LIVE_STATUSES.includes(current.status)) return;
        const reasons = new Set<PauseReason>(current.pauseReasons);
        for (const e of ordered) {
          const add = PAUSE_ADD[e.type];
          const remove = PAUSE_REMOVE[e.type];
          if (add !== undefined) reasons.add(add);
          if (remove !== undefined) reasons.delete(remove);
        }
        const next = [...reasons];
        const same =
          next.length === current.pauseReasons.length &&
          next.every((r) => current.pauseReasons.includes(r));
        if (same) return;
        if (current.status === 'IN_PROGRESS' && next.length > 0) {
          await this.states.transition({
            sessionId: ctx.sessionId,
            from: 'IN_PROGRESS',
            to: 'PAUSED',
            now,
            patch: { pauseReasons: next },
          });
        } else if (current.status === 'PAUSED' && next.length === 0) {
          await this.states.transition({
            sessionId: ctx.sessionId,
            from: 'PAUSED',
            to: 'IN_PROGRESS',
            now,
            patch: { pauseReasons: [] },
          });
        } else if (current.status === 'PAUSED') {
          // Still paused, with a different set of reasons: not a status change, so it is a plain
          // update guarded on the status (SessionStateService has no PAUSED to PAUSED edge).
          await this.prisma.client.session.updateMany({
            where: { id: ctx.sessionId, status: 'PAUSED' },
            data: { pauseReasons: next },
          });
        }
      });
    } catch (e) {
      if (e instanceof SessionStateConflictError) return;
      this.log.warn(`pause effects failed session=${ctx.sessionId}`);
    }
  }
}
