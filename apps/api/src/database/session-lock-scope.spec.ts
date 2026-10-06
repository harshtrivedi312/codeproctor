// The actor allowlist of the session locks (session-lock-scope.ts), on synthetic scope values: no database, no
// context. The scopes that no public entry can build (a kind that does not exist today, an unknown actor) are
// built by hand here, which is the point of a pure function. The same rules through the real locks and the
// real OrgContextService are in session-locks.spec.ts. NFR-04, TC-008.
import type { OrgScope } from './org-context';
import { lockScopeRefusal } from './session-lock-scope';

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

describe('lockScopeRefusal: the strict allowlist (guardLive, lockAnySession): NFR-04, TC-008', () => {
  it('TC-008 SERVICE and STAFF pass', () => {
    expect(lockScopeRefusal(service)).toBeUndefined();
    expect(lockScopeRefusal(staff)).toBeUndefined();
  });

  it.each([
    ['a CANDIDATE scope', candidate, /CANDIDATE scope/],
    ['system scope', system, /system scope/],
    ['a plain org scope with no actor (runInOrg)', plainOrg, /plain org scope/],
    ['no scope at all', undefined, /no scope at all/],
    ['a scope kind that does not exist today', futureKind, /this kind of scope/],
    ['a scope without a kind', noKind, /this kind of scope/],
    ['an actor that does not exist today', futureActor, /this actor/],
  ] as const)(
    'TC-008 %s is refused, with a message that names no value',
    (_what, scope, pattern) => {
      const message = lockScopeRefusal(scope);
      expect(message).toMatch(pattern);
      expect(message).not.toContain(ORG);
      expect(message).not.toContain(SID);
      expect(message).not.toContain('RECRUITER');
    },
  );

  it('TC-008 an unknown kind or actor is refused even though it carries a user or an org, and a staff user inside a session scope follows the actor', () => {
    expect(
      lockScopeRefusal({ kind: 'platform', orgId: ORG, user: USER } as unknown as OrgScope),
    ).toBeDefined();
    expect(
      lockScopeRefusal({
        kind: 'org',
        orgId: ORG,
        user: USER,
        session: { actor: 'CANDIDATE', sessionId: SID },
      }),
    ).toMatch(/CANDIDATE/);
  });
});

describe('lockScopeRefusal with allowPlainOrg (lockForAccommodation only): NFR-04, TC-008', () => {
  it('TC-008 a plain org scope passes, and SERVICE and STAFF still do', () => {
    expect(lockScopeRefusal(plainOrg, true)).toBeUndefined();
    expect(lockScopeRefusal(service, true)).toBeUndefined();
    expect(lockScopeRefusal(staff, true)).toBeUndefined();
  });

  it.each([
    ['a CANDIDATE scope', candidate],
    ['system scope', system],
    ['no scope at all', undefined],
    ['a scope kind that does not exist today', futureKind],
    ['a scope without a kind', noKind],
    ['an actor that does not exist today', futureActor],
  ] as const)('TC-008 %s is still refused', (_what, scope) => {
    expect(lockScopeRefusal(scope, true)).toBeDefined();
  });
});
