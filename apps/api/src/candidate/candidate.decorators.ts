import {
  applyDecorators,
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/auth/decorators';
import { CandidateContextInterceptor } from './candidate-context.interceptor';
import { CandidateSessionGuard } from './candidate-session.guard';
import type { CandidateContext, CandidateRequest } from './candidate.types';

/**
 * Marks a route as a candidate route behind a session token. The global staff guard is deny by
 * default, so the route is opened to it with @Public() and then protected again by
 * CandidateSessionGuard; this decorator always applies both together, so one cannot be forgotten
 * (candidate-routes.spec.ts fails for any /candidate route that is neither this nor on the
 * pre-token list). The per-IP candidate throttle is skipped: a test centre puts many candidates
 * behind one address, so these routes are limited per session in Redis (ADR 0013 section 5.1).
 */
export function CandidateScoped(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    Public(),
    UseGuards(CandidateSessionGuard),
    UseInterceptors(CandidateContextInterceptor),
    SkipThrottle({ candidate: true }),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({
      description:
        'No, invalid or expired candidate token. Codes: TOKEN_EXPIRED, SESSION_TAKEN_OVER (another device passed the OTP).',
    }),
  );
}

/** The CandidateContext the guard built. Throws if the guard did not run. */
export const Candidate = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const candidate = ctx.switchToHttp().getRequest<CandidateRequest>().candidate;
  if (candidate === undefined) throw new UnauthorizedException('Authentication required.');
  return candidate satisfies CandidateContext;
});
