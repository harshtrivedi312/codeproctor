// Pilot org provisioning CLI (ADR 0006 section 8.9, FU-DB-76). The owner runs it on the pilot host,
// never from a developer machine or an agent session (ADR 0009, D-38).
//
//   node --import tsx infra/scripts/provision-org.mjs create  --file /secure/path/org.json
//   node --import tsx infra/scripts/provision-org.mjs reissue --file /secure/path/org.json
//
// create file:  { "orgName": "...", "retentionDays": 90, "adminEmail": "...", "adminName": "...",
//                 "expectedDatabase": "<the pilot database name>" }
// reissue file: { "orgName": "...", "adminEmail": "...", "expectedDatabase": "..." }
// The file holds personal data: a regular file (no symlink), mode 600 or stricter, at most 64 KiB.
//
// Environment: DATABASE_URL (the app_user URL; there is no MIGRATION_DATABASE_URL fallback and no
// localhost guard, because this runs against the pilot database), REDIS_URL, and optionally
// GITHUB_RUN_ID (recorded in the audit row; a random id is used otherwise). Nothing else is read.
// The org name and email come only from the file: never argv, env or workflow inputs.
//
// Exit codes: 0 done; 1 bad input, configuration or failure (the message says what happened and
// whether anything was created); 2 the org and admin exist but the job could not be queued: run
// `reissue`. Output is ids only. The email, the token and the link are never printed, logged or kept.
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  connectRedis,
  EnqueueError,
  InputError,
  provisionOrg,
  QUEUE_NAME,
  reissueSetPassword,
  validateInput,
  withTimeout,
} from './provision-org-core.mjs';

const MAX_FILE_BYTES = 64 * 1024;
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

let prisma;
let queue;
let connection;
/** Closes whatever is open. Each close is bounded: a hung Redis must not hang the exit. */
const closeAll = async () => {
  await Promise.allSettled(
    [queue?.close(), prisma?.$disconnect()].filter(Boolean).map((p) => withTimeout(p, 3000)),
  );
  try {
    connection?.disconnect();
  } catch {
    // already closed
  }
};
const fail = async (message, code = 1) => {
  console.error(`provision-org: ${message}`);
  await closeAll();
  process.exit(code);
};

const [command, flag, file, ...extra] = process.argv.slice(2);
if (
  !['create', 'reissue'].includes(command ?? '') ||
  flag !== '--file' ||
  !file ||
  extra.length > 0
) {
  await fail(
    'usage: provision-org.mjs <create|reissue> --file <path>. Nothing else is accepted on the command line.',
  );
}
for (const name of ['DATABASE_URL', 'REDIS_URL']) {
  if (!process.env[name]) await fail(`${name} is not set`);
}

let input;
try {
  // One handle for the checks and the read, so a link swapped in between cannot be followed.
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    await fail('--file must be a regular file, not a link');
  }
  let text;
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) await fail('--file must be a regular file, not a link');
    if (info.size > MAX_FILE_BYTES) await fail('--file is larger than 64 KiB');
    if (info.mode & 0o077) await fail('--file must not be readable by group or others (chmod 600)');
    if (info.uid !== process.getuid())
      await fail('--file must be owned by the user running this script');
    text = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
  input = validateInput(JSON.parse(text), {
    forReissue: command === 'reissue',
  });
} catch (error) {
  // JSON.parse messages quote the text around the error, so they are never passed on.
  await fail(
    error instanceof InputError ? error.message : 'the file cannot be read or is not valid JSON',
  );
}

try {
  // The client comes from the one factory (ADR 0009 4.2). Needs `node --import tsx` and `pnpm db:generate`.
  try {
    const factory = pathToFileURL(
      fileURLToPath(
        new URL('../../apps/api/src/database/create-prisma-client.ts', import.meta.url),
      ),
    );
    prisma = (await import(factory.href)).createPrismaClient(process.env.DATABASE_URL);
  } catch {
    await fail(
      'cannot load the database client. Run with `node --import tsx` after `pnpm db:generate`.',
    );
  }

  // Connect as a plain app_user, to the database the file names, before anything is written.
  const [who] =
    await prisma.$queryRaw`SELECT current_user AS name, current_database() AS db, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS powerful`;
  if (who.name !== 'app_user') await fail('DATABASE_URL must connect as app_user');
  if (who.powerful) await fail('the app_user role is a superuser or bypasses row security');
  if (who.db !== input.expectedDatabase)
    await fail(
      'DATABASE_URL points at a different database than expectedDatabase. Nothing was created.',
    );

  // BullMQ is BE-06's dependency, resolved from apps/api like the seed resolves argon2.
  const requireFromApi = createRequire(new URL('../../apps/api/package.json', import.meta.url));
  let bullmq;
  let IORedis;
  try {
    // Never from outside this checkout (a parent directory or NODE_PATH).
    for (const name of ['bullmq', 'ioredis']) {
      if (!requireFromApi.resolve(name).startsWith(REPO_ROOT)) throw new Error('outside');
    }
    bullmq = requireFromApi('bullmq');
    IORedis = requireFromApi('ioredis');
  } catch {
    await fail('bullmq is not installed in apps/api (it arrives with BE-06). Nothing was created.');
  }
  // A short-lived producer: fail fast when Redis is down instead of waiting forever.
  try {
    connection = await connectRedis(IORedis, process.env.REDIS_URL);
  } catch {
    await fail('cannot reach Redis. Nothing was created.');
  }
  queue = new bullmq.Queue(QUEUE_NAME, { connection });

  const runId = process.env.GITHUB_RUN_ID ?? randomUUID();
  const result =
    command === 'create'
      ? await provisionOrg({ prisma, queue, input, runId })
      : await reissueSetPassword({ prisma, queue, input, runId });
  console.log(`provision-org: ${command} done. org=${result.orgId} user=${result.userId}`);
  await closeAll();
  process.exit(0); // a close that timed out must not keep the process alive
} catch (error) {
  if (error instanceof EnqueueError) {
    await fail(
      `the org and admin exist but the link job was not queued. Run reissue. org=${error.orgId} user=${error.userId}`,
      2,
    );
  }
  // Only a known message or a code: other errors may quote values.
  await fail(
    error instanceof InputError
      ? error.message
      : `failed (${typeof error?.code === 'string' ? error.code : 'error'})`,
  );
}
