import { ApiProperty } from '@nestjs/swagger';
import { MAX_MIN_ASSISTANTS } from '../ai-reference-rules';

/** The org's AI reference policy, read-only for authors (ADR 0005 AI-4, AI-5). */
export class AiPolicyDto {
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: MAX_MIN_ASSISTANTS,
    description: 'Assistants required per language to publish; 0 is off.',
  })
  minAssistants!: number;

  @ApiProperty({ description: 'True when the org has no valid setting and the default applies.' })
  isDefault!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'AI-4 refresh interval in days; null until the setting is implemented.',
  })
  refreshIntervalDays!: number | null;
}
