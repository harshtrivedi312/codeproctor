// Fills the org context from the authenticated user (the population point for BE-02's auth).
//
// Order in a Nest request: guards, then interceptors, then the handler. BE-02's JwtAuthGuard
// verifies the staff access token and sets `request.user` to an AuthUser (`id`, `orgId`, `role`,
// `kind`); this interceptor, which runs after it, reads `request.user` and runs the rest of the
// request (pipes, handler, services, queries) inside the org context, with `id` as the user id.
// A route with no `request.user` (a @Public() route such as health or login) runs with no context,
// so any query on org data from it throws. Only HTTP is handled here: a Socket.IO or queue handler
// calls OrgContextService.runAsUser or runInOrg itself.
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { z } from 'zod';
import type { AuthUser } from '../common/auth/auth.types';
import { UserRole } from '../generated/prisma/enums.js';
import { OrgContextService } from './org-context';
import type { AuthenticatedUser } from './org-context';

type RequestWithUser = Request & { user?: unknown };

// Checks request.user against BE-02's AuthUser. Typing the schema as ZodType<AuthUser> makes the
// compiler flag an AuthUser that gains a field or changes a field's type. It does not notice a
// field being removed from AuthUser (the schema's output is still assignable to it). z.guid() accepts any
// 8-4-4-4-12 hex id, which is all a Postgres uuid column needs. Only an access token is a session;
// the guard never lets a 2FA challenge token through, and this check does not either.
const requestUserSchema: z.ZodType<AuthUser> = z.object({
  id: z.guid(),
  orgId: z.guid(),
  role: z.enum(UserRole),
  kind: z.literal('access'),
});

@Injectable()
export class OrgContextInterceptor implements NestInterceptor {
  private readonly logger = new Logger(OrgContextInterceptor.name);

  constructor(private readonly orgContext: OrgContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const { user } = context.switchToHttp().getRequest<RequestWithUser>();
    if (user === undefined || user === null) return next.handle();

    const parsed = requestUserSchema.safeParse(user);
    if (!parsed.success) {
      // The guard accepted a token but produced a user without a usable org: a bug in the auth
      // layer, not a bad credential from the client. Fail closed with 500 (FU-DB-65), and log no
      // values.
      this.logger.error('request.user does not match AuthUser (id, orgId, role, kind "access")');
      throw new InternalServerErrorException();
    }
    const authenticated: AuthenticatedUser = {
      orgId: parsed.data.orgId,
      userId: parsed.data.id,
      role: parsed.data.role,
    };

    // The handler runs when the observable is subscribed to, so subscribe inside the context.
    return new Observable<unknown>((subscriber) => {
      const subscription = this.orgContext.runAsUser(authenticated, () =>
        next.handle().subscribe(subscriber),
      );
      return () => subscription.unsubscribe();
    });
  }
}
