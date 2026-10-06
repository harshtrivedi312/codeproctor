import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, MaxLength, ValidateBy, ValidateIf } from 'class-validator';
import { isStorableText } from '../../questions/text-rules';

/** Like @IsOptional(), but only `undefined` skips validation: an explicit null is a 400. */
const Opt = (): PropertyDecorator => ValidateIf((_o: unknown, v: unknown) => v !== undefined);
const SafeText = (): PropertyDecorator =>
  ValidateBy({
    name: 'safeText',
    validator: {
      validate: (v: unknown) => typeof v !== 'string' || isStorableText(v),
      defaultMessage: () => '$property contains a NUL byte or a lone surrogate',
    },
  });

/**
 * Display safety in the staff UI: single-line text without C0/C1 controls (newline and tab
 * included), bidi overrides and isolates, or the Arabic letter mark.
 */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects
const UNSAFE_DISPLAY = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const DisplaySafe = (): PropertyDecorator =>
  ValidateBy({
    name: 'displaySafe',
    validator: {
      validate: (v: unknown) => typeof v !== 'string' || !UNSAFE_DISPLAY.test(v),
      defaultMessage: () => '$property contains a control or bidirectional override character',
    },
  });

/** Date-time with an explicit UTC offset (Z or +hh:mm): no local-time guessing on the server. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
export const parseInstant = (v: unknown): Date | null => {
  if (typeof v !== 'string' || v.length > 40 || !ISO_INSTANT.test(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const IsInstant = (): PropertyDecorator =>
  ValidateBy({
    name: 'isInstant',
    validator: {
      validate: (v: unknown) => parseInstant(v) !== null,
      defaultMessage: () => '$property must be an ISO 8601 date-time with a UTC offset',
    },
  });

/** No quoted local part and no UTF-8 local part: plain ASCII atoms only. */
const PlainLocalPart = (): PropertyDecorator =>
  ValidateBy({
    name: 'plainLocalPart',
    validator: {
      validate: (v: unknown) => typeof v !== 'string' || /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@/i.test(v),
      defaultMessage: () => '$property must not use a quoted or non-ASCII local part',
    },
  });

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const trimLower = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export const MAX_EMAIL_LENGTH = 254;
export const MAX_FULL_NAME_LENGTH = 200;
export const MAX_EXTERNAL_REF_LENGTH = 100;

export class CreateInvitationDto {
  @ApiProperty({ maxLength: MAX_EMAIL_LENGTH, description: 'Stored lower-case.' })
  @Transform(trimLower)
  @IsString()
  @MaxLength(MAX_EMAIL_LENGTH)
  @IsEmail({ allow_utf8_local_part: false })
  @DisplaySafe()
  @PlainLocalPart()
  email!: string;

  @ApiProperty({ minLength: 1, maxLength: MAX_FULL_NAME_LENGTH })
  @Transform(trim)
  @IsString()
  @Length(1, MAX_FULL_NAME_LENGTH)
  @SafeText()
  @DisplaySafe()
  fullName!: string;

  @ApiPropertyOptional({
    maxLength: MAX_EXTERNAL_REF_LENGTH,
    description: 'Your own reference (for example an ATS id). Kept only for a new candidate.',
  })
  @Opt()
  @Transform(trim)
  @IsString()
  @Length(1, MAX_EXTERNAL_REF_LENGTH)
  @SafeText()
  @DisplaySafe()
  externalRef?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'ISO 8601 with a UTC offset. Default: the server time now.',
  })
  @Opt()
  @IsInstant()
  windowStart?: string;

  @ApiProperty({
    format: 'date-time',
    description:
      'ISO 8601 with a UTC offset. After windowStart and after now (server time), at most INVITATION_MAX_WINDOW_DAYS (default 7) after windowStart.',
  })
  @IsInstant()
  windowEnd!: string;
}

export const MAIL_OUTCOMES = ['queued', 'failed', 'disabled'] as const;
export type MailOutcomeDto = (typeof MAIL_OUTCOMES)[number];

export class InvitationCreatedDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) testId!: string;
  @ApiProperty({ format: 'uuid' }) candidateId!: string;
  @ApiProperty({ format: 'date-time' }) windowStart!: string;
  @ApiProperty({ format: 'date-time' }) windowEnd!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({
    enum: MAIL_OUTCOMES,
    description:
      'queued: accepted for delivery (not proof of delivery). failed: the mail could not be queued, the invitation still exists. disabled: no mail provider is configured.',
  })
  mail!: MailOutcomeDto;
}
