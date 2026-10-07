import { Module } from '@nestjs/common';
import { RecordingStoragePort, UnconfiguredRecordingStorage } from './recording-storage.port';
import { ReviewController } from './review.controller';
import { ReviewService } from './review.service';

// The S3 adapter binds RecordingStoragePort here when it exists (FU-BE-229); until then playback is 503.
@Module({
  controllers: [ReviewController],
  providers: [
    ReviewService,
    { provide: RecordingStoragePort, useClass: UnconfiguredRecordingStorage },
  ],
})
export class ReviewModule {}
