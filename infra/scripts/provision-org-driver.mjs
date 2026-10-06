// Test driver for provision-org-core.mjs: the real core and the real Prisma client from the one
// factory, with a fake queue that records jobs. Run as `node --import tsx` by provision-org.test.mjs.
// Not shipped to the pilot host and never given real credentials.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  EnqueueError,
  provisionOrg,
  reissueSetPassword,
  validateInput,
} from './provision-org-core.mjs';

const factory = pathToFileURL(
  new URL('../../apps/api/src/database/create-prisma-client.ts', import.meta.url).pathname,
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
      error: { name: error.constructor.name, message: error.message, code: error.code ?? null },
      ids: error instanceof EnqueueError ? { orgId: error.orgId, userId: error.userId } : null,
      jobs,
    }),
  );
} finally {
  await prisma.$disconnect();
}
