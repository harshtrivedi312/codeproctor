import { Module } from '@nestjs/common';
import { CandidateModule } from '../candidate/candidate.module';
import { SessionModule } from '../session/session.module';
import { MediaCandidateController } from './media-candidate.controller';
import { MediaPlaybackService } from './media-playback.service';
import { ObjectStorePort } from '../retention/object-store.port';
import { S3ObjectStore } from './s3-object-store';
import { MediaService } from './media.service';
import { StorageModule } from './storage.module';

// FR-701 to FR-704 (BE-09): candidate chunk presign and confirm, and the playback playlist service
// that BE-13's review route calls.
@Module({
  imports: [CandidateModule, StorageModule, SessionModule],
  controllers: [MediaCandidateController],
  providers: [
    MediaService,
    MediaPlaybackService,
    // The object store RetentionModule.forRoot({ objectStore: MediaModule }) runs on (FR-704).
    { provide: ObjectStorePort, useClass: S3ObjectStore },
  ],
  exports: [MediaPlaybackService, StorageModule, ObjectStorePort],
})
export class MediaModule {}
