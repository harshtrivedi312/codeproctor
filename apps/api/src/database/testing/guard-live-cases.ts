// The guardLive cases that depend on what the generated `SessionStatus` enum looks like, written once and run
// by the two mocked-enum specs (session-locks-enum-erased.spec.ts: the enum HAS ERASED, as after PR #91;
// session-locks-enum-absent.spec.ts: it has NONE, as on main before it). Each spec replaces the generated enums
// module with jest.mock, so the real `guardLive` export is run in the mode, and the cases mean the same
// whenever #91 lands. `guardLiveWith` no longer exists: nothing else takes the member as a parameter.
//
// Both modes share one rule (N1): the status that was READ is compared with the literal 'ERASED', so a client
// generated before the migration still fails closed on a row that reads ERASED. They differ in one thing: the
// typed `NOT: { status: 'ERASED' }` condition is in the update's where only when the enum has the member.
// FR-704, NFR-05 (erasure), NFR-04, TC-008, TC-094.
import { SessionStatus } from '../../generated/prisma/enums.js';
import { OrgScopeError, SessionLockRetryError, SessionNotFoundError } from '../errors';
import { MAX_LOCK_ATTEMPTS } from '../session-locks';
import type { GuardLiveResult, SessionLockTx } from '../session-locks';
import {
  FAKE_ERASED,
  SID,
  fakeTx,
  inService,
  moving,
  reads,
  shape,
  steady,
  updates,
} from './session-lock-fakes';

export type EnumMode = 'present' | 'absent';

const readsAsErased = (status: string): boolean => status === 'ERASED';

export function defineGuardLiveCases(
  guardLive: (tx: SessionLockTx, sessionId: string) => Promise<GuardLiveResult>,
  mode: EnumMode,
): void {
  const withNot = mode === 'present';
  const run = (tx: SessionLockTx) => inService(() => guardLive(tx, SID));

  describe(`guardLive (ADR 0013 section 5.7), the enum has ${withNot ? '' : 'no '}ERASED: the lock call, FR-704, NFR-04, TC-008`, () => {
    it("TC-008 reads the status in the caller's scope, then writes the SAME status once: one read, one updateMany", async () => {
      const { tx, calls } = fakeTx(steady('IN_PROGRESS'));
      await expect(run(tx)).resolves.toBe('LIVE');
      expect(shape(calls)).toBe('RU');
      expect(reads(calls)[0]).toEqual({
        op: 'findUnique',
        args: { where: { id: SID }, select: { status: true } },
      });
      const where = withNot
        ? { id: SID, status: 'IN_PROGRESS', NOT: { status: FAKE_ERASED } }
        : { id: SID, status: 'IN_PROGRESS' };
      expect(updates(calls)[0]?.args).toEqual({ where, data: { status: 'IN_PROGRESS' } });
    });

    it('TC-008 the compare-and-set names the status that was read, for every status the enum has', async () => {
      for (const status of Object.values(SessionStatus)) {
        if (readsAsErased(status)) continue; // an ERASED row is not locked (below)
        const { tx, calls } = fakeTx(steady(status));
        await expect(run(tx)).resolves.toBe('LIVE');
        const [update] = updates(calls);
        expect(update?.args.where.status).toBe(status);
        expect(update?.args.data).toEqual({ status });
      }
    });

    it('TC-008 the ERASED condition is in the where exactly when the enum has the member', async () => {
      const { tx, calls } = fakeTx(steady('PAUSED'));
      await run(tx);
      const where = updates(calls)[0]?.args.where;
      expect(Object.hasOwn(where ?? {}, 'NOT')).toBe(withNot);
      if (withNot) expect(where?.NOT).toEqual({ status: FAKE_ERASED });
    });

    it('TC-008 no row (another org, unknown id) throws SessionNotFoundError and sends no update', async () => {
      const { tx, calls } = fakeTx({ read: () => null, update: () => 1 });
      await expect(run(tx)).rejects.toBeInstanceOf(SessionNotFoundError);
      expect(shape(calls)).toBe('R');
    });

    it('TC-008 0 rows, then the re-read finds another status: retries on THAT status and returns LIVE', async () => {
      const { tx, calls } = fakeTx(moving(['OPENED', 'CONSENTED'], 1));
      await expect(run(tx)).resolves.toBe('LIVE');
      expect(shape(calls)).toBe('RURU');
      expect(updates(calls).map((c) => c.args.where.status)).toEqual(['OPENED', 'CONSENTED']);
      expect(updates(calls).map((c) => c.args.data)).toEqual([
        { status: 'OPENED' },
        { status: 'CONSENTED' },
      ]);
    });

    it('TC-008 retries at most 3 times in total, then throws SessionLockRetryError', async () => {
      expect(MAX_LOCK_ATTEMPTS).toBe(3);
      const { tx, calls } = fakeTx(moving(['OPENED', 'CONSENTED', 'VERIFIED', 'IN_PROGRESS']));
      await expect(run(tx)).rejects.toBeInstanceOf(SessionLockRetryError);
      // Three updates. The re-read after the last lost update decides ERASED or not; it is not a fourth try.
      expect(updates(calls)).toHaveLength(3);
      expect(shape(calls)).toBe('RURURUR');
    });

    it('TC-008 the third try may still win: 2 lost updates, then LIVE', async () => {
      const { tx, calls } = fakeTx(moving(['OPENED', 'CONSENTED', 'VERIFIED'], 2));
      await expect(run(tx)).resolves.toBe('LIVE');
      expect(shape(calls)).toBe('RURURU');
    });

    it('TC-008 a row that vanishes between the tries throws SessionNotFoundError, not a retry error', async () => {
      const { tx } = fakeTx({ read: (n) => (n === 0 ? 'OPENED' : null), update: () => 0 });
      await expect(run(tx)).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    it('TC-008 an error from the database is not retried and is not swallowed', async () => {
      const boom = new Error('connection lost');
      const calls: string[] = [];
      const tx: SessionLockTx = {
        session: {
          findUnique: () => Promise.resolve({ status: 'OPENED' }),
          updateMany: () => {
            calls.push('U');
            return Promise.reject(boom);
          },
        },
      };
      await expect(run(tx)).rejects.toBe(boom);
      expect(calls).toEqual(['U']);
    });

    it('TC-008 the errors carry no value: never the session id', async () => {
      for (const make of [
        () => run(fakeTx({ read: () => null, update: () => 1 }).tx),
        () => run(fakeTx(moving(['OPENED', 'CONSENTED', 'VERIFIED', 'IN_PROGRESS'])).tx),
      ]) {
        const error = await make().then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(Error);
        expect(JSON.stringify(error)).not.toContain(SID);
        expect(String((error as Error).message)).not.toContain(SID);
        expect((error as Error).stack ?? '').not.toContain(SID);
        expect(error).not.toBeInstanceOf(OrgScopeError);
      }
    });

    describe('a row that reads ERASED (the fence, ADR 0004 section 9): NFR-05, TC-094', () => {
      it('NFR-05 TC-094 a read status of ERASED returns ERASED and writes nothing', async () => {
        const { tx, calls } = fakeTx(steady(FAKE_ERASED));
        await expect(run(tx)).resolves.toBe('ERASED');
        expect(shape(calls)).toBe('R');
        expect(updates(calls)).toHaveLength(0);
      });

      it('NFR-05 TC-094 0 rows and a re-read of ERASED returns ERASED: the fence won the race, nothing is written', async () => {
        const { tx, calls } = fakeTx(moving(['IN_PROGRESS', FAKE_ERASED]));
        await expect(run(tx)).resolves.toBe('ERASED');
        expect(shape(calls)).toBe('RUR');
        expect(updates(calls)).toHaveLength(1);
        expect(updates(calls)[0]?.args.where.status).toBe('IN_PROGRESS');
      });

      it('NFR-05 TC-094 no update ever writes ERASED, and the ones that lost carry the NOT condition exactly when the enum has the member', async () => {
        const { tx, calls } = fakeTx(moving(['IN_PROGRESS', 'SUBMITTED', FAKE_ERASED]));
        await expect(run(tx)).resolves.toBe('ERASED');
        for (const update of updates(calls)) {
          expect(update.args.data).not.toEqual({ status: FAKE_ERASED });
          expect(Object.hasOwn(update.args.where, 'NOT')).toBe(withNot);
          if (withNot) expect(update.args.where.NOT).toEqual({ status: FAKE_ERASED });
        }
      });

      it('NFR-05 TC-094 the last lost try re-reads too: ERASED there is ERASED, not a retry error', async () => {
        const { tx, calls } = fakeTx(moving(['OPENED', 'CONSENTED', 'VERIFIED', FAKE_ERASED]));
        await expect(run(tx)).resolves.toBe('ERASED');
        expect(updates(calls)).toHaveLength(3);
        expect(shape(calls)).toBe('RURURUR');
      });

      it('NFR-05 TC-094 any other status never makes it return ERASED', async () => {
        for (const status of Object.values(SessionStatus)) {
          if (readsAsErased(status)) continue;
          const { tx } = fakeTx(steady(status));
          await expect(run(tx)).resolves.toBe('LIVE');
        }
      });
    });
  });
}
