import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  ArrayMaxSize,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';

/** The invitation token is 32 random bytes as base64url (43 characters); bounds are generous. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

export class LinkDto {
  @ApiProperty({ writeOnly: true, description: 'The token from the invitation link' })
  @IsString()
  @Matches(TOKEN_PATTERN)
  invitationToken!: string;
}

export class StartSessionDto extends LinkDto {
  @ApiProperty({ example: '123456', writeOnly: true, description: '6-digit code from the email' })
  @IsString()
  @Matches(/^\d{6}$/)
  otp!: string;
}

export class SignConsentDto {
  @ApiProperty({ format: 'uuid', description: 'The consent document the page showed (GET consent)' })
  @IsUUID()
  consentTextId!: string;

  @ApiProperty({ minLength: 2, maxLength: 200, description: 'Full legal name, typed' })
  @IsString()
  @Length(2, 200)
  signedName!: string;

  @ApiProperty({ description: 'Must be true: the candidate confirms being 18 or older (C-30)' })
  @IsBoolean()
  confirmedAge18!: boolean;
}

/** Optional health block the SDK sends with a beat (ADR 0013 section 5.3). */
export class HeartbeatDto {
  @ApiPropertyOptional({ type: 'array', items: { type: 'object' }, maxItems: 32 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  capabilities?: unknown[];

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  recorder?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  queue?: Record<string, unknown>;
}

// ---- responses ----

export class LinkViewDto {
  @ApiProperty({ enum: ['OTP_REQUIRED', 'ALREADY_USED', 'EXPIRED', 'DECLINED', 'BLOCKED', 'NOT_YET_OPEN'] })
  state!: string;
  @ApiProperty() orgName!: string;
  @ApiProperty({ nullable: true, description: 'DECLINED only: contact for alternatives or accommodations' })
  declineContact!: string | null;
  @ApiProperty({ nullable: true, description: 'BLOCKED or NOT_YET_OPEN: seconds to wait' })
  retryAfterSeconds!: number | null;
  @ApiProperty({ format: 'date-time' }) windowStart!: string;
  @ApiProperty({ format: 'date-time' }) windowEnd!: string;
}

export class OtpSentDto {
  @ApiProperty({ enum: ['OTP_SENT', 'OTP_REQUIRED', 'ALREADY_USED', 'EXPIRED', 'DECLINED', 'BLOCKED', 'NOT_YET_OPEN'] })
  state!: string;
  @ApiProperty({ nullable: true, example: 'a***@example.com' }) maskedEmail!: string | null;
  @ApiProperty({ example: 600 }) expiresInSeconds!: number;
  @ApiProperty({ nullable: true }) retryAfterSeconds!: number | null;
  @ApiProperty({ nullable: true }) declineContact!: string | null;
}

export class SessionTokenDto {
  @ApiProperty({ description: 'Candidate session JWT; keep it in memory. Renewed by the heartbeat.' })
  sessionToken!: string;
  @ApiProperty({ format: 'date-time' }) sessionTokenExpiresAt!: string;
  @ApiProperty({ enum: ['OPENED', 'CONSENTED', 'VERIFIED', 'IN_PROGRESS', 'PAUSED'] }) status!: string;
  @ApiProperty({ format: 'date-time' }) serverTime!: string;
}

export class ConsentDocumentDto {
  @ApiProperty({ format: 'uuid' }) consentTextId!: string;
  @ApiProperty() version!: string;
  @ApiProperty({ description: 'Markdown. Render as text; never as HTML.' }) bodyMd!: string;
  @ApiProperty({ description: 'False for a placeholder text (not for real candidates)' }) legalApproved!: boolean;
  @ApiProperty() signed!: boolean;
  @ApiProperty({ nullable: true, format: 'date-time' }) signedAt!: string | null;
}

export class ConsentSignedDto {
  @ApiProperty({ enum: ['CONSENTED'] }) status!: string;
  @ApiProperty({ format: 'date-time', description: 'Server time of the signature' }) signedAt!: string;
}

export class ConsentDeclinedDto {
  @ApiProperty({ enum: ['DECLINED'] }) status!: string;
  @ApiProperty({ nullable: true }) declineContact!: string | null;
}

export class SessionStateDto {
  @ApiProperty({ format: 'date-time' }) serverTime!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ nullable: true, format: 'date-time' }) startedAt!: string | null;
  @ApiProperty({ nullable: true, format: 'date-time' }) deadlineAt!: string | null;
  @ApiProperty({ nullable: true, format: 'date-time' }) sectionDeadlineAt!: string | null;
  @ApiProperty({ type: [String] }) pauseReasons!: string[];
}

export class HeartbeatResultDto extends SessionStateDto {
  @ApiPropertyOptional({ description: 'Present only when the server renews the token' })
  sessionToken?: string;
  @ApiPropertyOptional({ format: 'date-time' }) sessionTokenExpiresAt?: string;
}

class StartedQuestionDto {
  @ApiProperty({ format: 'uuid' }) sessionQuestionId!: string;
  @ApiProperty() position!: number;
  @ApiProperty({ description: 'Decimal string' }) points!: string;
}

class StartedSectionDto {
  @ApiProperty() position!: number;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true, description: 'After accommodations; null = shares the session time' })
  timeLimitMs!: number | null;
  @ApiProperty({ nullable: true, format: 'date-time' }) startedAt!: string | null;
  @ApiProperty({ nullable: true, format: 'date-time' }) deadlineAt!: string | null;
  @ApiProperty({ type: [StartedQuestionDto] }) questions!: StartedQuestionDto[];
}

export class TestStartedDto {
  @ApiProperty({ enum: ['IN_PROGRESS', 'PAUSED'] }) status!: string;
  @ApiProperty({ format: 'date-time' }) serverTime!: string;
  @ApiProperty({ format: 'date-time' }) startedAt!: string;
  @ApiProperty({ format: 'date-time', description: 'Server deadline; the client clock never decides' })
  deadlineAt!: string;
  @ApiProperty({ type: [StartedSectionDto] }) sections!: StartedSectionDto[];
}

class MediaCounterDto {
  @ApiProperty() nextSeq!: number;
  @ApiProperty() nextSegment!: number;
}

class MediaCountersDto {
  @ApiProperty({ type: MediaCounterDto }) SCREEN!: MediaCounterDto;
  @ApiProperty({ type: MediaCounterDto }) WEBCAM!: MediaCounterDto;
  @ApiProperty({ type: MediaCounterDto }) AUDIO!: MediaCounterDto;
}

class CountersDto {
  @ApiProperty() eventSeqStart!: number;
  @ApiProperty() keystrokeSeqStart!: number;
  @ApiProperty({ type: MediaCountersDto }) media!: MediaCountersDto;
}

export class ProctorKeyDto {
  @ApiProperty({ enum: ['HMAC-SHA256'] }) alg!: string;
  @ApiProperty({ description: 'Base64, 32 bytes. Returned once per auth epoch; never log it.' }) key!: string;
  @ApiProperty() keyEpoch!: number;
  @ApiProperty({ type: CountersDto }) counters!: CountersDto;
}
