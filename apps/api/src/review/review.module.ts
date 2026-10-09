import { Module } from '@nestjs/common';
import { SessionModule } from '../session/session.module';
import { StorageModule } from '../media/storage.module';
import { RecordingStoragePort } from './recording-storage.port';
import { ReviewDecisionsService } from './review-decisions.service';
import { ReviewController } from './review.controller';
import { ReviewService } from './review.service';
import { StorageRecordingStorage } from './storage-recording-storage';

// Playback signs through the shared StorageService (BE-09, FR-703): S3 on pilot and production, R2
// or MinIO locally, 503 when storage is not configured (FU-BE-229).
@Module({
  imports: [StorageModule, SessionModule],
  controllers: [ReviewController],
  providers: [
    ReviewService,
    ReviewDecisionsService,
    { provide: RecordingStoragePort, useClass: StorageRecordingStorage },
  ],
})
export class ReviewModule {}
