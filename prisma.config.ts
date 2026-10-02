// Prisma CLI configuration (Prisma 7 reads connection URLs and the seed command from here,
// not from schema.prisma). The schema is added in DB-02, migrations in DB-03, the seed in DB-04.
import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 does not load .env on its own.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
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
