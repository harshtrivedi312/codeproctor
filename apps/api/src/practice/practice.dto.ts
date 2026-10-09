import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { PRACTICE_MAX_CODE_CHARS } from './practice.content';

export class PracticeSampleTestDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() input!: string;
  @ApiProperty() expectedOutput!: string;
}

export class PracticeQuestionDto {
  @ApiProperty() title!: string;
  @ApiProperty() statementMarkdown!: string;
  @ApiProperty({ type: [String], example: ['python'] }) languages!: string[];
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  starterCode!: Record<string, string>;
  @ApiProperty({ type: [PracticeSampleTestDto] }) sampleTests!: PracticeSampleTestDto[];
}

export class PracticeRunDto {
  @ApiProperty({ example: 'python', description: 'One of the practice question languages' })
  @IsString()
  @Length(1, 32)
  language!: string;

  @ApiProperty({ maxLength: PRACTICE_MAX_CODE_CHARS })
  @IsString()
  @Length(1, PRACTICE_MAX_CODE_CHARS)
  code!: string;
}

export class PracticeTestResultDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['passed', 'failed'] }) status!: 'passed' | 'failed';
  @ApiPropertyOptional() input?: string;
  @ApiPropertyOptional() expectedOutput?: string;
  @ApiPropertyOptional() actualOutput?: string;
  @ApiPropertyOptional() durationMs?: number;
}

export class PracticeRunResultDto {
  @ApiProperty({ enum: ['completed', 'compile_error', 'runtime_error', 'time_limit_exceeded'] })
  outcome!: 'completed' | 'compile_error' | 'runtime_error' | 'time_limit_exceeded';

  @ApiProperty({
    type: [PracticeTestResultDto],
    description: 'Empty when stub is true: nothing ran, so there is no pass or fail',
  })
  tests!: PracticeTestResultDto[];

  @ApiProperty() stdout!: string;
  @ApiProperty() stderr!: string;

  @ApiPropertyOptional({
    enum: [true],
    description: 'Present only for the local development stub: not real execution (DL-58)',
  })
  stub?: true;
  @ApiPropertyOptional({ description: 'Present with stub: "local stub, not real execution"' })
  message?: string;
}
