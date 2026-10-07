import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CandidateModule } from '../candidate/candidate.module';
import type { Env } from '../config/env';
import { StorageModule } from '../media/storage.module';
import { SessionModule } from '../session/session.module';
import { VerifySessionJobs } from '../session/verify-session.jobs';
import { FaceMatchService } from './face-match.service';
import { IdentitySessionJobs } from './identity-session-jobs';
import { IdentityCandidateController } from './identity-candidate.controller';
import { IdentityFacts, PrismaIdentityFacts } from './identity-facts';
import { IdentityJobsService } from './identity-jobs.service';
import { IdentityMedia } from './identity-media';
import { IdentityNamesStore } from './identity-names.store';
import { IdentityPurgeService } from './identity-purge.service';
import { FaceMatchQueue, VerifySessionPort } from './identity-ports';
import { IdentityService } from './identity.service';
import { HttpWorkerClient, UnconfiguredWorkerClient, WorkerClient } from './worker-client';

// FR-403 (BE-08b): the API half of the identity check. The ports bound to stand-ins here are marked
// in the PR: verify-session (BE-07 owns the job), the facts reader (reads the accommodation until the
// WAIVED status and the erasure markers exist), and the worker client (unconfigured without the
// WORKER_* settings, which makes every match MANUAL_REVIEW: the candidate continues, D-05).
@Module({
  imports: [CandidateModule, SessionModule, StorageModule],
  controllers: [IdentityCandidateController],
  providers: [
    IdentityMedia,
    IdentityNamesStore,
    IdentityPurgeService,
    IdentityService,
    FaceMatchService,
    IdentitySessionJobs,
    IdentityJobsService,
    { provide: FaceMatchQueue, useExisting: IdentityJobsService },
    { provide: IdentityFacts, useClass: PrismaIdentityFacts },
    {
      // Called only inside IdentitySessionJobs.enqueueVerify, in the session-job scope enqueueVerifySession requires.
      provide: VerifySessionPort,
      inject: [VerifySessionJobs],
      useFactory: (jobs: VerifySessionJobs): VerifySessionPort => ({
        enqueue: (orgId, sessionId) => jobs.enqueueVerifySession(orgId, sessionId),
      }),
    },
    {
      provide: WorkerClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): WorkerClient => {
        const baseUrl = config.get('WORKER_BASE_URL', { infer: true });
        const keyId = config.get('WORKER_HMAC_KEY_ID', { infer: true });
        const key = config.get('WORKER_HMAC_KEY', { infer: true });
        if (baseUrl === undefined || keyId === undefined || key === undefined) {
          return new UnconfiguredWorkerClient();
        }
        return new HttpWorkerClient({ baseUrl, keyId, key: Buffer.from(key, 'base64') });
      },
    },
  ],
  // BE-06 calls IdentityService.purgeAfterWaiver after it commits a waiver (DL-30).
  exports: [IdentityService],
})
export class IdentityModule {}
