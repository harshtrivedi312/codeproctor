// Pilot org provisioning (ADR 0006 section 8.9, FU-DB-76): the logic, with the database client and
// the queue passed in so tests can run it against a throwaway Postgres and a fake queue.
// provision-org.mjs wires it to the real client and Redis.
//
// Nothing here returns, logs or throws the admin email, the placeholder token or a link. Errors name
// a field or an id, never a value.
import { createHash, randomBytes } from 'node:crypto';

/** BE-06 owns the `set-password` processor. Replace these with its exported constant when it lands. */
export const QUEUE_NAME = 'set-password';
export const JOB_NAME = 'set-password';
/** `_` and not `:` (ADR 0004 9.5: BullMQ may reject `:` in a custom job id). */
export const jobIdFor = (userId) => `set-password_${userId}`;
export const JOB_OPTIONS = {
  removeOnComplete: true,
  removeOnFail: true,
  attempts: 3,
  backoff: { type: 'exponential', delay: 30_000 },
};

export const ACTION_PROVISIONED = 'ORG_PROVISIONED';
export const ACTION_REISSUED = 'SET_PASSWORD_REISSUED';
export const ACTION_REISSUE_FAILED = 'SET_PASSWORD_REISSUE_FAILED';

/** A problem with what the operator supplied. The message never holds a value. */
export class InputError extends Error {
  name = 'InputError';
}
/** The org and user exist and are committed, but the job was not queued. Carries ids only. */
export class EnqueueError extends Error {
  constructor(orgId, userId) {
    super('the set-password job could not be queued');
    this.name = 'EnqueueError';
    this.orgId = orgId;
    this.userId = userId;
  }
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
// Control characters (NUL breaks the insert; others reach the email template) are never accepted.
const hasControl = (text) => [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const DATABASE_NAME = /^[A-Za-z0-9_.-]{1,63}$/;

/**
 * @param {unknown} raw parsed JSON from the host file
 * @returns {{ orgName: string, retentionDays: number, adminEmail: string, adminName: string, expectedDatabase: string }}
 */
export function validateInput(raw, { forReissue = false } = {}) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new InputError('the file must hold a JSON object');
  const allowed = forReissue
    ? ['orgName', 'adminEmail', 'expectedDatabase']
    : ['orgName', 'retentionDays', 'adminEmail', 'adminName', 'expectedDatabase'];
  // A key is never echoed: a hand-edited file can have an email address in the place of a key.
  if (Object.keys(raw).some((key) => !allowed.includes(key))) {
    throw new InputError(`the file has an unknown field (allowed: ${allowed.join(', ')})`);
  }
  const text = (field, max) => {
    const v = raw[field];
    if (typeof v !== 'string' || v.trim() === '' || v.length > max || hasControl(v)) {
      throw new InputError(
        `${field} must be a non-empty string of at most ${max} characters, with no control characters`,
      );
    }
    return v.trim();
  };
  const orgName = text('orgName', 200);
  const adminEmail = text('adminEmail', 254);
  if (!EMAIL.test(adminEmail)) throw new InputError('adminEmail must look like an email address');
  const expectedDatabase = text('expectedDatabase', 63);
  if (!DATABASE_NAME.test(expectedDatabase))
    throw new InputError('expectedDatabase must be a plain database name');
  if (forReissue) return { orgName, adminEmail, adminName: '', retentionDays: 0, expectedDatabase };
  const adminName = text('adminName', 200);
  const retentionDays = raw.retentionDays === undefined ? 90 : raw.retentionDays;
  if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 730) {
    throw new InputError('retentionDays must be a whole number from 7 to 730');
  }
  return { orgName, adminEmail, adminName, retentionDays, expectedDatabase };
}

/** Rejects with `Error('timeout')` when the promise does not settle in time (Redis can hang a producer). */
export function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
export const ENQUEUE_TIMEOUT_MS = 15_000;

async function enqueue(queue, orgId, userId) {
  try {
    await withTimeout(
      queue.add(JOB_NAME, { orgId, userId }, { jobId: jobIdFor(userId), ...JOB_OPTIONS }),
      ENQUEUE_TIMEOUT_MS,
    );
  } catch {
    throw new EnqueueError(orgId, userId);
  }
}

/**
 * Creates the organization, its first SUPER_ADMIN (no password, a placeholder token that is already
 * expired) and one audit row in one transaction, then queues the set-password job.
 * @returns {{ orgId: string, userId: string }}
 */
export async function provisionOrg({ prisma, queue, input, runId, now = () => new Date() }) {
  const secret = randomBytes(32);
  const placeholderHash = createHash('sha256').update(secret).digest('hex');
  secret.fill(0); // the cleartext is gone before anything is written
  const insertedAt = now();
  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: { name: input.orgName, retentionDays: input.retentionDays },
        select: { id: true },
      });
      const user = await tx.user.create({
        data: {
          orgId: org.id,
          email: input.adminEmail,
          fullName: input.adminName,
          role: 'SUPER_ADMIN',
          passwordHash: null,
          setPasswordTokenHash: placeholderHash,
          setPasswordExpiresAt: insertedAt, // never valid: the reset endpoint treats <= now() as expired
        },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: {
          orgId: org.id,
          actorId: null,
          action: ACTION_PROVISIONED,
          entityType: 'organization',
          entityId: org.id,
          metadata: { runId, orgId: org.id, userId: user.id },
        },
      });
      return { orgId: org.id, userId: user.id };
    });
  } catch (error) {
    // A unique violation on users.email: say so without the address (ADR 0006 8.9, ADR 0001 C-3).
    if (error?.code === 'P2002')
      throw new InputError('an admin user with that email already exists (nothing was created)');
    throw error;
  }
  await enqueue(queue, created.orgId, created.userId);
  return created;
}

/**
 * Queues the set-password job again for a SUPER_ADMIN of the named org who has no password.
 * @returns {{ orgId: string, userId: string }}
 */
export async function reissueSetPassword({ prisma, queue, input, runId }) {
  const user = await prisma.user.findFirst({
    where: {
      email: input.adminEmail,
      role: 'SUPER_ADMIN',
      passwordHash: null,
      isActive: true,
      org: { name: input.orgName },
    },
    select: { id: true, orgId: true },
  });
  if (!user)
    throw new InputError('no active SUPER_ADMIN without a password matches that org and email');
  await prisma.auditLog.create({
    data: {
      orgId: user.orgId,
      actorId: null,
      action: ACTION_REISSUED,
      entityType: 'user',
      entityId: user.id,
      metadata: { runId, orgId: user.orgId, userId: user.id },
    },
  });
  try {
    await enqueue(queue, user.orgId, user.id);
  } catch (error) {
    // The first row says a reissue was requested; this one says it did not reach the queue.
    await prisma.auditLog.create({
      data: {
        orgId: user.orgId,
        actorId: null,
        action: ACTION_REISSUE_FAILED,
        entityType: 'user',
        entityId: user.id,
        metadata: { runId, orgId: user.orgId, userId: user.id },
      },
    });
    throw error;
  }
  return { orgId: user.orgId, userId: user.id };
}
