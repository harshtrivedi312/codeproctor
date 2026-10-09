import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsString,
  IsUUID,
  Length,
  ValidateBy,
  ValidateIf,
} from 'class-validator';
import { Verdict } from '../../generated/prisma/enums';
import { isStorableText } from '../../questions/text-rules';

export const MAX_ANSWER_NOTE = 1000;
export const MAX_VERDICT_NOTE = 2000;

/**
 * Staff free text shown in the review workspace: newline and tab are allowed, every other C0/C1
 * control, bidi override or isolate and the Arabic letter mark is refused, and so are NUL and lone
 * surrogates (Postgres cannot store them).
 */
const UNSAFE = new RegExp(
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects
  '[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]',
);
const ReviewText = (): PropertyDecorator =>
  ValidateBy({
    name: 'reviewText',
    validator: {
      validate: (v: unknown) => typeof v !== 'string' || (isStorableText(v) && !UNSAFE.test(v)),
      defaultMessage: () => '$property contains a control or bidirectional override character',
    },
  });

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class ScoreParamsDto {
  @IsUUID() sessionId!: string;
  @IsUUID() sessionQuestionId!: string;
}

export class ScoreAnswerDto {
  @ApiProperty({ description: 'true gives the question its full points, false gives 0.' })
  @IsBoolean()
  correct!: boolean;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: MAX_ANSWER_NOTE,
    description: 'Kept with the decision and shown in the review bundle; never in the audit row.',
  })
  @ValidateIf((o: { note?: unknown }) => o.note !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, MAX_ANSWER_NOTE)
  @ReviewText()
  note?: string;
}

export class ScoredAnswerDto {
  @ApiProperty({ format: 'uuid' }) sessionQuestionId!: string;
  @ApiProperty() correct!: boolean;
  @ApiProperty({ description: 'numeric(6,2) as a JSON number' }) score!: number;
}

export class SetVerdictDto {
  @ApiProperty({ enum: Verdict })
  @IsEnum(Verdict)
  verdict!: Verdict;

  @ApiPropertyOptional({ minLength: 1, maxLength: MAX_VERDICT_NOTE })
  @ValidateIf((o: { note?: unknown }) => o.note !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, MAX_VERDICT_NOTE)
  @ReviewText()
  note?: string;
}

export class ReviewVerdictDto {
  @ApiProperty({ enum: Verdict, nullable: true }) verdict!: Verdict | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) completedAt!: string | null;
}
