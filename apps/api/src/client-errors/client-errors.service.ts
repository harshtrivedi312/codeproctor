import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { scrubClientText, scrubClientUrl } from '../common/scrub-client-text';
import type { ClientErrorDto } from './dto/client-error.dto';

const USER_AGENT_MAX = 200;

/**
 * Writes one structured log line per browser error report (C-32). It never touches the database
 * or Redis, writes no audit row, and logs no IP, headers or raw body: only scrubbed fields.
 */
@Injectable()
export class ClientErrorsService {
  constructor(@InjectPinoLogger(ClientErrorsService.name) private readonly logger: PinoLogger) {}

  record(dto: ClientErrorDto, userAgent: string | undefined, traceId: string): void {
    const level = dto.level ?? 'error';
    const line = {
      event: 'client_error',
      traceId,
      reportedLevel: level,
      message: scrubClientText(dto.message, 1000),
      stack: dto.stack === undefined ? undefined : scrubClientText(dto.stack, 8000),
      name: dto.name === undefined ? undefined : scrubClientText(dto.name, 100),
      url: dto.url === undefined ? undefined : scrubClientUrl(dto.url, 500),
      component: dto.component === undefined ? undefined : scrubClientText(dto.component, 200),
      route: dto.route === undefined ? undefined : scrubClientText(dto.route, 200),
      release: dto.release === undefined ? undefined : scrubClientText(dto.release, 100),
      userAgent: userAgent === undefined ? undefined : scrubClientText(userAgent, USER_AGENT_MAX),
    };
    if (level === 'warn') this.logger.warn(line, 'client_error');
    else this.logger.error(line, 'client_error');
  }
}
