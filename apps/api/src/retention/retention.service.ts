// RetentionService: the daily retention tiers (FR-704, NFR-05; ADR 0004 9.2). Face tier and media
// tier here; results (R-10), consent (R-9) and erasure follow in their own slices.
//
// For each tier: find the sessions that are due and have no marker, then per session (in its own
// org scope) delete the objects, verify, and only then null the columns and write the marker in one
// transaction. A session that fails verification changes nothing and is retried the next run.
// Object keys are never logged or returned; sessions are named by id.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LegalHoldPort } from './legal-hold.port';
import { ObjectStorePort } from './object-store.port';
import { RetentionRepository } from './retention.repository';
import type { DueSession } from './retention.repository';
import { FACE_SUBPREFIXES, REPORTS_SUBPREFIX, sessionPrefix } from './retention.constants';
import type { RetentionTier } from './retention.constants';
import type { RetentionConfig } from './retention.config';
import { assertVersioningSafe, deleteVerified } from './verified-delete';

export const RETENTION_CONFIG = Symbol('RETENTION_CONFIG');

export interface TierSummary {
  /** Sessions the tier looked at this run. */
  readonly due: number;
  /** Sessions whose deletion was verified and whose marker was written. */
  readonly completed: number;
  /** Sessions left for tomorrow: not verified, held, or an error. */
  readonly retryLater: number;
}

export interface RunSummary {
  readonly runId: string;
  readonly face: TierSummary;
  readonly media: TierSummary;
}

@Injectable()
export class RetentionService {
  private readonly log = new Logger(RetentionService.name);

  constructor(
    private readonly repo: RetentionRepository,
    private readonly store: ObjectStorePort,
    private readonly legalHold: LegalHoldPort,
    @Inject(RETENTION_CONFIG) private readonly config: RetentionConfig,
  ) {}

  /** Runs the face and media tiers once. Throws (and does nothing) if the object store is not safe. */
  async runDaily(now: Date = new Date()): Promise<RunSummary> {
    await assertVersioningSafe(this.store, this.config);
    const runId = randomUUID();
    const perOrg = new Map<string, Record<string, number>>();
    const count = (orgId: string, key: string): void => {
      const row = perOrg.get(orgId) ?? {};
      row[key] = (row[key] ?? 0) + 1;
      perOrg.set(orgId, row);
    };

    const face = await this.runTier('FACE', now, runId, count);
    const media = await this.runTier('MEDIA', now, runId, count);

    for (const [orgId, counts] of perOrg) {
      await this.repo.inOrg(orgId, () => this.repo.writeRunSummary(orgId, runId, counts));
    }
    return { runId, face, media };
  }

  private async runTier(
    tier: Extract<RetentionTier, 'FACE' | 'MEDIA'>,
    now: Date,
    runId: string,
    count: (orgId: string, key: string) => void,
  ): Promise<TierSummary> {
    const limit = this.config.RETENTION_BATCH_SIZE;
    const due: DueSession[] =
      tier === 'FACE'
        ? await this.repo.findDueFace(now, limit)
        : await this.repo.findDueMedia(now, this.config.RETENTION_MEDIA_CAP_DAYS, limit);
    let completed = 0;
    let retryLater = 0;
    for (const session of due) {
      const done = await this.processSession(tier, session, now, runId);
      if (done) {
        completed++;
        count(session.orgId, `${tier.toLowerCase()}Completed`);
      } else {
        retryLater++;
        count(session.orgId, `${tier.toLowerCase()}RetryLater`);
      }
    }
    return { due: due.length, completed, retryLater };
  }

  /** True when the tier finished for the session (marker written); false means "try again tomorrow". */
  private async processSession(
    tier: Extract<RetentionTier, 'FACE' | 'MEDIA'>,
    session: DueSession,
    now: Date,
    runId: string,
  ): Promise<boolean> {
    const { orgId, sessionId } = session;
    try {
      return await this.repo.inOrg(orgId, async () => {
        if (this.config.RETENTION_LEGAL_HOLD && (await this.legalHold.isHeld(orgId, sessionId)))
          return false;
        if (await this.repo.hasMarker(tier, sessionId)) return true; // another run finished it

        const root = sessionPrefix(orgId, sessionId);
        const result =
          tier === 'FACE'
            ? await deleteVerified(this.store, this.facePrefixes(root))
            : await deleteVerified(this.store, [root], (key) =>
                key.startsWith(`${root}${REPORTS_SUBPREFIX}`),
              );
        if (!result.verified) {
          this.log.warn(`retention ${tier} not verified for session ${sessionId}`);
          return false;
        }
        if (tier === 'FACE') {
          await this.repo.completeFace({
            orgId,
            sessionId,
            evidenceAll: this.config.RETENTION_EVIDENCE_IN_FACE_TIER,
            runId,
          });
        } else {
          await this.repo.completeMedia({ orgId, sessionId, now, runId });
        }
        return true;
      });
    } catch {
      // The error is not logged: a Prisma or store error can quote values. The session is named by id.
      this.log.warn(`retention ${tier} failed for session ${sessionId}`);
      return false;
    }
  }

  /** The face tier's prefixes; with OQ-19 on, all of `evidence/` (event frames show faces too). */
  private facePrefixes(root: string): string[] {
    return this.config.RETENTION_EVIDENCE_IN_FACE_TIER
      ? [`${root}identity/`, `${root}evidence/`]
      : FACE_SUBPREFIXES.map((p) => `${root}${p}`);
  }
}
