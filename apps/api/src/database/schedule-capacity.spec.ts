import { OrgScopeViolationError } from './errors';
import { SYSTEM_SCOPE_REASONS } from './org-context';
import {
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
