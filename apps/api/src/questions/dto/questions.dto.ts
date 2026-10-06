import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CODE_LANGUAGES } from '@codeproctor/shared';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Difficulty, QuestionType } from '../../generated/prisma/enums';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const tagNorm = ({ value }: { value: unknown }): unknown =>
  Array.isArray(value)
    ? value.map((v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v))
    : value;
const toBool = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const TAG_PATTERN = /^[a-z0-9][a-z0-9 _.+#-]{0,39}$/;
export const MAX_STATEMENT_LENGTH = 50_000;
export const MAX_TEST_CASES = 100;
export const MAX_TEST_IO_LENGTH = 100_000;

export class LimitsDto {
  @ApiProperty({ minimum: 100, maximum: 10_000, example: 2000 })
  @IsInt()
  @Min(100)
  @Max(10_000)
  cpuMs!: number;

  @ApiProperty({ minimum: 100, maximum: 20_000, example: 5000 })
  @IsInt()
  @Min(100)
  @Max(20_000)
  wallMs!: number;

  @ApiProperty({ minimum: 16_384, maximum: 524_288, example: 262_144 })
  @IsInt()
  @Min(16 * 1024)
  @Max(512 * 1024)
  memoryKb!: number;
}

/** Test slot fields (FR-202). */
export class TestCaseFieldsDto {
  @ApiProperty({ maxLength: MAX_TEST_IO_LENGTH })
  @IsString()
  @MaxLength(MAX_TEST_IO_LENGTH)
  input!: string;

  @ApiProperty({ maxLength: MAX_TEST_IO_LENGTH })
  @IsString()
  @MaxLength(MAX_TEST_IO_LENGTH)
  expectedOutput!: string;

  @ApiPropertyOptional({
    default: true,
    description: 'Hidden tests are never shown to candidates.',
  })
  @IsOptional()
  @IsBoolean()
  isHidden?: boolean;

  @ApiPropertyOptional({ default: 1, minimum: 0.01, maximum: 9999.99 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9999.99)
  weight?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 10_000,
    description: 'Default: after the last slot.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  position?: number;
}

export class UpdateTestCaseDto {
  @ApiPropertyOptional({ maxLength: MAX_TEST_IO_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_TEST_IO_LENGTH)
  input?: string;

  @ApiPropertyOptional({ maxLength: MAX_TEST_IO_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_TEST_IO_LENGTH)
  expectedOutput?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isHidden?: boolean;

  @ApiPropertyOptional({ minimum: 0.01, maximum: 9999.99 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9999.99)
  weight?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 10_000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  position?: number;
}

/** Fields shared by create and update; update makes all of them optional. */
class QuestionContentBase {
  @ApiPropertyOptional({ type: [String], maxItems: 20 })
  @IsOptional()
  @Transform(tagNorm)
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @Matches(TAG_PATTERN, { each: true })
  tags?: string[];

  @ApiPropertyOptional({ enum: CODE_LANGUAGES, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CODE_LANGUAGES.length)
  @IsIn([...CODE_LANGUAGES], { each: true })
  allowedLanguages?: string[];

  @ApiPropertyOptional({ type: LimitsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LimitsDto)
  limits?: LimitsDto;

  @ApiPropertyOptional({
    description: 'Language to starter code. Keys python, javascript, java; 100000 chars each.',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject()
  starterCode?: Record<string, string>;

  @ApiPropertyOptional({
    description: 'Language to reference solution (FR-201). Staff with question:update only.',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject()
  referenceSolution?: Record<string, string>;
}

export class CreateQuestionDto extends QuestionContentBase {
  @ApiPropertyOptional({ enum: QuestionType, default: QuestionType.CODING })
  @IsOptional()
  @IsEnum(QuestionType)
  type?: QuestionType;

  @ApiPropertyOptional({
    description: 'Unique per organization; generated from the title when omitted.',
    maxLength: 80,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  @Matches(SLUG_PATTERN)
  slug?: string;

  @ApiProperty({ minLength: 1, maxLength: 200 })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  title!: string;

  @ApiProperty({ description: 'Markdown.', maxLength: MAX_STATEMENT_LENGTH })
  @IsString()
  @Length(1, MAX_STATEMENT_LENGTH)
  statementMd!: string;

  @ApiProperty({ enum: Difficulty })
  @IsEnum(Difficulty)
  difficulty!: Difficulty;

  @ApiPropertyOptional({
    description:
      'MCQ { options: [{id, text}], correctOptionIds, multiple } or SHORT_ANSWER { canonical, acceptedVariants } (ADR 0007, D-23). Never on CODING.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  answerSpec?: Record<string, unknown>;

  @ApiPropertyOptional({ type: [TestCaseFieldsDto], maxItems: MAX_TEST_CASES })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TEST_CASES)
  @ValidateNested({ each: true })
  @Type(() => TestCaseFieldsDto)
  testCases?: TestCaseFieldsDto[];
}

export class UpdateQuestionDto extends QuestionContentBase {
  @ApiPropertyOptional({ minLength: 1, maxLength: 200 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  title?: string;

  @ApiPropertyOptional({ maxLength: MAX_STATEMENT_LENGTH })
  @IsOptional()
  @IsString()
  @Length(1, MAX_STATEMENT_LENGTH)
  statementMd?: string;

  @ApiPropertyOptional({ enum: Difficulty })
  @IsOptional()
  @IsEnum(Difficulty)
  difficulty?: Difficulty;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  answerSpec?: Record<string, unknown>;
}

export class QuestionListQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 100_000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;

  @ApiPropertyOptional({ description: 'Questions carrying this tag (lower case).' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @Matches(TAG_PATTERN)
  tag?: string;

  @ApiPropertyOptional({
    enum: Difficulty,
    description:
      'Difficulty of the published version, or of the latest draft when never published.',
  })
  @IsOptional()
  @IsEnum(Difficulty)
  difficulty?: Difficulty;

  @ApiPropertyOptional({ enum: QuestionType })
  @IsOptional()
  @IsEnum(QuestionType)
  type?: QuestionType;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  includeArchived?: boolean;
}

export class VersionQueryDto {
  @ApiPropertyOptional({ minimum: 1, description: 'Version number; default the latest.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  version?: number;
}

export class QuestionVersionRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() version!: number;
  @ApiProperty() isPublished!: boolean;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: Difficulty }) difficulty!: Difficulty;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) validatedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export class QuestionSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: QuestionType }) type!: QuestionType;
  @ApiProperty({ type: [String] }) tags!: string[];
  @ApiProperty() isArchived!: boolean;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({
    type: QuestionVersionRefDto,
    nullable: true,
    description: 'The published version tests use; null until the first publish.',
  })
  published!: QuestionVersionRefDto | null;
  @ApiProperty({
    type: QuestionVersionRefDto,
    description: 'Highest version number (maybe a draft).',
  })
  latest!: QuestionVersionRefDto;
}

export class QuestionListDto {
  @ApiProperty({ type: [QuestionSummaryDto] }) items!: QuestionSummaryDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}

export class TestCaseDto {
  @ApiProperty() id!: string;
  @ApiProperty() position!: number;
  @ApiProperty() isHidden!: boolean;
  @ApiProperty() weight!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'null for a hidden case to a caller without question:update.',
  })
  input!: string | null;
  @ApiProperty({ type: String, nullable: true })
  expectedOutput!: string | null;
}

export class QuestionVersionDto extends QuestionVersionRefDto {
  @ApiProperty() statementMd!: string;
  @ApiProperty({ type: [String] }) allowedLanguages!: string[];
  @ApiProperty({ type: LimitsDto }) limits!: LimitsDto;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  starterCode!: Record<string, string>;
  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })
  referenceSolution?: Record<string, string>;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true })
  answerSpec?: Record<string, unknown> | null;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true })
  validationReport?: Record<string, unknown> | null;
  @ApiProperty({ type: [TestCaseDto] }) testCases!: TestCaseDto[];
}

export class QuestionDetailDto extends QuestionSummaryDto {
  @ApiProperty({ type: [QuestionVersionRefDto] }) versions!: QuestionVersionRefDto[];
  @ApiProperty({ type: QuestionVersionDto }) version!: QuestionVersionDto;
  @ApiProperty({
    description: 'true when this PATCH created a new version because the latest was published.',
  })
  createdNewVersion!: boolean;
}

export class CandidateQuestionPreviewDto {
  @ApiProperty({ enum: QuestionType }) type!: QuestionType;
  @ApiProperty() title!: string;
  @ApiProperty() statementMd!: string;
  @ApiProperty({ type: [String] }) languages!: string[];
  @ApiProperty({ type: LimitsDto }) limits!: LimitsDto;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  starterCode!: Record<string, string>;
  @ApiProperty({ type: 'array', items: { type: 'object' } })
  samples!: { input: string; expectedOutput: string }[];
  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  mcq?: { multiple: boolean; options: { id: string; text: string }[] };
}
