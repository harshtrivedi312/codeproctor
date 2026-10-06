import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MAX_MIN_ASSISTANTS } from '@codeproctor/shared';
import { Type } from 'class-transformer';
import { IsInt, IsObject, Max, Min, ValidateIf, ValidateNested } from 'class-validator';
import { CurrentPasswordDto } from '../../auth/dto/auth.dto';

// The global ValidationPipe (whitelist + forbidNonWhitelisted) rejects unknown keys at every level.
// IsOptional would also accept an explicit null, so absence is tested with ValidateIf instead:
// only undefined skips a field, null reaches IsInt / IsObject and is refused.

export class AiReferenceSettingsPatchDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: MAX_MIN_ASSISTANTS })
  @ValidateIf((_o, v) => v !== undefined)
  @IsInt()
  @Min(0)
  @Max(MAX_MIN_ASSISTANTS)
  minAssistants?: number;
}

export class UpdateOrgSettingsDto extends CurrentPasswordDto {
  @ApiPropertyOptional({ type: AiReferenceSettingsPatchDto })
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => AiReferenceSettingsPatchDto)
  aiReferences?: AiReferenceSettingsPatchDto;
}

export class AiReferenceSettingsViewDto {
  @ApiProperty({ minimum: 0, maximum: MAX_MIN_ASSISTANTS, description: 'The effective value.' })
  minAssistants!: number;

  @ApiProperty({ description: 'true when no valid value is stored and the default applies.' })
  isDefault!: boolean;
}

export class OrgSettingsDto {
  @ApiProperty({ type: AiReferenceSettingsViewDto })
  aiReferences!: AiReferenceSettingsViewDto;
}
