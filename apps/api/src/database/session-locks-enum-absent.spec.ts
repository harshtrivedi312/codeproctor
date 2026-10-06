// guardLive when the generated `SessionStatus` enum has NO `ERASED`: a client generated before PR #91 (ADR 0004
// section 9, now on main). The generated enums module is replaced by one with ERASED removed, so the spec means the
// same whatever the real client has, and the real `guardLive` export is run: the load-time detection leaves the typed `NOT`
// condition out. The cases are shared with its twin session-locks-enum-erased.spec.ts
// (testing/guard-live-cases.ts).
//
// N1 (review of #208): the status that was READ is compared with the literal 'ERASED' in this mode too, so a
// client generated before the migration still fails closed on a row that reads ERASED: guardLive returns
// 'ERASED' and writes nothing. Tested below with a row that reads 'ERASED' although the enum has no such member.
// Fake transaction, no database. FR-704, NFR-05, NFR-04, TC-008, TC-094.
import { SessionStatus } from '../generated/prisma/enums.js';
import { guardLive, lockAnySession, lockForAccommodation } from './session-locks';
import { defineGuardLiveCases } from './testing/guard-live-cases';
import {
  FAKE_ERASED,
  SID,
  fakeTx,
  inService,
  inStaff,
  moving,
  shape,
  steady,
  updates,
} from './testing/session-lock-fakes';

jest.mock('../generated/prisma/enums.js', () => {
  const actual = jest.requireActual<typeof import('../generated/prisma/enums.js')>(
    '../generated/prisma/enums.js',
  );
  const withoutErased = Object.fromEntries(
    Object.entries(actual.SessionStatus).filter(([name]) => name !== 'ERASED'),
  );
  return { ...actual, SessionStatus: withoutErased };
});

describe('the mocked enum has no ERASED (the premise of this spec)', () => {
  it('TC-008 the generated enum module is replaced by one without ERASED', () => {
    expect(Object.hasOwn(SessionStatus, 'ERASED')).toBe(false);
    expect(Object.values(SessionStatus)).toContain('IN_PROGRESS');
  });
});

defineGuardLiveCases(guardLive, 'absent');

describe('a stale client: the enum has no ERASED but the row reads ERASED (N1, NFR-05, TC-094)', () => {
  it('NFR-05 TC-094 guardLive compares the status it read with the literal and fails closed: ERASED, nothing written', async () => {
    const { tx, calls } = fakeTx(steady(FAKE_ERASED));
    await expect(inService(() => guardLive(tx, SID))).resolves.toBe('ERASED');
    expect(shape(calls)).toBe('R');
    expect(updates(calls)).toHaveLength(0);
  });

  it('NFR-05 TC-094 the fence wins the race against a stale client too: 0 rows, the re-read reads ERASED, ERASED', async () => {
    const { tx, calls } = fakeTx(moving(['IN_PROGRESS', FAKE_ERASED]));
    await expect(inService(() => guardLive(tx, SID))).resolves.toBe('ERASED');
    expect(shape(calls)).toBe('RUR');
    // No NOT condition without the member: the `status: <read>` condition is what kept it from writing.
    expect(Object.hasOwn(updates(calls)[0]?.args.where ?? {}, 'NOT')).toBe(false);
  });

  // Each any-status lock in the scope it passes in: lockForAccommodation in STAFF, lockAnySession in SERVICE.
  it.each([
    ['lockForAccommodation', lockForAccommodation, inStaff],
    ['lockAnySession', lockAnySession, inService],
  ] as const)(
    'NFR-05 TC-094 %s still locks a row that reads ERASED: the reduction and the erasure-compatible jobs must run on it',
    async (_name, lock, inScope) => {
      const { tx, calls } = fakeTx(steady(FAKE_ERASED));
      await expect(inScope(() => lock(tx, SID))).resolves.toBe('ERASED');
      expect(updates(calls)[0]?.args.where).toEqual({ id: SID, status: FAKE_ERASED });
    },
  );

  it.each([
    ['lockForAccommodation', lockForAccommodation, inStaff],
    ['lockAnySession', lockAnySession, inService],
  ] as const)('TC-008 %s has the same where as guardLive here', async (_name, lock, inScope) => {
    const { tx, calls } = fakeTx(steady('COMPLETED'));
    await expect(inScope(() => lock(tx, SID))).resolves.toBe('COMPLETED');
    expect(updates(calls)[0]?.args.where).toEqual({ id: SID, status: 'COMPLETED' });
  });
});
