import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export const CLIENT_ERROR_LEVELS = ['error', 'warn'] as const;
export type ClientErrorLevel = (typeof CLIENT_ERROR_LEVELS)[number];

/** A browser error report (C-32). Never put user data in it: the server scrubs, but do not rely on it. */
export class ClientErrorDto {
  @ApiProperty({ maxLength: 1000, example: 'Cannot read properties of undefined' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  message!: string;

  @ApiPropertyOptional({ maxLength: 8000 })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  stack?: string;

  @ApiPropertyOptional({ maxLength: 100, example: 'TypeError' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    maxLength: 2000,
    description: 'Page URL; the query and fragment are dropped.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  url?: string;

  @ApiPropertyOptional({ maxLength: 200, example: 'CodeEditor' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  component?: string;

  @ApiPropertyOptional({ maxLength: 200, example: '/candidate/session/[id]' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  route?: string;

  @ApiPropertyOptional({ maxLength: 100, example: 'web@1.4.2' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  release?: string;

  @ApiPropertyOptional({ enum: CLIENT_ERROR_LEVELS, default: 'error' })
  @IsOptional()
  @IsIn(CLIENT_ERROR_LEVELS)
  level?: ClientErrorLevel;
}
