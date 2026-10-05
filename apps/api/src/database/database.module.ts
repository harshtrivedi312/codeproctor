// Database access for the API (DB-05). Global, like InfrastructureModule, so business modules
// inject PrismaService and OrgContextService without importing this module. Importing it once in
// AppModule also turns on OrgContextInterceptor for every route.
import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
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
