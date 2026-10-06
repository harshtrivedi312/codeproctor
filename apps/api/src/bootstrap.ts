// Shared by main.ts and the e2e tests so both run the same middleware and pipes.
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Server } from 'node:http';
import cookieParser from 'cookie-parser';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { createClientErrorBody } from './client-errors/client-error-body.middleware';
import type { Env } from './config/env';
import { applyHttpTimeouts } from './common/http-timeouts';
import { createScopedJsonParser, useDefaultBodyParsers } from './common/body-parsers';
import { ProblemFilter } from './common/problem.filter';

export const API_PREFIX = 'api/v1';
/** JSON body limit for the question bank only (FR-201): the largest valid body is a few hundred KB. */
export const QUESTIONS_JSON_BODY_LIMIT = '1mb';
export const DOCS_PATH = 'api/docs';

export function configureApp(app: INestApplication): void {
  const express = app as NestExpressApplication;
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  app.useLogger(app.get(Logger));
  // Slowloris defence for every route and body parser (FU-BE-98).
  applyHttpTimeouts(app.getHttpServer() as Server, {
    headersTimeoutMs: config.get('HTTP_HEADERS_TIMEOUT_MS', { infer: true }),
    requestTimeoutMs: config.get('HTTP_REQUEST_TIMEOUT_MS', { infer: true }),
    keepAliveTimeoutMs: config.get('HTTP_KEEPALIVE_TIMEOUT_MS', { infer: true }),
    checkIntervalMs: config.get('HTTP_TIMEOUT_CHECK_INTERVAL_MS', { infer: true }),
  });
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
  // they exceed Express's default 100 KB JSON limit. Only that route gets the 1 MB parser; every
  // other route (login, reset, candidate bootstrap included) keeps Nest's default 100 KB parser,
  // so a public route never parses 1 MB before the throttler runs (FU-BE-104). Express matches
  // the mount path case-insensitively, like the routes themselves. /client-errors is parsed
  // before all of this by its own 16 KB middleware and is unaffected.
  app.use(`/${API_PREFIX}/questions`, createScopedJsonParser(app, QUESTIONS_JSON_BODY_LIMIT));
  // Global parsers at the default 100 KB, with body-parser failures mapped to fixed problem details.
  useDefaultBodyParsers(app);
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
