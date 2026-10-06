// OrgContextService.withGrant (ADR 0013 CS-4.4 "Grant spec", ADR 0006 section 8.5): the mandatory ids, the
// model and columns of ONE grant site, scope only, no nesting, and the lifetime: the grant object carries
// an `active` flag that is cleared in a `finally` when `fn` settles, and any query that runs under the
// inactive grant throws, so a promise or a timer that `fn` started and did not await cannot use it. No
// database: the client points at a closed port, so a query that the scope ALLOWS fails with a connection
// error, which tells it apart from a refusal (OrgScopeError). The queries that reach Postgres are in
// cs4-columns-grants.spec.ts. NFR-04, TC-008.
import { setCandidateFacts } from './candidate-facts';
import { createPrismaClient } from './create-prisma-client';
import {
  OrgContextMissingError,
  OrgScopeError,
  OrgScopeViolationError,
  RawQueryNotAllowedError,
} from './errors';
import { OrgContextService } from './org-context';
import type { Grant, GrantRequest } from './org-context';
import { createOrgScopedClient } from './org-scope.extension';

const ORG = '11111111-1111-4111-8111-111111111111';
const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const FACTS = {
  candidateId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
  invitationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
  testId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3',
};

const KEY: GrantRequest = { model: 'Session', columns: ['hmacKeyEnc'], ids: [SID] };
const STATE: GrantRequest = {
  model: 'Session',
  columns: ['status', 'pauseReasons', 'submittedAt'],
  ids: [SID],
};

describe('OrgContextService.withGrant (ADR 0013 CS-4.4; NFR-04, TC-008)', () => {
  const orgContext = new OrgContextService();
  const base = createPrismaClient('postgresql://nobody:nothing@127.0.0.1:1/none');
  const client = createOrgScopedClient(base, orgContext);

  afterAll(async () => {
    await base.$disconnect();
  });

  const asCandidate = <T>(fn: () => T): Promise<Awaited<T>> =>
    Promise.resolve(
      orgContext.runAsCandidate(ORG, SID, () => {
        setCandidateFacts(orgContext, FACTS);
        return fn();
      }),
    ) as Promise<Awaited<T>>;
  /** withGrant for a callback that may return a plain value: always a Promise. */
  const grantP = <T>(request: GrantRequest, fn: () => T): Promise<Awaited<T>> =>
    Promise.resolve(orgContext.withGrant(request, fn)) as Promise<Awaited<T>>;

  /** A refusal by the scope. Anything else (a connection error to the closed port) means "allowed". */
  async function refusal(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => undefined,
      (error: unknown) => error,
    );
  }
  const isRefused = async (promise: Promise<unknown>): Promise<boolean> =>
    (await refusal(promise)) instanceof OrgScopeError;
  const readKey = (): Promise<unknown> =>
    client.session.findFirst({ select: { hmacKeyEnc: true } });
  const ENDED = /the grant of this unit of work has ended/;

  describe('the request: model, columns and ids are mandatory, and name ONE site', () => {
    it('TC-008 outside any scope it throws OrgContextMissingError, and in a system scope OrgScopeViolationError', () => {
      expect(() => orgContext.withGrant(KEY, () => 1)).toThrow(OrgContextMissingError);
      for (const reason of ['AUTH_BOOTSTRAP', 'BACKGROUND_JOB', 'RETENTION_ERASURE'] as const) {
        expect(() =>
          orgContext.runSystem(reason, () => orgContext.withGrant(KEY, () => 1)),
        ).toThrow(/needs an org scope/);
      }
    });

    it('TC-008 an empty ids throws, and so does a missing, a non-list and a malformed one', async () => {
      await asCandidate(() => {
        for (const ids of [
          [],
          undefined,
          null,
          'x',
          SID,
          {},
          7,
          [7],
          [''],
          ['not-a-uuid'],
          [null],
          [{}],
        ]) {
          expect(() => orgContext.withGrant({ ...KEY, ids: ids as never }, () => 1)).toThrow(
            OrgScopeViolationError,
          );
        }
        expect(() => orgContext.withGrant({ ...KEY, ids: [] }, () => 1)).toThrow(
          /ids are mandatory and an empty list throws/,
        );
        const noIds = { model: KEY.model, columns: KEY.columns };
        expect(() => orgContext.withGrant(noIds as never, () => 1)).toThrow(/ids are mandatory/);
      });
    });

    it('TC-008 a model with no grant site is named as such, before its columns are looked at', async () => {
      await asCandidate(() => {
        for (const model of ['User', 'sessions', 'Submission', 'Candidate', 'SessionSection']) {
          expect(() =>
            orgContext.withGrant({ model, columns: ['id'], ids: [SID] }, () => 1),
          ).toThrow(/has no grant site in ADR 0013 CS-4\.4/);
        }
      });
    });

    it('TC-008 the model must be one with a grant site, and the columns one non-empty list of distinct names of ONE site', async () => {
      await asCandidate(() => {
        for (const request of [
          { ...KEY, model: 'User' },
          { ...KEY, model: 'sessions' },
          { ...KEY, model: undefined },
          { ...KEY, model: 7 },
          { ...KEY, columns: [] },
          { ...KEY, columns: undefined },
          { ...KEY, columns: 'hmacKeyEnc' },
          { ...KEY, columns: [7] },
          { ...KEY, columns: ['hmacKeyEnc', 'hmacKeyEnc'] },
          // a column of the model that no site names
          { ...KEY, columns: ['invitationId'] },
          { ...KEY, columns: ['riskScore'] },
          // a column of another model
          { ...KEY, columns: ['settings'] },
          // the columns of two sites join: one grant is one service
          { ...KEY, columns: ['status', 'hmacKeyEnc'] },
          { ...KEY, columns: ['hmacKeyEnc', 'deviceInfo'] },
          { ...STATE, columns: ['status', 'deviceInfo'] },
          null,
          'Session',
          undefined,
        ]) {
          expect(() => orgContext.withGrant(request as never, () => 1)).toThrow(
            OrgScopeViolationError,
          );
        }
      });
    });

    it('TC-008 a subset of a site is a grant, and so is every site, with the ids of its kind', async () => {
      await asCandidate(() => {
        for (const request of [
          KEY,
          STATE,
          { ...STATE, columns: ['status'] },
          { model: 'Session', columns: ['deviceInfo'], ids: [SID] },
          { model: 'MediaChunk', columns: ['objectKey'], ids: [7n] },
          { model: 'Organization', columns: ['settings'], ids: [ORG] },
          { model: 'Test', columns: ['settings'], ids: [FACTS.testId] },
          { model: 'Invitation', columns: ['accommodations'], ids: [FACTS.invitationId] },
          { model: 'SessionQuestion', columns: ['testQuestionId'], ids: [OTHER] },
          { model: 'TestQuestion', columns: ['id', 'sectionId'], ids: [OTHER] },
          { model: 'TestQuestion', columns: ['sectionId'], ids: [OTHER] },
          {
            model: 'ConsentText',
            columns: ['id', 'version', 'bodyMd', 'legalApprovedAt'],
            ids: [OTHER, SID],
          },
          {
            model: 'Consent',
            columns: ['sessionId', 'consentTextId', 'signedName', 'signedAt', 'ip', 'userAgent'],
            ids: [SID],
          },
        ]) {
          expect(() => orgContext.withGrant(request, () => 1)).not.toThrow();
        }
      });
    });

    it('TC-008 the ids are normalised: lower-case uuids and no duplicates, and positive integers for media_chunks (a bigint key)', async () => {
      await asCandidate(() => {
        const seen = orgContext.withGrant(
          { model: 'ConsentText', columns: ['id'], ids: [SID.toUpperCase(), SID, OTHER] },
          () => orgContext.current()?.grant,
        );
        expect(seen?.ids).toEqual([SID, OTHER]);
        const chunks = orgContext.withGrant(
          { model: 'MediaChunk', columns: ['objectKey'], ids: [7, 7n, 9n] },
          () => orgContext.current()?.grant,
        );
        expect(chunks?.ids).toEqual([7n, 9n]);
        for (const ids of [
          [0],
          [-1],
          [1.5],
          ['7'],
          [0n],
          [-3n],
          [SID],
          [Number.MAX_SAFE_INTEGER + 2],
        ]) {
          expect(() =>
            orgContext.withGrant({ model: 'MediaChunk', columns: ['objectKey'], ids }, () => 1),
          ).toThrow(/positive integers/);
        }
        // And a uuid kind refuses an integer.
        expect(() => orgContext.withGrant({ ...KEY, ids: [7n] as never }, () => 1)).toThrow(
          /uuid form/,
        );
      });
    });

    it('TC-008 the messages carry no id', async () => {
      await asCandidate(() => {
        let message = '';
        try {
          orgContext.withGrant({ ...KEY, ids: ['not-a-uuid-secret-value'] }, () => 1);
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toContain('withGrant');
        expect(message).not.toContain('secret-value');
      });
    });
  });

  describe('the grant object', () => {
    it('TC-008 fn sees an active, frozen grant with the model, the site, the columns and the normalised ids; a copy cannot be changed', async () => {
      const seen = await asCandidate(() =>
        orgContext.withGrant(STATE, () => {
          const grant = orgContext.current()?.grant as Grant;
          expect(grant.active).toBe(true);
          return grant;
        }),
      );
      expect(seen.model).toBe('Session');
      expect(seen.site).toBe('SessionStateService');
      expect(seen.mode).toBe('rows');
      expect(seen.columns).toEqual(['status', 'pauseReasons', 'submittedAt']);
      expect(seen.ids).toEqual([SID]);
      for (const part of [seen, seen.columns, seen.ids]) expect(Object.isFrozen(part)).toBe(true);
      expect(() => {
        (seen as unknown as { columns: string[] }).columns = ['hmacKeyEnc'];
      }).toThrow(TypeError);
      expect(() => (seen.columns as string[]).push('hmacKeyEnc')).toThrow(TypeError);
      expect(() => (seen.ids as string[]).push(OTHER)).toThrow(TypeError);
    });

    it('TC-008 active is false once fn has settled, and nothing outside can switch it on again', async () => {
      const grant = await asCandidate(() =>
        orgContext.withGrant(KEY, () => orgContext.current()?.grant as Grant),
      );
      expect(grant.active).toBe(false);
      expect(() => {
        (grant as { active: boolean }).active = true;
      }).toThrow(TypeError);
      expect(() => Object.defineProperty(grant, 'active', { value: true })).toThrow(TypeError);
      expect(Object.getOwnPropertyDescriptor(grant, 'active')).toEqual(
        expect.objectContaining({ set: undefined }),
      );
      expect(grant.active).toBe(false);
      // A copy is a snapshot, not the live flag: nothing can make the original active.
      const copy = { ...grant, active: true };
      expect(grant.active).toBe(false);
      expect(copy.active).toBe(true);
    });

    it('TC-008 active turns false when fn settles by returning, by awaiting, by throwing and by rejecting', async () => {
      const keep: Grant[] = [];
      await asCandidate(() => {
        orgContext.withGrant(KEY, () => keep.push(orgContext.current()?.grant as Grant));
        expect(() =>
          orgContext.withGrant(KEY, () => {
            keep.push(orgContext.current()?.grant as Grant);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        return undefined;
      });
      await asCandidate(async () => {
        await grantP(KEY, async () => {
          await Promise.resolve();
          keep.push(orgContext.current()?.grant as Grant);
        });
        await expect(
          orgContext.withGrant(KEY, async () => {
            keep.push(orgContext.current()?.grant as Grant);
            await Promise.resolve();
            throw new Error('async boom');
          }),
        ).rejects.toThrow('async boom');
      });
      expect(keep).toHaveLength(4);
      expect(keep.map((g) => g.active)).toEqual([false, false, false, false]);
    });

    it('TC-008 the grant is active for the whole of an async fn, across awaits', async () => {
      const flags = await asCandidate(() =>
        orgContext.withGrant(KEY, async () => {
          const grant = orgContext.current()?.grant as Grant;
          const out = [grant.active];
          await new Promise((resolve) => setTimeout(resolve, 5));
          out.push(grant.active);
          await Promise.all([Promise.resolve(), new Promise((resolve) => setImmediate(resolve))]);
          out.push(grant.active);
          return out;
        }),
      );
      expect(flags).toEqual([true, true, true]);
    });

    it('TC-008 outside withGrant, in the same scope, there is no grant (the store of the caller is untouched)', async () => {
      await asCandidate(async () => {
        expect(orgContext.current()?.grant).toBeUndefined();
        await grantP(KEY, async () => {
          await Promise.resolve();
        });
        expect(orgContext.current()?.grant).toBeUndefined();
        // And the scope survives: the same session, the same actor.
        expect(orgContext.current()?.scope).toMatchObject({
          kind: 'org',
          orgId: ORG,
          session: { actor: 'CANDIDATE', sessionId: SID },
        });
      });
    });

    it('TC-008 two grants of one scope that run at the same time are independent', async () => {
      const seen = await asCandidate(() =>
        Promise.all([
          orgContext.withGrant(KEY, async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return orgContext.current()?.grant?.columns;
          }),
          orgContext.withGrant(
            { model: 'Session', columns: ['deviceInfo'], ids: [SID] },
            async () => {
              await Promise.resolve();
              return orgContext.current()?.grant?.columns;
            },
          ),
        ]),
      );
      expect(seen).toEqual([['hmacKeyEnc'], ['deviceInfo']]);
    });
  });

  describe('grants do not nest, and are not an exit from the scope', () => {
    it('TC-008 a grant inside a grant throws: the same one, another one, and one inside an async callback', async () => {
      await asCandidate(async () => {
        await grantP(KEY, async () => {
          expect(() => orgContext.withGrant(KEY, () => 1)).toThrow(/grants do not nest/);
          expect(() =>
            orgContext.withGrant(
              { model: 'Session', columns: ['deviceInfo'], ids: [SID] },
              () => 1,
            ),
          ).toThrow(/grants do not nest/);
          await Promise.resolve();
          expect(() => orgContext.withGrant(STATE, () => 1)).toThrow(/grants do not nest/);
        });
        // Back outside: a new grant is fine.
        expect(() => orgContext.withGrant(STATE, () => 1)).not.toThrow();
      });
    });

    it('TC-008 a grant inside the detached callback of an ended grant throws too (the unit of work still carries the ended one)', async () => {
      let late: unknown;
      await asCandidate(async () => {
        await grantP(KEY, () => {
          setTimeout(() => {
            try {
              orgContext.withGrant(STATE, () => 1);
            } catch (error) {
              late = error;
            }
          }, 5);
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(late).toBeInstanceOf(OrgScopeViolationError);
    });

    it('TC-008 inside a grant no session scope can be entered, and detachForSessionJob throws (it asserts an empty store)', async () => {
      await asCandidate(() => {
        orgContext.withGrant(KEY, () => {
          expect(() => orgContext.runAsCandidate(ORG, SID, () => 1)).toThrow(
            /allowed from no scope only/,
          );
          expect(() => orgContext.runAsSessionJob(ORG, SID, () => 1)).toThrow(
            /allowed from no scope only/,
          );
          expect(() => orgContext.detachForSessionJob(() => 1)).toThrow(/needs an empty context/);
          expect(() => orgContext.runSystem('AUTH_BOOTSTRAP', () => 1)).toThrow(
            OrgScopeViolationError,
          );
          expect(() =>
            orgContext.runAsUser({ orgId: ORG, userId: OTHER, role: 'RECRUITER' }, () => 1),
          ).toThrow(/Inside a CANDIDATE session scope/);
        });
      });
    });

    it('TC-008 runInOrg of the same org inside a grant keeps the grant, the session and the actor', async () => {
      await asCandidate(() => {
        orgContext.withGrant(KEY, () => {
          const outer = orgContext.current()?.grant;
          orgContext.runInOrg(ORG, () => {
            expect(orgContext.current()?.grant).toBe(outer);
            expect(orgContext.current()?.scope).toMatchObject({
              session: { actor: 'CANDIDATE', sessionId: SID },
            });
          });
        });
      });
    });

    it('TC-008 an open runRawSql hatch and a grant together: raw SQL is still refused in a session scope', async () => {
      await asCandidate(async () => {
        await grantP(KEY, () =>
          orgContext.runRawSql('a reviewed query that must still be refused here', async () => {
            await expect(client.$queryRaw`SELECT 1`).rejects.toBeInstanceOf(
              RawQueryNotAllowedError,
            );
          }),
        );
      });
    });
  });

  describe('the extension: a query under the grant, and a query that outlives it', () => {
    it('TC-008 an explicit-only column is refused without the grant and allowed under it, and the grant ends with its callback', async () => {
      await asCandidate(async () => {
        expect(await isRefused(readKey())).toBe(true);
        expect(await isRefused(orgContext.withGrant(KEY, readKey))).toBe(false);
        // The scope still has no grant afterwards.
        expect(await isRefused(readKey())).toBe(true);
      });
    });

    it('TC-008 a detached promise run after fn resolved throws: the grant has ended (the store is still alive in it)', async () => {
      await asCandidate(async () => {
        let detached: Promise<unknown> = Promise.resolve();
        await grantP(KEY, () => {
          // Started inside fn and NOT awaited: it runs after fn has returned.
          detached = new Promise((resolve) => setTimeout(resolve, 20)).then(() => readKey());
        });
        const error = await refusal(detached);
        expect(error).toBeInstanceOf(OrgScopeViolationError);
        expect((error as Error).message).toMatch(ENDED);
      });
    });

    it('TC-008 a setTimeout callback run after fn resolved throws', async () => {
      let late: unknown = 'not run';
      await asCandidate(async () => {
        await grantP(KEY, () => {
          setTimeout(() => {
            late = readKey().then(
              () => undefined,
              (error: unknown) => error,
            );
          }, 10);
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      const error = await (late as Promise<unknown>);
      expect(error).toBeInstanceOf(OrgScopeViolationError);
      expect((error as Error).message).toMatch(ENDED);
    });

    it('TC-008 an emitter callback and an unawaited async function run after fn resolved throw', async () => {
      const { EventEmitter } = await import('node:events');
      const emitter = new EventEmitter();
      const results: unknown[] = [];
      await asCandidate(async () => {
        await grantP(KEY, () => {
          emitter.on('go', () => {
            results.push(
              readKey().then(
                () => undefined,
                (error: unknown) => error,
              ),
            );
          });
          // The emit comes from a timer that fn started, so its listener runs in the store of fn.
          setTimeout(() => emitter.emit('go'), 15);
          // An async function that waits on something outside fn and is not awaited.
          void (async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            results.push(
              readKey().then(
                () => undefined,
                (error: unknown) => error,
              ),
            );
          })();
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const errors = await Promise.all(results);
      expect(errors).toHaveLength(2);
      for (const error of errors) {
        expect(error).toBeInstanceOf(OrgScopeViolationError);
        expect((error as Error).message).toMatch(ENDED);
      }
    });

    it('TC-008 a detached query that names no grant column is refused as well: an ended grant refuses every query, raw SQL included', async () => {
      const outcomes: unknown[] = [];
      await asCandidate(async () => {
        await grantP(KEY, () => {
          setTimeout(() => {
            for (const query of [
              () => client.session.findFirst({ select: { id: true } }),
              () => client.session.count(),
              () => client.organization.findFirst({ select: { id: true } }),
              () => client.$queryRaw`SELECT 1`,
            ]) {
              outcomes.push(
                (query() as Promise<unknown>).then(
                  () => undefined,
                  (error: unknown) => error,
                ),
              );
            }
          }, 10);
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const errors = await Promise.all(outcomes);
      expect(errors).toHaveLength(4);
      for (const error of errors) {
        expect(error).toBeInstanceOf(OrgScopeViolationError);
        expect((error as Error).message).toMatch(ENDED);
      }
    });

    it('TC-008 the same detached query inside fn (the grant still active) is allowed: the flag is what ends it', async () => {
      await asCandidate(async () => {
        const detached = await grantP(KEY, async () => {
          const pending = new Promise((resolve) => setTimeout(resolve, 5)).then(() => readKey());
          return refusal(pending);
        });
        expect(detached).toBeDefined();
        expect(detached).not.toBeInstanceOf(OrgScopeError);
      });
    });

    it('TC-008 a query after fn, in the awaiting caller, runs with no grant: allowed columns work, a grant column does not', async () => {
      await asCandidate(async () => {
        await grantP(KEY, () => 1);
        expect(
          await isRefused(client.session.findFirst({ select: { id: true } }) as Promise<unknown>),
        ).toBe(false);
        expect(await isRefused(readKey())).toBe(true);
      });
    });

    it('TC-008 the grant never widens the model allowlist: a model off the list throws under a grant too', async () => {
      await asCandidate(async () => {
        await grantP(KEY, async () => {
          await expect(client.user.findMany({ select: { id: true } })).rejects.toThrow(
            /not on the CANDIDATE allowlist/,
          );
          await expect(
            client.session.findFirst({ select: { invitationId: true } }),
          ).rejects.toThrow(/the column invitationId is not available/);
          await expect(
            client.session.update({
              where: { id: SID },
              data: { riskScore: 1 },
              select: { id: true },
            }),
          ).rejects.toThrow(/riskScore cannot be written by a candidate update here/);
        });
      });
    });

    it('TC-008 a grant of another model unlocks nothing here: Test settings under an Organization grant, a gated model under a grant of the other', async () => {
      await asCandidate(async () => {
        await grantP({ model: 'Organization', columns: ['settings'], ids: [ORG] }, async () => {
          await expect(client.test.findFirst({ select: { settings: true } })).rejects.toThrow(
            /the column settings is not available/,
          );
          expect(
            await isRefused(
              client.organization.findFirst({ select: { settings: true } }) as Promise<unknown>,
            ),
          ).toBe(false);
        });
        await grantP({ model: 'TestQuestion', columns: ['id'], ids: [OTHER] }, async () => {
          await expect(client.consentText.findMany({ select: { id: true } })).rejects.toThrow(
            /readable only under a grant of its own/,
          );
        });
      });
    });
  });

  describe('in the other scopes (no column limit there): validated, and carrying no filter', () => {
    it('TC-008 a staff scope and a plain org scope may enter a grant; a query runs as it would without one', async () => {
      const staff = (fn: () => Promise<unknown>) =>
        orgContext.runAsUser({ orgId: ORG, userId: OTHER, role: 'RECRUITER' }, fn);
      const plain = (fn: () => Promise<unknown>) => orgContext.runInOrg(ORG, fn);
      for (const run of [staff, plain]) {
        const error = await run(async () => {
          const grant = orgContext.withGrant(
            { model: 'Organization', columns: ['settings'], ids: [ORG] },
            () => orgContext.current()?.grant,
          );
          expect(grant?.active).toBe(false);
          return refusal(
            orgContext.withGrant({ model: 'Organization', columns: ['settings'], ids: [ORG] }, () =>
              client.organization.findFirst({ select: { settings: true } }),
            ),
          );
        });
        expect(error).not.toBeInstanceOf(OrgScopeError);
      }
    });

    it('TC-008 a SERVICE scope may enter a grant, and an ended grant refuses its detached query there too', async () => {
      await orgContext.runAsSessionJob(ORG, SID, async () => {
        let late: Promise<unknown> = Promise.resolve();
        await grantP(KEY, () => {
          late = new Promise((resolve) => setTimeout(resolve, 10)).then(() =>
            client.session.findFirst({ select: { hmacKeyEnc: true } }),
          );
        });
        const error = await refusal(late);
        expect(error).toBeInstanceOf(OrgScopeViolationError);
        expect((error as Error).message).toMatch(ENDED);
      });
    });

    it('TC-008 the grant API is a method of the service and not a way to leave a scope: the store keeps its scope', async () => {
      await orgContext.runInOrg(ORG, async () => {
        await grantP({ model: 'Organization', columns: ['settings'], ids: [ORG] }, () => {
          expect(orgContext.current()?.scope).toMatchObject({ kind: 'org', orgId: ORG });
          expect(orgContext.requireOrgId()).toBe(ORG);
        });
      });
    });
  });
});
