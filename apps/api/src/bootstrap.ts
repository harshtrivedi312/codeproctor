// Shared by main.ts and the e2e tests so both run the same middleware and pipes.
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Env } from './config/env';
import { ProblemFilter } from './common/problem.filter';

export const API_PREFIX = 'api/v1';
export const DOCS_PATH = 'api/docs';

export const CLIENT_ERROR_MAX_BODY_BYTES = 16 * 1024;

function problem(req: Request, res: Response, status: number, title: string, detail: string): void {
  const inbound = req.headers['x-request-id'];
  const traceId =
    typeof inbound === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(inbound) ? inbound : randomUUID();
  res.setHeader('x-request-id', traceId);
  res
    .status(status)
    .type('application/problem+json')
    .json({ type: 'about:blank', title, status, detail, instance: req.path, traceId });
}

export function clientErrorBodyLimit(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'POST') return next();
  const raw = req.headers['content-length'];
  if (raw === undefined) {
    // Chunked bodies have no declared size to check up front.
    return problem(req, res, 411, 'Length Required', 'A Content-Length header is required.');
  }
  const length = Number(raw);
  if (!Number.isFinite(length) || length < 0 || length > CLIENT_ERROR_MAX_BODY_BYTES) {
    return problem(req, res, 413, 'Payload Too Large', 'The report is too large.');
  }
  next();
}

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
  // Hard body limit for the public client-error route, enforced from Content-Length before any
  // parsing (C-32). Node frames the body by Content-Length, so a client cannot exceed it.
  app.use(`/${API_PREFIX}/client-errors`, clientErrorBodyLimit);
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
