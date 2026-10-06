// Erasure on request (FR-704, C-06, C-17; ADR 0004 9.5). One idempotent `run` per candidate: fence each
// live session through the port, delete its whole object prefix with verification, then (and only
// then) purge the rows (R-6 as amended). It repeats until every session is ERASED and verified, then
// writes the completion row once. The candidate row is anonymised at the first of: the email-sent row,
// a recorded manual notice, or day 28 of the 30-day deadline. It never writes a RETENTION_*_DONE
// marker, never touches the consent record and never logs a key, an email or a name.
import { Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import {
  ERASURE_ALERT_DAY,
  ERASURE_ANONYMISE_DAY,
  ERASURE_AUDIT_ACTIONS,
  ERASURE_RERUN_BASE_SECONDS,
  STORAGE_SWEEP_MARGIN_SECONDS,
  sessionPrefix,
} from '../retention.constants';
import { ObjectStorePort } from '../object-store.port';
import type { RetentionConfig } from '../retention.config';
import { RETENTION_CONFIG } from '../retention.service';
import { deleteVerified } from '../verified-delete';
import {
  ErasureAlertPort,
  ErasureNoticePort,
  ErasureSchedulerPort,
  SessionFencePort,
} from './erasure.ports';
import { ErasureRepository, requestIdOf } from './erasure.repository';

const DAY_MS = 86_400_000;

export interface ErasureRunResult {
  readonly status: 'notFound' | 'notRequested' | 'inProgress' | 'held' | 'completed';
  readonly requestId?: string;
  readonly anonymised?: boolean;
}

@Injectable()
export class ErasureService {
  private readonly log = new Logger(ErasureService.name);

  constructor(
    private readonly repo: ErasureRepository,
    private readonly store: ObjectStorePort,
    private readonly fence: SessionFencePort,
    private readonly scheduler: ErasureSchedulerPort,
    private readonly notices: ErasureNoticePort,
    private readonly alerts: ErasureAlertPort,
    @Inject(RETENTION_CONFIG) private readonly config: RetentionConfig,
  ) {}

  /** Records the request (once) and starts the first run. Returns the request id. */
  async requestErasure(args: {
    orgId: string;
    candidateId: string;
    actorId: string | null;
    now?: Date;
  }): Promise<ErasureRunResult> {
    const now = args.now ?? new Date();
    const requestedAt = await this.repo.inOrg(args.orgId, () =>
      this.repo.markRequested({ ...args, now }),
    );
    if (requestedAt === null) return { status: 'notFound' };
    return this.run(args.orgId, args.candidateId, now);
  }

  /** A super admin records that the candidate was told by hand (the mail failed). Audited, once. */
  async recordManualNotice(args: {
    orgId: string;
    candidateId: string;
    actorId: string;
    now?: Date;
  }): Promise<ErasureRunResult> {
    const { orgId, candidateId, actorId } = args;
    const requestId = await this.repo.inOrg(orgId, async () => {
      const candidate = await this.repo.readCandidate(candidateId);
      if (candidate?.erasureRequestedAt == null) return null;
      const id = requestIdOf(candidateId, candidate.erasureRequestedAt);
      await this.repo.writeOnce({
        orgId,
        candidateId,
        requestId: id,
        action: ERASURE_AUDIT_ACTIONS.NOTICE_RECORDED,
        actorId,
      });
      return id;
    });
    if (requestId === null) return { status: 'notRequested' };
    return this.run(orgId, candidateId, args.now ?? new Date());
  }

  /** The daily sweep: every candidate with an open request, one run each; one failure never stops the rest. */
  async runDue(now: Date = new Date()): Promise<{ candidates: number; failed: number }> {
    let candidates = 0;
    let failed = 0;
    let after: string | undefined;
    for (;;) {
      const page = await this.repo.findRequested(this.config.RETENTION_BATCH_SIZE, after);
      if (page.length === 0) break;
      for (const { orgId, candidateId } of page) {
        candidates += 1;
        try {
          await this.run(orgId, candidateId, now);
        } catch {
          failed += 1;
          this.log.warn(`erasure run failed for candidate ${candidateId}`);
        }
      }
      after = page[page.length - 1]?.candidateId;
      if (page.length < this.config.RETENTION_BATCH_SIZE) break;
    }
    return { candidates, failed };
  }

  async run(orgId: string, candidateId: string, now: Date = new Date()): Promise<ErasureRunResult> {
    const candidate = await this.repo.inOrg(orgId, () => this.repo.readCandidate(candidateId));
    if (candidate === null) return { status: 'notFound' };
    if (candidate.erasureRequestedAt === null) return { status: 'notRequested' };
    const requestId = requestIdOf(candidateId, candidate.erasureRequestedAt);
    const requestedAt = candidate.erasureRequestedAt;

    const hold = await this.repo.inOrg(orgId, () => this.repo.holdEnabled(orgId));
    const sessions = await this.repo.inOrg(orgId, () => this.repo.sessionsOf(candidateId));

    let heldAny = false;
    for (const s of sessions) {
      if (s.status === 'ERASED') continue;
      const wouldHold =
        hold && (s.status === 'UNDER_REVIEW' || s.status === 'APPEALED' || s.hasOpenAppeal);
      if (wouldHold) {
        heldAny = true;
        continue;
      }
      const result = await this.fence.fence({ orgId, sessionId: s.id, closeOpenAppeal: !hold });
      if (result === 'held') {
        heldAny = true;
        continue;
      }
      if (result === 'fenced') {
        // In-flight uploads land within the sweep margin: delete again after it.
        await this.scheduler.scheduleRerun({
          orgId,
          candidateId,
          requestId,
          runAt: new Date(
            now.getTime() + (ERASURE_RERUN_BASE_SECONDS + STORAGE_SWEEP_MARGIN_SECONDS) * 1000,
          ),
        });
      }
    }
    if (heldAny) {
      const first = await this.repo.inOrg(orgId, () =>
        this.repo.writeOnce({
          orgId,
          candidateId,
          requestId,
          action: ERASURE_AUDIT_ACTIONS.DELAY_NOTIFIED,
        }),
      );
      if (first) await this.notices.enqueueDelayed({ orgId, candidateId, requestId });
    }

    // Purge what is ERASED: the whole prefix first, verified, then the rows.
    const fresh = await this.repo.inOrg(orgId, () => this.repo.sessionsOf(candidateId));
    let allErased = fresh.length === 0 || fresh.every((s) => s.status === 'ERASED');
    let unverified = false;
    for (const s of fresh) {
      if (s.status !== 'ERASED') continue;
      const deleted = await deleteVerified(this.store, [sessionPrefix(orgId, s.id)]);
      if (!deleted.verified) {
        unverified = true;
        allErased = false;
        this.log.warn(`erasure prefix not verified for session ${s.id}`);
        continue;
      }
      const purged = await this.repo.inOrg(orgId, () =>
        this.repo.purgeSession({
          orgId,
          candidateId,
          sessionId: s.id,
          requestId,
          reduceAll: this.config.RETENTION_REDUCE_ACCOMMODATIONS,
        }),
      );
      const clean = purged && (await this.repo.inOrg(orgId, () => this.repo.isPurged(s.id)));
      if (!clean) allErased = false;
    }

    const deadlineFrom = await this.deadlineStart(orgId, candidateId, requestedAt);
    const ageDays = (now.getTime() - deadlineFrom.getTime()) / DAY_MS;

    let completed = await this.repo.inOrg(orgId, () =>
      this.repo.isCompleted(requestId, candidateId),
    );
    if (!completed && allErased) {
      await this.repo.inOrg(orgId, () =>
        this.repo.recordCompleted({ orgId, candidateId, requestId }),
      );
      completed = true;
    }
    if (completed) {
      const sent = await this.repo.inOrg(orgId, () => this.repo.emailSent(requestId, candidateId));
      const noticed = await this.repo.inOrg(orgId, () =>
        this.repo.noticeRecorded(requestId, candidateId),
      );
      if (!sent && !noticed && !candidate.erasedAt) {
        await this.notices.enqueueCompleted({ orgId, candidateId, requestId });
      }
    }

    const sent = await this.repo.inOrg(orgId, () => this.repo.emailSent(requestId, candidateId));
    const noticed = await this.repo.inOrg(orgId, () =>
      this.repo.noticeRecorded(requestId, candidateId),
    );
    if (!sent && !noticed && ageDays >= ERASURE_ALERT_DAY) {
      const first = await this.repo.inOrg(orgId, () =>
        this.repo.writeOnce({
          orgId,
          candidateId,
          requestId,
          action: ERASURE_AUDIT_ACTIONS.ALERT_RAISED,
        }),
      );
      if (first)
        await this.alerts.raise({
          kind: 'ERASURE_DAY_25_NO_NOTICE',
          orgId,
          candidateId,
          requestId,
        });
    }
    if (unverified && ageDays >= ERASURE_ALERT_DAY) {
      await this.alerts.raise({ kind: 'ERASURE_PREFIX_UNVERIFIED', orgId, candidateId, requestId });
    }

    let anonymised = candidate.erasedAt !== null;
    if (!anonymised && (sent || noticed || ageDays >= ERASURE_ANONYMISE_DAY)) {
      anonymised = await this.repo.inOrg(orgId, () =>
        this.repo.anonymiseCandidate({ orgId, candidateId, requestId, now }),
      );
    }
    if (completed) return { status: 'completed', requestId, anonymised };
    return { status: heldAny ? 'held' : 'inProgress', requestId, anonymised };
  }

  /** The C-06 deadline counts from the request or the close of the last review or appeal, whichever is later. */
  private async deadlineStart(
    orgId: string,
    candidateId: string,
    requestedAt: Date,
  ): Promise<Date> {
    const closed = await this.repo.inOrg(orgId, () => this.repo.holdClosedAt(candidateId));
    return closed !== null && closed > requestedAt ? closed : requestedAt;
  }
}
