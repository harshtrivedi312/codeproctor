// Prisma CLI configuration (Prisma 7 reads connection URLs and the seed command from here,
// not from schema.prisma). The schema is added in DB-02, migrations in DB-03, the seed in DB-04.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { defineConfig } from 'prisma/config';

// Prisma 7 does not load .env on its own. Resolve it next to this file, not from the working
// directory, and refuse a .env that defines Prisma's AI-agent consent variable. Loading it would
// hand that consent to a direct `prisma migrate reset` (ADR 0009 section 4.4).
const envPath = resolve(__dirname, '.env');
if (existsSync(envPath)) {
  if ('PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION' in parseEnv(readFileSync(envPath, 'utf8'))) {
    throw new Error(
      '.env must not define PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION. ' +
        'Only infra/scripts/db-reset may set it (ADR 0009 section 4.4).',
    );
  }
  process.loadEnvFile(envPath);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Owner-role URL, used only by prisma migrate (ADR 0006). The app connects with
    // DATABASE_URL (app_user) through its own client, never through this file.
    // Empty fallback so `prisma validate` and `prisma format` work without a database.
    url: process.env.MIGRATION_DATABASE_URL ?? '',
  },
});
