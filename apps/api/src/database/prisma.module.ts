// BE-02's interim unscoped client for auth only; deleted by FU-DB-58.
import { Global, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from './create-prisma-client';

@Injectable()
export class PrismaService implements OnApplicationShutdown {
  readonly client: PrismaClient;

  constructor(config: ConfigService<Env, true>) {
    this.client = createPrismaClient(config.get('DATABASE_URL', { infer: true }));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.$disconnect();
  }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
