import { ApiProperty } from '@nestjs/swagger';
import { Equals, IsBoolean, IsIn, IsInt, Matches, Max, Min } from 'class-validator';
import {
  IDENTITY_IMAGE_MAX_BYTES,
  IDENTITY_IMAGE_TYPE,
  IDENTITY_NAME,
  IDENTITY_PURPOSES,
} from '../identity.constants';
import type { IdentityPurpose } from '../identity.constants';

/** POST /candidate/session/identity/presign */
export class PresignIdentityDto {
  @ApiProperty({ enum: IDENTITY_PURPOSES })
  @IsIn(IDENTITY_PURPOSES)
  purpose!: IdentityPurpose;

  @ApiProperty({ enum: [IDENTITY_IMAGE_TYPE] })
  @Equals(IDENTITY_IMAGE_TYPE)
  contentType!: typeof IDENTITY_IMAGE_TYPE;

  @ApiProperty({ minimum: 1, maximum: IDENTITY_IMAGE_MAX_BYTES })
  @IsInt()
  @Min(1)
  @Max(IDENTITY_IMAGE_MAX_BYTES)
  bytes!: number;
}

export class IdentityPresignedDto {
  @ApiProperty({ description: 'Pre-signed PUT URL, valid 60 seconds.' })
  url!: string;
  @ApiProperty({ enum: ['PUT'] })
  method!: 'PUT';
  @ApiProperty({ description: 'Send exactly these headers (the signature covers them).' })
  headers!: Record<string, string>;
  @ApiProperty({
    description: 'Single-use name to send back to POST /candidate/session/identity.',
    example: 'identity/1/id-01J9ZZZZZZZZZZZZZZZZZZZZZZ.jpg',
  })
  name!: string;
  @ApiProperty()
  attempt!: number;
  @ApiProperty()
  expiresAt!: string;
}

/** POST /candidate/session/identity: never object keys, only the names the server issued. */
export class SubmitIdentityDto {
  @ApiProperty({ example: 'identity/1/id-01J9ZZZZZZZZZZZZZZZZZZZZZZ.jpg' })
  @Matches(IDENTITY_NAME)
  idImageName!: string;

  @ApiProperty({ example: 'identity/1/selfie-01J9ZZZZZZZZZZZZZZZZZZZZZZ.jpg' })
  @Matches(IDENTITY_NAME)
  selfieName!: string;

  @ApiProperty({
    description:
      'What the browser liveness prompt reported (client-reported, R-05). It can only lead to manual review.',
  })
  @IsBoolean()
  livenessConfirmed!: boolean;
}

export const IDENTITY_STATUSES = [
  'NOT_STARTED',
  'PENDING',
  'PASSED',
  'LOW_CONFIDENCE',
  'MANUAL_REVIEW',
  'REVIEWED',
  'WAIVED',
] as const;
export type IdentityStatusView = (typeof IDENTITY_STATUSES)[number];

/**
 * What the candidate may see: the attempt, the status and whether a retry is open. Never the score,
 * the threshold, the model id or the review reason (NFR-05).
 */
export class IdentityStatusDto {
  @ApiProperty()
  attempt!: number;
  @ApiProperty({ enum: IDENTITY_STATUSES })
  status!: IdentityStatusView;
  @ApiProperty({ description: 'Attempt 1 was LOW_CONFIDENCE and attempt 2 has not been made.' })
  canRetry!: boolean;
}
