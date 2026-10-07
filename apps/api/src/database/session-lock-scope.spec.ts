// The per-lock actor allowlists of the session locks (session-lock-scope.ts), on synthetic scope values: no database,
// no context. The scopes that no public entry can build (a kind that does not exist today, an unknown actor) are
// built by hand here, which is the point of a pure function. The expected matrix below is written out BY HAND from the
// merged ADR 0006 section 8.5 (#211, #213), not read from LOCK_SCOPE_POLICY, so a change of the table fails here.
// The same rules through the real locks and the real OrgContextService are in session-locks.spec.ts. NFR-04, TC-008.
import type { OrgScope } from './org-context';
import { LOCK_SCOPE_POLICY, lockScopeRefusal } from './session-lock-scope';

const ORG = '55555555-5555-4555-8555-555555555555';
const SID = '66666666-6666-4666-8666-666666666666';
const USER = { orgId: ORG, userId: SID, role: 'RECRUITER' } as const;

const service: OrgScope = {
  kind: 'org',
  orgId: ORG,
  session: { actor: 'SERVICE', sessionId: SID },
};
const candidate: OrgScope = {
  kind: 'org',
  orgId: ORG,
  session: { actor: 'CANDIDATE', sessionId: SID },
};
const staff: OrgScope = { kind: 'org', orgId: ORG, user: USER };
const plainOrg: OrgScope = { kind: 'org', orgId: ORG };
const system: OrgScope = { kind: 'system', reason: 'BACKGROUND_JOB' };
/** A scope kind that does not exist today, and an actor that does not exist today. */
const futureKind = { kind: 'platform', orgId: ORG } as unknown as OrgScope;
const futureActor = {
  kind: 'org',
  orgId: ORG,
  session: { actor: 'AUDITOR', sessionId: SID },
} as unknown as OrgScope;
const noKind = {} as unknown as OrgScope;

type LockName = keyof typeof LOCK_SCOPE_POLICY;

/** What each lock passes in, by hand from ADR 0006 section 8.5: true = allowed, false = refused. */
const MATRIX: Record<LockName, Array<[string, OrgScope | undefined, boolean]>> = {
  guardLive: [
    ['SERVICE', service, true],
    ['STAFF', staff, true],
    ['plain org', plainOrg, false],
    ['CANDIDATE', candidate, false],
    ['system', system, false],
    ['no scope', undefined, false],
    ['unknown kind', futureKind, false],
    ['no kind', noKind, false],
    ['unknown actor', futureActor, false],
  ],
  lockAnySession: [
    ['SERVICE', service, true],
    ['STAFF', staff, false],
    ['plain org', plainOrg, false],
    ['CANDIDATE', candidate, false],
    ['system', system, false],
    ['no scope', undefined, false],
    ['unknown kind', futureKind, false],
    ['no kind', noKind, false],
    ['unknown actor', futureActor, false],
  ],
  lockForAccommodation: [
    ['SERVICE', service, false],
    ['STAFF', staff, true],
    ['plain org', plainOrg, true],
    ['CANDIDATE', candidate, false],
    ['system', system, false],
    ['no scope', undefined, false],
    ['unknown kind', futureKind, false],
    ['no kind', noKind, false],
    ['unknown actor', futureActor, false],
  ],
};

describe.each(Object.keys(MATRIX) as LockName[])(
  'lockScopeRefusal for %s: the merged ADR 0006 section 8.5 (NFR-04, TC-008)',
  (lock) => {
    it.each(MATRIX[lock])('TC-008 %s', (_what, scope, allowed) => {
      const message = lockScopeRefusal(scope, LOCK_SCOPE_POLICY[lock]);
      expect(message === undefined).toBe(allowed);
      if (message !== undefined) {
        // A refusal names no value.
        expect(message).not.toContain(ORG);
        expect(message).not.toContain(SID);
        expect(message).not.toContain('RECRUITER');
      }
    });
  },
);

describe('lockScopeRefusal: the messages say what is refused and what is allowed (NFR-04, TC-008)', () => {
  it('TC-008 each refusal names its case, and the allowed scopes of THAT lock', () => {
    const g = LOCK_SCOPE_POLICY.guardLive;
    const a = LOCK_SCOPE_POLICY.lockAnySession;
    const c = LOCK_SCOPE_POLICY.lockForAccommodation;
    expect(lockScopeRefusal(candidate, g)).toMatch(/CANDIDATE scope/);
    expect(lockScopeRefusal(system, g)).toMatch(/system scope/i);
    expect(lockScopeRefusal(undefined, g)).toMatch(/no scope at all/);
    expect(lockScopeRefusal(futureKind, g)).toMatch(/this kind of scope/);
    expect(lockScopeRefusal(futureActor, g)).toMatch(/this actor/);
    expect(lockScopeRefusal(plainOrg, g)).toMatch(/plain org scope/);
    expect(lockScopeRefusal(plainOrg, g)).toMatch(/SERVICE.*or.*STAFF/);
    expect(lockScopeRefusal(staff, a)).toMatch(/refused in a STAFF scope: only a SERVICE scope/);
    expect(lockScopeRefusal(service, c)).toMatch(
      /refused in a SERVICE scope: only a STAFF scope.* or a plain org job scope/,
    );
  });

  it('TC-008 an unknown kind or actor is refused even though it carries a user or an org, and a staff user inside a session scope follows the actor', () => {
    for (const lock of Object.keys(LOCK_SCOPE_POLICY) as LockName[]) {
      const policy = LOCK_SCOPE_POLICY[lock];
      expect(
        lockScopeRefusal(
          { kind: 'platform', orgId: ORG, user: USER } as unknown as OrgScope,
          policy,
        ),
      ).toBeDefined();
      expect(
        lockScopeRefusal(
          {
            kind: 'org',
            orgId: ORG,
            user: USER,
            session: { actor: 'CANDIDATE', sessionId: SID },
          },
          policy,
        ),
      ).toMatch(/CANDIDATE/);
    }
  });

  it('TC-008 the policy table is the one of the merged ADR: exactly these three locks, exactly these scopes', () => {
    expect(LOCK_SCOPE_POLICY).toEqual({
      guardLive: { service: true, staff: true, plainOrg: false },
      lockAnySession: { service: true, staff: false, plainOrg: false },
      lockForAccommodation: { service: false, staff: true, plainOrg: true },
    });
  });
});

describe('the policy table is frozen and the scope shape fails closed (S-A and N-a of the re-review of #208): NFR-04, TC-008', () => {
  it('TC-008 S-A the policy table and every policy in it are frozen: a write throws, and the allowlist stays as it was', () => {
    expect(Object.isFrozen(LOCK_SCOPE_POLICY)).toBe(true);
    for (const lock of Object.keys(LOCK_SCOPE_POLICY) as LockName[]) {
      expect({ lock, frozen: Object.isFrozen(LOCK_SCOPE_POLICY[lock]) }).toEqual({
        lock,
        frozen: true,
      });
    }
    expect(() => {
      (LOCK_SCOPE_POLICY.lockAnySession as { staff: boolean }).staff = true;
    }).toThrow(TypeError);
    expect(() => {
      (LOCK_SCOPE_POLICY as unknown as Record<string, unknown>)['sneaky'] = {
        service: true,
        staff: true,
        plainOrg: true,
      };
    }).toThrow(TypeError);
    expect(() => {
      delete (LOCK_SCOPE_POLICY as unknown as Record<string, unknown>)['guardLive'];
    }).toThrow(TypeError);
    // Still refused after the attempts.
    expect(lockScopeRefusal(staff, LOCK_SCOPE_POLICY.lockAnySession)).toBeDefined();
    expect(lockScopeRefusal(service, LOCK_SCOPE_POLICY.lockForAccommodation)).toBeDefined();
  });

  const shapes: Array<[string, unknown]> = [
    ['a null session', { kind: 'org', orgId: ORG, session: null }],
    ['a string session', { kind: 'org', orgId: ORG, session: 'SERVICE' }],
    ['a boolean session', { kind: 'org', orgId: ORG, session: true }],
    ['a null user', { kind: 'org', orgId: ORG, user: null }],
    ['a string user', { kind: 'org', orgId: ORG, user: 'staff' }],
    ['a boolean user', { kind: 'org', orgId: ORG, user: true }],
    ['a numeric user', { kind: 'org', orgId: ORG, user: 1 }],
    ['a null session and a real user', { kind: 'org', orgId: ORG, session: null, user: USER }],
  ];

  describe.each(Object.keys(LOCK_SCOPE_POLICY) as LockName[])(
    '%s: a malformed scope is refused',
    (lock) => {
      it.each(shapes)('TC-008 N-a %s, with a message that names no value', (_what, scope) => {
        const message = lockScopeRefusal(scope as OrgScope, LOCK_SCOPE_POLICY[lock]);
        expect(message).toMatch(/unexpected shape/);
        expect(message).not.toContain(ORG);
        expect(message).not.toContain(SID);
      });
    },
  );

  it('TC-008 N-a an object user or session still follows its own rule, and an undefined one is simply absent', () => {
    const undefinedUser = { kind: 'org', orgId: ORG, user: undefined } as OrgScope;
    expect(lockScopeRefusal(undefinedUser, LOCK_SCOPE_POLICY.lockForAccommodation)).toBeUndefined();
    expect(lockScopeRefusal(undefinedUser, LOCK_SCOPE_POLICY.guardLive)).toMatch(/plain org scope/);
    expect(lockScopeRefusal(staff, LOCK_SCOPE_POLICY.guardLive)).toBeUndefined();
    expect(lockScopeRefusal(service, LOCK_SCOPE_POLICY.guardLive)).toBeUndefined();
  });
});
