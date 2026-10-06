// FR-105: writes an audit_logs row for every route marked @Audited(action, entityType), after the
// handler succeeded and before the response leaves. If the audit write fails the request fails
// (500) and the response body, which may hold candidate data, is dropped. The row carries no
// request body, query string, token or media key: only the action, the entity type and id, the
// HTTP method and the route template (never the concrete URL), plus actor, org and IP.
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Observable, mergeMap } from 'rxjs';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import type { AuthUser } from '../common/auth/auth.types';
import { AuditWriteAfterCommitError } from './audit-write-after-commit.error';
import { AUDITED } from './audited.decorator';
import type { AuditedOptions } from './audited.decorator';

/** Uuids are stored in lowercase, whatever case the URL used, so one entity has one id. */
function normaliseId(id: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id.toLowerCase()
    : id;
}

type AuditedRequest = Request & { user?: AuthUser };

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const options = this.reflector.getAllAndOverride<AuditedOptions | undefined>(AUDITED, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return next.handle();
    const req = context.switchToHttp().getRequest<AuditedRequest>();
    return next.handle().pipe(
      mergeMap(async (data: unknown) => {
        try {
          await this.write(req, options);
        } catch (e) {
          // A missing actor is a wiring bug, not a failed write: rethrown unchanged.
          if (e instanceof InternalServerErrorException) {
            this.logger.error('Audited route without a verified user');
            throw e;
          }
          // The handler has already committed. A lock or deadlock error here must not reach the
          // client as 503 + Retry-After (DL-37): that invites a retry of a non-idempotent action
          // that already happened. A fixed error with no cause is never remapped (the filter
          // answers a bare 500, as before; an HttpException would add a detail the QA contract
          // for this route does not expect), so no Retry-After is sent. The response data stays
          // dropped (fail closed). Class name only is logged.
          this.logger.error(
            { errorName: e instanceof Error ? e.name : 'NonError' },
            'Audit write failed after the handler committed',
          );
          throw new AuditWriteAfterCommitError();
        }
        return data;
      }),
    );
  }

  private async write(req: AuditedRequest, options: AuditedOptions): Promise<void> {
    const user = req.user;
    // An audited route is a staff route. Without a verified user there is no actor and no org:
    // refuse rather than write an anonymous row.
    if (!user) throw new InternalServerErrorException();
    const rawId = options.idParam === undefined ? undefined : req.params[options.idParam];
    const route = this.routeTemplate(req);
    await this.orgContext.runAsUser({ orgId: user.orgId, userId: user.id, role: user.role }, () =>
      this.prisma.client.auditLog.create({
        data: {
          orgId: user.orgId,
          actorId: user.id,
          action: options.action,
          entityType: options.entityType,
          entityId: typeof rawId === 'string' ? normaliseId(rawId) : null,
          ip: req.ip ?? null,
          metadata: { method: req.method, route },
        },
      }),
    );
  }

  /** "/admin/users/:userId", never the concrete URL, so no id or query value is stored twice. */
  private routeTemplate(req: Request): string {
    const base: unknown = req.baseUrl;
    const path: unknown = (req.route as { path?: unknown } | undefined)?.path;
    return `${typeof base === 'string' ? base : ''}${typeof path === 'string' ? path : ''}`;
  }
}
