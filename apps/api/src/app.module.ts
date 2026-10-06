import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { LoggerModule } from 'nestjs-pino';
import { API_PREFIX } from './bootstrap';
import { validateEnv } from './config/env';
import type { Env } from './config/env';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CandidateModule } from './candidate/candidate.module';
import { UsersModule } from './users/users.module';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { buildPinoHttpOptions } from './common/pino-http.config';
import { TokenModule } from './common/auth/token.service';
import { DatabaseModule } from './database/database.module';
import { ExecutionModule } from './execution/execution.module';
import { MailModule } from './mail/mail.module';
import { MediaModule } from './media/media.module';
import { RetentionModule } from './retention/retention.module';
import { ipBucket } from './client-errors/ip-bucket';
import { ClientErrorsModule } from './client-errors/client-errors.module';
import { HealthModule } from './health/health.module';
import { InfrastructureModule } from './infrastructure/infrastructure.module';

type Area = 'auth' | 'candidate' | 'client-errors' | 'other';

function areaOf(context: ExecutionContext): Area {
  // Express matches routes case-insensitively, so classify the same way (FU-BE-09).
  const path = context.switchToHttp().getRequest<Request>().path.toLowerCase();
  if (path.startsWith(`/${API_PREFIX}/auth`)) return 'auth';
  if (path.startsWith(`/${API_PREFIX}/candidate`)) return 'candidate';
  if (path.startsWith(`/${API_PREFIX}/client-errors`)) return 'client-errors';
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
        pinoHttp: buildPinoHttpOptions(config.get('LOG_LEVEL', { infer: true })),
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const ttl = config.get('THROTTLE_TTL_MS', { infer: true });
        return {
          // Five named throttlers; each applies to exactly one area of the API.
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
            {
              // Public, unauthenticated browser error reports (C-32): its own small budget.
              name: 'client-errors',
              ttl,
              limit: config.get('CLIENT_ERROR_THROTTLE_LIMIT', { infer: true }),
              // Per IP, IPv6 bucketed by /64.
              getTracker: (req) => ipBucket(typeof req['ip'] === 'string' ? req['ip'] : undefined),
              skipIf: (ctx) => areaOf(ctx) !== 'client-errors',
            },
            {
              // One budget for the whole instance, whoever sends: caps log volume from a botnet
              // or a rotating IPv6 range.
              name: 'client-errors-global',
              ttl,
              limit: config.get('CLIENT_ERROR_GLOBAL_LIMIT', { infer: true }),
              getTracker: () => 'client-errors-global',
              skipIf: (ctx) => areaOf(ctx) !== 'client-errors',
            },
          ],
        };
      },
    }),
    InfrastructureModule,
    DatabaseModule,
    MailModule,
    TokenModule,
    AuditModule,
    AuthModule,
    CandidateModule,
    MediaModule,
    RetentionModule.forRoot({ objectStore: MediaModule }),
    UsersModule,
    HealthModule,
    ClientErrorsModule,
    ExecutionModule,
  ],
  // Order matters: throttle first, then authenticate (deny by default).
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
