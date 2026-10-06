// RetentionService: the daily retention tiers (FR-704, NFR-05; ADR 0004 9.2 to 9.4): face, media and
// results tiers, consent records (R-9) and candidate anonymisation. Erasure is its own slice.
//
// For each tier: page through the sessions that are due and have no marker (a keyset cursor, so a
// session that never verifies cannot starve the others), then per session in its own org scope:
// re-check, delete the objects, verify, and only then null the columns and write the marker in one
// transaction. A session that fails verification changes nothing and is retried the next run.
// Object keys are never logged or returned; sessions are named by id.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LegalHoldPort } from './legal-hold.port';
import { ObjectStorePort } from './object-store.port';
import { ConsentRetentionRepository } from './consent-retention.repository';
import type { DueConsent, ConsentCursor } from './consent-retention.repository';
import { RetentionRepository } from './retention.repository';
import type { Cursor, DueSession } from './retention.repository';
import {
  FACE_SUBPREFIXES,
  REPORTS_SUBPREFIX,
  consentPrefix,
  sessionPrefix,
} from './retention.constants';
import type { RetentionTier } from './retention.constants';
import type { RetentionConfig } from './retention.config';
import { assertVersioningSafe, deleteVerified } from './verified-delete';

export const RETENTION_CONFIG = Symbol('RETENTION_CONFIG');

/** One run looks at no more than this many pages per tier (batch size x pages is the daily ceiling). */
const MAX_PAGES_PER_TIER = 500;

type Tier = Extract<RetentionTier, 'FACE' | 'MEDIA' | 'RESULTS'>;

export interface TierSummary {
  /** Sessions the tier looked at this run. */
  readonly due: number;
  /** Sessions whose deletion was verified and whose marker this run wrote. */
  readonly completed: number;
  /** Sessions another run finished first (their marker was already there). */
  readonly alreadyDone: number;
  /** Sessions left for tomorrow: not verified, held, no longer eligible, or an error. */
  readonly retryLater: number;
}

export interface RunSummary {
  readonly runId: string;
  readonly face: TierSummary;
  readonly media: TierSummary;
  readonly results: TierSummary;
  /** R-9: signed and declined consent records past 3 years. */
  readonly consent: TierSummary;
  /** Candidates anonymised this run (R-10's atomic path and the daily backstop). */
  readonly candidatesAnonymised: number;
}

type Outcome = 'completed' | 'alreadyDone' | 'retryLater';

@Injectable()
export class RetentionService {
  private readonly log = new Logger(RetentionService.name);

  constructor(
    private readonly repo: RetentionRepository,
    private readonly consentRepo: ConsentRetentionRepository,
    private readonly store: ObjectStorePort,
    private readonly legalHold: LegalHoldPort,
    @Inject(RETENTION_CONFIG) private readonly config: RetentionConfig,
  ) {}

  /** Runs the face, media and results tiers and the consent rule (R-9) once. Throws (and does nothing) if the object store is not safe. */
  async runDaily(now: Date = new Date()): Promise<RunSummary> {
    await assertVersioningSafe(this.store, this.config);
    const runId = randomUUID();
    const perOrg = new Map<string, Record<string, number>>();
    const count = (orgId: string, key: string): void => {
      const row = perOrg.get(orgId) ?? {};
      row[key] = (row[key] ?? 0) + 1;
      perOrg.set(orgId, row);
    };

    const ctx = { anonymised: 0 };
    const face = await this.runTier('FACE', now, runId, count, ctx);
    const media = await this.runTier('MEDIA', now, runId, count, ctx);
    const results = await this.runTier('RESULTS', now, runId, count, ctx);
    const consent = await this.runConsent(now, runId, count);
    await this.sweepCandidates(now, runId, count, ctx);

    for (const [orgId, counts] of perOrg) {
      await this.repo.inOrg(orgId, () => this.repo.writeRunSummary(orgId, runId, counts));
    }
    return { runId, face, media, results, consent, candidatesAnonymised: ctx.anonymised };
  }

  private async runTier(
    tier: Tier,
    now: Date,
    runId: string,
    count: (orgId: string, key: string) => void,
    ctx: { anonymised: number },
  ): Promise<TierSummary> {
    const limit = this.config.RETENTION_BATCH_SIZE;
    const tally = { due: 0, completed: 0, alreadyDone: 0, retryLater: 0 };
    let after: Cursor | undefined;
    for (let page = 0; page < MAX_PAGES_PER_TIER; page++) {
      const due: DueSession[] =
        tier === 'FACE'
          ? await this.repo.findDueFace(now, limit, after)
          : tier === 'MEDIA'
            ? await this.repo.findDueMedia(now, this.config.RETENTION_MEDIA_CAP_DAYS, limit, after)
            : await this.repo.findDueResults(
                now,
                this.config.RETENTION_RESULTS_CLOCK,
                limit,
                after,
              );
      for (const session of due) {
        const outcome = await this.processSession(tier, session, now, runId, ctx);
        tally.due++;
        tally[outcome]++;
        count(
          session.orgId,
          `${tier.toLowerCase()}${outcome[0]?.toUpperCase()}${outcome.slice(1)}`,
        );
      }
      const last = due.at(-1);
      // A short page is the end. A session that failed is simply stepped past (the cursor moves on),
      // so it is retried tomorrow instead of blocking the head of the queue today.
      if (due.length < limit || last === undefined) break;
      after = { createdAtCursor: last.createdAtCursor, sessionId: last.sessionId };
    }
    return tally;
  }

  private async processSession(
    tier: Tier,
    session: DueSession,
    now: Date,
    runId: string,
    ctx: { anonymised: number },
  ): Promise<Outcome> {
    const { orgId, sessionId } = session;
    try {
      return await this.repo.inOrg(orgId, async (): Promise<Outcome> => {
        // OQ-10 pauses R-4, R-9 and R-10 (ADR 0004 9.10). The face cap runs "whatever any hold says" (C-35).
        if (
          tier !== 'FACE' &&
          this.config.RETENTION_LEGAL_HOLD &&
          (await this.isHeld(orgId, sessionId))
        ) {
          return 'retryLater';
        }
        if (await this.repo.hasMarker(tier, sessionId)) return 'alreadyDone';
        // R-2: selection may be stale, so the hold states are read again right before deleting.
        if (tier === 'MEDIA' && !(await this.repo.mediaStillEligible(sessionId)))
          return 'retryLater';
        if (
          tier === 'RESULTS' &&
          !(await this.repo.stillEligible(sessionId, this.config.RETENTION_RESULTS_CLOCK, { now }))
        ) {
          return 'retryLater';
        }

        const root = sessionPrefix(orgId, sessionId);
        // A key stored outside the session prefix would be nulled but never deleted: not verified.
        if (
          await this.repo.hasKeyOutside(
            root,
            sessionId,
            tier,
            this.config.RETENTION_EVIDENCE_IN_FACE_TIER,
          )
        ) {
          this.log.warn(
            `retention ${tier} found a stored key outside the tier prefixes for session ${sessionId}`,
          );
          return 'retryLater';
        }
        const result =
          tier === 'FACE'
            ? await deleteVerified(this.store, this.facePrefixes(root))
            : tier === 'MEDIA'
              ? await deleteVerified(this.store, [root], (key) =>
                  key.startsWith(`${root}${REPORTS_SUBPREFIX}`),
                )
              : // R-10 deletes the whole prefix, reports included, with its own verification: it does
                // not wait for the face or media markers.
                await deleteVerified(this.store, [root]);
        if (!result.verified) {
          this.log.warn(`retention ${tier} not verified for session ${sessionId}`);
          return 'retryLater';
        }
        if (tier === 'RESULTS') {
          const done = await this.repo.completeResults({
            orgId,
            sessionId,
            reduceAccommodationsOnRun: this.config.RETENTION_REDUCE_ACCOMMODATIONS,
            clock: this.config.RETENTION_RESULTS_CLOCK,
            now,
            runId,
          });
          // R-2 held it again inside the transaction (a review or appeal opened meanwhile).
          if (done.kind === 'notEligible') return 'retryLater';
          if (done.kind === 'alreadyDone') return 'alreadyDone';
          if (done.anonymised) ctx.anonymised++;
          return 'completed';
        }
        const wrote =
          tier === 'FACE'
            ? await this.repo.completeFace({
                orgId,
                sessionId,
                evidenceAll: this.config.RETENTION_EVIDENCE_IN_FACE_TIER,
                runId,
              })
            : await this.repo.completeMedia({ orgId, sessionId, now, runId });
        return wrote ? 'completed' : 'alreadyDone';
      });
    } catch (error) {
      // Only the error's name and a Prisma code are logged: a message can quote values.
      const code = (error as { code?: unknown } | null)?.code;
      const name = error instanceof Error ? error.name : 'Error';
      this.log.warn(
        `retention ${tier} failed for session ${sessionId} (${name}${typeof code === 'string' ? ` ${code}` : ''})`,
      );
      return 'retryLater';
    }
  }

  /**
   * R-9 (ADR 0004 9.3): signed consent records 3 years after signing (declined ones too, OQ-11). The
   * consent PDF prefix is deleted and verified before the row goes, and the row is read only through
   * ConsentRetentionRepository's fixed select. Erasure does not delete these (C-17).
   */
  private async runConsent(
    now: Date,
    runId: string,
    count: (orgId: string, key: string) => void,
  ): Promise<TierSummary> {
    const limit = this.config.RETENTION_BATCH_SIZE;
    const tally = { due: 0, completed: 0, alreadyDone: 0, retryLater: 0 };
    let after: ConsentCursor | undefined;
    for (let page = 0; page < MAX_PAGES_PER_TIER; page++) {
      const due: DueConsent[] = await this.consentRepo.findDue(
        now,
        this.config.RETENTION_DECLINED_CONSENTS_EXPIRE,
        limit,
        after,
      );
      for (const item of due) {
        const outcome = await this.processConsent(item, runId);
        tally.due++;
        tally[outcome]++;
        count(item.orgId, `consent${outcome[0]?.toUpperCase()}${outcome.slice(1)}`);
      }
      const last = due.at(-1);
      if (due.length < limit || last === undefined) break;
      after = { clockCursor: last.clockCursor, consentId: last.consentId };
    }
    return tally;
  }

  private async processConsent(item: DueConsent, runId: string): Promise<Outcome> {
    const { orgId, sessionId, consentId } = item;
    try {
      return await this.consentRepo.inOrg(orgId, async (): Promise<Outcome> => {
        if (this.config.RETENTION_LEGAL_HOLD && (await this.isHeld(orgId, sessionId)))
          return 'retryLater';
        const row = await this.consentRepo.read(consentId);
        if (row === null) return 'alreadyDone';
        // R-9 skip rule, read again just before deleting.
        if (!(await this.consentRepo.sessionNotHeld(sessionId))) return 'retryLater';
        const prefix = consentPrefix(orgId, sessionId);
        // The PDF key must lie under the prefix that is deleted, or the row (its only pointer) would go with the object left behind.
        if (row.pdfKey !== null && !row.pdfKey.startsWith(prefix)) {
          this.log.warn(
            `retention CONSENT found a stored key outside the prefix for session ${sessionId}`,
          );
          return 'retryLater';
        }
        const result = await deleteVerified(this.store, [prefix]);
        if (!result.verified) {
          this.log.warn(`retention CONSENT not verified for session ${sessionId}`);
          return 'retryLater';
        }
        return (await this.consentRepo.deleteRow({ orgId, sessionId, consentId, runId }))
          ? 'completed'
          : 'alreadyDone';
      });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const name = error instanceof Error ? error.name : 'Error';
      this.log.warn(
        `retention CONSENT failed for session ${sessionId} (${name}${typeof code === 'string' ? ` ${code}` : ''})`,
      );
      return 'retryLater';
    }
  }

  /**
   * The daily backstop for candidate anonymisation (ADR 0004 9.4): a candidate whose sessions all have
   * their results marker but who was not anonymised (an older marker, or a session added later) is
   * anonymised here, one per transaction, in their own org. The legal hold (OQ-10) applies: it is a
   * per-candidate port, asked through one of the candidate's sessions. Paged by candidate id, so a
   * candidate that keeps failing is stepped past.
   */
  private async sweepCandidates(
    now: Date,
    runId: string,
    count: (orgId: string, key: string) => void,
    ctx: { anonymised: number },
  ): Promise<void> {
    const limit = this.config.RETENTION_BATCH_SIZE;
    let afterId: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_TIER; page++) {
      const found = await this.repo.findCandidatesToAnonymise(limit, afterId);
      for (const { candidateId, orgId, sessionId } of found) {
        try {
          if (this.config.RETENTION_LEGAL_HOLD && (await this.isHeld(orgId, sessionId))) {
            count(orgId, 'candidatesRetryLater');
            continue;
          }
          const did = await this.repo.inOrg(orgId, () =>
            this.repo.anonymiseCandidateIfDone({ orgId, candidateId, now, runId }),
          );
          if (did) {
            ctx.anonymised++;
            count(orgId, 'candidatesAnonymised');
          }
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          this.log.warn(
            `retention candidate anonymisation failed (${typeof code === 'string' ? code : 'error'})`,
          );
        }
      }
      const last = found.at(-1);
      if (found.length < limit || last === undefined) break;
      afterId = last.candidateId;
    }
  }

  /** An error from the hold port counts as held: never delete when the hold cannot be read. */
  private async isHeld(orgId: string, sessionId: string): Promise<boolean> {
    try {
      return await this.legalHold.isHeld(orgId, sessionId);
    } catch {
      return true;
    }
  }

  /** The face tier's prefixes; with OQ-19 on, all of `evidence/` (event frames show faces too). */
  private facePrefixes(root: string): string[] {
    return this.config.RETENTION_EVIDENCE_IN_FACE_TIER
      ? [`${root}identity/`, `${root}evidence/`]
      : FACE_SUBPREFIXES.map((p) => `${root}${p}`);
  }
}
