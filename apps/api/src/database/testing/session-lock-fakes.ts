// A fake transaction client for the session-lock tests (session-locks.spec.ts and the two mocked-enum specs):
// no database. It records every call, so a test pins the exact statements the locks ask for, and a loop that
// never ends (a mutation) fails the test instead of hanging it. Synthetic data only.
import type { SessionStatus } from '../../generated/prisma/enums.js';
import { OrgContextService } from '../org-context';
import type { SessionLockTx, SessionLockWhere } from '../session-locks';

export const SID = '11111111-1111-4111-8111-111111111111';
export const ORG = '44444444-4444-4444-8444-444444444444';

const orgContext = new OrgContextService();

/**
 * Runs `fn` in a SERVICE session scope (`runAsSessionJob`), the scope the locks need: they refuse a call with
 * no scope at all. The fake transaction ignores the scope; only the refusal looks at it. The test body must be
 * outside any scope (runAsSessionJob is allowed from no scope only).
 */
export const inService = <T>(fn: () => Promise<T>): Promise<T> =>
  orgContext.runAsSessionJob(ORG, SID, fn);

/** Stands in for `SessionStatus.ERASED` while the generated enum lacks it. Valid after #91 too. */
export const FAKE_ERASED = 'ERASED' as string as SessionStatus;

export type Call =
  | { readonly op: 'findUnique'; readonly args: unknown }
  | { readonly op: 'updateMany'; readonly args: { where: SessionLockWhere; data: unknown } };

export interface Script {
  /** The status the n-th read (from 0) returns; null is "no row". */
  readonly read: (n: number) => SessionStatus | null;
  /** The row count of the n-th update (from 0). */
  readonly update: (n: number, where: SessionLockWhere) => number;
}

/** A hard cap, so a loop that never ends (a mutation) fails the test instead of hanging it. */
const RUNAWAY = 40;

export function fakeTx(script: Script): { tx: SessionLockTx; calls: Call[] } {
  const calls: Call[] = [];
  let reads = 0;
  let updates = 0;
  const guardRunaway = (): void => {
    if (calls.length > RUNAWAY) throw new Error('runaway: the lock loop does not end');
  };
  const tx: SessionLockTx = {
    session: {
      findUnique: (args) => {
        calls.push({ op: 'findUnique', args });
        guardRunaway();
        const status = script.read(reads);
        reads += 1;
        return Promise.resolve(status === null ? null : { status });
      },
      updateMany: (args) => {
        calls.push({ op: 'updateMany', args });
        guardRunaway();
        const count = script.update(updates, args.where);
        updates += 1;
        return Promise.resolve({ count });
      },
    },
  };
  return { tx, calls };
}

export const reads = (calls: readonly Call[]): Call[] => calls.filter((c) => c.op === 'findUnique');
export const updates = (calls: readonly Call[]): Array<Extract<Call, { op: 'updateMany' }>> =>
  calls.filter((c): c is Extract<Call, { op: 'updateMany' }> => c.op === 'updateMany');

/** The order of the calls: R for a read, U for an update. */
export const shape = (calls: readonly Call[]): string =>
  calls.map((c) => (c.op === 'findUnique' ? 'R' : 'U')).join('');

/** One row of status `status`, and every update wins. */
export const steady = (status: SessionStatus): Script => ({
  read: () => status,
  update: () => 1,
});

/** The status read changes with each read; every update loses until `winAt` (never, by default). */
export const moving = (
  statuses: readonly SessionStatus[],
  winAt = Number.POSITIVE_INFINITY,
): Script => ({
  read: (n) => statuses[Math.min(n, statuses.length - 1)] ?? null,
  update: (n) => (n >= winAt ? 1 : 0),
});
