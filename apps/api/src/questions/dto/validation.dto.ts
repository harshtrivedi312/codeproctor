import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Matches } from 'class-validator';
import { ValidateIf } from 'class-validator';

export const VALIDATION_STATUSES = [
  'NONE',
  'RUNNING',
  'PASSED',
  'FAILED',
  'STALE',
  'ERROR',
] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

export class StartValidationDto {
  @ApiPropertyOptional({
    description:
      'The `revision` of the draft as the client loaded it; 409 when it no longer matches, so the run validates what the author saw.',
  })
  @ValidateIf((_o: unknown, v: unknown) => v !== undefined)
  @Matches(/^[0-9a-f]{64}$/)
  expectedRevision?: string;
}

export class ValidationStartedDto {
  @ApiProperty({ format: 'uuid' }) jobId!: string;
  @ApiProperty({ enum: ['RUNNING'] }) status!: 'RUNNING';
  @ApiProperty({
    description: 'The content revision this run validates (taken under the question lock).',
  })
  revision!: string;
  @ApiProperty({ minimum: 1 }) version!: number;
  @ApiProperty({ format: 'date-time' }) startedAt!: string;
}

export class ValidationStatusDto {
  @ApiProperty({
    enum: VALIDATION_STATUSES,
    description:
      'NONE: never run on this content; RUNNING; PASSED or FAILED: finished on the current content; STALE: the content changed while it ran, the result was discarded (publish stays closed); ERROR: the run could not complete (fail closed).',
  })
  status!: ValidationStatus;
  @ApiProperty({ nullable: true, type: String }) jobId!: string | null;
  @ApiProperty({ minimum: 1 }) version!: number;
  @ApiProperty({ description: 'The revision of the draft right now.' }) currentRevision!: string;
  @ApiProperty({ nullable: true, type: String, description: 'The revision the run was bound to.' })
  revision!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) startedAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) finishedAt!: string | null;
  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description: 'Set only by a passing run of the current content.',
  })
  validatedAt!: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  report!: Record<string, unknown> | null;
}
