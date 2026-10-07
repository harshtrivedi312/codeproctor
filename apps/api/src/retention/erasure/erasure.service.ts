// Erasure on request (FR-704, C-06, C-17; ADR 0004 9.5). One idempotent `run` per candidate: fence each
// live session through the port, delete its whole object prefix with verification, then (and only
// then) purge the rows (R-6 as amended). It repeats until every session is ERASED and verified, then
// writes the completion row once. The candidate row is anonymised at the first of: the email-sent row,
// a recorded manual notice, or day 28 of the 30-day deadline. It never writes a RETENTION_*_DONE
// marker, never touches the consent record and never logs a key, an email or a name.
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ERASURE_ALERT_DAY,
  ERASURE_ANONYMISE_DAY,
  TIER_FAILURE_ALERT_DAYS,
  ERASURE_AUDIT_ACTIONS,
  ERASURE_RERUN_BASE_SECONDS,
  FENCE_POLL_FAST_SECONDS,
  FENCE_POLL_FAST_WINDOW_SECONDS,
  FENCE_POLL_SLOW_SECONDS,
  FENCE_POLL_WINDOW_SECONDS,
  STORAGE_SWEEP_MARGIN_SECONDS,
  sessionPrefix,
} from '../retention.constants';
import { ObjectStorePort } from '../object-store.port';
import type { RetentionConfig } from '../retention.config';
import { RETENTION_CONFIG } from '../retention.service';
import { deleteVerified } from '../verified-delete';
import {
  ErasureAlertPort,
  ErasureListPort,
  ErasureNoticePort,
  ErasureSchedulerPort,
  SessionFencePort,
} from './erasure.ports';
import { ErasureRepository, requestIdOf } from './erasure.repository';

const DAY_MS = 86_400_000;
const SETTLE_MS = (ERASURE_RERUN_BASE_SECONDS + STORAGE_SWEEP_MARGIN_SECONDS) * 1000;

export interface ErasureRunResult {
  readonly status: 'notFound' | 'notRequested' | 'inProgress' | 'held' | 'completed';
  readonly requestId?: string;
  readonly anonymised?: boolean;
}

@Injectable()
export class ErasureService {
  private readonly log = new Logger(ErasureService.name);
  /** Wall clock in ms. Run times are `now` plus the time elapsed since the run (or sweep) began, so a fence late in a long sweep is not stamped early. Tests replace it. */
  clock: () => number = () => Date.now();

  constructor(
    private readonly repo: ErasureRepository,
    private readonly store: ObjectStorePort,
    private readonly fence: SessionFencePort,
    private readonly scheduler: ErasureSchedulerPort,
    private readonly notices: ErasureNoticePort,
    private readonly alerts: ErasureAlertPort,
    private readonly list: ErasureListPort,
    @Inject(RETENTION_CONFIG) private readonly config: RetentionConfig,
  ) {}

  /** Records the request (once, audited with who asked) and starts the first run. */
  async requestErasure(args: {
    orgId: string;
    candidateId: string;
    actorId: string;
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
      await this.repo.recordNotice({ orgId, candidateId, requestId: id, actorId });
      return id;
    });
    if (requestId === null) return { status: 'notRequested' };
    return this.run(orgId, candidateId, args.now ?? new Date());
  }

  /** The daily sweep: every candidate with an open request, one run each; one failure never stops the rest. */
  async runDue(now: Date = new Date()): Promise<{ candidates: number; failed: number }> {
    const sweepStart = this.clock();
    let candidates = 0;
    let failed = 0;
    let after: string | undefined;
    for (;;) {
      const page = await this.repo.findRequested(this.config.RETENTION_BATCH_SIZE, after);
      if (page.length === 0) break;
      for (const { orgId, candidateId } of page) {
        candidates += 1;
        try {
          await this.run(orgId, candidateId, new Date(now.getTime() + (this.clock() - sweepStart)));
        } catch (error) {
          failed += 1;
          const name = error instanceof Error ? error.name : 'unknown';
          this.log.warn(`erasure run failed for candidate ${candidateId} (${name})`);
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
    const requestedAt = candidate.erasureRequestedAt;
    const runStart = this.clock();
    const current = (): Date => new Date(now.getTime() + (this.clock() - runStart));
    const requestId = requestIdOf(candidateId, requestedAt);
    const inOrg = <T>(fn: () => Promise<T>): Promise<T> => this.repo.inOrg(orgId, fn);

    const hold = await inOrg(() => this.repo.holdEnabled(orgId));
    const sessions = await inOrg(() => this.repo.sessionsOf(candidateId));

    // Before anything is fenced or deleted: a restore must not bring this candidate back (FU-DBB-02).
    // (The entry is per candidate; new invitations for a candidate with an erasure pending or done are refused by ADR 0004 9.5, so no later session is expected once the list is completed.)
    if (!(await inOrg(() => this.repo.isCompleted(requestId, candidateId)))) {
      await this.list.append({ orgId, candidateId });
    }

    let heldAny = false;
    let requested = 0;
    for (const s of sessions) {
      if (s.status === 'ERASED') continue;
      const wouldHold =
        hold && (s.status === 'UNDER_REVIEW' || s.status === 'APPEALED' || s.hasOpenAppeal);
      if (wouldHold) {
        heldAny = true;
        continue;
      }
      // Only a request: the fence runs as a SERVICE session job and decides under the session lock
      // (a session that became held in the meantime stays as it is). The status is read back below.
      await this.fence.requestFence({
        orgId,
        sessionId: s.id,
        closeOpenAppeal: !hold,
        requestedAt: current(),
      });
      requested += 1;
    }
    if (requested > 0) {
      // Look again once the job has had time to run. This is a look-again, NOT a fence time: the fence
      // time is recorded below the first time a session is READ as ERASED. The polls are bounded by the
      // age of the erasure request (see FENCE_POLL_*); the daily sweep is the retry after that.
      // Measured from the later of the request and the close of the last hold: a request whose hold closed
      // weeks later still gets its fast polls (the same base as the C-06 deadline).
      const closed = await inOrg(() => this.repo.holdClosedAt(candidateId));
      const base = closed !== null && closed > requestedAt ? closed : requestedAt;
      const nowAt = current();
      const ageSeconds = (nowAt.getTime() - base.getTime()) / 1000;
      if (ageSeconds < FENCE_POLL_WINDOW_SECONDS) {
        const after =
          ageSeconds < FENCE_POLL_FAST_WINDOW_SECONDS
            ? FENCE_POLL_FAST_SECONDS
            : FENCE_POLL_SLOW_SECONDS;
        await this.scheduler.scheduleFencePoll({
          orgId,
          candidateId,
          requestId,
          runAt: new Date(nowAt.getTime() + after * 1000),
        });
      }
    }
    if (heldAny) {
      const key = { candidateId, requestId, action: ERASURE_AUDIT_ACTIONS.DELAY_NOTIFIED };
      if (!(await inOrg(() => this.repo.onceDone(key)))) {
        await this.notices.enqueueDelayed({ orgId, candidateId, requestId });
        await inOrg(() => this.repo.writeOnce({ orgId, ...key }));
      }
    }

    // Purge what is ERASED: the whole prefix first, verified, then the rows.
    const fresh = await inOrg(() => this.repo.sessionsOf(candidateId));
    // Once completed, the purge does not repeat on the daily sweeps that wait for day 28 or a notice.
    const wasCompleted = await inOrg(() => this.repo.isCompleted(requestId, candidateId));
    let allClean = fresh.every((s) => s.status === 'ERASED');
    let settled = true;
    for (const s of fresh) {
      if (s.status !== 'ERASED') continue;
      const fencedAt = await inOrg(() =>
        this.repo.fenceTime({ orgId, candidateId, sessionId: s.id, requestId, now: current() }),
      );
      const settleAt = new Date(fencedAt.getTime() + SETTLE_MS);
      // After completion, a session that already had a verified pass after its settle time is left
      // alone (no store traffic on the daily sweeps); a session fenced since gets its post-margin pass.
      if (wasCompleted && (await inOrg(() => this.repo.purgedAfter(s.id, requestId, settleAt))))
        continue;
      if (current().getTime() < fencedAt.getTime() + SETTLE_MS) {
        settled = false;
        // Idempotent by request and fence time: a lost or failed first scheduling is repaired here.
        await this.scheduler.scheduleRerun({
          orgId,
          candidateId,
          requestId,
          fencedAt,
          runAt: new Date(fencedAt.getTime() + SETTLE_MS),
        });
      }
      // Stamped BEFORE the list-delete-verify: only a pass that began after the settle window proves the late uploads were seen.
      const passStart = current();
      const deleted = await deleteVerified(this.store, [sessionPrefix(orgId, s.id)]);
      if (!deleted.verified) {
        allClean = false;
        this.log.warn(`erasure prefix not verified for session ${s.id}`);
        await this.alertUnverified({
          orgId,
          candidateId,
          requestId,
          since: fencedAt,
          now: current(),
        });
        continue;
      }
      const purged = await inOrg(() =>
        this.repo.purgeSession({
          orgId,
          candidateId,
          sessionId: s.id,
          requestId,
          reduceAll: this.config.RETENTION_REDUCE_ACCOMMODATIONS,
          at: passStart,
        }),
      );
      if (!purged || !(await inOrg(() => this.repo.isPurged(s.id)))) allClean = false;
    }

    // The completion row waits for a verified pass at or after fence + 60 s + the sweep margin, so a
    // late upload is caught by the same pass that completes (ADR 0004 9.5 steps 5, 7, 8).
    let completed = wasCompleted;
    if (!completed && allClean && settled) {
      await inOrg(() => this.repo.recordCompleted({ orgId, candidateId, requestId }));
      completed = true;
    }
    const sent = await inOrg(() => this.repo.emailSent(requestId, candidateId));
    const noticed = await inOrg(() => this.repo.noticeRecorded(requestId, candidateId));

    // The C-06 deadline (day 25 alert, day 28 anonymisation) does not run while a hold is open: it
    // counts from the request or the close of the last review or appeal, whichever is later.
    let anonymised = candidate.erasedAt !== null;
    if (!heldAny) {
      const closed = await inOrg(() => this.repo.holdClosedAt(candidateId));
      const since = closed !== null && closed > requestedAt ? closed : requestedAt;
      const ageDays = (current().getTime() - since.getTime()) / DAY_MS;
      if (!sent && !noticed && ageDays >= ERASURE_ALERT_DAY) {
        const key = {
          candidateId,
          requestId,
          action: ERASURE_AUDIT_ACTIONS.ALERT_RAISED,
          since: `deadline:${Math.floor(since.getTime() / 1000)}`,
        };
        if (!(await inOrg(() => this.repo.onceDone(key)))) {
          await this.alerts.raise({
            kind: 'ERASURE_DAY_25_NO_NOTICE',
            orgId,
            candidateId,
            requestId,
          });
          await inOrg(() => this.repo.writeOnce({ orgId, ...key }));
        }
      }
      if (!anonymised && (sent || noticed || ageDays >= ERASURE_ANONYMISE_DAY)) {
        anonymised = await inOrg(() =>
          this.repo.anonymiseCandidate({ orgId, candidateId, requestId, now: current() }),
        );
      }
    }
    // The list entry and the mail wait for every session's post-margin pass, so the sweep keeps the
    // candidate until then (a session fenced after completion is not covered by a lost re-run job).
    const finished = completed && settled && allClean;
    if (
      finished &&
      anonymised &&
      !(await inOrg(() => this.repo.listCompleted(candidateId, requestId)))
    ) {
      try {
        await this.list.complete({ orgId, candidateId });
        await inOrg(() => this.repo.markListCompleted(orgId, candidateId, requestId));
      } catch (error) {
        // The notice and the anonymisation are done: the sweep retries this, the caller need not fail.
        const name = error instanceof Error ? error.name : 'unknown';
        this.log.warn(`erasure list completion failed for candidate ${candidateId} (${name})`);
      }
    }
    // After the day-28 check: an already anonymised candidate gets no mail (ADR 0004 9.5 step 8).
    if (finished && !sent && !noticed && !anonymised) {
      await this.notices.enqueueCompleted({ orgId, candidateId, requestId });
    }
    if (completed) return { status: 'completed', requestId, anonymised };
    return { status: heldAny ? 'held' : 'inProgress', requestId, anonymised };
  }

  /** An undeletable prefix pages after the tiers' 3 days, once per fence (ADR 0004 9.5 step 7). */
  private async alertUnverified(a: {
    orgId: string;
    candidateId: string;
    requestId: string;
    since: Date;
    now: Date;
  }): Promise<void> {
    if ((a.now.getTime() - a.since.getTime()) / DAY_MS < TIER_FAILURE_ALERT_DAYS) return;
    const key = {
      candidateId: a.candidateId,
      requestId: a.requestId,
      action: ERASURE_AUDIT_ACTIONS.ALERT_RAISED,
      since: `prefix:${Math.floor(a.since.getTime() / 1000)}`,
    };
    if (await this.repo.inOrg(a.orgId, () => this.repo.onceDone(key))) return;
    await this.alerts.raise({
      kind: 'ERASURE_PREFIX_UNVERIFIED',
      orgId: a.orgId,
      candidateId: a.candidateId,
      requestId: a.requestId,
    });
    await this.repo.inOrg(a.orgId, () => this.repo.writeOnce({ orgId: a.orgId, ...key }));
  }
}
