// Shared by main.ts and the e2e tests so both run the same middleware and pipes.
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import type { Env } from './config/env';
import { ProblemFilter } from './common/problem.filter';

export const API_PREFIX = 'api/v1';
export const DOCS_PATH = 'api/docs';

export function configureApp(app: INestApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(API_PREFIX);
  app.use(helmet());
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
  app.useGlobalFilters(new ProblemFilter());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableShutdownHooks();

  // OpenAPI is never served in production.
  const isProduction =
    config.get('NODE_ENV', { infer: true }) === 'production' ||
    config.get('APP_ENV', { infer: true }) === 'production';
  if (!isProduction) {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('CodeProctor API').setVersion('1.0').addBearerAuth().build(),
    );
    SwaggerModule.setup(DOCS_PATH, app, doc);
  }
}
