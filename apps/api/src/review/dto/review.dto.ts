import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { SessionStatus } from '../../generated/prisma/enums';

export class QueueQueryDto {
  @ApiPropertyOptional({
    enum: SessionStatus,
    description: 'Default: GRADED and UNDER_REVIEW (sessions awaiting or under review).',
  })
  @IsOptional()
  @IsEnum(SessionStatus)
  status?: SessionStatus;

  @ApiPropertyOptional({ description: 'The nextCursor of the previous page.', maxLength: 300 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 300)
  cursor?: string;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 25;
}

export class QueueItemDto {
  @ApiProperty({ format: 'uuid' }) sessionId!: string;
  @ApiProperty() candidateName!: string;
  @ApiProperty() candidateEmail!: string;
  @ApiProperty() testTitle!: string;
  @ApiProperty({ enum: SessionStatus }) status!: SessionStatus;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) submittedAt!: string | null;
  @ApiProperty({ type: Number, nullable: true }) riskScore!: number | null;
  @ApiProperty({ description: 'Events of severity MEDIUM or HIGH.' }) flagCount!: number;
  @ApiProperty({ description: 'Answers still MANUAL_PENDING.' }) pendingManualCount!: number;
}

export class QueueDto {
  @ApiProperty({ type: [QueueItemDto] }) items!: QueueItemDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class ReviewRunTestDto {
  @ApiProperty() name!: string;
  @ApiProperty() status!: string;
}
export class ReviewRunResultDto {
  @ApiProperty({ type: String, format: 'date-time' }) at!: string;
  @ApiProperty() passed!: number;
  @ApiProperty() total!: number;
  @ApiProperty({ type: [ReviewRunTestDto] }) tests!: ReviewRunTestDto[];
}
export class ReviewAnswerDto {
  @ApiProperty({ format: 'uuid' }) sessionQuestionId!: string;
  @ApiProperty({ enum: ['CODING', 'MCQ', 'SHORT_ANSWER'] }) type!: string;
  @ApiProperty() title!: string;
  @ApiProperty() statement!: string;
  @ApiProperty() points!: number;
  @ApiProperty({ type: Number, nullable: true }) score!: number | null;
  @ApiProperty({ enum: ['AUTO', 'MANUAL', 'MANUAL_PENDING'] }) scoring!: string;
  @ApiProperty({ type: String, nullable: true }) scoringNote!: string | null;
  @ApiProperty({
    description:
      'CODING: { language, code } or null. MCQ and SHORT_ANSWER: the stored answer value or null.',
    nullable: true,
    type: 'object',
    additionalProperties: true,
  })
  answer!: unknown;
  @ApiPropertyOptional({ type: [ReviewRunResultDto], description: 'CODING only.' })
  runResults?: ReviewRunResultDto[];
}
export class ReviewEventDto {
  @ApiProperty({ description: 'Event id (decimal string).' }) id!: string;
  @ApiProperty({ type: String, format: 'date-time' }) at!: string;
  @ApiProperty() type!: string;
  @ApiProperty({ enum: ['LOW', 'MEDIUM', 'HIGH'] }) severity!: string;
  @ApiProperty({ type: String, nullable: true }) detail!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Id of the flag decision, once decided.',
  })
  flagId!: string | null;
}
export class ReviewRecordingDto {
  @ApiProperty({ description: 'KIND-SEGMENT, e.g. SCREEN-0.' }) id!: string;
  @ApiProperty({ enum: ['SCREEN', 'WEBCAM', 'AUDIO'] }) kind!: string;
  @ApiProperty({ type: String, format: 'date-time' }) startedAt!: string;
  @ApiProperty() durationMs!: number;
}
export class ReviewVerdictDto {
  @ApiProperty({ enum: ['CLEAN', 'SUSPICIOUS', 'VIOLATION'], nullable: true, type: String })
  verdict!: string | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) completedAt!: string | null;
}
class ReviewSessionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: SessionStatus }) status!: SessionStatus;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) startedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) submittedAt!: string | null;
  @ApiProperty({ type: Number, nullable: true }) totalScore!: number | null;
  @ApiProperty({ type: Number, nullable: true }) riskScore!: number | null;
}
class ReviewCandidateDto {
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
}
class ReviewTestDto {
  @ApiProperty() title!: string;
}
export class ReviewBundleDto {
  @ApiProperty({ type: ReviewSessionDto }) session!: ReviewSessionDto;
  @ApiProperty({ type: ReviewCandidateDto }) candidate!: ReviewCandidateDto;
  @ApiProperty({ type: ReviewTestDto }) test!: ReviewTestDto;
  @ApiProperty({ type: [ReviewAnswerDto] }) answers!: ReviewAnswerDto[];
  @ApiProperty({ type: [ReviewEventDto] }) events!: ReviewEventDto[];
  @ApiProperty({ type: [ReviewRecordingDto] }) recordings!: ReviewRecordingDto[];
  @ApiProperty({ type: ReviewVerdictDto, nullable: true }) verdict!: ReviewVerdictDto | null;
}

export class PlaybackPartDto {
  @ApiProperty() url!: string;
  @ApiProperty() seq!: number;
  @ApiProperty() durationMs!: number;
}
export class PlaybackDto {
  @ApiProperty({ description: 'Presigned GET of the first part (it holds the WebM header).' })
  url!: string;
  @ApiProperty({ type: String, format: 'date-time' }) expiresAt!: string;
  @ApiProperty() contentType!: string;
  @ApiProperty({
    type: [PlaybackPartDto],
    description: 'All parts in order; play them in sequence.',
  })
  parts!: PlaybackPartDto[];
}
