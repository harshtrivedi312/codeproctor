import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { API_PREFIX } from './bootstrap';
import { validateEnv } from './config/env';
import type { Env } from './config/env';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { TokenModule } from './common/auth/token.service';
import { DatabaseModule } from './database/database.module';
import { PrismaModule } from './database/prisma.module';
import { MailModule } from './mail/mail.module';
import { HealthModule } from './health/health.module';
import { InfrastructureModule } from './infrastructure/infrastructure.module';

type Area = 'auth' | 'candidate' | 'other';

function areaOf(context: ExecutionContext): Area {
  // Express matches routes case-insensitively, so classify the same way (FU-BE-09).
  const path = context.switchToHttp().getRequest<Request>().path.toLowerCase();
  if (path.startsWith(`/${API_PREFIX}/auth`)) return 'auth';
  if (path.startsWith(`/${API_PREFIX}/candidate`)) return 'candidate';
  return 'other';
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      envFilePath: ['.env', '../../.env'],
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          // Per-request trace ID (NFR-09): honour a well-formed inbound id, else generate one.
          genReqId: (req, res) => {
            const inbound = req.headers['x-request-id'];
            const id =
              typeof inbound === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(inbound)
                ? inbound
                : randomUUID();
            res.setHeader('x-request-id', id);
            return id;
          },
          // Never log credentials, tokens or cookies.
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
            censor: '[redacted]',
          },
          // The query string may carry tokens, so log the path only.
          serializers: {
            req: (req: { id: string; method: string; url: string }) => ({
              id: req.id,
              method: req.method,
              url: req.url.split('?')[0],
            }),
          },
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const ttl = config.get('THROTTLE_TTL_MS', { infer: true });
        return {
          // Three named throttlers; each applies to exactly one area of the API.
          throttlers: [
            {
              name: 'default',
              ttl,
              limit: config.get('THROTTLE_DEFAULT_LIMIT', { infer: true }),
              skipIf: (ctx) => areaOf(ctx) !== 'other',
            },
            {
              name: 'auth',
              ttl,
              limit: config.get('THROTTLE_AUTH_LIMIT', { infer: true }),
              skipIf: (ctx) => areaOf(ctx) !== 'auth',
            },
            {
              name: 'candidate',
              ttl,
              limit: config.get('THROTTLE_CANDIDATE_LIMIT', { infer: true }),
              skipIf: (ctx) => areaOf(ctx) !== 'candidate',
            },
          ],
        };
      },
    }),
    InfrastructureModule,
    PrismaModule,
    DatabaseModule,
    MailModule,
    TokenModule,
    AuthModule,
    HealthModule,
  ],
  // Order matters: throttle first, then authenticate (deny by default).
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
