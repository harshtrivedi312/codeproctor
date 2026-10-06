import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Difficulty, ProctorProfile, QuestionType } from '../../generated/prisma/enums';
import { parseRandomRule } from '../random-rule';
import {
  MAX_DURATION_MIN,
  MAX_POINTS,
  MAX_QUESTIONS_PER_SECTION,
  MAX_SECTIONS,
  MIN_DURATION_MIN,
  PROFILES_OFFERED,
} from '../test-structure';
import { isStorableText } from '../text-rules';

/** Like @IsOptional(), but only `undefined` skips validation: an explicit null is a 400. */
const Opt = (): PropertyDecorator => ValidateIf((_o: unknown, v: unknown) => v !== undefined);
/** Rejects NUL bytes and lone surrogates, which Postgres cannot store (would be a 500). */
const SafeText = (): PropertyDecorator =>
  ValidateBy({
    name: 'safeText',
    validator: {
      validate: (v: unknown) => typeof v !== 'string' || isStorableText(v),
      defaultMessage: () => '$property contains a NUL byte or a lone surrogate',
    },
  });
const RandomRuleShape = (): PropertyDecorator =>
  ValidateBy({
    name: 'randomRule',
    validator: {
      validate: (v: unknown) => parseRandomRule(v).ok,
      defaultMessage: (args) => {
        const r = parseRandomRule(args?.value);
        return r.ok ? '' : `randomRule is invalid: ${r.problems.join('; ')}`;
      },
    },
  });

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const toBool = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

export const MAX_NAME_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 5000;
export const MAX_SECTION_TITLE_LENGTH = 200;

export class TestQuestionInputDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'A fixed question: a PUBLISHED version of a non-archived question of your organization. Exactly one of questionVersionId and randomRule.',
  })
  @Opt()
  @IsUUID()
  questionVersionId?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: false,
    description:
      'A random pick: exactly { tags?: string[] (all must match, 1 to 20), difficulty?, type? }. Unknown keys are refused. It must match at least one published, non-archived question of your organization now.',
    properties: {
      tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
      difficulty: { type: 'string', enum: Object.values(Difficulty) },
      type: { type: 'string', enum: Object.values(QuestionType) },
    },
  })
  @Opt()
  @IsObject()
  @RandomRuleShape()
  randomRule?: Record<string, unknown>;

  @ApiPropertyOptional({ default: 100, minimum: 0.01, maximum: MAX_POINTS })
  @Opt()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_POINTS)
  points?: number;

  @ApiPropertyOptional({
    minimum: 1,
    description: 'Position in the section, from 1 without gaps. Default: the array order.',
  })
  @Opt()
  @IsInt()
  @Min(1)
  @Max(MAX_QUESTIONS_PER_SECTION)
  position?: number;
}

export class TestSectionInputDto {
  @ApiProperty({ minLength: 1, maxLength: MAX_SECTION_TITLE_LENGTH })
  @Transform(trim)
  @IsString()
  @Length(1, MAX_SECTION_TITLE_LENGTH)
  @SafeText()
  title!: string;

  @ApiPropertyOptional({
    minimum: 1,
    description:
      'Position in the test, from 1 without gaps. Default: the array order. Give it on all sections or none.',
  })
  @Opt()
  @IsInt()
  @Min(1)
  @Max(MAX_SECTIONS)
  position?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_DURATION_MIN,
    description:
      'Section time limit in minutes. All limits together may not exceed durationMinutes (ADR 0002).',
  })
  @Opt()
  @IsInt()
  @Min(1)
  @Max(MAX_DURATION_MIN)
  timeLimitMin?: number;

  @ApiProperty({ type: [TestQuestionInputDto], minItems: 1, maxItems: MAX_QUESTIONS_PER_SECTION })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_QUESTIONS_PER_SECTION)
  @ValidateNested({ each: true })
  @Type(() => TestQuestionInputDto)
  questions!: TestQuestionInputDto[];
}

/** Fields shared by create and update; update makes all of them optional. */
class TestFieldsBase {
  @ApiPropertyOptional({
    description:
      'STANDARD (web) or STRICT (web + second camera). LOCKDOWN is not offered (FR-302).',
    enum: PROFILES_OFFERED,
    default: 'STANDARD',
  })
  @Opt()
  @IsIn([...PROFILES_OFFERED])
  profile?: ProctorProfile;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: MAX_POINTS,
    description: 'From 0 to the points of all questions together.',
  })
  @Opt()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_POINTS)
  passScore?: number;

  @ApiPropertyOptional({ maxLength: MAX_DESCRIPTION_LENGTH })
  @Opt()
  @IsString()
  @MaxLength(MAX_DESCRIPTION_LENGTH)
  @SafeText()
  description?: string;
}

export class CreateTestDto extends TestFieldsBase {
  @ApiProperty({ minLength: 1, maxLength: MAX_NAME_LENGTH })
  @Transform(trim)
  @IsString()
  @Length(1, MAX_NAME_LENGTH)
  @SafeText()
  name!: string;

  @ApiProperty({ minimum: MIN_DURATION_MIN, maximum: MAX_DURATION_MIN })
  @IsInt()
  @Min(MIN_DURATION_MIN)
  @Max(MAX_DURATION_MIN)
  durationMinutes!: number;

  @ApiProperty({ type: [TestSectionInputDto], minItems: 1, maxItems: MAX_SECTIONS })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SECTIONS)
  @ValidateNested({ each: true })
  @Type(() => TestSectionInputDto)
  sections!: TestSectionInputDto[];
}

export class UpdateTestDto extends TestFieldsBase {
  @ApiPropertyOptional({ minLength: 1, maxLength: MAX_NAME_LENGTH })
  @Opt()
  @Transform(trim)
  @IsString()
  @Length(1, MAX_NAME_LENGTH)
  @SafeText()
  name?: string;

  @ApiPropertyOptional({ minimum: MIN_DURATION_MIN, maximum: MAX_DURATION_MIN })
  @Opt()
  @IsInt()
  @Min(MIN_DURATION_MIN)
  @Max(MAX_DURATION_MIN)
  durationMinutes?: number;

  @ApiPropertyOptional({
    type: [TestSectionInputDto],
    description:
      'Replaces ALL sections and questions of the test. Only while the test has no invitation or session (409 otherwise).',
  })
  @Opt()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SECTIONS)
  @ValidateNested({ each: true })
  @Type(() => TestSectionInputDto)
  sections?: TestSectionInputDto[];
}

export class TestIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id!: string;
}

export class TestListQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 100_000 })
  @Opt()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Opt()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;

  @ApiPropertyOptional({ description: 'Part of the name, case-insensitive.', maxLength: 100 })
  @Opt()
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  @SafeText()
  search?: string;

  @ApiPropertyOptional({ enum: PROFILES_OFFERED })
  @Opt()
  @IsIn([...PROFILES_OFFERED])
  profile?: ProctorProfile;

  @ApiPropertyOptional({
    description:
      'true: only tests that already have invitations; false: only tests that have none.',
  })
  @Opt()
  @Transform(toBool)
  @IsBoolean()
  used?: boolean;
}

// ---- responses ---------------------------------------------------------------------------------

export class TestQuestionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() position!: number;
  @ApiProperty() points!: number;
  @ApiProperty({ format: 'uuid', nullable: true }) questionVersionId!: string | null;
  @ApiProperty({ nullable: true, description: 'Title of the fixed version.' })
  title!: string | null;
  @ApiProperty({ enum: Difficulty, nullable: true }) difficulty!: Difficulty | null;
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  randomRule!: Record<string, unknown> | null;
}

export class TestSectionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() position!: number;
  @ApiProperty({ nullable: true }) timeLimitMin!: number | null;
  @ApiProperty({ type: [TestQuestionDto] }) questions!: TestQuestionDto[];
}

export class TestSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty() durationMinutes!: number;
  @ApiProperty({ enum: ProctorProfile }) profile!: ProctorProfile;
  @ApiProperty({ nullable: true }) passScore!: number | null;
  @ApiProperty({ format: 'uuid', nullable: true }) createdById!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() sectionCount!: number;
  @ApiProperty() questionCount!: number;
  @ApiProperty({
    description: 'The test has an invitation or session: it can no longer be edited.',
  })
  used!: boolean;
}

export class TestDetailDto extends TestSummaryDto {
  @ApiProperty({ type: [TestSectionDto] }) sections!: TestSectionDto[];
}

export class TestListDto {
  @ApiProperty({ type: [TestSummaryDto] }) items!: TestSummaryDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}
