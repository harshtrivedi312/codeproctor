import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsISO8601, Max, Min } from 'class-validator';
import {
  MAX_CHUNK_BYTES,
  MAX_CHUNK_DURATION_MS,
  MAX_SEGMENT,
  MAX_SEQ,
  MEDIA_CONTENT_TYPES,
  MEDIA_STREAMS,
} from '../media.constants';
import type { CandidateMediaStream, MediaContentType } from '../media.constants';

export class ChunkRefDto {
  @ApiProperty({
    enum: MEDIA_STREAMS,
    description: 'SIDE_CAMERA is not accepted yet (ARC-03 part 2)',
  })
  @IsIn([...MEDIA_STREAMS])
  stream!: CandidateMediaStream;

  @ApiProperty({
    minimum: 0,
    maximum: MAX_SEGMENT,
    description: 'A recorder restart starts a new segment',
  })
  @IsInt()
  @Min(0)
  @Max(MAX_SEGMENT)
  segment!: number;

  @ApiProperty({ minimum: 0, maximum: MAX_SEQ })
  @IsInt()
  @Min(0)
  @Max(MAX_SEQ)
  seq!: number;
}

export class MediaPresignDto extends ChunkRefDto {
  @ApiProperty({ minimum: 1, maximum: MAX_CHUNK_BYTES, description: '16 MiB; AUDIO 4 MiB' })
  @IsInt()
  @Min(1)
  @Max(MAX_CHUNK_BYTES)
  bytes!: number;

  @ApiProperty({
    enum: MEDIA_CONTENT_TYPES,
    description: 'The bare type, sent as the Content-Type header of the PUT (not blob.type)',
  })
  @IsIn([...MEDIA_CONTENT_TYPES])
  contentType!: MediaContentType;

  @ApiProperty({
    format: 'date-time',
    description: 'Clamped to the server clock and session start',
  })
  @IsISO8601({ strict: true })
  startedAt!: string;

  @ApiProperty({ minimum: 1, maximum: MAX_CHUNK_DURATION_MS })
  @IsInt()
  @Min(1)
  @Max(MAX_CHUNK_DURATION_MS)
  durationMs!: number;
}

export class MediaConfirmDto extends ChunkRefDto {}

export class PresignedPutDto {
  @ApiProperty({ description: 'Never logged. Valid 60 s.' }) url!: string;
  @ApiProperty({ enum: ['PUT'] }) method!: 'PUT';
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Send exactly these headers (Content-Type; If-None-Match when conditional)',
  })
  headers!: Record<string, string>;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

export class AlreadyUploadedDto {
  @ApiProperty({ enum: [true], description: 'Confirmed chunk: no new URL is ever issued' })
  alreadyUploaded!: true;
}

export class MediaConfirmedDto {
  @ApiProperty({ enum: [true] }) uploaded!: true;
  @ApiProperty() sizeBytes!: number;
}

// ---- staff playback (FR-703) ----

export class PlaylistChunkDto {
  @ApiProperty() seq!: number;
  @ApiProperty({ format: 'date-time' }) startedAt!: string;
  @ApiProperty() durationMs!: number;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty({ description: 'Signed GET URL, valid 15 minutes. Never logged.' }) url!: string;
}

export class PlaylistSegmentDto {
  @ApiProperty() segment!: number;
  @ApiProperty({ type: [PlaylistChunkDto], description: 'In seq order; a missing chunk is a gap' })
  chunks!: PlaylistChunkDto[];
}

export class PlaylistStreamDto {
  @ApiProperty({ enum: ['SCREEN', 'WEBCAM', 'AUDIO', 'SIDE_CAMERA', 'ROOM_SCAN'] })
  stream!: string;
  @ApiProperty({ type: [PlaylistSegmentDto] }) segments!: PlaylistSegmentDto[];
}

export class MediaPlaylistDto {
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ type: [PlaylistStreamDto] }) streams!: PlaylistStreamDto[];
}
