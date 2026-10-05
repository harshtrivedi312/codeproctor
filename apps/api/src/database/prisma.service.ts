// The API's database access: the client factory (ADR 0009 section 4.2) with DATABASE_URL, which is
// app_user in every environment (ADR 0006 section 3), wrapped in the org-scope extension.
//
// Services and repositories inject PrismaService and use `prisma.client`. The base client stays
// private, so no query can skip the extension by accident. $connect and $disconnect follow Nest's
// lifecycle. $connect only prepares the driver pool; the first query opens the connection, so the
// API still starts when Postgres is down and /health reports it (NFR-09).
import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from './create-prisma-client';
import { OrgContextService } from './org-context';
import { createOrgScopedClient } from './org-scope.extension';
import type { OrgScopedPrismaClient } from './org-scope.extension';

@Injectable()
export class PrismaService implements OnModuleInit, OnApplicationShutdown {
  private readonly base: PrismaClient;

  /** Every model query runs through the org scope. Use this, never a client of your own. */
  readonly client: OrgScopedPrismaClient;

  constructor(config: ConfigService<Env, true>, orgContext: OrgContextService) {
    this.base = createPrismaClient(config.get('DATABASE_URL', { infer: true }));
    this.client = createOrgScopedClient(this.base, orgContext);
  }

  async onModuleInit(): Promise<void> {
    await this.base.$connect();
  }

  // After the HTTP server has stopped taking requests, so in-flight requests finish their queries.
  async onApplicationShutdown(): Promise<void> {
    await this.base.$disconnect();
  }
}
