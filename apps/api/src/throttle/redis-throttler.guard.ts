import { ServiceUnavailableException } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';
import { ThrottleBackendUnavailableError } from './redis-throttler-storage';

// Redis down: answer 503 (same convention as the other Redis-dependent routes) instead of a 500
// or, worse, letting traffic through unthrottled. /health is @SkipThrottle() so it never lands here.
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    try {
      return await super.handleRequest(requestProps);
    } catch (e) {
      if (e instanceof ThrottleBackendUnavailableError) {
        throw new ServiceUnavailableException('Service is temporarily unavailable.');
      }
      throw e;
    }
  }
}
