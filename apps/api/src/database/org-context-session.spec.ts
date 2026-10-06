// ADR 0013 CS-4.1 and CS-4.4 (the candidate facts), ADR 0006 sections 8.4 and 8.5: the two session
// actors, how they are entered, what may be nested inside them, detachForSessionJob, and the
// candidate-facts setter. No database: this is the context alone (NFR-04, TC-008).
import { setCandidateFacts } from './candidate-facts';
import { OrgContextMissingError, OrgScopeViolationError } from './errors';
import * as barrel from './index';
import { OrgContextService, SYSTEM_SCOPE_REASONS } from './org-context';
import type { AuthenticatedUser, CandidateFacts, Scoped, SystemScopeReason } from './org-context';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const SESSION_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const SESSION_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const USER_A: AuthenticatedUser = {
  orgId: ORG_A,
  userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  role: 'RECRUITER',
};
const FACTS: CandidateFacts = {
  candidateId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
  invitationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
  testId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3',
};

const REASONS = Object.keys(SYSTEM_SCOPE_REASONS) as SystemScopeReason[];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Entry = 'runAsCandidate' | 'runAsSessionJob';
const ENTRIES: ReadonlyArray<readonly [Entry, 'CANDIDATE' | 'SERVICE']> = [
  ['runAsCandidate', 'CANDIDATE'],
  ['runAsSessionJob', 'SERVICE'],
];

describe('session scopes: entry and actor (ADR 0013 CS-4.1; NFR-04, TC-008)', () => {
  const svc = new OrgContextService();

  /** Enter the session scope through `entry`, with the actor the entry sets. */
  function enterSession<T>(
    entry: Entry,
    fn: () => T,
    orgId = ORG_A,
    sessionId = SESSION_1,
  ): Scoped<T> {
    return svc[entry](orgId, sessionId, fn);
  }

  it.each(ENTRIES)(
    'TC-008 %s from no scope sets the actor %s, the org and the session, and frozen',
    (entry, actor) => {
      enterSession(entry, () => {
        const scope = svc.current()?.scope;
        expect(scope).toEqual({
          kind: 'org',
          orgId: ORG_A,
          session: { actor, sessionId: SESSION_1 },
        });
        expect(svc.requireOrgId()).toBe(ORG_A);
        // A session scope has no staff user.
        expect(() => svc.requireUser()).toThrow(OrgContextMissingError);
        expect(Object.isFrozen(svc.current())).toBe(true);
        expect(Object.isFrozen(scope)).toBe(true);
        expect(Object.isFrozen(scope?.kind === 'org' ? scope.session : undefined)).toBe(true);
        expect(() => {
          (scope as unknown as { session: { actor: string } }).session.actor = 'SERVICE';
        }).toThrow(TypeError);
      });
      expect(svc.current()).toBeUndefined();
    },
  );

  it('TC-008 the actor is set by the entry and cannot be passed in', () => {
    // The entries take (orgId, sessionId, fn): an extra argument is not an actor.
    const forged = (...args: unknown[]): unknown =>
      (svc.runAsSessionJob as unknown as (...a: unknown[]) => unknown).apply(svc, args);
    const actorOf = (): string | undefined => {
      const scope = svc.current()?.scope;
      return scope?.kind === 'org' ? scope.session?.actor : undefined;
    };
    expect(forged(ORG_A, SESSION_1, actorOf, 'CANDIDATE')).toBe('SERVICE');
    expect(svc.runAsCandidate(ORG_A, SESSION_1, actorOf)).toBe('CANDIDATE');
  });

  it.each(ENTRIES)('TC-008 %s validates both ids as uuids', (entry) => {
    for (const bad of ['', 'org-1', 'not-a-uuid', '11111111-1111-4111-8111-11111111111g']) {
      expect(() => svc[entry](bad, SESSION_1, () => undefined)).toThrow(OrgScopeViolationError);
      expect(() => svc[entry](ORG_A, bad, () => undefined)).toThrow(OrgScopeViolationError);
    }
    expect(() => svc[entry](undefined as unknown as string, SESSION_1, () => 1)).toThrow(
      OrgScopeViolationError,
    );
    expect(() => svc[entry](ORG_A, null as unknown as string, () => 1)).toThrow(
      OrgScopeViolationError,
    );
    // A refused entry never ran fn and left no context behind.
    expect(svc.current()).toBeUndefined();
  });

  it.each(ENTRIES)('TC-008 %s returns a native Promise for a returned thenable', async (entry) => {
    const lazy = {
      then: (resolve: (id: string | undefined) => void): void => {
        const scope = svc.current()?.scope;
        resolve(scope?.kind === 'org' ? scope.session?.sessionId : undefined);
      },
    };
    const result = enterSession(entry, () => lazy as unknown as Promise<string>);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe(SESSION_1);
  });

  it.each(ENTRIES)(
    'TC-008 %s follows awaited work, timers and concurrent scopes',
    async (entry) => {
      const work = (sessionId: string, delay: number): Promise<string[]> =>
        svc[entry](ORG_A, sessionId, async () => {
          const read = (): string => {
            const scope = svc.current()?.scope;
            return scope?.kind === 'org' ? (scope.session?.sessionId ?? 'none') : 'none';
          };
          const seen = [read()];
          await sleep(delay);
          seen.push(read());
          seen.push(await new Promise<string>((resolve) => setImmediate(() => resolve(read()))));
          return seen;
        });
      const runs = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          work(i % 2 === 0 ? SESSION_1 : SESSION_2, 1 + (i % 4)),
        ),
      );
      runs.forEach((seen, i) => {
        const expected = i % 2 === 0 ? SESSION_1 : SESSION_2;
        expect(seen).toEqual([expected, expected, expected]);
      });
      expect(svc.current()).toBeUndefined();
    },
  );

  describe.each(ENTRIES)('%s is allowed from no scope only', (entry) => {
    it('TC-008 refused inside a staff scope and a plain org scope', () => {
      const fn = jest.fn((): undefined => undefined);
      svc.runAsUser(USER_A, () => {
        expect(() => svc[entry](ORG_A, SESSION_1, fn)).toThrow(OrgScopeViolationError);
      });
      svc.runInOrg(ORG_A, () => {
        expect(() => svc[entry](ORG_A, SESSION_1, fn)).toThrow(OrgScopeViolationError);
        // Not even another org's, and not a narrowing of the same org.
        expect(() => svc[entry](ORG_B, SESSION_1, fn)).toThrow(OrgScopeViolationError);
      });
      expect(fn).not.toHaveBeenCalled();
    });

    it.each(REASONS)('TC-008 refused inside system scope %s', (reason) => {
      const fn = jest.fn((): undefined => undefined);
      svc.runSystem(reason, () => {
        expect(() => svc[entry](ORG_A, SESSION_1, fn)).toThrow(OrgScopeViolationError);
      });
      expect(fn).not.toHaveBeenCalled();
    });

    it('TC-008 refused inside an open runRawSql hatch, so no hatch can carry into a session scope', () => {
      const fn = jest.fn((): undefined => undefined);
      svc.runSystem('BACKGROUND_JOB', () => {
        svc.runRawSql('one reviewed raw statement for the test', () => {
          expect(() => svc[entry](ORG_A, SESSION_1, fn)).toThrow(OrgScopeViolationError);
        });
      });
      svc.runInOrg(ORG_A, () => {
        svc.runRawSql('one reviewed raw statement for the test', () => {
          expect(() => svc[entry](ORG_A, SESSION_1, fn)).toThrow(OrgScopeViolationError);
        });
      });
      expect(fn).not.toHaveBeenCalled();
    });

    it('TC-008 refused inside a session scope: the same scope again, another session, another org', () => {
      // ADR 0006 section 8.4 lists "same actor, same ids: allowed, no change"; ADR 0013 CS-4.1 and the
      // task say "no scope only". The stricter reading is built (FU-DB-180).
      const fn = jest.fn((): undefined => undefined);
      enterSession(entry, () => {
        expect(() => svc[entry](ORG_A, SESSION_1, fn)).toThrow(OrgScopeViolationError);
        expect(() => svc[entry](ORG_A, SESSION_2, fn)).toThrow(OrgScopeViolationError);
        expect(() => svc[entry](ORG_B, SESSION_1, fn)).toThrow(OrgScopeViolationError);
      });
      expect(fn).not.toHaveBeenCalled();
    });
  });

  it('TC-008 the other actor cannot be entered from a session scope, in either direction', () => {
    const fn = jest.fn((): undefined => undefined);
    svc.runAsCandidate(ORG_A, SESSION_1, () => {
      expect(() => svc.runAsSessionJob(ORG_A, SESSION_1, fn)).toThrow(OrgScopeViolationError);
    });
    svc.runAsSessionJob(ORG_A, SESSION_1, () => {
      expect(() => svc.runAsCandidate(ORG_A, SESSION_1, fn)).toThrow(OrgScopeViolationError);
    });
    expect(fn).not.toHaveBeenCalled();
  });

  describe.each(ENTRIES)('nesting inside %s', (entry, actor) => {
    it('TC-008 runInOrg of the same org keeps the session and the actor', async () => {
      await enterSession(entry, () => {
        const outer = svc.current()?.scope;
        svc.runInOrg(ORG_A, () => {
          const inner = svc.current()?.scope;
          expect(inner).toBe(outer); // the very same frozen scope: nothing was rebuilt or dropped
          expect(inner).toEqual({
            kind: 'org',
            orgId: ORG_A,
            session: { actor, sessionId: SESSION_1 },
          });
        });
        // Async work inside the nested scope still sees it.
        return svc.runInOrg(ORG_A, async () => {
          await sleep(1);
          expect(svc.current()?.scope).toBe(outer);
        });
      });
    });

    it('TC-008 runInOrg of another org is refused', () => {
      enterSession(entry, () => {
        expect(() => svc.runInOrg(ORG_B, () => undefined)).toThrow(OrgScopeViolationError);
      });
    });

    it('TC-008 runAsUser is refused, the same org and the same user included', () => {
      enterSession(entry, () => {
        expect(() => svc.runAsUser(USER_A, () => undefined)).toThrow(OrgScopeViolationError);
        expect(() => svc.runAsUser({ ...USER_A, orgId: ORG_B }, () => undefined)).toThrow(
          OrgScopeViolationError,
        );
        // The scope is as it was.
        const scope = svc.current()?.scope;
        expect(scope?.kind === 'org' ? scope.session?.actor : undefined).toBe(actor);
        expect(() => svc.requireUser()).toThrow(OrgContextMissingError);
      });
    });

    it.each(REASONS)('TC-008 runSystem(%s) is refused', (reason) => {
      enterSession(entry, () => {
        expect(() => svc.runSystem(reason, () => undefined)).toThrow(OrgScopeViolationError);
      });
    });

    it('TC-008 detachForSessionJob is refused: a session scope cannot leave itself', () => {
      const fn = jest.fn((): undefined => undefined);
      enterSession(entry, () => {
        expect(() => svc.detachForSessionJob(fn)).toThrow(OrgScopeViolationError);
        svc.runInOrg(ORG_A, () => {
          expect(() => svc.detachForSessionJob(fn)).toThrow(OrgScopeViolationError);
        });
      });
      expect(fn).not.toHaveBeenCalled();
    });

    it('TC-008 runRawSql opens a hatch, but the session binding stays', () => {
      enterSession(entry, () => {
        svc.runRawSql('one reviewed raw statement for the test', () => {
          const store = svc.current();
          expect(store?.rawSqlReason).toBeDefined();
          const scope = store?.scope;
          expect(scope?.kind === 'org' ? scope.session?.sessionId : undefined).toBe(SESSION_1);
        });
      });
    });
  });
});

describe('detachForSessionJob (ADR 0013 CS-4.1, ADR 0006 section 8.5; NFR-04, TC-008)', () => {
  const svc = new OrgContextService();

  it('TC-008 from no scope it runs fn in a fresh empty store, then a session scope can be entered', () => {
    expect(svc.current()).toBeUndefined();
    const result = svc.detachForSessionJob(() => {
      const store = svc.current();
      expect(store).toEqual({});
      expect(Object.isFrozen(store)).toBe(true);
      expect(store?.scope).toBeUndefined();
      expect(() => svc.requireOrgId()).toThrow(OrgContextMissingError);
      // This is what SessionJobProcessor does next.
      return svc.runAsSessionJob(ORG_A, SESSION_1, () => {
        const scope = svc.current()?.scope;
        return scope?.kind === 'org' ? scope.session?.actor : undefined;
      });
    });
    expect(result).toBe('SERVICE');
    expect(svc.current()).toBeUndefined();
  });

  it('TC-008 it returns a native Promise for async work and keeps the empty store through it', async () => {
    const result = svc.detachForSessionJob(async () => {
      await sleep(2);
      return svc.current();
    });
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toEqual({});
  });

  it('TC-008 it throws inside a staff scope, a plain org scope and a candidate or service scope', () => {
    const fn = jest.fn((): undefined => undefined);
    svc.runAsUser(USER_A, () => {
      expect(() => svc.detachForSessionJob(fn)).toThrow(OrgScopeViolationError);
    });
    svc.runInOrg(ORG_A, () => {
      expect(() => svc.detachForSessionJob(fn)).toThrow(OrgScopeViolationError);
    });
    svc.runAsCandidate(ORG_A, SESSION_1, () => {
      expect(() => svc.detachForSessionJob(fn)).toThrow(OrgScopeViolationError);
    });
    svc.runAsSessionJob(ORG_A, SESSION_1, () => {
      expect(() => svc.detachForSessionJob(fn)).toThrow(OrgScopeViolationError);
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it.each(REASONS)(
    'TC-008 it throws inside system scope %s (the BACKGROUND_JOB allowance is dropped)',
    (reason) => {
      const fn = jest.fn((): undefined => undefined);
      svc.runSystem(reason, () => {
        expect(() => svc.detachForSessionJob(fn)).toThrow(OrgScopeViolationError);
      });
      expect(fn).not.toHaveBeenCalled();
    },
  );

  it('TC-008 it throws while a runRawSql hatch is open, in any scope', () => {
    const fn = jest.fn((): undefined => undefined);
    const reason = 'one reviewed raw statement for the test';
    svc.runSystem('BACKGROUND_JOB', () => {
      svc.runRawSql(reason, () => {
        expect(() => svc.detachForSessionJob(fn)).toThrow(OrgScopeViolationError);
      });
    });
    svc.runInOrg(ORG_A, () => {
      svc.runRawSql(reason, () => {
        expect(() => svc.detachForSessionJob(fn)).toThrow(OrgScopeViolationError);
      });
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('TC-008 it throws in a non-empty store of any kind, so an inherited context is caught', async () => {
    // A BullMQ worker built while a scope was active would inherit it in every callback: the
    // processor's detach must throw there, and must work for a callback built outside any scope.
    const inherited = await new Promise<unknown>((resolve) => {
      svc.runInOrg(ORG_A, () => {
        setTimeout(() => {
          try {
            svc.detachForSessionJob(() => 'ran');
            resolve('no error');
          } catch (error) {
            resolve(error);
          }
        }, 1);
      });
    });
    expect(inherited).toBeInstanceOf(OrgScopeViolationError);
    const clean = await new Promise<unknown>((resolve) => {
      setTimeout(() => {
        resolve(svc.detachForSessionJob(() => 'ran'));
      }, 1);
    });
    expect(clean).toBe('ran');
  });

  it('TC-008 inside detach, a hatch cannot be opened without a scope, and no scope is carried over', () => {
    svc.detachForSessionJob(() => {
      expect(() => svc.runRawSql('one reviewed raw statement for the test', () => 1)).toThrow(
        OrgContextMissingError,
      );
      // A second detach inside an empty store is fine (it is still empty).
      expect(svc.detachForSessionJob(() => 'ok')).toBe('ok');
    });
  });
});

describe('the candidate facts (ADR 0013 CS-4.4 "Candidate facts"; NFR-04, TC-008)', () => {
  const svc = new OrgContextService();

  it('TC-008 are unset in a new CANDIDATE scope, and in every other scope', () => {
    expect(svc.candidateFacts()).toBeUndefined();
    svc.runAsCandidate(ORG_A, SESSION_1, () => {
      expect(svc.candidateFacts()).toBeUndefined();
    });
    svc.runAsSessionJob(ORG_A, SESSION_1, () => {
      expect(svc.candidateFacts()).toBeUndefined();
    });
    svc.runAsUser(USER_A, () => {
      expect(svc.candidateFacts()).toBeUndefined();
    });
    svc.runSystem('BACKGROUND_JOB', () => {
      expect(svc.candidateFacts()).toBeUndefined();
    });
  });

  it('TC-008 are set once in a CANDIDATE scope, frozen, and visible to nested and async work', async () => {
    await svc.runAsCandidate(ORG_A, SESSION_1, async () => {
      setCandidateFacts(svc, FACTS);
      const facts = svc.candidateFacts();
      expect(facts).toEqual(FACTS);
      expect(Object.isFrozen(facts)).toBe(true);
      expect(() => {
        (facts as unknown as { testId: string }).testId = ORG_B;
      }).toThrow(TypeError);
      await sleep(1);
      expect(svc.candidateFacts()).toEqual(FACTS);
      svc.runInOrg(ORG_A, () => {
        expect(svc.candidateFacts()).toEqual(FACTS);
      });
      await new Promise<void>((resolve) =>
        setImmediate(() => {
          expect(svc.candidateFacts()).toEqual(FACTS);
          resolve();
        }),
      );
    });
  });

  it('TC-008 are copied: changing the object passed in, or one with extra keys, changes nothing', () => {
    svc.runAsCandidate(ORG_A, SESSION_1, () => {
      const input = { ...FACTS, extra: 'ignored' };
      setCandidateFacts(svc, input);
      (input as { testId: string }).testId = ORG_B;
      expect(svc.candidateFacts()).toEqual(FACTS);
      expect(Object.keys(svc.candidateFacts() ?? {}).sort()).toEqual([
        'candidateId',
        'invitationId',
        'testId',
      ]);
    });
  });

  it('TC-008 refuse a second call, with the same values or others, and nested in the same scope', () => {
    svc.runAsCandidate(ORG_A, SESSION_1, () => {
      setCandidateFacts(svc, FACTS);
      expect(() => setCandidateFacts(svc, FACTS)).toThrow(OrgScopeViolationError);
      expect(() => setCandidateFacts(svc, { ...FACTS, candidateId: SESSION_2 })).toThrow(
        OrgScopeViolationError,
      );
      svc.runInOrg(ORG_A, () => {
        expect(() => setCandidateFacts(svc, FACTS)).toThrow(OrgScopeViolationError);
      });
      expect(svc.candidateFacts()).toEqual(FACTS);
    });
  });

  it('TC-008 are per scope: the next CANDIDATE scope starts unset, and concurrent scopes are separate', async () => {
    svc.runAsCandidate(ORG_A, SESSION_1, () => {
      setCandidateFacts(svc, FACTS);
    });
    svc.runAsCandidate(ORG_A, SESSION_1, () => {
      expect(svc.candidateFacts()).toBeUndefined();
    });
    const other: CandidateFacts = {
      candidateId: SESSION_2,
      invitationId: SESSION_2,
      testId: SESSION_2,
    };
    const results = await Promise.all(
      [FACTS, other, FACTS, other].map((facts, i) =>
        svc.runAsCandidate(ORG_A, i % 2 === 0 ? SESSION_1 : SESSION_2, async () => {
          setCandidateFacts(svc, facts);
          await sleep(1 + i);
          return svc.candidateFacts();
        }),
      ),
    );
    expect(results).toEqual([FACTS, other, FACTS, other]);
  });

  it('TC-008 are refused outside a CANDIDATE scope: none, staff, plain org, SERVICE, system, detached', () => {
    expect(() => setCandidateFacts(svc, FACTS)).toThrow(OrgContextMissingError);
    svc.runAsUser(USER_A, () => {
      expect(() => setCandidateFacts(svc, FACTS)).toThrow(OrgScopeViolationError);
    });
    svc.runInOrg(ORG_A, () => {
      expect(() => setCandidateFacts(svc, FACTS)).toThrow(OrgScopeViolationError);
    });
    svc.runAsSessionJob(ORG_A, SESSION_1, () => {
      expect(() => setCandidateFacts(svc, FACTS)).toThrow(OrgScopeViolationError);
      expect(svc.candidateFacts()).toBeUndefined();
    });
    for (const reason of REASONS) {
      svc.runSystem(reason, () => {
        expect(() => setCandidateFacts(svc, FACTS)).toThrow(OrgScopeViolationError);
      });
    }
    svc.detachForSessionJob(() => {
      expect(() => setCandidateFacts(svc, FACTS)).toThrow(OrgContextMissingError);
    });
  });

  it('TC-008 need uuids: a bad id throws and leaves the facts unset, so the guard can still set them', () => {
    svc.runAsCandidate(ORG_A, SESSION_1, () => {
      for (const key of ['candidateId', 'invitationId', 'testId'] as const) {
        expect(() => setCandidateFacts(svc, { ...FACTS, [key]: 'not-a-uuid' })).toThrow(
          OrgScopeViolationError,
        );
        expect(() =>
          setCandidateFacts(svc, { ...FACTS, [key]: undefined as unknown as string }),
        ).toThrow(OrgScopeViolationError);
      }
      expect(svc.candidateFacts()).toBeUndefined();
      setCandidateFacts(svc, FACTS);
      expect(svc.candidateFacts()).toEqual(FACTS);
    });
  });

  it('TC-008 the setter is not part of the database barrel or the service surface (CandidateSessionGuard only)', () => {
    expect(Object.keys(barrel)).not.toContain('setCandidateFacts');
    expect(Object.keys(barrel)).not.toContain('SET_CANDIDATE_FACTS');
    const names = Object.getOwnPropertyNames(OrgContextService.prototype);
    expect(names).not.toContain('setCandidateFacts');
    // The one way in is the symbol-keyed method; its symbol is not registered, so it cannot be rebuilt.
    const symbols = Object.getOwnPropertySymbols(OrgContextService.prototype);
    expect(symbols).toHaveLength(1);
    expect(Symbol.keyFor(symbols[0] as symbol)).toBeUndefined();
    // The barrel does carry the entries BE-07 needs, through OrgContextService.
    expect(barrel.OrgContextService).toBe(OrgContextService);
  });
});
