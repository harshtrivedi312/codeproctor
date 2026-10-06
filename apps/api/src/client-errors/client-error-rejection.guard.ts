import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { getEarlyRejection } from '../common/early-rejection';

/**
 * Answers a body that createClientErrorBody refused (413, 415, 408, 400). It is a controller guard,
 * so it runs after the global throttler: the refused request has already been counted against the
 * per-IP and whole-instance budgets, and a flood of them ends in 429 (FU-BE-100).
 */
@Injectable()
export class ClientErrorRejectionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const rejection = getEarlyRejection(context.switchToHttp().getRequest<Request>());
    if (rejection) throw new HttpException(rejection.detail, rejection.status);
    return true;
  }
}
