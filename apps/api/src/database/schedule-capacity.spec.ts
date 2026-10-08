import { OrgScopeViolationError } from './errors';
import { SYSTEM_SCOPE_REASONS } from './org-context';
import { FK_CLASSES } from './org-scope-relations';
import {
  SCHEDULE_BACK_RELATIONS,
  SCHEDULE_CAPACITY_COLUMNS,
  SCHEDULE_CAPACITY_OPERATIONS,
  assertScheduleCapacityScope,
} from './schedule-capacity';

const check =
  (operation: string, args: unknown, reason = 'SCHEDULE_CAPACITY', model = 'ScheduledWindow') =>
  () =>
    assertScheduleCapacityScope(model, operation, reason, args);

const FIVE = { startsAt: true, endsAt: true, ceilingAt: true, status: true, kind: true };

describe('the SCHEDULE_CAPACITY system read of scheduled_windows (ADR 0017 4.7, C-53; FR-306, FR-307, TC-111, TC-106, TC-008)', () => {
  it('TC-111 the reason exists, and the shape is frozen: five columns and four read operations', () => {
    expect(Object.keys(SYSTEM_SCOPE_REASONS)).toContain('SCHEDULE_CAPACITY');
    expect([...SCHEDULE_CAPACITY_COLUMNS]).toEqual([
      'startsAt',
      'endsAt',
      'ceilingAt',
      'status',
      'kind',
    ]);
    expect([...SCHEDULE_CAPACITY_OPERATIONS]).toEqual([
      'findMany',
      'count',
      'aggregate',
      'groupBy',
    ]);
    expect(Object.isFrozen(SCHEDULE_CAPACITY_COLUMNS)).toBe(true);
    expect(Object.isFrozen(SCHEDULE_CAPACITY_OPERATIONS)).toBe(true);
  });

  describe('(a) the reads it allows', () => {
    it.each([
      ['findMany with the five columns', 'findMany', { select: FIVE }],
      [
        'findMany of the live windows of a range, ordered',
        'findMany',
        {
          select: { startsAt: true, ceilingAt: true },
          where: {
            status: { in: ['SCHEDULED', 'DONE'] },
            AND: [
              { startsAt: { lt: new Date('2026-11-01') } },
              { ceilingAt: { gt: new Date('2026-10-01') } },
            ],
          },
          orderBy: [{ startsAt: 'asc' }, { ceilingAt: { sort: 'desc', nulls: 'last' } }],
          distinct: ['startsAt'],
          take: 100,
          skip: 0,
        },
      ],
      ['count', 'count', { where: { kind: 'SLOT', NOT: { status: 'CANCELLED' } } }],
      ['count with a select', 'count', { select: { _all: true, startsAt: true } }],
      [
        'aggregate (the monthly hours)',
        'aggregate',
        {
          where: { status: 'DONE' },
          _count: { _all: true },
          _min: { startsAt: true },
          _max: { ceilingAt: true },
        },
      ],
      [
        'groupBy kind',
        'groupBy',
        {
          by: ['kind'],
          _count: { _all: true },
          having: { kind: { not: 'REVIEW' } },
          orderBy: { kind: 'asc' },
        },
      ],
    ])('TC-111 %s passes', (_what, operation, args) => {
      expect(check(operation, args)).not.toThrow();
    });
  });

  describe('(a) every column outside the five, and every other shape, is refused before any statement', () => {
    it.each([
      ['select id', 'findMany', { select: { id: true } }],
      ['select orgId', 'findMany', { select: { startsAt: true, orgId: true } }],
      ['select invitationId', 'findMany', { select: { invitationId: true } }],
      ['select requestedBy', 'findMany', { select: { requestedBy: true } }],
      ['select createdAt', 'findMany', { select: { createdAt: true } }],
      ['select updatedAt', 'findMany', { select: { updatedAt: true } }],
      ['no select (every column)', 'findMany', {}],
      ['no arguments at all', 'findMany', undefined],
      ['an empty select', 'findMany', { select: {} }],
      [
        'a select value other than true',
        'findMany',
        { select: { startsAt: { select: { x: true } } } },
      ],
      ['a select that relates', 'findMany', { select: { invitation: true } }],
      ['include', 'findMany', { select: FIVE, include: { invitation: true } }],
      ['omit', 'findMany', { select: FIVE, omit: { orgId: true } }],
      ['cursor', 'findMany', { select: FIVE, cursor: { id: 'x' } }],
      ['where orgId', 'findMany', { select: FIVE, where: { orgId: 'o' } }],
      [
        'where requestedBy inside AND',
        'findMany',
        { select: FIVE, where: { AND: [{ requestedBy: 'u' }] } },
      ],
      ['where invitationId inside NOT', 'count', { where: { NOT: { invitationId: null } } }],
      ['a relation filter', 'count', { where: { invitation: { is: { candidateId: 'c' } } } }],
      ['orderBy id', 'findMany', { select: FIVE, orderBy: { id: 'asc' } }],
      [
        'orderBy createdAt in a list',
        'findMany',
        { select: FIVE, orderBy: [{ startsAt: 'asc' }, { createdAt: 'asc' }] },
      ],
      ['distinct invitationId', 'findMany', { select: FIVE, distinct: ['invitationId'] }],
      ['distinct as one name', 'findMany', { select: FIVE, distinct: 'orgId' }],
      [
        'groupBy orgId (a per-organisation count)',
        'groupBy',
        { by: ['orgId'], _count: { _all: true } },
      ],
      ['groupBy with no by', 'groupBy', { _count: { _all: true } }],
      ['having requestedBy', 'groupBy', { by: ['kind'], having: { requestedBy: { not: null } } }],
      ['an aggregate of id', 'aggregate', { _count: { id: true } }],
      ['an aggregate of orgId', 'aggregate', { _max: { orgId: true } }],
      ['_avg', 'aggregate', { _avg: { startsAt: true } }],
      ['take as a string', 'findMany', { select: FIVE, take: '10' }],
      ['a count select of id', 'count', { select: { id: true } }],
    ])('TC-008 %s is refused', (_what, operation, args) => {
      expect(check(operation, args)).toThrow(OrgScopeViolationError);
    });

    it('TC-008 a field reference is refused (it would compare against a column outside the five)', () => {
      const fieldRef = {
        modelName: 'ScheduledWindow',
        name: 'createdAt',
        typeName: 'DateTime',
        isList: false,
        isEnum: false,
      };
      expect(check('count', { where: { startsAt: { gt: fieldRef } } })).toThrow(/field reference/);
    });

    it('TC-008 a class instance as structure is refused', () => {
      class Where {
        status = 'SCHEDULED';
      }
      expect(check('count', { where: new Where() })).toThrow(/plain arguments/);
    });

    it('TC-008 the message names columns and rules, never a value the caller passed', () => {
      let message = '';
      try {
        check('findMany', { select: FIVE, where: { orgId: 'org-secret-123' } })();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('orgId');
      expect(message).not.toContain('org-secret-123');
      expect(message).toContain('ADR 0017 section 4.7');
    });
  });

  describe('(b) and (c): any other reason, and any write, is refused for ScheduledWindow', () => {
    it.each(Object.keys(SYSTEM_SCOPE_REASONS).filter((reason) => reason !== 'SCHEDULE_CAPACITY'))(
      'TC-008 a %s system scope cannot read scheduled_windows at all',
      (reason) => {
        expect(check('findMany', { select: FIVE }, reason)).toThrow(/only under SCHEDULE_CAPACITY/);
        expect(check('deleteMany', { where: { kind: 'SLOT' } }, reason)).toThrow(
          /only under SCHEDULE_CAPACITY/,
        );
      },
    );

    it.each([
      'findUnique',
      'findUniqueOrThrow',
      'findFirst',
      'findFirstOrThrow',
      'create',
      'createMany',
      'createManyAndReturn',
      'update',
      'updateMany',
      'updateManyAndReturn',
      'upsert',
      'delete',
      'deleteMany',
    ])('TC-008 %s is refused under SCHEDULE_CAPACITY: writes stay org-scoped', (operation) => {
      expect(check(operation, { where: { kind: 'SLOT' } })).toThrow(OrgScopeViolationError);
    });
  });

  describe('(b) through a relation: no system query reaches scheduled_windows from another model (B1 of the #261 review)', () => {
    it('TC-008 the relations that lead to scheduled_windows are derived from FK_CLASSES and pinned', () => {
      expect([...SCHEDULE_BACK_RELATIONS]).toEqual([
        'requestedScheduledWindows',
        'scheduledWindows',
      ]);
      expect(Object.isFrozen(SCHEDULE_BACK_RELATIONS)).toBe(true);
    });

    const routes: ReadonlyArray<[string, string, string, unknown]> = [
      [
        'an include from Invitation',
        'Invitation',
        'findMany',
        { include: { scheduledWindows: true } },
      ],
      [
        'a select from Organization',
        'Organization',
        'findMany',
        { select: { id: true, scheduledWindows: true } },
      ],
      [
        'a nested select from User',
        'User',
        'findMany',
        { select: { requestedScheduledWindows: { select: { orgId: true } } } },
      ],
      [
        'a _count select',
        'Invitation',
        'findMany',
        { select: { _count: { select: { scheduledWindows: true } } } },
      ],
      [
        'a some filter (an oracle)',
        'User',
        'findMany',
        {
          select: { id: true },
          where: { requestedScheduledWindows: { some: { status: 'SCHEDULED' } } },
        },
      ],
      [
        'an orderBy _count',
        'Organization',
        'findMany',
        { orderBy: { scheduledWindows: { _count: 'desc' } } },
      ],
      [
        'two levels down, from Session',
        'Session',
        'findMany',
        { include: { invitation: { include: { scheduledWindows: true } } } },
      ],
      [
        'inside an array',
        'Invitation',
        'findMany',
        { where: { OR: [{ scheduledWindows: { none: {} } }] } },
      ],
      [
        'a count with a relation filter',
        'Invitation',
        'count',
        { where: { scheduledWindows: { some: {} } } },
      ],
    ];

    // Nit 5 of the #261 delta review: every other system reason, derived, so a new reason is covered without an edit.
    const OTHER_REASONS = Object.keys(SYSTEM_SCOPE_REASONS).filter(
      (r) => r !== 'SCHEDULE_CAPACITY',
    );

    for (const reason of OTHER_REASONS) {
      it.each(routes)(`TC-008 under ${reason}, %s is refused`, (_what, model, operation, args) => {
        expect(check(operation, args, reason, model)).toThrow(/leads to scheduled_windows/);
      });
    }

    // B1a of the #261 delta review: a _count with no explicit select counts every list relation of its model.
    const countAll: ReadonlyArray<[string, string, unknown]> = [
      [
        'select _count: true on Organization',
        'Organization',
        { select: { id: true, _count: true } },
      ],
      ['include _count: true on Invitation', 'Invitation', { include: { _count: true } }],
      ['include _count: {} on Invitation', 'Invitation', { include: { _count: {} } }],
      ['select _count: { select: null } on User', 'User', { select: { _count: { select: null } } }],
      ['select _count: true on User', 'User', { select: { id: true, orgId: true, _count: true } }],
      [
        'include _count: true two levels down, from Session',
        'Session',
        { include: { invitation: { include: { _count: true } } } },
      ],
      [
        'select _count: true two levels down, from Session',
        'Session',
        { select: { invitation: { select: { id: true, _count: true } } } },
      ],
    ];
    for (const reason of OTHER_REASONS) {
      it.each(countAll)(`TC-008 B1a under ${reason}, %s is refused`, (_what, model, args) => {
        expect(check('findMany', args, reason, model)).toThrow(/counts every relation/);
      });
    }

    it.each([
      [
        'an explicit _count select of another relation',
        'Invitation',
        'findMany',
        { select: { _count: { select: { sessions: true } } } },
      ],
      ['a row aggregate _count: true', 'Session', 'aggregate', { _count: true }],
      [
        'a groupBy orderBy _count',
        'Session',
        'groupBy',
        { by: ['status'], orderBy: { _count: { status: 'desc' } } },
      ],
      [
        'a groupBy having _count',
        'Session',
        'groupBy',
        { by: ['status'], having: { status: { _count: { gt: 1 } } } },
      ],
    ])('TC-008 B1a %s still passes', (_what, model, operation, args) => {
      expect(check(operation, args, 'RETENTION_ERASURE', model)).not.toThrow();
    });

    it('TC-008 B1a an explicit _count select that names scheduledWindows is refused by name', () => {
      expect(
        check(
          'findMany',
          { select: { _count: { select: { scheduledWindows: true } } } },
          'BACKGROUND_JOB',
          'Invitation',
        ),
      ).toThrow(/scheduledWindows leads to scheduled_windows/);
    });

    it('TC-008 B1b a relation 40 hops deep is still found, and arguments past the walk depth are refused, never passed', () => {
      let deep: Record<string, unknown> = { scheduledWindows: true };
      for (let hop = 0; hop < 40; hop += 1) {
        deep = { select: { [hop % 2 === 0 ? 'invitation' : 'sessions']: deep } };
      }
      expect(check('findMany', deep, 'BACKGROUND_JOB', 'Invitation')).toThrow(
        OrgScopeViolationError,
      );
      let tooDeep: Record<string, unknown> = { id: true };
      for (let hop = 0; hop < 120; hop += 1) tooDeep = { select: { invitation: tooDeep } };
      expect(check('findMany', tooDeep, 'BACKGROUND_JOB', 'Invitation')).toThrow(/nested too deep/);
    });

    it('TC-008 S-a the set holds every relation of a foreign key from or into scheduled_windows', () => {
      for (const key of FK_CLASSES) {
        if (key.model === 'ScheduledWindow') expect(SCHEDULE_BACK_RELATIONS).toContain(key.back);
        if (key.target === 'ScheduledWindow') expect(SCHEDULE_BACK_RELATIONS).toContain(key.field);
      }
    });

    it('TC-008 nit 4 a JSON write payload that merely holds the name is not a relation (write payloads are not walked)', () => {
      expect(
        check(
          'create',
          { data: { action: 'X', metadata: { scheduledWindows: 3 } } },
          'BACKGROUND_JOB',
          'AuditLog',
        ),
      ).not.toThrow();
    });

    it('TC-008 a system query on another model with no such relation is untouched', () => {
      expect(
        check(
          'findMany',
          { include: { sessions: true }, where: { id: 'x' } },
          'RETENTION_ERASURE',
          'Invitation',
        ),
      ).not.toThrow();
    });
  });

  describe('nit 1 of the #261 review: the scalar requestedById is refused by name too', () => {
    it.each([
      ['select', 'findMany', { select: { startsAt: true, requestedById: true } }],
      ['where', 'count', { where: { requestedById: 'u' } }],
      ['orderBy', 'findMany', { select: FIVE, orderBy: { requestedById: 'asc' } }],
      ['by', 'groupBy', { by: ['requestedById'], _count: { _all: true } }],
      ['distinct', 'findMany', { select: FIVE, distinct: ['requestedById'] }],
      ['_max', 'aggregate', { _max: { requestedById: true } }],
      ['invitationId in a where NOT', 'count', { where: { NOT: [{ invitationId: 'i' }] } }],
    ])('TC-008 requestedById in %s is refused', (_what, operation, args) => {
      expect(check(operation, args)).toThrow(OrgScopeViolationError);
    });
  });

  describe('(d) the reason reads no other model', () => {
    it.each(['Session', 'Invitation', 'Organization', 'User', 'Candidate'])(
      'TC-008 %s under SCHEDULE_CAPACITY is refused',
      (model) => {
        expect(check('findMany', { select: { id: true } }, 'SCHEDULE_CAPACITY', model)).toThrow(
          /reads scheduled_windows only/,
        );
      },
    );

    it('TC-008 another model under another reason is not this rule’s business', () => {
      expect(
        check('findMany', { where: { id: 'x' } }, 'RETENTION_ERASURE', 'Session'),
      ).not.toThrow();
    });
  });
});
