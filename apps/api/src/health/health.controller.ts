import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../common/auth/decorators';
import { SkipThrottle } from '@nestjs/throttler';
import { HealthService } from './health.service';
import type { HealthReport } from './health.service';

// Public liveness/readiness probe for uptime alerts (NFR-09). It exposes only up/down per
// dependency, never hostnames, versions or error text. It is explicitly @Public() (FU-BE-04).
@ApiTags('health')
@Public()
@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Check Postgres and Redis connectivity' })
  @ApiOkResponse({ description: 'All dependencies reachable' })
  @ApiServiceUnavailableResponse({ description: 'A dependency is down (problem+json)' })
  async get(): Promise<HealthReport> {
    const report = await this.health.check();
    if (report.status !== 'ok') {
      const down = Object.entries(report.checks)
        .filter(([, state]) => state === 'down')
        .map(([name]) => name);
      throw new ServiceUnavailableException(`Unavailable: ${down.join(', ')}`);
    }
    return report;
  }
}
