import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import { STORAGE_SETTINGS, StorageService } from './storage.service';
import type { StorageSettings } from './storage.service';

/** Settings from the environment, or null when storage is not configured (media routes then 503). */
export function storageSettingsFromEnv(env: ConfigService<Env, true>): StorageSettings | null {
  const bucket = env.get('S3_MEDIA_BUCKET', { infer: true });
  const region = env.get('S3_REGION', { infer: true });
  if (bucket === undefined || region === undefined) return null;
  const endpoint = env.get('S3_ENDPOINT', { infer: true });
  const accessKeyId = env.get('S3_ACCESS_KEY_ID', { infer: true });
  const secretAccessKey = env.get('S3_SECRET_ACCESS_KEY', { infer: true });
  return {
    bucket,
    region,
    ...(endpoint !== undefined ? { endpoint } : {}),
    forcePathStyle: env.get('S3_FORCE_PATH_STYLE', { infer: true }),
    ...(accessKeyId !== undefined && secretAccessKey !== undefined
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
    conditionalWrites: env.get('S3_CONDITIONAL_WRITES', { infer: true }),
  };
}

// FR-701 to FR-704 (BE-09): the S3-compatible StorageService, shared by the candidate and review
// modules and by the retention and erasure jobs (Database track).
@Module({
  providers: [
    {
      provide: STORAGE_SETTINGS,
      inject: [ConfigService],
      useFactory: (env: ConfigService<Env, true>): StorageSettings | null =>
        storageSettingsFromEnv(env),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
