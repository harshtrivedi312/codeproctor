import { Module } from '@nestjs/common';
import { StorageModule } from '../media/storage.module';
import { StorageService } from '../media/storage.service';
import { SessionModule } from '../session/session.module';
import { CandidateAuthController } from './candidate-auth.controller';
import { CandidateAuthService } from './candidate-auth.service';
import { CandidateMailPort, UnboundCandidateMailPort } from './candidate-mail.port';
import { CandidateScope } from './candidate-scope';
import { CandidateSessionController } from './candidate-session.controller';
import { CandidateSessionGuard } from './candidate-session.guard';
import { CandidateSessionService } from './candidate-session.service';
import { CandidateTokenService } from './candidate-token.service';
import { ConsentPdfService } from './consent-pdf.service';
import { ConsentService } from './consent.service';
import { ObjectStoragePort } from './object-storage.port';
import { OtpService } from './otp.service';
import { SessionJobsService } from './session-jobs.service';
import { SessionRateLimiter } from './session-rate-limiter';
import { TestStartService } from './test-start.service';

// FR-106, FR-401, FR-505, FR-609 (BE-07). The two ports are bound to stand-ins here and replaced by
// Backend A's mail provider (BE-06) in its own module. The storage port is the StorageService (BE-09).
@Module({
  imports: [SessionModule, StorageModule],
  controllers: [CandidateAuthController, CandidateSessionController],
  providers: [
    CandidateTokenService,
    CandidateScope,
    CandidateSessionGuard,
    CandidateAuthService,
    CandidateSessionService,
    ConsentService,
    ConsentPdfService,
    TestStartService,
    OtpService,
    SessionRateLimiter,
    SessionJobsService,
    { provide: CandidateMailPort, useClass: UnboundCandidateMailPort },
    // BE-09: the real S3-compatible store (StorageService extends the port).
    { provide: ObjectStoragePort, useExisting: StorageService },
  ],
  exports: [
    CandidateTokenService,
    SessionRateLimiter,
    CandidateMailPort,
    ObjectStoragePort,
    CandidateScope,
  ],
})
export class CandidateModule {}
