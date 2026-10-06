import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsObject,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateBy,
  ValidateIf,
} from 'class-validator';
import type { ValidationArguments } from 'class-validator';
import { isStorableText } from '../text-rules';
import { paramsProblems } from '../variant-template';
import type { ParamValue } from '../variant-template';
import { MAX_TEST_IO_LENGTH, VariantDto, VersionParamDto } from './questions.dto';

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
/** Flat scalar params with safe names and bounded size (variant-template.ts). */
const VariantParams = (): PropertyDecorator =>
  ValidateBy({
    name: 'variantParams',
    validator: {
      validate: (v: unknown) => paramsProblems(v).length === 0,
      defaultMessage: (a?: ValidationArguments) => `params: ${paramsProblems(a?.value).join('; ')}`,
    },
  });

export const MAX_VARIANTS = 50;
const REVISION_PATTERN = /^[0-9a-f]{64}$/;

const REVISION_DOC =
  'The `revision` of the version as the client loaded it; 409 when it no longer matches.';

export class CreateVariantDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
    description:
      'Flat parameters for the {{name}} placeholders of the statement, starter code and reference solution. Names: letters, digits, underscore; at most 50; strings up to 1000 characters.',
  })
  @IsObject()
  @VariantParams()
  params!: Record<string, ParamValue>;

  @ApiPropertyOptional({ default: true })
  @Opt()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: REVISION_DOC })
  @Opt()
  @IsString()
  @Matches(REVISION_PATTERN)
  expectedRevision?: string;
}

export class UpdateVariantDto {
  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @Opt()
  @IsObject()
  @VariantParams()
  params?: Record<string, ParamValue>;

  @ApiPropertyOptional()
  @Opt()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: REVISION_DOC })
  @Opt()
  @IsString()
  @Matches(REVISION_PATTERN)
  expectedRevision?: string;
}

export class VariantOverrideFieldsDto {
  @ApiProperty({ maxLength: MAX_TEST_IO_LENGTH })
  @IsString()
  @MaxLength(MAX_TEST_IO_LENGTH)
  @SafeText()
  input!: string;

  @ApiProperty({ maxLength: MAX_TEST_IO_LENGTH })
  @IsString()
  @MaxLength(MAX_TEST_IO_LENGTH)
  @SafeText()
  expectedOutput!: string;

  @ApiPropertyOptional({ description: REVISION_DOC })
  @Opt()
  @IsString()
  @Matches(REVISION_PATTERN)
  expectedRevision?: string;
}

/** For the DELETE routes, which carry no body. */
export class RevisionQueryDto {
  @ApiPropertyOptional({ description: REVISION_DOC })
  @Opt()
  @IsString()
  @Matches(REVISION_PATTERN)
  expectedRevision?: string;
}

export class VariantParamDto extends VersionParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  variantId!: string;
}

export class VariantTestCaseParamDto extends VariantParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  testCaseId!: string;
}

export class VariantListDto {
  @ApiProperty({ type: [VariantDto] }) items!: VariantDto[];
  @ApiProperty({ description: 'Revision of the version; send it back as expectedRevision.' })
  revision!: string;
}

export class VariantMutationDto {
  @ApiProperty({ type: VariantDto }) variant!: VariantDto;
  @ApiProperty({ description: 'The new revision of the version.' }) revision!: string;
}
