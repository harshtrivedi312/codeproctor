// The nested guards: deny-by-default for nested relation writes (ADR 0006 section 8), and no nested
// cursors. Pure functions, no database; the queries that reach Postgres are in
// tc-008-org-isolation.spec.ts.
import { OrgScopeViolationError } from './errors';
import { applyOrgScope } from './org-scope-args';
import { ORG_SCOPE } from './org-scope-map';
import type { ModelName } from './org-scope-map';
import { assertNoNestedWrites, NESTED_WRITE_ALLOWLIST } from './org-scope-nested';
import type { NestedWriteAllowance } from './org-scope-nested';
import { relationKeys } from './org-scope-relations';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ID_OF_B = '33333333-3333-4333-8333-333333333333';

type Args = Record<string, unknown>;

function scope(model: ModelName, operation: string, args: unknown): Args {
  return applyOrgScope({ model, rule: ORG_SCOPE[model], operation, args, orgId: ORG_A });
}

const refused = (model: ModelName, operation: string, args: unknown): void => {
  expect(() => scope(model, operation, args)).toThrow(OrgScopeViolationError);
};

const NESTED_OPERATIONS = [
  'connect',
  'connectOrCreate',
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'set',
  'disconnect',
] as const;

/** A plausible value for each nested operation. The guard refuses on the key, never on the value. */
const NESTED_VALUE: Record<(typeof NESTED_OPERATIONS)[number], unknown> = {
  connect: { id: ID_OF_B },
  connectOrCreate: { where: { id: ID_OF_B }, create: {} },
  create: { title: 't' },
  createMany: { data: [{ title: 't' }] },
  update: { where: { id: ID_OF_B }, data: { title: 'u' } },
  updateMany: { where: {}, data: { title: 'u' } },
  upsert: { where: { id: ID_OF_B }, create: {}, update: { title: 'u' } },
  delete: true,
  deleteMany: {},
  set: [{ id: ID_OF_B }],
  disconnect: true,
};

/** Every operation that carries a payload, with the payload where Prisma puts it. */
const WRITE_OPERATIONS: Array<[string, (data: Args) => Args]> = [
  ['create', (data) => ({ data })],
  ['update', (data) => ({ where: { id: 'x' }, data })],
  ['updateMany', (data) => ({ where: {}, data })],
  ['updateManyAndReturn', (data) => ({ where: {}, data })],
  ['upsert (create branch)', (data) => ({ where: { id: 'x' }, create: data, update: {} })],
  ['upsert (update branch)', (data) => ({ where: { id: 'x' }, create: {}, update: data })],
];

describe('nested relation writes are denied by default (NFR-04, FR-103; ADR 0006 section 8)', () => {
  const relations = relationKeys().map((key) => key.split('.') as [ModelName, string]);

  it('TC-008 the relation table covers all 118 relation fields of the schema, both sides of 59 foreign keys', () => {
    expect(relations).toHaveLength(118);
  });

  it.each(NESTED_OPERATIONS)(
    'TC-008 nested %s is refused through every relation, on both sides, in create, update and upsert',
    (op) => {
      for (const [model, field] of relations) {
        for (const [name, build] of WRITE_OPERATIONS) {
          const operation = name.split(' ')[0] as string;
          const data = { [field]: { [op]: NESTED_VALUE[op] } };
          // Refused by the nested rule itself (the message names the relation field and the
          // operation), not by some other check on the way.
          expect(() => scope(model, operation, build(data))).toThrow(
            `${model}.${operation}: nested relation write refused (${model}.${field}.${op}): `,
          );
        }
      }
    },
  );

  it('TC-008 the refusal does not depend on the shape of the value: empty, null, a list or a string', () => {
    for (const value of [{}, null, [], [{ id: 'x' }], 'x', true, 1]) {
      expect(() =>
        scope('Session', 'update', { where: { id: 'x' }, data: { invitation: value } }),
      ).toThrow(/nested relation write refused \(Session\.invitation\./);
    }
  });

  it('TC-008 the message names the operation, model, relation and nested operation, and nothing else', () => {
    let message = '';
    try {
      scope('Organization', 'update', {
        where: { id: ORG_A },
        data: { users: { connect: { id: ID_OF_B } } },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      'Organization.update: nested relation write refused (Organization.users.connect): write ' +
        'related rows with their own scoped call and scalar foreign keys (ADR 0006 §8, ' +
        'deny-by-default).',
    );
    expect(message).not.toContain(ID_OF_B);
    expect(message).not.toContain(ORG_A);
  });

  describe('the attacks this rule exists for', () => {
    it("TC-008 parent-side connect, set and update of another org's rows", () => {
      refused('Organization', 'update', {
        where: { id: ORG_A },
        data: { users: { connect: { id: ID_OF_B } } },
      });
      refused('TestSection', 'update', {
        where: { id: 'x' },
        data: { questions: { set: [{ id: ID_OF_B }] } },
      });
      refused('User', 'update', {
        where: { id: 'x' },
        data: { sessionReviews: { updateMany: { where: {}, data: { notes: 'n' } } } },
      });
      refused('User', 'update', {
        where: { id: 'x' },
        data: { sessionReviews: { deleteMany: {} } },
      });
    });

    it('TC-008 RULE_I takeover: reviewer.update, with and without a connect next to it', () => {
      refused('SessionReview', 'update', {
        where: { id: 'x' },
        data: { reviewer: { update: { passwordHash: 'p' } } },
      });
      refused('SessionReview', 'update', {
        where: { id: 'x' },
        data: {
          reviewer: { connect: { id: ID_OF_B }, update: { email: 'a@x.test', passwordHash: 'p' } },
        },
      });
    });

    it('TC-008 FR-305 ADR 0015 4: nested writes through identity_checks.video_check_by, a RULE_I staff relation, are refused on both sides, like reviewed_by', () => {
      for (const [model, field] of [
        ['IdentityCheck', 'videoCheckBy'],
        ['IdentityCheck', 'reviewedBy'],
      ] as const) {
        refused(model, 'update', {
          where: { id: 'x' },
          data: { [field]: { update: { passwordHash: 'p' } } },
        });
        refused(model, 'update', {
          where: { id: 'x' },
          data: {
            [field]: { connect: { id: ID_OF_B }, update: { email: 'a@x.test', passwordHash: 'p' } },
          },
        });
        refused(model, 'update', { where: { id: 'x' }, data: { [field]: { delete: true } } });
        refused(model, 'update', { where: { id: 'x' }, data: { [field]: { disconnect: true } } });
        refused(model, 'create', {
          data: { sessionId: 's', [field]: { connect: { id: ID_OF_B } } },
        });
      }
      for (const field of ['videoCheckedIdentityChecks', 'reviewedIdentityChecks'] as const) {
        refused('User', 'update', {
          where: { id: 'x' },
          data: { [field]: { updateMany: { where: {}, data: { reviewNote: 'n' } } } },
        });
        refused('User', 'update', { where: { id: 'x' }, data: { [field]: { deleteMany: {} } } });
        refused('User', 'update', {
          where: { id: 'x' },
          data: { [field]: { connect: { id: ID_OF_B } } },
        });
      }
      // The scalar foreign key is not a relation write: services write it after loading the user in scope.
      expect(() =>
        scope('IdentityCheck', 'update', {
          where: { id: 'x' },
          data: { videoCheckDone: true, videoCheckById: ID_OF_B, videoCheckAt: new Date() },
        }),
      ).not.toThrow();
      expect(() =>
        scope('IdentityCheck', 'create', {
          data: { sessionId: 's', attempt: 1, status: 'WAIVED' },
        }),
      ).not.toThrow();
    });

    it('TC-008 B2(a): connect through a COMPOSITE relation rewrites org_id, so it is refused (update and create)', () => {
      // The scalar form (invitationId) keeps org_id as it is, and Postgres checks the composite key.
      refused('Session', 'update', {
        where: { id: 'x' },
        data: { invitation: { connect: { id: ID_OF_B } } },
      });
      refused('Session', 'create', {
        data: { org: { connect: { id: ORG_A } }, invitation: { connect: { id: ID_OF_B } } },
      });
      refused('Invitation', 'update', {
        where: { id: 'x' },
        data: { test: { connect: { id: ID_OF_B } }, candidate: { connect: { id: ID_OF_B } } },
      });
      refused('Invitation', 'create', {
        data: { test: { connect: { id: ID_OF_B } }, candidate: { connect: { id: ID_OF_B } } },
      });
    });

    it('TC-008 B2(b): connect plus a write in one to-one input is refused, in every class', () => {
      for (const [model, field] of [
        ['RefreshToken', 'user'], // SCOPE_HOP
        ['TestSection', 'test'], // SCOPE_HOP
        ['Submission', 'sessionQuestion'], // SCOPE_HOP
        ['Session', 'invitation'], // COMPOSITE
        ['SessionReview', 'reviewer'], // RULE_I
      ] as const) {
        refused(model, 'update', {
          where: { id: 'x' },
          data: {
            [field]: { connect: { id: ID_OF_B }, update: { passwordHash: 'p', email: 'a@x.test' } },
          },
        });
      }
    });
  });

  describe('the org relation (org: { connect })', () => {
    it('TC-008 org: { connect } is refused on every model with an org_id; services set the scalar orgId', () => {
      for (const model of [
        'User',
        'Question',
        'Test',
        'Candidate',
        'Invitation',
        'Session',
        'AuditLog',
        'ConsentText',
        'WebhookEndpoint',
      ] as const) {
        refused(model, 'create', { data: { org: { connect: { id: ORG_A } } } });
        refused(model, 'update', { where: { id: 'x' }, data: { org: { connect: { id: ORG_A } } } });
      }
      // A flat createMany row is not walked, but its org relation is still refused.
      refused('Test', 'createMany', { data: [{ name: 't', org: { connect: { id: ORG_A } } }] });
      refused('Test', 'createManyAndReturn', { data: { org: { connect: { id: ORG_A } } } });
    });

    it("TC-008 the scalar orgId is stamped when missing, accepted when it is the caller's, and refused for another org", () => {
      expect(scope('Test', 'create', { data: { name: 't' } }).data).toEqual({
        name: 't',
        orgId: ORG_A,
      });
      expect(scope('Test', 'create', { data: { name: 't', orgId: ORG_A } }).data).toEqual({
        name: 't',
        orgId: ORG_A,
      });
      refused('Test', 'create', { data: { name: 't', orgId: ORG_B } });
    });
  });

  describe('what stays allowed', () => {
    it('TC-008 scalar fields, including scalar foreign keys, in create, update and upsert', () => {
      const scalars: Array<[ModelName, Args]> = [
        ['Session', { invitationId: ID_OF_B, status: 'INVITED' }],
        ['Invitation', { testId: 't', candidateId: 'c', tokenHash: 'h' }],
        ['SessionReview', { reviewerId: ID_OF_B, notes: 'n' }],
        ['RefreshToken', { userId: ID_OF_B, familyId: 'f' }],
        ['TestSection', { testId: 't', title: 'x', position: 1 }],
        [
          'SessionQuestion',
          { sessionId: 's', testQuestionId: 't', questionVersionId: 'v', variantId: null },
        ],
      ];
      for (const [model, data] of scalars) {
        for (const [name, build] of WRITE_OPERATIONS) {
          expect(() => scope(model, name.split(' ')[0] as string, build(data))).not.toThrow();
        }
      }
    });

    it('TC-008 a scalar list keeps its { set }, and a Json column is never entered', () => {
      const lookalike = {
        users: { connect: { id: ID_OF_B } },
        sections: { set: [{ id: ID_OF_B }] },
      };
      expect(() =>
        scope('Question', 'update', { where: { id: 'x' }, data: { tags: { set: ['a'] } } }),
      ).not.toThrow();
      expect(() =>
        scope('User', 'update', {
          where: { id: 'x' },
          data: { recoveryCodeHashes: { set: ['h'] } },
        }),
      ).not.toThrow();
      expect(() =>
        scope('WebhookEndpoint', 'create', {
          data: { url: 'u', events: { set: ['e'] }, secretEnc: 's' },
        }),
      ).not.toThrow();
      expect(() =>
        scope('Test', 'update', { where: { id: 'x' }, data: { settings: lookalike } }),
      ).not.toThrow();
      expect(() =>
        scope('Organization', 'update', { where: { id: ORG_A }, data: { settings: lookalike } }),
      ).not.toThrow();
      expect(() =>
        scope('QuestionVersion', 'update', {
          where: { id: 'x' },
          data: { starterCode: lookalike, limits: { connect: 1 } },
        }),
      ).not.toThrow();
    });

    it('TC-008 a flat createMany of any model is not walked, so ingest paths pay nothing', () => {
      const rows = Array.from({ length: 1000 }, (_, i) => ({ sessionId: 's', seq: i }));
      expect(() => scope('ProctorEvent', 'createMany', { data: rows })).not.toThrow();
      expect(() => scope('ProctorEvent', 'createManyAndReturn', { data: rows })).not.toThrow();
    });

    it('TC-008 a relation key that is undefined, data that is not an object, and reads are left alone', () => {
      expect(() =>
        scope('Session', 'update', {
          where: { id: 'x' },
          data: { invitation: undefined, status: 'GRADED' },
        }),
      ).not.toThrow();
      expect(() => scope('Session', 'update', { where: { id: 'x' } })).not.toThrow();
      expect(() => scope('Session', 'update', { where: { id: 'x' }, data: 'nope' })).not.toThrow();
      // include and select name relations too, but they are reads.
      expect(() =>
        scope('Session', 'findMany', { include: { invitation: true, org: true } }),
      ).not.toThrow();
    });
  });

  describe('the allowlist', () => {
    it('TC-008 NESTED_WRITE_ALLOWLIST is empty: BE-02 and BE-03 use scalar foreign keys only', () => {
      // Adding an entry is a reviewed change: it needs the model, the relation, the operations and
      // its own cross-org test in tc-008-org-isolation.spec.ts. This test fails until then.
      expect(NESTED_WRITE_ALLOWLIST).toEqual([]);
    });

    it('TC-008 an entry allows exactly the named model, relation and operations, and nothing else', () => {
      const allowlist: NestedWriteAllowance[] = [
        { model: 'Session', field: 'invitation', operations: ['disconnect'], reason: 'test only' },
      ];
      expect(() =>
        assertNoNestedWrites('Session', 'update', { invitation: { disconnect: true } }, allowlist),
      ).not.toThrow();
      // Another operation on the same relation, another relation, another model: still refused.
      for (const [model, data] of [
        ['Session', { invitation: { connect: { id: 'x' } } }],
        ['Session', { invitation: { disconnect: true, update: { data: {} } } }],
        ['Session', { consent: { disconnect: true } }],
        ['Invitation', { sessions: { disconnect: [{ id: 'x' }] } }],
      ] as const) {
        expect(() => assertNoNestedWrites(model, 'update', data, allowlist)).toThrow(
          OrgScopeViolationError,
        );
      }
    });
  });

  it('TC-008 the guard does not change the arguments it was given', () => {
    const args = { where: { id: 'x' }, data: { name: 'n', settings: { a: 1 } } };
    const copy = structuredClone(args);
    scope('Test', 'update', args);
    expect(args).toEqual(copy);
    const refusedArgs = { where: { id: 'x' }, data: { sections: { create: { title: 't' } } } };
    const refusedCopy = structuredClone(refusedArgs);
    expect(() => scope('Test', 'update', refusedArgs)).toThrow();
    expect(refusedArgs).toEqual(refusedCopy);
  });
});

describe('nested cursors in include and select (NFR-04, FR-103)', () => {
  describe('refused', () => {
    const OPS_WITH_SELECTION = [
      'findUnique',
      'findUniqueOrThrow',
      'findFirst',
      'findFirstOrThrow',
      'findMany',
      'create',
      'update',
      'upsert',
      'delete',
      'createManyAndReturn',
      'updateManyAndReturn',
    ];
    const withSelection = (operation: string, selection: Args): Args => ({
      where: { id: 'x' },
      data: {},
      create: {},
      update: {},
      ...selection,
    });

    it.each(OPS_WITH_SELECTION)(
      'TC-008 %s: include and select with a nested cursor are refused',
      (operation) => {
        for (const model of ['Session', 'Test', 'User'] as const) {
          const field =
            model === 'Session'
              ? 'proctorEvents'
              : model === 'Test'
                ? 'sections'
                : 'sessionReviews';
          for (const key of ['include', 'select'] as const) {
            refused(
              model,
              operation,
              withSelection(operation, { [key]: { [field]: { cursor: { id: 1 }, take: 2 } } }),
            );
          }
        }
      },
    );

    it('TC-008 the fluent API reaches the extension as a select on the relation, and is refused', () => {
      // session.findUnique({ where }).proctorEvents({ cursor, orderBy }) arrives exactly like this
      // (checked against Prisma 7: operation findUnique, select: { proctorEvents: { cursor, ... } }).
      for (const operation of [
        'findUnique',
        'findUniqueOrThrow',
        'findFirst',
        'findFirstOrThrow',
      ]) {
        refused('Session', operation, {
          where: { id: 'x' },
          select: { proctorEvents: { cursor: { id: 2n }, orderBy: { id: 'asc' } } },
        });
      }
    });

    it('TC-008 a selection nested more than 16 relations deep is refused with its own message (FU-DB-99)', () => {
      const include = (depth: number): Args =>
        depth === 0 ? {} : { include: { replaces: include(depth - 1) } };
      expect(() => scope('RefreshToken', 'findMany', include(10))).not.toThrow();
      refused('RefreshToken', 'findMany', include(20));
      let message = '';
      try {
        scope('RefreshToken', 'findMany', include(20));
      } catch (error) {
        message = (error as Error).message;
      }
      // A selection is a read: the message does not talk about a nested write.
      expect(message).toContain(
        'RefreshToken.findMany: selection refused at RefreshToken.replaces',
      );
      expect(message).toContain('nested more than 16 relations deep');
      expect(message).not.toContain('nested write');
      expect(message).not.toContain('nested relation write refused');
    });

    it('TC-008 a nested cursor is refused at any depth, in include, select and _count', () => {
      refused('Test', 'findMany', {
        include: { sections: { include: { questions: { cursor: { id: 'q' } } } } },
      });
      refused('Test', 'findMany', {
        select: {
          sections: { select: { questions: { select: { id: true }, cursor: { id: 'q' } } } },
        },
      });
      refused('Test', 'findMany', {
        include: {
          sections: {
            select: { questions: { include: { sessionQuestions: { cursor: { id: 'q' } } } } },
          },
        },
      });
      refused('Session', 'findFirst', {
        select: { _count: { select: { proctorEvents: { cursor: { id: 1 } } } } },
      });
    });

    it('TC-008 the message names the model, field and the way to page, and carries no value', () => {
      let message = '';
      try {
        scope('Session', 'findUnique', {
          where: { id: ID_OF_B },
          include: { proctorEvents: { cursor: { id: ID_OF_B } } },
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('Session.findUnique');
      expect(message).toContain('Session.proctorEvents');
      expect(message).toContain('where, take and orderBy');
      expect(message).not.toContain(ID_OF_B);
    });

    it('TC-008 nested paging with where, take, skip and orderBy is allowed, and so is a plain include or select', () => {
      for (const key of ['include', 'select'] as const) {
        expect(() =>
          scope('Session', 'findUnique', {
            where: { id: 'x' },
            [key]: {
              proctorEvents: {
                where: { id: { gt: 5n } },
                take: 10,
                skip: 1,
                orderBy: { id: 'asc' },
              },
              questions: true,
              id: true,
              _count: true,
            },
          }),
        ).not.toThrow();
      }
      expect(() =>
        scope('Session', 'findMany', {
          include: { _count: { select: { proctorEvents: { where: { severity: 'LOW' } } } } },
        }),
      ).not.toThrow();
    });

    it('TC-008 a top-level cursor and a nested cursor are checked independently', () => {
      // A direct model keeps its scoped top-level cursor; a nested one next to it is still refused.
      expect(() =>
        scope('Test', 'findMany', { cursor: { id: 'x' }, include: { sections: true } }),
      ).not.toThrow();
      refused('Test', 'findMany', {
        cursor: { id: 'x' },
        include: { sections: { cursor: { id: 'y' } } },
      });
    });
  });
});
