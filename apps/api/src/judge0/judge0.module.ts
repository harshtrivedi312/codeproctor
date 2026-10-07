import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import { HttpJudge0Client, UnconfiguredJudge0Client } from './http-judge0.client';
import { StubJudge0Client } from './stub-judge0.client';
import { JUDGE0_CLIENT } from './judge0.types';
import type { Judge0Client } from './judge0.types';

@Module({
  providers: [
    {
      provide: JUDGE0_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Judge0Client => {
        // Read from process env at boot only (DL-56); config refuses stub outside development.
        if (config.get('JUDGE0_MODE', { infer: true }) === 'stub') {
          new Logger('Judge0Module').warn('local stub mode: not real execution');
          return new StubJudge0Client();
        }
        const baseUrl = config.get('JUDGE0_URL', { infer: true });
        if (!baseUrl) return new UnconfiguredJudge0Client();
        return new HttpJudge0Client({
          baseUrl,
          authToken: config.get('JUDGE0_AUTH_TOKEN', { infer: true }),
          authzToken: config.get('JUDGE0_AUTHZ_TOKEN', { infer: true }),
          requestTimeoutMs: config.get('JUDGE0_REQUEST_TIMEOUT_MS', { infer: true }),
          pollDeadlineMs: config.get('JUDGE0_POLL_DEADLINE_MS', { infer: true }),
        });
      },
    },
  ],
  exports: [JUDGE0_CLIENT],
})
export class Judge0Module {}
