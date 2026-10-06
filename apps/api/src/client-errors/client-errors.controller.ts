import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
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
import { ClientErrorRejectionGuard } from './client-error-rejection.guard';
import { ClientErrorsService } from './client-errors.service';
import { ClientErrorDto } from './dto/client-error.dto';

// Intentionally @Public() (C-32): candidates have no staff JWT and a crashed page may have no
// session at all. It is not an auth bypass: it reads nothing, returns nothing, writes one scrubbed
// log line, has its own strict per-IP and whole-instance throttles ('client-errors' and
// 'client-errors-global' in app.module.ts) and a streaming 16 KB body limit with a read
// deadline (client-error-body.middleware.ts). A refused body is answered by
// ClientErrorRejectionGuard after the throttlers, so it counts against them.
@ApiTags('client-errors')
@Public()
@UseGuards(ClientErrorRejectionGuard)
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
