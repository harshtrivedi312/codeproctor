// DL-30: when a waiver lands after a match has run, the sealed ID image and selfie of every earlier
// attempt are deleted at once, and each attempt row keeps only its ids, status and timestamps. A
// waived candidate's images never survive. Its own service so the job and the routes can both use it
// without depending on each other.
import { Injectable, Logger } from '@nestjs/common';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import type { SessionScope } from '../media/storage-keys';
import { IdentityMedia } from './identity-media';

@Injectable()
export class IdentityPurgeService {
  private readonly logger = new Logger(IdentityPurgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
    private readonly media: IdentityMedia,
  ) {}

  /** Idempotent. `deleted` is false while any identity object remains (the caller must retry). */
  async purgeAfterWaiver(orgId: string, sessionId: string): Promise<{ deleted: boolean }> {
    const scope: SessionScope = { orgId, sessionId };
    const imagesGone = await this.media.deleteSessionIdentityImages(scope);
    await this.orgContext.runInOrg(orgId, () =>
      this.prisma.client.identityCheck.updateMany({
        where: { sessionId },
        data: {
          idImageKey: null,
          selfieKey: null,
          faceMatchScore: null,
          modelId: null,
          threshold: null,
          livenessPassed: null,
          reviewReason: null,
        },
      }),
    );
    this.logger.log({ event: 'identity.purged-after-waiver', sessionId, imagesGone });
    return { deleted: imagesGone };
  }
}
