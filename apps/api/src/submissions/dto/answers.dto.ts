import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Largest source a candidate may save, run or submit (characters). */
export const MAX_CODE_CHARS = 100_000;

export class RunDto {
  @ApiProperty({ maxLength: MAX_CODE_CHARS, description: 'The source to run against the samples' })
  @IsString()
  @Length(1, MAX_CODE_CHARS)
  code!: string;

  @ApiProperty({ example: 'python', description: 'One of the question allowed languages' })
  @IsString()
  @Length(1, 32)
  language!: string;
}

export class SubmitDto extends RunDto {}

export class DraftDto {
  @ApiPropertyOptional({ maxLength: MAX_CODE_CHARS, description: 'CODING questions: the source' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CODE_CHARS)
  code?: string;

  @ApiPropertyOptional({ example: 'python', description: 'CODING questions: required with code' })
  @IsOptional()
  @IsString()
  @Length(1, 32)
  language?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'MCQ: { optionIds: string[] }. SHORT_ANSWER: { text: string }. Checked against the question type.',
  })
  @IsOptional()
  @IsObject()
  answer?: Record<string, unknown>;
}

export class SampleResultDto {
  @ApiProperty({ description: 'Sample number, from 1' })
  index!: number;
  @ApiProperty({
    enum: [
      'PASSED',
      'FAILED',
      'COMPILE_ERROR',
      'TIME_LIMIT',
      'MEMORY_LIMIT',
      'OUTPUT_LIMIT',
      'RUNTIME_ERROR',
      'INTERNAL_ERROR',
      'LOCAL_STUB',
    ],
  })
  verdict!: string;
  @ApiProperty()
  passed!: boolean;
  @ApiPropertyOptional({ nullable: true })
  timeMs!: number | null;
  @ApiPropertyOptional({ nullable: true })
  memoryKb!: number | null;
  @ApiPropertyOptional({ description: 'Your program output on a sample (capped)' })
  stdout?: string;
  @ApiPropertyOptional()
  stdoutTruncated?: boolean;
  @ApiPropertyOptional({ description: 'A fixed sentence, plus capped compiler or runtime output' })
  message?: string;
}

export class RunResultDto {
  @ApiProperty()
  serverTime!: string;
  @ApiProperty()
  passed!: number;
  @ApiProperty()
  total!: number;
  @ApiProperty({ type: [SampleResultDto] })
  results!: SampleResultDto[];
}

export class DraftSavedDto {
  @ApiProperty({ description: 'Server time of the save' })
  savedAt!: string;
}

export class SubmitAcceptedDto {
  @ApiProperty({ example: true })
  accepted!: true;
  @ApiProperty({ format: 'uuid' })
  submissionId!: string;
}

export class SessionFinishedDto {
  @ApiProperty({ example: 'SUBMITTED' })
  status!: string;
  @ApiProperty()
  serverTime!: string;
}

/** Names the section by its position in the token's own session (never an id). */
export class SectionFinishDto {
  @ApiProperty({ minimum: 1, description: 'Position of the section within this session, from 1' })
  @IsInt()
  @Min(1)
  @Max(1000)
  position!: number;
}

export class SectionFinishQueuedDto {
  @ApiProperty({ example: true })
  accepted!: true;
}
