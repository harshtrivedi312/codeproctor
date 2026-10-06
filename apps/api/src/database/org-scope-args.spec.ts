// What the extension turns each operation's arguments into. Pure functions, no database.
import { OrgScopeViolationError } from './errors';
import { applyOrgScope, assertSystemScopeWrite, SCOPED_OPERATIONS } from './org-scope-args';
import type { ScopedOperation } from './org-scope-args';
import { ORG_SCOPE, orgFilter } from './org-scope-map';
import type { ModelName } from './org-scope-map';
import { scopeHopColumn } from './org-scope-relations';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

type Args = Record<string, unknown>;

function scope(model: ModelName, operation: string, args: unknown, orgId = ORG_A): Args {
  return applyOrgScope({ model, rule: ORG_SCOPE[model], operation, args, orgId });
}

const WHERE_OPERATIONS: readonly ScopedOperation[] = [
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
];

describe('org scope arguments (NFR-04, FR-103)', () => {
  it('TC-008 SCOPED_OPERATIONS lists the 17 operations of a model delegate', () => {
    expect([...SCOPED_OPERATIONS].sort()).toEqual(
      [
        'aggregate',
        'count',
        'create',
        'createMany',
        'createManyAndReturn',
        'delete',
        'deleteMany',
        'findFirst',
        'findFirstOrThrow',
        'findMany',
        'findUnique',
        'findUniqueOrThrow',
        'groupBy',
        'update',
        'updateMany',
        'updateManyAndReturn',
        'upsert',
      ].sort(),
    );
  });

  describe.each(WHERE_OPERATIONS)('%s', (operation) => {
    const data = { update: { x: 1 }, create: { x: 1 }, data: { x: 1 } };

    it.each(Object.keys(ORG_SCOPE) as ModelName[])(
      'TC-008 adds the org filter to the where of %s',
      (model) => {
        if (
          ['upsert', 'delete', 'deleteMany'].includes(operation) &&
          ORG_SCOPE[model].kind === 'self'
        ) {
          // Replacing or deleting an organization is not possible inside an org scope.
          expect(() => scope(model, operation, { where: { id: 'x' }, ...data })).toThrow(
            OrgScopeViolationError,
          );
          return;
        }
        const filter = orgFilter(ORG_SCOPE[model], ORG_A);
        const result = scope(model, operation, { where: { id: 'x' }, ...data });
        expect(result.where).toEqual({ id: 'x', AND: [filter] });
      },
    );

    it("TC-008 keeps the caller's own filter, OR and AND, and ANDs the org filter next to them", () => {
      const result = scope('Session', operation, {
        where: { OR: [{ status: 'GRADED' }, { status: 'COMPLETED' }], AND: [{ riskScore: 5 }] },
        ...data,
      });
      expect(result.where).toEqual({
        OR: [{ status: 'GRADED' }, { status: 'COMPLETED' }],
        AND: [{ riskScore: 5 }, { orgId: ORG_A }],
      });
      const single = scope('Session', operation, { where: { AND: { riskScore: 5 } }, ...data });
      expect(single.where).toEqual({ AND: [{ riskScore: 5 }, { orgId: ORG_A }] });
    });

    it("TC-008 cannot be overridden by an orgId in the caller's where", () => {
      const result = scope('Session', operation, { where: { orgId: ORG_B }, ...data });
      // Both conditions must hold, so a where naming another org matches nothing.
      expect(result.where).toEqual({ orgId: ORG_B, AND: [{ orgId: ORG_A }] });
    });

    it('TC-008 scopes a call with no arguments or no where', () => {
      if (operation === 'upsert') return; // upsert always has arguments
      expect(scope('ProctorEvent', operation, undefined).where).toEqual({
        session: { orgId: ORG_A },
      });
      expect(scope('ProctorEvent', operation, {}).where).toEqual({ session: { orgId: ORG_A } });
    });

    it('TC-008 does not change the arguments it was given', () => {
      const args = { where: { id: 'x', AND: [{ a: 1 }] }, ...data };
      const copy = structuredClone(args);
      scope('Session', operation, args);
      expect(args).toEqual(copy);
    });
  });

  it('TC-008 keeps the other arguments of a read: select, include, order, paging, group-by and aggregates', () => {
    const args = {
      where: { status: 'GRADED' },
      select: { id: true },
      include: { org: true },
      orderBy: { createdAt: 'desc' },
      take: 5,
      skip: 1,
      by: ['status'],
      _count: true,
    };
    expect(scope('Session', 'groupBy', args)).toEqual({
      ...args,
      where: { status: 'GRADED', AND: [{ orgId: ORG_A }] },
    });
  });

  describe('cursor (Prisma finds the cursor row by its own fields, not by where)', () => {
    // Every operation that accepts a cursor on a model delegate.
    const CURSOR_OPERATIONS = ['findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate'];

    it.each(CURSOR_OPERATIONS)(
      "TC-008 %s: a direct model's cursor gets the caller's org, next to the filtered where",
      (operation) => {
        const result = scope('AuditLog', operation, {
          where: { action: 'x' },
          cursor: { id: 7n },
          orderBy: { id: 'asc' },
          take: 3,
        });
        expect(result).toEqual({
          where: { action: 'x', AND: [{ orgId: ORG_A }] },
          cursor: { id: 7n, orgId: ORG_A },
          orderBy: { id: 'asc' },
          take: 3,
        });
      },
    );

    it.each(CURSOR_OPERATIONS)(
      'TC-008 %s: a cursor that names another org is refused, also inside a compound key',
      (operation) => {
        expect(() => scope('Test', operation, { cursor: { id: 'x', orgId: ORG_B } })).toThrow(
          OrgScopeViolationError,
        );
        expect(() =>
          scope('Test', operation, { cursor: { id_orgId: { id: 'x', orgId: ORG_B } } }),
        ).toThrow(OrgScopeViolationError);
        // Naming its own org is fine, and is not added twice.
        expect(scope('Test', operation, { cursor: { id: 'x', orgId: ORG_A } }).cursor).toEqual({
          id: 'x',
          orgId: ORG_A,
        });
        expect(
          scope('Test', operation, { cursor: { id_orgId: { id: 'x', orgId: ORG_A } } }).cursor,
        ).toEqual({ id_orgId: { id: 'x', orgId: ORG_A }, orgId: ORG_A });
      },
    );

    it.each(CURSOR_OPERATIONS)(
      'TC-008 %s: a cursor on a model without org_id is refused, with the way to page instead',
      (operation) => {
        for (const model of [
          'ProctorEvent',
          'TestCase',
          'Submission',
          'WebhookDelivery',
        ] as const) {
          expect(() => scope(model, operation, { cursor: { id: 1 }, take: 5 })).toThrow(
            /Page with where plus orderBy/,
          );
        }
        // The same call without a cursor is fine: paging by where and orderBy is scoped.
        expect(
          scope('ProctorEvent', operation, { where: { id: { gt: 5 } }, orderBy: { id: 'asc' } })
            .where,
        ).toEqual({ id: { gt: 5 }, AND: [{ session: { orgId: ORG_A } }] });
      },
    );

    it.each(CURSOR_OPERATIONS)(
      'TC-008 %s: the organization row accepts only its own id as the cursor',
      (operation) => {
        expect(scope('Organization', operation, { cursor: { id: ORG_A } }).cursor).toEqual({
          id: ORG_A,
        });
        expect(() => scope('Organization', operation, { cursor: { id: ORG_B } })).toThrow(
          OrgScopeViolationError,
        );
        expect(() => scope('Organization', operation, { cursor: {} })).toThrow(
          OrgScopeViolationError,
        );
      },
    );

    it('TC-008 no operation lets a cursor through unscoped, including ones Prisma would reject', () => {
      // Prisma refuses a cursor on these, but the scope does not depend on that.
      for (const operation of SCOPED_OPERATIONS) {
        if (CURSOR_OPERATIONS.includes(operation)) continue;
        const args = { where: { id: 'x' }, data: {}, create: {}, update: {}, cursor: { id: 'x' } };
        expect(() => scope('ProctorEvent', operation, args)).toThrow(OrgScopeViolationError);
        const direct = scope('Test', operation, args);
        expect(direct.cursor).toEqual({ id: 'x', orgId: ORG_A });
      }
    });

    it('TC-008 an absent or null cursor is left alone, and the arguments are not changed', () => {
      expect(scope('ProctorEvent', 'findMany', { take: 2 })).not.toHaveProperty('cursor');
      const args = { cursor: { id: 'x' }, take: 1 };
      scope('Test', 'findMany', args);
      expect(args).toEqual({ cursor: { id: 'x' }, take: 1 });
      expect(() => scope('Test', 'findMany', { cursor: 'x' })).toThrow(OrgScopeViolationError);
    });
  });

  describe('create on a model with its own org_id', () => {
    it('TC-008 adds the org when the data has none', () => {
      expect(scope('Test', 'create', { data: { name: 'T' } }).data).toEqual({
        name: 'T',
        orgId: ORG_A,
      });
    });

    it("TC-008 accepts the caller's org as the scalar orgId; org: { connect } is a nested relation write and is refused", () => {
      expect(scope('Test', 'create', { data: { name: 'T', orgId: ORG_A } }).data).toEqual({
        name: 'T',
        orgId: ORG_A,
      });
      // Even naming the caller's own org: services set the scalar orgId.
      expect(() =>
        scope('Test', 'create', { data: { name: 'T', org: { connect: { id: ORG_A } } } }),
      ).toThrow(/nested relation write refused \(Test\.org\.connect\)/);
    });

    it("TC-008 refuses another org's id, a connect to another org, or both forms at once", () => {
      expect(() => scope('Test', 'create', { data: { orgId: ORG_B } })).toThrow(
        OrgScopeViolationError,
      );
      expect(() => scope('Test', 'create', { data: { org: { connect: { id: ORG_B } } } })).toThrow(
        OrgScopeViolationError,
      );
      expect(() =>
        scope('Test', 'create', { data: { org: { connect: { id: ORG_A } }, orgId: ORG_A } }),
      ).toThrow(OrgScopeViolationError);
      expect(() => scope('Test', 'create', { data: { org: { create: { name: 'X' } } } })).toThrow(
        OrgScopeViolationError,
      );
    });

    it.each(['createMany', 'createManyAndReturn'])(
      'TC-008 %s stamps every row, accepts one object, and refuses a row of another org',
      (operation) => {
        const stamped = scope('Candidate', operation, {
          data: [{ email: 'a' }, { email: 'b', orgId: ORG_A }],
          skipDuplicates: true,
        });
        expect(stamped).toEqual({
          data: [
            { email: 'a', orgId: ORG_A },
            { email: 'b', orgId: ORG_A },
          ],
          skipDuplicates: true,
        });
        expect(scope('Candidate', operation, { data: { email: 'a' } }).data).toEqual({
          email: 'a',
          orgId: ORG_A,
        });
        expect(() =>
          scope('Candidate', operation, { data: [{ email: 'a' }, { email: 'b', orgId: ORG_B }] }),
        ).toThrow(OrgScopeViolationError);
      },
    );

    it('TC-008 upsert stamps the create branch and filters the where', () => {
      const result = scope('Test', 'upsert', {
        where: { id: 'x' },
        create: { name: 'T' },
        update: { name: 'U' },
      });
      expect(result).toEqual({
        where: { id: 'x', AND: [{ orgId: ORG_A }] },
        create: { name: 'T', orgId: ORG_A },
        update: { name: 'U' },
      });
      expect(() =>
        scope('Test', 'upsert', { where: { id: 'x' }, create: { orgId: ORG_B }, update: {} }),
      ).toThrow(OrgScopeViolationError);
    });
  });

  describe('update on a model with its own org_id', () => {
    it.each(['update', 'updateMany', 'updateManyAndReturn'])(
      'TC-008 %s cannot move a row to another org',
      (operation) => {
        expect(() => scope('Test', operation, { where: {}, data: { orgId: ORG_B } })).toThrow(
          OrgScopeViolationError,
        );
        expect(() =>
          scope('Test', operation, { where: {}, data: { orgId: { set: ORG_B } } }),
        ).toThrow(OrgScopeViolationError);
        expect(() =>
          scope('Test', operation, { where: {}, data: { org: { connect: { id: ORG_B } } } }),
        ).toThrow(OrgScopeViolationError);
        // Naming its own org is harmless.
        expect(() =>
          scope('Test', operation, { where: {}, data: { orgId: ORG_A, name: 'x' } }),
        ).not.toThrow();
        expect(() =>
          scope('Test', operation, { where: {}, data: { orgId: { set: ORG_A } } }),
        ).not.toThrow();
      },
    );

    it('TC-008 upsert cannot move a row to another org through its update branch', () => {
      expect(() =>
        scope('Test', 'upsert', { where: { id: 'x' }, create: {}, update: { orgId: ORG_B } }),
      ).toThrow(OrgScopeViolationError);
    });
  });

  describe("FU-DB-201: the caller's orgId is compared in lower case (scope ids are lower-cased on entry)", () => {
    // Hex letters, so the upper-case spelling really differs from the lower-case one.
    const LOW = 'abcdabcd-abcd-4bcd-8bcd-abcdabcdabcd';
    const UP = LOW.toUpperCase();
    const OTHER_LOW = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const OTHER_UP = OTHER_LOW.toUpperCase();
    const inLow = (model: ModelName, operation: string, args: unknown): Args =>
      scope(model, operation, args, LOW);

    it('TC-008 the fixture ids differ by case, so these tests mean something', () => {
      expect(UP).not.toBe(LOW);
      expect(OTHER_UP).not.toBe(OTHER_LOW);
    });

    it("TC-008 a create that names the caller's org in upper case passes, and is written in the scope's spelling", () => {
      expect(inLow('Test', 'create', { data: { name: 'T', orgId: UP } }).data).toEqual({
        name: 'T',
        orgId: LOW,
      });
      expect(inLow('Test', 'createMany', { data: [{ name: 'T', orgId: UP }] }).data).toEqual([
        { name: 'T', orgId: LOW },
      ]);
      expect(
        inLow('Test', 'upsert', { where: { id: 'x' }, create: { orgId: UP }, update: {} }).create,
      ).toEqual({ orgId: LOW });
      // Already in the scope's spelling: the very same object, nothing copied.
      const data = { name: 'T', orgId: LOW };
      expect(inLow('Test', 'create', { data }).data).toBe(data);
    });

    it('TC-008 another org in either case, and anything that is not a string, is still refused', () => {
      for (const orgId of [OTHER_UP, OTHER_LOW, 7, null, { equals: LOW }, [LOW]]) {
        expect(() => inLow('Test', 'create', { data: { orgId } })).toThrow(
          /orgId in the data is not the caller's org/,
        );
      }
    });

    it.each(['update', 'updateMany', 'updateManyAndReturn'])(
      "TC-008 %s: the caller's own org in upper case is harmless, another org in either case is refused",
      (operation) => {
        expect(() =>
          inLow('Test', operation, { where: {}, data: { orgId: UP, name: 'x' } }),
        ).not.toThrow();
        expect(() =>
          inLow('Test', operation, { where: {}, data: { orgId: { set: UP } } }),
        ).not.toThrow();
        for (const other of [OTHER_UP, OTHER_LOW]) {
          expect(() => inLow('Test', operation, { where: {}, data: { orgId: other } })).toThrow(
            /orgId cannot be changed to another org/,
          );
          expect(() =>
            inLow('Test', operation, { where: {}, data: { orgId: { set: other } } }),
          ).toThrow(/orgId cannot be changed to another org/);
        }
      },
    );

    it.each(['findMany', 'findFirst', 'count'])(
      "TC-008 %s: a cursor that names the caller's org in upper case passes (also in a compound key), another org does not",
      (operation) => {
        expect(inLow('Test', operation, { cursor: { id: 'x', orgId: UP } }).cursor).toEqual({
          id: 'x',
          orgId: LOW,
        });
        expect(() =>
          inLow('Test', operation, { cursor: { id_orgId: { id: 'x', orgId: UP } } }),
        ).not.toThrow();
        expect(() => inLow('Test', operation, { cursor: { id: 'x', orgId: OTHER_UP } })).toThrow(
          /names another org's row/,
        );
        expect(() =>
          inLow('Test', operation, { cursor: { id_orgId: { id: 'x', orgId: OTHER_UP } } }),
        ).toThrow(/names another org's row/);
      },
    );

    it("TC-008 the organization row: a cursor on the caller's own organization in upper case passes, another does not", () => {
      expect(() => inLow('Organization', 'findMany', { cursor: { id: UP } })).not.toThrow();
      expect(() => inLow('Organization', 'findMany', { cursor: { id: OTHER_UP } })).toThrow(
        /not the caller's own organization/,
      );
    });

    it('TC-008 a scope org handed over in upper case is compared in lower case as well', () => {
      expect(scope('Test', 'create', { data: { orgId: LOW } }, UP).data).toEqual({ orgId: UP });
      expect(() => scope('Test', 'create', { data: { orgId: OTHER_LOW } }, UP)).toThrow(
        OrgScopeViolationError,
      );
    });
  });

  describe('models scoped through a parent path', () => {
    it.each(['update', 'updateMany', 'updateManyAndReturn'])(
      'TC-008 %s in an org scope does not refuse a first-hop key: re-parenting there is rule (i), the limit README (b) documents (FU-DB-107)',
      (operation) => {
        const result = scope('TestSection', operation, { where: {}, data: { testId: 'parent-1' } });
        expect(result.data).toEqual({ testId: 'parent-1' });
        expect(result.where).toEqual({ AND: [{ test: { orgId: ORG_A } }] });
      },
    );

    it('TC-008 an upsert update branch in an org scope does not refuse a first-hop key either', () => {
      const result = scope('ProctorEvent', 'upsert', {
        where: { id: 1n },
        create: { sessionId: 's1' },
        update: { sessionId: 's2' },
      });
      expect(result.update).toEqual({ sessionId: 's2' });
    });

    it.each(['create', 'createMany', 'createManyAndReturn'])(
      'TC-008 %s passes the data through: the parent id must have been loaded through the scoped client',
      (operation) => {
        const data = operation === 'create' ? { sessionId: 's1' } : [{ sessionId: 's1' }];
        expect(scope('ProctorEvent', operation, { data }).data).toEqual(data);
      },
    );
  });

  describe('the organization row (tenant root)', () => {
    it('TC-008 is filtered by its own id', () => {
      expect(scope('Organization', 'findMany', {}).where).toEqual({ id: ORG_A });
    });

    it.each(['create', 'createMany', 'createManyAndReturn', 'upsert'])(
      'TC-008 %s is refused inside an org scope',
      (operation) => {
        expect(() =>
          scope('Organization', operation, {
            data: { name: 'X' },
            create: { name: 'X' },
            update: {},
            where: { id: ORG_B },
          }),
        ).toThrow(OrgScopeViolationError);
      },
    );

    it.each(['delete', 'deleteMany'])(
      'TC-008 %s is refused inside an org scope: deleting a tenant is a system operation (FU-DB-68)',
      (operation) => {
        for (const args of [{ where: { id: ORG_A } }, { where: { id: ORG_B } }, {}, undefined]) {
          expect(() => scope('Organization', operation, args)).toThrow(
            /organizations are deleted only in system scope/,
          );
        }
        // Other models are still deletable by their own org.
        expect(scope('Test', operation, { where: { id: 'x' } }).where).toEqual({
          id: 'x',
          AND: [{ orgId: ORG_A }],
        });
      },
    );

    it('TC-008 update cannot change the id', () => {
      expect(() => scope('Organization', 'update', { where: {}, data: { id: ORG_B } })).toThrow(
        OrgScopeViolationError,
      );
      expect(() =>
        scope('Organization', 'update', { where: {}, data: { name: 'New' } }),
      ).not.toThrow();
    });
  });

  it('TC-008 refuses an operation it does not know, so a new Prisma operation cannot bypass the filter', () => {
    expect(() => scope('Session', 'findRaw', {})).toThrow(OrgScopeViolationError);
    expect(() => scope('Session', 'somethingNew', {})).toThrow(OrgScopeViolationError);
  });

  it('TC-008 refuses arguments that are not an object', () => {
    expect(() => scope('Session', 'findMany', 'where')).toThrow(OrgScopeViolationError);
    expect(() => scope('Session', 'findMany', { where: 'x' })).toThrow(OrgScopeViolationError);
  });

  it('TC-008 an unscoped rule is not filtered, so callers must skip it', () => {
    expect(() =>
      applyOrgScope({
        model: 'Session',
        rule: { kind: 'unscoped', reason: 'test' },
        operation: 'findMany',
        args: {},
        orgId: ORG_A,
      }),
    ).toThrow(OrgScopeViolationError);
  });
});

describe('system scope: a scalar orgId cannot move a row (ADR 0006 section 8; NFR-04)', () => {
  const ORG_X = '44444444-4444-4444-8444-444444444444';
  const system = (model: ModelName, operation: string, args: unknown): void =>
    assertSystemScopeWrite(model, ORG_SCOPE[model], operation, args);

  /** The payload of each write operation that can carry an update, with the update at `data`. */
  const UPDATES: Array<[string, (data: Record<string, unknown>) => Record<string, unknown>]> = [
    ['update', (data) => ({ where: { id: 'x' }, data })],
    ['updateMany', (data) => ({ where: {}, data })],
    ['updateManyAndReturn', (data) => ({ where: {}, data })],
    ['upsert (update branch)', (data) => ({ where: { id: 'x' }, create: {}, update: data })],
  ];
  const DIRECT = [
    'User',
    'Question',
    'Test',
    'Candidate',
    'Invitation',
    'Session',
    'AuditLog',
    'ConsentText',
    'WebhookEndpoint',
  ] as const;

  const PATH = (Object.keys(ORG_SCOPE) as ModelName[]).filter(
    (model) => ORG_SCOPE[model].kind === 'path',
  );

  describe.each(UPDATES)('%s', (name, build) => {
    const operation = name.split(' ')[0] as string;

    it.each(DIRECT)('TC-008 %s: any orgId key is refused, whatever its value', (model) => {
      for (const value of [ORG_X, ORG_A, null, '', { set: ORG_X }, { set: ORG_A }, { set: null }]) {
        expect(() => system(model, operation, build({ orgId: value }))).toThrow(
          OrgScopeViolationError,
        );
      }
    });

    it('TC-008 the message names the model and operation and carries no value', () => {
      let message = '';
      try {
        system('User', operation, build({ orgId: ORG_X }));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(`User.${operation}`);
      expect(message).toContain('orgId cannot be written by an update in system scope');
      // Org scope does not refuse the key: an update may name the caller's own orgId there.
      expect(message).not.toContain('or any other');
      expect(message).not.toContain(ORG_X);
    });

    it.each(DIRECT)('TC-008 %s: an update without orgId is allowed in system scope', (model) => {
      expect(() =>
        system(model, operation, build({ fullName: 'x', orgId: undefined })),
      ).not.toThrow();
      expect(() => system(model, operation, build({ name: 'x' }))).not.toThrow();
    });

    it.each(PATH)(
      'TC-008 %s: its first-hop scope key is refused, whatever its value (FU-DB-107)',
      (model) => {
        const column = scopeHopColumn(model) as string;
        for (const value of ['parent-1', null, '', 7n, { set: 'parent-1' }, { set: null }]) {
          expect(() => system(model, operation, build({ [column]: value }))).toThrow(
            OrgScopeViolationError,
          );
        }
      },
    );

    it('TC-008 the first-hop message names the model, the operation and the column, and carries no value', () => {
      let message = '';
      try {
        system('TestSection', operation, build({ testId: 'SECRET-PARENT-ID' }));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(`TestSection.${operation}`);
      expect(message).toContain('testId cannot be written by an update in system scope');
      expect(message).not.toContain('SECRET-PARENT-ID');
    });

    it.each(PATH)(
      'TC-008 %s: an update without its first-hop key is allowed in system scope',
      (model) => {
        expect(() => system(model, operation, build({ note: 'x' }))).not.toThrow();
        expect(() =>
          system(model, operation, build({ [scopeHopColumn(model) as string]: undefined })),
        ).not.toThrow();
      },
    );

    it('TC-008 only the first hop is refused: the other foreign keys of a path model are rule (i), and allowed', () => {
      const others: Array<[ModelName, string]> = [
        ['SessionQuestion', 'testQuestionId'],
        ['SessionQuestion', 'questionVersionId'],
        ['SessionQuestion', 'variantId'],
        ['SessionQuestion', 'scoredById'],
        ['SessionSection', 'sectionId'],
        ['TestQuestion', 'questionVersionId'],
        ['Consent', 'consentTextId'],
        ['KeystrokeBatch', 'sessionQuestionId'],
        ['WebhookDelivery', 'sessionId'],
        ['RefreshToken', 'replacedById'],
        ['VariantTestCase', 'testCaseId'],
        ['IdentityCheck', 'reviewedById'],
        ['IdentityCheck', 'videoCheckById'],
      ];
      for (const [model, column] of others) {
        expect(() => system(model, operation, build({ [column]: 'x' }))).not.toThrow();
      }
    });

    it('TC-008 a model without its own org_id has no orgId to refuse, and Organization keeps its id', () => {
      expect(() => system('TestSection', operation, build({ title: 'x' }))).not.toThrow();
      expect(() => system('Organization', operation, build({ name: 'x' }))).not.toThrow();
      expect(() => system('Organization', operation, build({ id: ORG_X }))).toThrow(
        OrgScopeViolationError,
      );
    });
  });

  it('TC-008 a system-scope create may set orgId (creates in system scope are review-only)', () => {
    for (const model of DIRECT) {
      system(model, 'create', { data: { orgId: ORG_X } });
      system(model, 'createMany', { data: [{ orgId: ORG_X }] });
      system(model, 'createManyAndReturn', { data: [{ orgId: ORG_X }] });
    }
    // The create branch of an upsert too; only its update branch is refused.
    expect(() =>
      system('User', 'upsert', { where: { id: 'x' }, create: { orgId: ORG_X }, update: {} }),
    ).not.toThrow();
    expect(() =>
      system('User', 'upsert', {
        where: { id: 'x' },
        create: { orgId: ORG_X },
        update: { orgId: ORG_X },
      }),
    ).toThrow(OrgScopeViolationError);
  });

  it('TC-008 a system-scope create may name any parent (creates in system scope are review-only), and only the update branch of an upsert is refused', () => {
    for (const model of PATH) {
      const column = scopeHopColumn(model) as string;
      system(model, 'create', { data: { [column]: 'parent-1' } });
      system(model, 'createMany', { data: [{ [column]: 'parent-1' }] });
      system(model, 'createManyAndReturn', { data: [{ [column]: 'parent-1' }] });
      system(model, 'upsert', {
        where: { id: 'x' },
        create: { [column]: 'parent-1' },
        update: {},
      });
      expect(() =>
        system(model, 'upsert', {
          where: { id: 'x' },
          create: { [column]: 'parent-1' },
          update: { [column]: 'parent-1' },
        }),
      ).toThrow(OrgScopeViolationError);
    }
  });

  it('TC-008 reads and deletes carry no data and are untouched', () => {
    for (const operation of ['findMany', 'findFirst', 'count', 'delete', 'deleteMany']) {
      expect(() => system('User', operation, { where: { orgId: ORG_X } })).not.toThrow();
    }
  });

  it('TC-008 the nested relation rule still applies next to it, and the arguments are not changed', () => {
    expect(() =>
      system('User', 'update', { where: { id: 'x' }, data: { org: { connect: { id: ORG_X } } } }),
    ).toThrow(/nested relation write refused \(User\.org\.connect\)/);
    const args = { where: { id: 'x' }, data: { fullName: 'n' } };
    const copy = structuredClone(args);
    system('User', 'update', args);
    expect(args).toEqual(copy);
  });
});

describe('system scope: an unknown operation is refused, deny by default (FU-DB-160; ADR 0006 section 8.2; NFR-04)', () => {
  const system = (model: ModelName, operation: string, args: unknown): void =>
    assertSystemScopeWrite(model, ORG_SCOPE[model], operation, args);
  // findRaw and aggregateRaw are MongoDB-only today; the others stand for one a future Prisma adds.
  const UNKNOWN = ['findRaw', 'aggregateRaw', 'somethingNew', 'deleteManyAndReturn', ''];
  // One model of each rule kind: direct, path and the tenant root.
  const MODELS: readonly ModelName[] = ['Session', 'ProctorEvent', 'Organization'];

  it.each(MODELS)(
    'TC-008 %s: every unknown operation is refused, with or without arguments',
    (model) => {
      for (const operation of UNKNOWN) {
        for (const args of [{}, undefined, { where: {} }, { data: { orgId: ORG_B } }]) {
          expect(() => system(model, operation, args)).toThrow(OrgScopeViolationError);
        }
      }
    },
  );

  it('TC-008 the message names the model and the operation, and carries no value', () => {
    let message = '';
    try {
      system('Session', 'somethingNew', { where: { id: 'SECRET-SESSION-ID' } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      'Session.somethingNew: unknown operation in system scope. Add it to SCOPED_OPERATIONS and handle it.',
    );
  });

  it.each(Object.keys(ORG_SCOPE) as ModelName[])(
    'TC-008 %s: every operation in SCOPED_OPERATIONS still passes the check with plain arguments',
    (model) => {
      for (const operation of SCOPED_OPERATIONS) {
        expect(() => system(model, operation, {})).not.toThrow();
      }
    },
  );

  it('TC-008 org scope and system scope refuse the same unknown operations', () => {
    for (const operation of UNKNOWN) {
      expect(() => scope('Session', operation, {})).toThrow(OrgScopeViolationError);
      expect(() => system('Session', operation, {})).toThrow(OrgScopeViolationError);
    }
  });
});
