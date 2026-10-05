// Development seed (DB-04). Run with `pnpm db:seed`, which runs the localhost guard and then
// `prisma db seed` (migrations.seed in prisma.config.ts; ADR 0009 section 4.3). Idempotent: a second
// run inserts nothing. Original, synthetic data only.
//
// It builds its client with the one factory (ADR 0009 section 4.2) from DATABASE_URL (app_user, the
// least-privileged role that can do the job) or, when that is empty, MIGRATION_DATABASE_URL.
// Refuses to run unless APP_ENV is "development" (Q-28) and the database is on this machine.
// Prints per-table counts and the staff emails, never the password.
import { resolve } from 'node:path';
import { createPrismaClient } from '../apps/api/src/database/create-prisma-client';
import { applySeed, countRows } from './seed/apply';
import {
  SeedRefusal,
  assertResolvedHostIsLocal,
  chooseDatabaseUrl,
  requireDevelopment,
  runLocalGuard,
} from './seed/guard';
import { loadPasswordHasher } from './seed/passwords';
import { buildSeedPlan } from './seed/plan';

const REPO_ROOT = resolve(__dirname, '..');

function printCounts(before: Record<string, number>, after: Record<string, number>): void {
  const width = Math.max(...Object.keys(after).map((name) => name.length));
  console.log(
    `${'table'.padEnd(width)}  ${'before'.padStart(7)}  ${'after'.padStart(7)}  ${'inserted'.padStart(8)}`,
  );
  let totalInserted = 0;
  for (const [table, count] of Object.entries(after)) {
    const was = before[table] ?? 0;
    totalInserted += count - was;
    console.log(
      `${table.padEnd(width)}  ${String(was).padStart(7)}  ${String(count).padStart(7)}  ${String(count - was).padStart(8)}`,
    );
  }
  console.log(
    `${'total rows inserted'.padEnd(width)}  ${' '.repeat(7)}  ${' '.repeat(7)}  ${String(totalInserted).padStart(8)}`,
  );
}

async function main(): Promise<void> {
  // Everything that can refuse runs before the first connection.
  requireDevelopment(process.env);
  const target = chooseDatabaseUrl(process.env);
  runLocalGuard(REPO_ROOT);
  assertResolvedHostIsLocal(target.url, REPO_ROOT);
  const hashPassword = loadPasswordHasher(REPO_ROOT);

  const plan = buildSeedPlan(new Date());
  const client = createPrismaClient(target.url);
  try {
    const roles = await client.$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    console.log(
      `seed: connected with ${target.name} as database role "${roles[0]?.role ?? 'unknown'}".`,
    );
    const before = await countRows(client);
    await applySeed(client, plan, hashPassword);
    const after = await countRows(client);
    printCounts(before, after);
    console.log('');
    console.log('Staff accounts (development password, not printed here):');
    for (const user of plan.content.staff) console.log(`  ${user.role.padEnd(11)} ${user.email}`);
  } finally {
    await client.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.exitCode = 1;
  if (error instanceof SeedRefusal) {
    console.error(`seed: ${error.message}`);
    return;
  }
  // Prisma error text can contain the rows it was writing, including password hashes, so it is not
  // printed. SEED_VERBOSE_ERRORS=1 prints it for local debugging.
  const name = error instanceof Error ? error.name : 'Error';
  const rawCode = (error as { code?: unknown } | null)?.code;
  const code =
    typeof rawCode === 'string' && /^[A-Z0-9_]{1,40}$/.test(rawCode) ? ` ${rawCode}` : '';
  console.error(
    `seed: failed (${name}${code}). Set SEED_VERBOSE_ERRORS=1 to print the error text.`,
  );
  if (process.env.SEED_VERBOSE_ERRORS === '1' && error instanceof Error)
    console.error(error.message);
});
