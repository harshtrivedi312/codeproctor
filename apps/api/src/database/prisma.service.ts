// The API's database access: the client factory (ADR 0009 section 4.2) with DATABASE_URL, which is
// app_user in every environment (ADR 0006 section 3), wrapped in the org-scope extension.
//
// Services and repositories inject PrismaService and use `prisma.client`. The base client stays
// private, so no query can skip the extension by accident. $connect and $disconnect follow Nest's
// lifecycle. $connect only prepares the driver pool; the first query opens the connection, so the
// API still starts when Postgres is down and /health reports it (NFR-09).
import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
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
  private readonly logger = new Logger(PrismaService.name);
  private readonly warmupTimeoutMs: number;

  /** Every model query runs through the org scope. Use this, never a client of your own. */
  readonly client: OrgScopedPrismaClient;

  constructor(config: ConfigService<Env, true>, orgContext: OrgContextService) {
    this.base = createPrismaClient(config.get('DATABASE_URL', { infer: true }), {
      max: config.get('DB_POOL_MAX', { infer: true }),
      connectionTimeoutMillis: config.get('DB_CONNECT_TIMEOUT_MS', { infer: true }),
      idleTimeoutMillis: config.get('DB_IDLE_TIMEOUT_MS', { infer: true }),
    });
    this.warmupTimeoutMs = config.get('DB_WARMUP_TIMEOUT_MS', { infer: true });
    this.client = createOrgScopedClient(this.base, orgContext);
  }

  async onModuleInit(): Promise<void> {
    await this.base.$connect();
    await this.warmUp();
  }

  /**
   * Opens the first connection and runs the first query now, so the first request after a boot does
   * not pay for it (FU-BE-194, C-43: the first candidate after an instance boot). Best effort and
   * bounded: a down Postgres must not stop the API from starting (NFR-09), and /health reports it.
   * Only the error class is logged, never its message (it can carry the connection string).
   */
  private async warmUp(): Promise<void> {
    try {
      await this.withTimeout(this.base.$queryRaw`SELECT 1`, this.warmupTimeoutMs);
    } catch (e) {
      this.logger.warn(`database warm-up skipped (${e instanceof Error ? e.name : 'error'})`);
    }
  }

  /**
   * Readiness probe: one `SELECT 1` through the same pool and query path that requests use, so
   * /health is only green when a request could be served. Rejects on failure; the caller bounds it.
   */
  async ping(): Promise<void> {
    await this.base.$queryRaw`SELECT 1`;
  }

  private withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('warm-up timeout')), ms);
    });
    // The loser must not become an unhandled rejection if the timeout wins.
    work.catch(() => undefined);
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  }

  // After the HTTP server has stopped taking requests, so in-flight requests finish their queries.
  async onApplicationShutdown(): Promise<void> {
    await this.base.$disconnect();
  }
}
