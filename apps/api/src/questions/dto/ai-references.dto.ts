import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CODE_LANGUAGES } from '@codeproctor/shared';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsString,
  IsUUID,
  MaxLength,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { isStorableText } from '../text-rules';
import { MAX_CODE_LENGTH } from '../question-content';
import { VersionParamDto } from './questions.dto';

const Opt = (): PropertyDecorator => ValidateIf((_o: unknown, v: unknown) => v !== undefined);
const SafeText = (): PropertyDecorator =>
  ValidateBy({
    name: 'safeText',
    validator: {
      validate: (v: unknown) => typeof v !== 'string' || isStorableText(v),
      defaultMessage: () => '$property contains a NUL byte or a lone surrogate',
    },
  });
const NotBlank = (): PropertyDecorator =>
  ValidateBy({
    name: 'notBlank',
    validator: {
      validate: (v: unknown) => typeof v === 'string' && v.trim() !== '',
      defaultMessage: () => '$property must not be blank',
    },
  });

export const MAX_PROMPT_LENGTH = 20_000;

export class AiReferenceParamDto extends VersionParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  aiReferenceId!: string;
}

export class CreateAiReferenceDto {
  @ApiProperty({ maxLength: 100, description: 'Assistant product name, for example ChatGPT.' })
  @IsString()
  @NotBlank()
  @MaxLength(100)
  @SafeText()
  assistant!: string;

  @ApiProperty({ maxLength: 100, description: 'Model or version label as the assistant shows it.' })
  @IsString()
  @NotBlank()
  @MaxLength(100)
  @SafeText()
  modelLabel!: string;

  @ApiProperty({ enum: CODE_LANGUAGES })
  @IsIn(CODE_LANGUAGES)
  language!: string;

  @ApiProperty({ maxLength: MAX_CODE_LENGTH })
  @IsString()
  @IsNotEmpty()
  @NotBlank()
  @MaxLength(MAX_CODE_LENGTH)
  @SafeText()
  solutionCode!: string;

  @ApiPropertyOptional({ maxLength: MAX_PROMPT_LENGTH })
  @Opt()
  @IsString()
  @MaxLength(MAX_PROMPT_LENGTH)
  @SafeText()
  promptText?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'A variant of this version the solution was collected for; absent: the base statement.',
  })
  @Opt()
  @IsUUID()
  variantId?: string;
}

export class SupersedeAiReferenceDto {
  @ApiPropertyOptional({
    type: () => CreateAiReferenceDto,
    description:
      'The row that replaces this one (a refresh). Inserted in the same transaction; absent: the row is only retired.',
  })
  @Opt()
  @IsObject()
  @ValidateNested()
  @Type(() => CreateAiReferenceDto)
  replacement?: CreateAiReferenceDto;
}

export class AiReferenceDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) variantId!: string | null;
  @ApiProperty() assistant!: string;
  @ApiProperty() modelLabel!: string;
  @ApiProperty({ enum: CODE_LANGUAGES }) language!: string;
  @ApiProperty() solutionCode!: string;
  @ApiProperty({ nullable: true, type: String }) promptText!: string | null;
  @ApiProperty({ format: 'date-time', description: 'Server time of the insert.' })
  collectedAt!: string;
  @ApiProperty({ format: 'uuid' }) collectedById!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) supersededAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class AiReferenceListDto {
  @ApiProperty({ type: [AiReferenceDto] }) items!: AiReferenceDto[];
}

export class SupersedeResultDto {
  @ApiProperty({ type: AiReferenceDto }) superseded!: AiReferenceDto;
  @ApiProperty({ type: AiReferenceDto, nullable: true }) replacement!: AiReferenceDto | null;
}
