import { Module } from '@nestjs/common';
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
import { ObjectStoragePort, UnconfiguredObjectStorage } from './object-storage.port';
import { OtpService } from './otp.service';
import { SessionJobsService } from './session-jobs.service';
import { SessionRateLimiter } from './session-rate-limiter';
import { TestStartService } from './test-start.service';

// FR-106, FR-401, FR-505, FR-609 (BE-07). The two ports are bound to stand-ins here and replaced by
// Backend A's mail provider (BE-06) and the StorageService (BE-09) in their own modules.
@Module({
  imports: [SessionModule],
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
    { provide: ObjectStoragePort, useClass: UnconfiguredObjectStorage },
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
