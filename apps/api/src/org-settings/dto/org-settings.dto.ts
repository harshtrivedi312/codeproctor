import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsObject, Max, Min, ValidateIf, ValidateNested } from 'class-validator';

// The global ValidationPipe (whitelist + forbidNonWhitelisted) rejects unknown keys at every level.
// IsOptional would also accept an explicit null, so absence is tested with ValidateIf instead:
// only undefined skips a field, null reaches IsInt / IsObject and is refused.
export const MIN_ASSISTANTS_MAX = 5;

export class AiReferenceSettingsPatchDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: MIN_ASSISTANTS_MAX })
  @ValidateIf((_o, v) => v !== undefined)
  @IsInt()
  @Min(0)
  @Max(MIN_ASSISTANTS_MAX)
  minAssistants?: number;
}

export class UpdateOrgSettingsDto {
  @ApiPropertyOptional({ type: AiReferenceSettingsPatchDto })
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => AiReferenceSettingsPatchDto)
  aiReferences?: AiReferenceSettingsPatchDto;
}

export class AiReferenceSettingsViewDto {
  @ApiProperty({ minimum: 0, maximum: 10, description: 'The effective value.' })
  minAssistants!: number;

  @ApiProperty({ description: 'true when no valid value is stored and the default applies.' })
  isDefault!: boolean;
}

export class OrgSettingsDto {
  @ApiProperty({ type: AiReferenceSettingsViewDto })
  aiReferences!: AiReferenceSettingsViewDto;
}
