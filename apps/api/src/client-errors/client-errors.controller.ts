import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../common/auth/decorators';
import { ClientErrorsService } from './client-errors.service';
import { ClientErrorDto } from './dto/client-error.dto';

// Intentionally @Public() (C-32): candidates have no staff JWT and a crashed page may have no
// session at all. It is not an auth bypass: it reads nothing, returns nothing, writes one scrubbed
// log line, has its own strict per-IP throttle ('client-errors' in app.module.ts) and a 16 KB body
// limit (bootstrap.ts).
@ApiTags('client-errors')
@Public()
@Controller('client-errors')
export class ClientErrorsController {
  constructor(private readonly service: ClientErrorsService) {}

  @Post()
  @HttpCode(204)
  @ApiOperation({ summary: 'Report a browser error to the server log' })
  @ApiNoContentResponse({ description: 'Accepted and logged' })
  @ApiBadRequestResponse({ description: 'Validation failed (problem+json)' })
  @ApiResponse({ status: 413, description: 'Body larger than 16 KB (problem+json)' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded (problem+json)' })
  report(@Body() dto: ClientErrorDto, @Req() req: Request): void {
    const ua = req.headers['user-agent'];
    this.service.record(
      dto,
      typeof ua === 'string' ? ua : undefined,
      typeof req.id === 'string' ? req.id : '',
    );
  }
}
