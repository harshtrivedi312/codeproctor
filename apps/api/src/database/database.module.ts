// Database access for the API (DB-05). Global, like InfrastructureModule, so business modules
// inject PrismaService and OrgContextService without importing this module. Importing it once in
// AppModule also turns on OrgContextInterceptor for every route.
import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
// Side-effect import, on purpose (#126 nit 2): candidate-facts.ts claims the one candidate-facts setter
// from org-context.ts when it loads (a second claim throws). Loading it with this module, which every
// app imports, means the setter is claimed at boot and no other module can ever claim it first, even if
// CandidateSessionGuard's file is imported late or by a test. It exports nothing to this module.
import './candidate-facts';
import { OrgContextInterceptor } from './org-context.interceptor';
import { OrgContextService } from './org-context';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [
    OrgContextService,
    PrismaService,
    { provide: APP_INTERCEPTOR, useClass: OrgContextInterceptor },
  ],
  exports: [OrgContextService, PrismaService],
})
export class DatabaseModule {}
