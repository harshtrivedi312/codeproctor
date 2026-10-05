// What other modules import from the database layer.
export { DatabaseModule } from './database.module';
export { PrismaService } from './prisma.service';
export { OrgContextService, SYSTEM_SCOPE_REASONS } from './org-context';
export type { AuthenticatedUser, OrgScope, Scoped, SystemScopeReason } from './org-context';
export { OrgContextInterceptor } from './org-context.interceptor';
export {
  OrgContextMissingError,
  OrgScopeError,
  OrgScopeViolationError,
  RawQueryNotAllowedError,
} from './errors';
export type { OrgScopedPrismaClient } from './org-scope.extension';
// For the log boundary: scrub a Prisma or driver error before it is logged (FU-DB-70, FU-DB-112).
export { scrubPrismaError } from './error-scrub';
