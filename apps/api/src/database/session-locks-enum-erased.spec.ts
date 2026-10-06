// guardLive when the generated `SessionStatus` enum HAS `ERASED` (what main looks like once PR #91, ADR 0004
// section 9, has added it to session_status and the client is regenerated). On main today the enum lacks
// it, so this spec replaces the generated enums module with one that has it, and runs the real `guardLive`
// export, not the injectable inner function: it proves the load-time detection
// (`Object.hasOwn(SessionStatus, 'ERASED')`) is wired in. Its twin session-locks-enum-absent.spec.ts does
// the same for an enum without ERASED, so neither depends on when #91 lands. Fake transaction, no
// database. FR-704, NFR-04, TC-008.
import { guardLive, lockAnySession, lockForAccommodation } from './session-locks';
import type { SessionLockTx, SessionLockWhere } from './session-locks';
import type { SessionStatus } from '../generated/prisma/enums.js';

jest.mock('../generated/prisma/enums.js', () => {
  const actual = jest.requireActual<typeof import('../generated/prisma/enums.js')>(
    '../generated/prisma/enums.js',
  );
  return { ...actual, SessionStatus: { ...actual.SessionStatus, ERASED: 'ERASED' } };
});

const SID = '22222222-2222-4222-8222-222222222222';
const ERASED = 'ERASED' as string as SessionStatus;

/** A transaction whose reads return `reads` in turn (the last one repeats) and whose updates return `counts`. */
function fakeTx(reads: readonly SessionStatus[], counts: readonly number[]) {
  const wheres: SessionLockWhere[] = [];
  const data: unknown[] = [];
  let r = 0;
  let u = 0;
  const tx: SessionLockTx = {
    session: {
      findUnique: () => {
        const status = reads[Math.min(r, reads.length - 1)] as SessionStatus;
        r += 1;
        return Promise.resolve({ status });
      },
      updateMany: (args) => {
        wheres.push(args.where);
        data.push(args.data);
        const count = counts[u] ?? 0;
        u += 1;
        return Promise.resolve({ count });
      },
    },
  };
  return { tx, wheres, data };
}

describe('guardLive with an enum that has ERASED (the real export, ADR 0013 section 5.7)', () => {
  it('TC-008 the update excludes ERASED: NOT { status: ERASED } is in the where', async () => {
    const { tx, wheres, data } = fakeTx(['IN_PROGRESS'], [1]);
    await expect(guardLive(tx, SID)).resolves.toBe('LIVE');
    expect(wheres).toEqual([{ id: SID, status: 'IN_PROGRESS', NOT: { status: ERASED } }]);
    expect(data).toEqual([{ status: 'IN_PROGRESS' }]);
  });

  it('TC-008 a session that reads as ERASED returns ERASED and writes nothing', async () => {
    const { tx, wheres } = fakeTx([ERASED], [1]);
    await expect(guardLive(tx, SID)).resolves.toBe('ERASED');
    expect(wheres).toEqual([]);
  });

  it('TC-008 the fence commits between the read and the update: 0 rows, the re-read says ERASED, ERASED is returned', async () => {
    const { tx, wheres } = fakeTx(['IN_PROGRESS', ERASED], [0, 1]);
    await expect(guardLive(tx, SID)).resolves.toBe('ERASED');
    expect(wheres).toHaveLength(1);
  });

  it.each([
    ['lockForAccommodation', lockForAccommodation],
    ['lockAnySession', lockAnySession],
  ] as const)(
    'TC-008 %s is not affected: it locks an ERASED session, with no exclusion in the where',
    async (_name, lock) => {
      const { tx, wheres } = fakeTx([ERASED], [1]);
      await expect(lock(tx, SID)).resolves.toBe('ERASED');
      expect(wheres).toEqual([{ id: SID, status: ERASED }]);
      expect(Object.hasOwn(wheres[0] ?? {}, 'NOT')).toBe(false);
    },
  );
});
