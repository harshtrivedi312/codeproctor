// Fills the org context from the authenticated user (the population point BE-02 plugs into).
//
// Order in a Nest request: guards, then interceptors, then the handler. The auth guard (BE-02)
// verifies the token and sets `request.user`; this interceptor, which runs after it, reads
// `request.user` and runs the rest of the request (pipes, handler, services, queries) inside the
// org context. A route with no `request.user` (health, login) runs with no context, so any query
// on org data from it throws. Only HTTP is handled here: a Socket.IO or queue handler calls
// OrgContextService.runAsUser or runInOrg itself.
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { authenticatedUserSchema, OrgContextService } from './org-context';

type RequestWithUser = Request & { user?: unknown };

@Injectable()
export class OrgContextInterceptor implements NestInterceptor {
  private readonly logger = new Logger(OrgContextInterceptor.name);

  constructor(private readonly orgContext: OrgContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const { user } = context.switchToHttp().getRequest<RequestWithUser>();
    if (user === undefined || user === null) return next.handle();

    const parsed = authenticatedUserSchema.safeParse(user);
    if (!parsed.success) {
      // The auth layer produced a user without a usable org. Fail closed; log no values.
      this.logger.error('request.user does not match AuthenticatedUser (orgId, userId, role)');
      throw new UnauthorizedException();
    }

    // The handler runs when the observable is subscribed to, so subscribe inside the context.
    return new Observable<unknown>((subscriber) => {
      const subscription = this.orgContext.runAsUser(parsed.data, () =>
        next.handle().subscribe(subscriber),
      );
      return () => subscription.unsubscribe();
    });
  }
}
