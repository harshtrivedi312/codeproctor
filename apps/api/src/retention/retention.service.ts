// RetentionService: the daily retention tiers (FR-704, NFR-05; ADR 0004 9.2). Face tier and media
// tier here; results (R-10), consent (R-9) and erasure follow in their own slices.
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
import { RetentionRepository } from './retention.repository';
import type { Cursor, DueSession } from './retention.repository';
import { FACE_SUBPREFIXES, REPORTS_SUBPREFIX, sessionPrefix } from './retention.constants';
import type { RetentionTier } from './retention.constants';
import type { RetentionConfig } from './retention.config';
import { assertVersioningSafe, deleteVerified } from './verified-delete';

export const RETENTION_CONFIG = Symbol('RETENTION_CONFIG');

/** One run looks at no more than this many pages per tier (batch size x pages is the daily ceiling). */
const MAX_PAGES_PER_TIER = 500;

type Tier = Extract<RetentionTier, 'FACE' | 'MEDIA'>;

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
}

type Outcome = 'completed' | 'alreadyDone' | 'retryLater';

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
    tier: Tier,
    now: Date,
    runId: string,
    count: (orgId: string, key: string) => void,
  ): Promise<TierSummary> {
    const limit = this.config.RETENTION_BATCH_SIZE;
    const tally = { due: 0, completed: 0, alreadyDone: 0, retryLater: 0 };
    let after: Cursor | undefined;
    for (let page = 0; page < MAX_PAGES_PER_TIER; page++) {
      const due: DueSession[] =
        tier === 'FACE'
          ? await this.repo.findDueFace(now, limit, after)
          : await this.repo.findDueMedia(now, this.config.RETENTION_MEDIA_CAP_DAYS, limit, after);
      for (const session of due) {
        const outcome = await this.processSession(tier, session, now, runId);
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
  ): Promise<Outcome> {
    const { orgId, sessionId } = session;
    try {
      return await this.repo.inOrg(orgId, async (): Promise<Outcome> => {
        // OQ-10 pauses R-4, R-9 and R-10 (ADR 0004 9.10). The face cap runs "whatever any hold says" (C-35).
        if (
          tier === 'MEDIA' &&
          this.config.RETENTION_LEGAL_HOLD &&
          (await this.isHeld(orgId, sessionId))
        ) {
          return 'retryLater';
        }
        if (await this.repo.hasMarker(tier, sessionId)) return 'alreadyDone';
        // R-2: selection may be stale, so the hold states are read again right before deleting.
        if (tier === 'MEDIA' && !(await this.repo.mediaStillEligible(sessionId)))
          return 'retryLater';

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
            : await deleteVerified(this.store, [root], (key) =>
                key.startsWith(`${root}${REPORTS_SUBPREFIX}`),
              );
        if (!result.verified) {
          this.log.warn(`retention ${tier} not verified for session ${sessionId}`);
          return 'retryLater';
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
