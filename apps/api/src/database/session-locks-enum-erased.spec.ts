// guardLive when the generated `SessionStatus` enum HAS `ERASED` (what main looks like once PR #91, ADR 0004
// section 9, has added it to session_status and the client is regenerated). On main today the enum lacks
// it, so this spec replaces the generated enums module with one that has it, and runs the real `guardLive`
// export: it proves the load-time detection (`Object.hasOwn(SessionStatus, 'ERASED')`) is wired in and that
// the typed `NOT: { status: 'ERASED' }` condition is in the update. The cases are shared with its twin
// session-locks-enum-absent.spec.ts (testing/guard-live-cases.ts), so neither depends on when #91 lands.
// Fake transaction, no database. FR-704, NFR-05, NFR-04, TC-008, TC-094.
import { SessionStatus } from '../generated/prisma/enums.js';
import { guardLive, lockAnySession, lockForAccommodation } from './session-locks';
import { defineGuardLiveCases } from './testing/guard-live-cases';
import { FAKE_ERASED, SID, fakeTx, inService, steady, updates } from './testing/session-lock-fakes';

jest.mock('../generated/prisma/enums.js', () => {
  const actual = jest.requireActual<typeof import('../generated/prisma/enums.js')>(
    '../generated/prisma/enums.js',
  );
  return { ...actual, SessionStatus: { ...actual.SessionStatus, ERASED: 'ERASED' } };
});

describe('the mocked enum has ERASED (the premise of this spec)', () => {
  it('TC-008 the generated enum module is replaced by one with ERASED', () => {
    expect(Object.hasOwn(SessionStatus, 'ERASED')).toBe(true);
    expect(Object.values(SessionStatus)).toContain('IN_PROGRESS');
  });
});

defineGuardLiveCases(guardLive, 'present');

describe('the any-status locks with an enum that has ERASED: NFR-05, TC-094', () => {
  it.each([
    ['lockForAccommodation', lockForAccommodation],
    ['lockAnySession', lockAnySession],
  ] as const)(
    'NFR-05 TC-094 %s is not affected: it locks an ERASED session, with no exclusion in the where',
    async (_name, lock) => {
      const { tx, calls } = fakeTx(steady(FAKE_ERASED));
      await expect(inService(() => lock(tx, SID))).resolves.toBe('ERASED');
      const [update] = updates(calls);
      expect(update?.args.where).toEqual({ id: SID, status: FAKE_ERASED });
      expect(Object.hasOwn(update?.args.where ?? {}, 'NOT')).toBe(false);
    },
  );
});
