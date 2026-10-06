import { Module } from '@nestjs/common';
import { CandidateModule } from '../candidate/candidate.module';
import { MediaCandidateController } from './media-candidate.controller';
import { MediaPlaybackService } from './media-playback.service';
import { MediaService } from './media.service';
import { StorageModule } from './storage.module';

// FR-701 to FR-704 (BE-09): candidate chunk presign and confirm, and the playback playlist service
// that BE-13's review route calls.
@Module({
  imports: [CandidateModule, StorageModule],
  controllers: [MediaCandidateController],
  providers: [MediaService, MediaPlaybackService],
  exports: [MediaPlaybackService, StorageModule],
})
export class MediaModule {}
