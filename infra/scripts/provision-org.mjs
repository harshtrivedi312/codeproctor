// Pilot org provisioning CLI (ADR 0006 section 8.9, FU-DB-76). The owner runs it on the pilot host,
// never from a developer machine or an agent session (ADR 0009, D-38).
//
//   node --import tsx infra/scripts/provision-org.mjs create  --file /path/on/the/pilot/host.json
//   node --import tsx infra/scripts/provision-org.mjs reissue --file /path/on/the/pilot/host.json
//
// create file:  { "orgName": "...", "retentionDays": 90, "adminEmail": "...", "adminName": "..." }
// reissue file: { "orgName": "...", "adminEmail": "..." }
//
// Environment: DATABASE_URL (the app_user URL; there is no MIGRATION_DATABASE_URL fallback and no
// localhost guard, because this runs against the pilot database) and REDIS_URL. Nothing else is read.
// The org name and email come only from the file: never argv, env or workflow inputs.
//
// Exit codes: 0 done; 1 bad input, configuration or failure (nothing was created, or the error says
// what to do); 2 the org and admin exist but the job could not be queued: run `reissue`.
// Output is ids only. The email, the token and the link are never printed, logged or kept.
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  EnqueueError,
  InputError,
  provisionOrg,
  QUEUE_NAME,
  reissueSetPassword,
  validateInput,
} from './provision-org-core.mjs';

const fail = (message, code = 1) => {
  console.error(`provision-org: ${message}`);
  process.exit(code);
};

const [command, flag, file, ...extra] = process.argv.slice(2);
if (
  !['create', 'reissue'].includes(command ?? '') ||
  flag !== '--file' ||
  !file ||
  extra.length > 0
) {
  fail(
    'usage: provision-org.mjs <create|reissue> --file <path>. Nothing else is accepted on the command line.',
  );
}
for (const name of ['DATABASE_URL', 'REDIS_URL']) {
  if (!process.env[name]) fail(`${name} is not set`);
}

let input;
try {
  if (!statSync(file).isFile()) fail('--file is not a regular file');
  input = validateInput(JSON.parse(readFileSync(file, 'utf8')), {
    forReissue: command === 'reissue',
  });
} catch (error) {
  // JSON.parse messages quote the text around the error, so they are never passed on.
  fail(
    error instanceof InputError ? error.message : 'the file cannot be read or is not valid JSON',
  );
}

// The client comes from the one factory (ADR 0009 4.2). Needs `node --import tsx` and `pnpm db:generate`.
let prisma;
try {
  const factory = pathToFileURL(
    fileURLToPath(new URL('../../apps/api/src/database/create-prisma-client.ts', import.meta.url)),
  );
  prisma = (await import(factory.href)).createPrismaClient(process.env.DATABASE_URL);
} catch {
  fail('cannot load the database client. Run with `node --import tsx` after `pnpm db:generate`.');
}

let queue;
let connection;
const closeAll = async () => {
  await Promise.allSettled([queue?.close(), connection?.quit(), prisma.$disconnect()]);
};

try {
  // Connect as app_user only: owner credentials in DATABASE_URL are refused.
  const [{ current_user: who }] = await prisma.$queryRaw`SELECT current_user`;
  if (who !== 'app_user') fail('DATABASE_URL must connect as app_user');

  // BullMQ is BE-06's dependency, resolved from apps/api like the seed resolves argon2.
  const requireFromApi = createRequire(new URL('../../apps/api/package.json', import.meta.url));
  let bullmq;
  let IORedis;
  try {
    bullmq = requireFromApi('bullmq');
    IORedis = requireFromApi('ioredis');
  } catch {
    fail('bullmq is not installed in apps/api (it arrives with BE-06). Nothing was created.');
  }
  connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  queue = new bullmq.Queue(QUEUE_NAME, { connection });

  const runId = process.env.GITHUB_RUN_ID ?? randomUUID();
  const result =
    command === 'create'
      ? await provisionOrg({ prisma, queue, input, runId })
      : await reissueSetPassword({ prisma, queue, input, runId });
  console.log(`provision-org: ${command} done. org=${result.orgId} user=${result.userId}`);
  await closeAll();
} catch (error) {
  await closeAll();
  if (error instanceof EnqueueError) {
    console.error(
      `provision-org: the org and admin exist but the link job was not queued. Run reissue. org=${error.orgId} user=${error.userId}`,
    );
    process.exit(2);
  }
  // Only a known message or a code: other errors may quote values.
  fail(
    error instanceof InputError
      ? error.message
      : `failed (${typeof error?.code === 'string' ? error.code : 'error'})`,
  );
}
