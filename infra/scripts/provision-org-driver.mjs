// Test driver for provision-org-core.mjs: the real core and the real Prisma client from the one
// factory, with a fake queue that records jobs. Run as `node --import tsx` by provision-org.test.mjs.
// Not shipped to the pilot host and never given real credentials.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  EnqueueError,
  provisionOrg,
  reissueSetPassword,
  validateInput,
} from './provision-org-core.mjs';

// Test only: it skips the app_user and database checks of the real CLI and uses a fake queue, so it
// refuses to run unless a test flag is set and the database is on this machine.
const host = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid').hostname;
if (process.env.PROVISION_ORG_DRIVER !== 'test' || !['127.0.0.1', 'localhost'].includes(host)) {
  console.error('provision-org-driver: test only');
  process.exit(1);
}
const factory = pathToFileURL(
  fileURLToPath(new URL('../../apps/api/src/database/create-prisma-client.ts', import.meta.url)),
);
const prisma = (await import(factory.href)).createPrismaClient(process.env.DATABASE_URL);
const jobs = [];
const queue = {
  add: async (name, data, opts) => {
    if (process.env.DRIVER_QUEUE === 'fail') throw new Error('redis is down');
    jobs.push({ name, data, opts });
  },
};
const forReissue = process.env.DRIVER_COMMAND === 'reissue';
try {
  const input = validateInput(JSON.parse(readFileSync(process.env.DRIVER_FILE, 'utf8')), {
    forReissue,
  });
  const run = forReissue ? reissueSetPassword : provisionOrg;
  const result = await run({ prisma, queue, input, runId: 'run-test-1' });
  console.log(JSON.stringify({ ok: true, result, jobs }));
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      // Only known messages: a Prisma or pg error can quote values.
      error: {
        name: error.constructor.name,
        message:
          error.name === 'InputError' || error.name === 'EnqueueError' ? error.message : 'other',
        code: error.code ?? null,
      },
      ids: error instanceof EnqueueError ? { orgId: error.orgId, userId: error.userId } : null,
      jobs,
    }),
  );
} finally {
  await prisma.$disconnect();
}
