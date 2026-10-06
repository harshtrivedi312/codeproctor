// Shared by main.ts and the e2e tests so both run the same middleware and pipes.
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { createClientErrorBody } from './client-errors/client-error-body.middleware';
import type { Env } from './config/env';
import { ProblemFilter } from './common/problem.filter';

export const API_PREFIX = 'api/v1';
/** JSON body limit (FR-201): the largest valid question body is a few hundred KB. */
export const JSON_BODY_LIMIT = '1mb';
export const DOCS_PATH = 'api/docs';

export function configureApp(app: INestApplication): void {
  const express = app as NestExpressApplication;
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(API_PREFIX);
  // Behind Caddy the client address comes from X-Forwarded-For; trust exactly this many hops
  // (FU-BE-08). 0 ignores the header, so a direct client cannot spoof its throttle bucket.
  express.set('trust proxy', config.get('TRUST_PROXY_HOPS', { infer: true }));
  app.use(helmet());
  // Signed cookies: the refresh-token cookie (FR-104).
  app.use(cookieParser(config.get('COOKIE_SECRET', { infer: true })));
  // Only the web app origin is allowed; other origins get no CORS headers at all.
  const webOrigin = config.get('WEB_ORIGIN', { infer: true });
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: string | false) => void,
    ) => {
      callback(null, origin === undefined || origin === webOrigin ? webOrigin : false);
    },
    credentials: true,
  });
  // Public client-error route (C-32): streaming 16 KB cap, no inflation, parsed before the
  // global body parser (which then skips it).
  app.use(
    `/${API_PREFIX}/client-errors`,
    createClientErrorBody(config.get('CLIENT_ERROR_BODY_TIMEOUT_MS', { infer: true })),
  );
  // Question bank bodies carry up to 50 KB of statement and 100 KB per code map and test case, so
  // they exceed Express's default 100 KB JSON limit. `express` is not a direct dependency, so the
  // limit is raised for the one global JSON parser (every route has its own DTO length bounds).
  // /client-errors is parsed before it by its own 16 KB middleware and is unaffected.
  express.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.useGlobalFilters(new ProblemFilter());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableShutdownHooks();

  // OpenAPI is opt-in (ENABLE_API_DOCS) and the env schema refuses it in pilot and production.
  if (config.get('ENABLE_API_DOCS', { infer: true })) {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('CodeProctor API').setVersion('1.0').addBearerAuth().build(),
    );
    SwaggerModule.setup(DOCS_PATH, app, doc);
  }
}
