// The nested-write guard (FU-DB-63): what `applyOrgScope` refuses and allows inside `data`. Pure
// functions, no database; the queries that reach Postgres are in tc-008-org-isolation.spec.ts.
import { OrgScopeViolationError } from './errors';
import { applyOrgScope } from './org-scope-args';
import { ORG_SCOPE } from './org-scope-map';
import type { ModelName } from './org-scope-map';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ID_OF_B = '33333333-3333-4333-8333-333333333333';

type Args = Record<string, unknown>;

function scope(model: ModelName, operation: string, args: unknown): Args {
  return applyOrgScope({ model, rule: ORG_SCOPE[model], operation, args, orgId: ORG_A });
}

/** True when scoping `data` as an org-scope update refuses it. */
const refusedBy = (model: ModelName, data: Args): boolean => {
  try {
    scope(model, 'update', { where: { id: 'x' }, data });
    return false;
  } catch (error) {
    if (error instanceof OrgScopeViolationError) return true;
    throw error;
  }
};

const refused = (model: ModelName, operation: string, args: unknown): void => {
  expect(() => scope(model, operation, args)).toThrow(OrgScopeViolationError);
};

describe('nested writes in an org scope (NFR-04, FR-103; FU-DB-63)', () => {
  describe('refused: connect, connectOrCreate and set on a parent-side relation', () => {
    it.each(['update', 'updateManyAndReturn'])(
      "TC-008 %s: organization.update users.connect of another org's user",
      (operation) => {
        refused('Organization', operation, {
          where: { id: ORG_A },
          data: { users: { connect: { id: ID_OF_B } } },
        });
      },
    );

    it.each([
      ['Organization', 'users', 'connect', { id: ID_OF_B }],
      ['Organization', 'users', 'connect', [{ id: ID_OF_B }]],
      ['Organization', 'tests', 'set', [{ id: ID_OF_B }]],
      ['Test', 'sections', 'connect', { id: ID_OF_B }],
      ['TestSection', 'questions', 'set', [{ id: ID_OF_B }]],
      ['Session', 'questions', 'connect', [{ id: ID_OF_B }]],
      ['Session', 'proctorEvents', 'connect', [{ id: 1 }]],
      ['Session', 'consent', 'connect', { id: ID_OF_B }],
      ['Session', 'review', 'connect', { id: ID_OF_B }],
      ['User', 'createdQuestions', 'connect', { id: ID_OF_B }],
      ['ConsentText', 'currentForOrganizations', 'connect', { id: ORG_B }],
      ['RefreshToken', 'replaces', 'connect', { id: ID_OF_B }],
      ['SessionQuestion', 'submissions', 'set', [{ id: ID_OF_B }]],
      ['WebhookEndpoint', 'deliveries', 'connect', [{ id: 1 }]],
    ] as const)(
      'TC-008 %s.%s: %s is refused (the foreign key is on the related model)',
      (model, field, op, value) => {
        for (const operation of ['update', 'updateMany', 'upsert', 'create']) {
          const data = { [field]: { [op]: value } };
          const args = { where: { id: 'x' }, data, create: data, update: data };
          // Organization.create is refused for another reason; the point is that it is refused.
          refused(model, operation, args);
        }
      },
    );

    it('TC-008 connectOrCreate on a parent-side relation is refused', () => {
      refused('Session', 'update', {
        where: { id: 'x' },
        data: {
          review: {
            connectOrCreate: { where: { sessionId: 'x' }, create: { reviewerId: ID_OF_B } },
          },
        },
      });
      refused('Test', 'update', {
        where: { id: 'x' },
        data: {
          sections: {
            connectOrCreate: [{ where: { id: ID_OF_B }, create: { title: 't', position: 0 } }],
          },
        },
      });
    });

    it('TC-008 the same refusal holds at any depth', () => {
      refused('Test', 'update', {
        where: { id: 'x' },
        data: {
          sections: {
            update: { where: { id: 'y' }, data: { questions: { connect: { id: ID_OF_B } } } },
          },
        },
      });
      refused('Test', 'update', {
        where: { id: 'x' },
        data: {
          sections: {
            create: {
              title: 't',
              position: 1,
              questions: {
                create: { position: 0, sessionQuestions: { connect: { id: ID_OF_B } } },
              },
            },
          },
        },
      });
      refused('Test', 'upsert', {
        where: { id: 'x' },
        create: {},
        update: {
          sections: {
            upsert: {
              where: { id: 'y' },
              create: {},
              update: { questions: { set: [{ id: ID_OF_B }] } },
            },
          },
        },
      });
    });

    it('TC-008 the message names the model, the field and the way out, and carries no value', () => {
      let message = '';
      try {
        scope('Organization', 'update', {
          where: { id: ORG_A },
          data: { users: { connect: { id: ID_OF_B } } },
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('Organization.update');
      expect(message).toContain('Organization.users');
      expect(message).toContain('rule (i)');
      expect(message).not.toContain(ID_OF_B);
      expect(message).not.toContain(ORG_A);
      expect(message).not.toContain(ORG_B);
    });
  });

  describe('refused: a nested row of a model with its own org that names another org', () => {
    // organization.questions (an ORG_ID relation): the parent is the caller's own organization, and
    // the nested question carries its own org. Candidate.invitations is a COMPOSITE relation.
    const question = { slug: 's' };

    it.each([
      ['create', { create: { ...question, orgId: ORG_B } }],
      [
        'create (list)',
        {
          create: [
            { ...question, orgId: ORG_A },
            { ...question, orgId: ORG_B },
          ],
        },
      ],
      ['createMany', { createMany: { data: [{ ...question, orgId: ORG_B }] } }],
      [
        'upsert, create branch',
        { upsert: { where: { id: 'x' }, create: { ...question, orgId: ORG_B }, update: {} } },
      ],
      [
        'upsert, update branch',
        { upsert: { where: { id: 'x' }, create: {}, update: { orgId: ORG_B } } },
      ],
      ['update (where and data)', { update: { where: { id: 'x' }, data: { orgId: ORG_B } } }],
      ['update (set form)', { update: { where: { id: 'x' }, data: { orgId: { set: ORG_B } } } }],
      ['updateMany', { updateMany: { where: {}, data: { orgId: ORG_B } } }],
      ['create, org connect', { create: { ...question, org: { connect: { id: ORG_B } } } }],
      ['create, org create', { create: { ...question, org: { create: { name: 'x' } } } }],
      [
        'update, org relation',
        { update: { where: { id: 'x' }, data: { org: { connect: { id: ORG_A } } } } },
      ],
    ])('TC-008 organization.update questions.%s is refused', (_name, nested) => {
      refused('Organization', 'update', { where: { id: ORG_A }, data: { questions: nested } });
    });

    it('TC-008 a create or upsert of the parent carries the same check, through a COMPOSITE relation', () => {
      const invitation = { testId: 't', tokenHash: 'h' };
      refused('Candidate', 'create', {
        data: {
          email: 'a',
          fullName: 'a',
          invitations: { create: { ...invitation, orgId: ORG_B } },
        },
      });
      refused('Candidate', 'upsert', {
        where: { id: 'x' },
        create: { orgId: ORG_A, invitations: { create: { ...invitation, orgId: ORG_B } } },
        update: {},
      });
      refused('Candidate', 'update', {
        where: { id: 'x' },
        data: { invitations: { createMany: { data: [{ ...invitation, orgId: ORG_B }] } } },
      });
    });

    it('TC-008 a nested create of an organization is refused, however it is reached', () => {
      refused('ConsentText', 'update', {
        where: { id: 'x' },
        data: { currentForOrganizations: { create: { name: 'rogue' } } },
      });
      refused('ConsentText', 'update', {
        where: { id: 'x' },
        data: { currentForOrganizations: { createMany: { data: [{ name: 'rogue' }] } } },
      });
      refused('ConsentText', 'update', {
        where: { id: 'x' },
        data: {
          currentForOrganizations: {
            upsert: { where: { id: ORG_B }, create: { name: 'r' }, update: {} },
          },
        },
      });
    });

    it('TC-008 an organization reached through a relation keeps its id', () => {
      refused('ConsentText', 'update', {
        where: { id: 'x' },
        data: {
          currentForOrganizations: { update: { where: { id: ORG_B }, data: { id: ORG_A } } },
        },
      });
    });
  });

  describe('refused: what the guard does not know (fails closed) or will not walk', () => {
    it('TC-008 an unknown nested operation is refused', () => {
      refused('Test', 'update', {
        where: { id: 'x' },
        data: { sections: { teleport: { id: 'y' } } },
      });
    });

    it('TC-008 a nest deeper than 16 relations is refused (the guard is a safety net, not a reachable limit)', () => {
      // Through ORG_ID, SCOPE_HOP and COMPOSITE relations the nest is a few levels deep at most. The
      // nested cursor walk has no such limit on the schema, so it shows the depth guard.
      const include = (depth: number): Args =>
        depth === 0 ? {} : { include: { replaces: include(depth - 1) } };
      expect(() => scope('RefreshToken', 'findMany', include(10))).not.toThrow();
      refused('RefreshToken', 'findMany', include(20));
    });
  });

  describe('allowed', () => {
    it('TC-008 a child-side connect is the same as setting the scalar foreign key (rule (i))', () => {
      const cases: Array<[ModelName, Args]> = [
        ['Session', { invitation: { connect: { id: 'i' } } }],
        ['TestQuestion', { questionVersion: { connect: { id: 'v' } } }],
        [
          'SessionQuestion',
          { testQuestion: { connect: { id: 't' } }, variant: { connect: { id: 'v' } } },
        ],
        ['Submission', { sessionQuestion: { connect: { id: 's' } } }],
        ['RefreshToken', { replacedBy: { connect: { id: 'r' } }, user: { connect: { id: 'u' } } }],
        [
          'Question',
          { createdBy: { connect: { id: 'u' } }, currentVersion: { connect: { id: 'v' } } },
        ],
        ['SessionReview', { reviewer: { connect: { id: 'u' } } }],
      ];
      for (const [model, data] of cases) {
        for (const operation of ['update', 'create']) {
          expect(() => scope(model, operation, { where: { id: 'x' }, data })).not.toThrow();
        }
        expect(() =>
          scope(model, 'upsert', { where: { id: 'x' }, create: data, update: data }),
        ).not.toThrow();
      }
    });

    it('TC-008 nested create, update, upsert, delete, deleteMany, disconnect and updateMany under an in-scope parent', () => {
      const data = {
        sections: {
          create: [{ title: 'a', position: 0, questions: { create: { position: 0 } } }],
          createMany: { data: [{ title: 'b', position: 1 }] },
          update: [
            {
              where: { id: 's1' },
              data: {
                title: 'c',
                questions: { update: { where: { id: 'q' }, data: { position: 3 } } },
              },
            },
          ],
          updateMany: { where: {}, data: { title: 'd' } },
          upsert: {
            where: { id: 's2' },
            create: { title: 'e', position: 2 },
            update: { title: 'f' },
          },
          delete: [{ id: 's3' }],
          deleteMany: { position: { gt: 9 } },
          disconnect: [{ id: 's4' }],
        },
      };
      expect(() => scope('Test', 'update', { where: { id: 'x' }, data })).not.toThrow();
      expect(() =>
        scope('Test', 'update', {
          where: { id: 'x' },
          data: { sections: { update: { title: 'to-one form' } } },
        }),
      ).not.toThrow();
    });

    it("TC-008 a nested row of a model with its own org that names the caller's org, or none", () => {
      const question = { slug: 's' };
      const data = {
        questions: {
          create: [
            { ...question, orgId: ORG_A },
            { ...question },
            { ...question, org: { connect: { id: ORG_A } } },
          ],
          createMany: { data: [{ ...question, orgId: ORG_A }] },
          update: { where: { id: 'x' }, data: { orgId: ORG_A, isArchived: true } },
          upsert: {
            where: { id: 'x' },
            create: { ...question, orgId: ORG_A },
            update: { orgId: { set: ORG_A } },
          },
        },
      };
      expect(() => scope('Organization', 'update', { where: { id: ORG_A }, data })).not.toThrow();
    });

    it('TC-008 a Json column is never entered, and a scalar list keeps its { set }', () => {
      // The Json value looks like a nested write; it is data. So does the list.
      const lookalike = {
        users: { connect: { id: ID_OF_B } },
        sections: { set: [{ id: ID_OF_B }] },
      };
      expect(() =>
        scope('Test', 'update', { where: { id: 'x' }, data: { settings: lookalike } }),
      ).not.toThrow();
      expect(() =>
        scope('Question', 'update', { where: { id: 'x' }, data: { tags: { set: ['a', 'b'] } } }),
      ).not.toThrow();
      expect(() =>
        scope('User', 'update', {
          where: { id: 'x' },
          data: { recoveryCodeHashes: { set: ['h'] } },
        }),
      ).not.toThrow();
      expect(() =>
        scope('WebhookEndpoint', 'create', {
          data: { url: 'u', events: { set: ['x'] }, secretEnc: 's' },
        }),
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

    it('TC-008 createMany of any model is flat: relation-looking keys in a row are not walked', () => {
      // Prisma rejects relations in createMany itself; the guard adds no walk and no cost.
      const rows = Array.from({ length: 1000 }, (_, i) => ({
        sessionId: 's',
        seq: i,
        users: { connect: { id: 'x' } },
      }));
      expect(() => scope('ProctorEvent', 'createMany', { data: rows })).not.toThrow();
      expect(() => scope('ProctorEvent', 'createManyAndReturn', { data: rows })).not.toThrow();
    });

    it('TC-008 data that is not an object, or has no relations, passes through unchanged', () => {
      expect(scope('Test', 'update', { where: { id: 'x' }, data: { name: 'n' } }).data).toEqual({
        name: 'n',
      });
      expect(() => scope('Test', 'update', { where: { id: 'x' } })).not.toThrow();
      expect(() => scope('Test', 'update', { where: { id: 'x' }, data: 'nope' })).not.toThrow();
    });
  });

  describe('refused: a cursor nested in include or select', () => {
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

  describe("through a RULE_I relation (S-A): nested writes can reach another org's rows", () => {
    // Child side (this model holds the key) and parent side, for a staff and a cross-chain relation.
    const relations = [
      ['SessionReview', 'reviewer', 'child side, staff'],
      ['User', 'sessionReviews', 'parent side, staff'],
      ['SessionQuestion', 'testQuestion', 'child side, cross-chain'],
      ['TestQuestion', 'sessionQuestions', 'parent side, cross-chain'],
      ['Organization', 'currentConsentText', 'child side, cross-chain'],
      ['ConsentText', 'currentForOrganizations', 'parent side, cross-chain'],
      ['Question', 'createdBy', 'child side, staff'],
      ['User', 'createdQuestions', 'parent side, staff'],
    ] as const;
    const NESTED_OPS: Array<[string, unknown]> = [
      ['create', { title: 't' }],
      ['createMany', { data: [{ title: 't' }] }],
      ['update', { where: { id: 'x' }, data: { passwordHash: 'p' } }],
      ['update (to-one form)', { passwordHash: 'p' }],
      ['updateMany', { where: {}, data: { notes: 'n' } }],
      ['upsert', { where: { id: 'x' }, create: {}, update: { passwordHash: 'p' } }],
      ['delete', true],
      ['delete (list)', [{ id: 'x' }]],
      ['deleteMany', { notes: 'n' }],
      ['connectOrCreate', { where: { id: 'x' }, create: {} }],
    ];

    describe.each(relations)('%s.%s (%s)', (model, field) => {
      it.each(NESTED_OPS)('TC-008 nested %s is refused', (name, value) => {
        const op = name.split(' ')[0] as string;
        for (const operation of ['update', 'upsert']) {
          const data = { [field]: { [op]: value } };
          refused(model, operation, { where: { id: 'x' }, data, create: data, update: data });
        }
      });
    });

    it('TC-008 deeper: a RULE_I relation inside an allowed nest is refused', () => {
      // test.sections (SCOPE_HOP) is allowed; sessionQuestions under a test question (RULE_I) is not.
      expect(() =>
        scope('Test', 'update', {
          where: { id: 'x' },
          data: { sections: { update: { where: { id: 's' }, data: { title: 't' } } } },
        }),
      ).not.toThrow();
      refused('Test', 'update', {
        where: { id: 'x' },
        data: {
          sections: {
            update: {
              where: { id: 's' },
              data: {
                questions: {
                  update: { where: { id: 'q' }, data: { sessionQuestions: { deleteMany: {} } } },
                },
              },
            },
          },
        },
      });
    });

    it('TC-008 the reviewer takeover example is refused, with a connect next to the update', () => {
      refused('SessionReview', 'update', {
        where: { id: 'own' },
        data: {
          reviewer: {
            connect: { id: ID_OF_B },
            update: { email: 'attacker@example.test', passwordHash: 'x' },
          },
        },
      });
      refused('SessionReview', 'update', {
        where: { id: 'own' },
        data: { reviewer: { update: { data: { passwordHash: 'x' } } } },
      });
      refused('User', 'update', {
        where: { id: 'own' },
        data: { sessionReviews: { updateMany: { where: {}, data: { notes: 'x' } } } },
      });
      refused('User', 'update', {
        where: { id: 'own' },
        data: { sessionReviews: { deleteMany: {} } },
      });
    });

    it('TC-008 the message says which relation, and carries no value', () => {
      let message = '';
      try {
        scope('SessionReview', 'update', {
          where: { id: ID_OF_B },
          data: { reviewer: { update: { passwordHash: 'secret-value' } } },
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('SessionReview.update');
      expect(message).toContain('SessionReview.reviewer');
      expect(message).toContain('rule (i)');
      expect(message).not.toContain('secret-value');
      expect(message).not.toContain(ID_OF_B);
    });

    it.each([
      ['child-side connect, staff', 'SessionReview', { reviewer: { connect: { id: ID_OF_B } } }],
      [
        'child-side connect, cross-chain',
        'SessionQuestion',
        { testQuestion: { connect: { id: 't' } } },
      ],
      [
        'child-side connect, self relation',
        'RefreshToken',
        { replacedBy: { connect: { id: 'r' } } },
      ],
      ['child-side disconnect, staff', 'Question', { createdBy: { disconnect: true } }],
      [
        'child-side disconnect, cross-chain',
        'Organization',
        { currentConsentText: { disconnect: true } },
      ],
    ] as const)(
      'TC-008 %s is allowed (it sets or clears the scalar foreign key: rule (i))',
      (_name, model, data) => {
        // Organizations are never created or replaced in an org scope: only update applies to them.
        const operations = model === 'Organization' ? ['update'] : ['update', 'create', 'upsert'];
        for (const operation of operations) {
          expect(() =>
            scope(model, operation, { where: { id: 'x' }, data, create: data, update: data }),
          ).not.toThrow();
        }
      },
    );

    it('TC-008 parent-side connect, set and disconnect through a RULE_I relation are refused', () => {
      for (const op of ['connect', 'set', 'disconnect']) {
        refused('User', 'update', {
          where: { id: 'x' },
          data: { sessionReviews: { [op]: [{ id: 'r' }] } },
        });
      }
    });

    it('TC-008 SCOPE_HOP, COMPOSITE and ORG_ID relations keep their behaviour: nested writes are allowed', () => {
      const cases: Array<[ModelName, Args, string]> = [
        [
          'Test',
          {
            sections: {
              create: { title: 't', position: 1 },
              update: { where: { id: 's' }, data: { title: 'u' } },
              delete: [{ id: 's' }],
            },
          },
          'SCOPE_HOP',
        ],
        [
          'TestSection',
          {
            questions: {
              upsert: { where: { id: 'q' }, create: { position: 0 }, update: { position: 2 } },
              deleteMany: {},
            },
          },
          'SCOPE_HOP',
        ],
        [
          'Session',
          {
            sections: { createMany: { data: [{ sectionId: 's', position: 0 }] } },
            proctorEvents: { deleteMany: { severity: 'LOW' } },
          },
          'SCOPE_HOP',
        ],
        [
          'Candidate',
          {
            invitations: {
              create: { testId: 't', tokenHash: 'h' },
              updateMany: { where: {}, data: { sentAt: new Date() } },
              deleteMany: {},
            },
          },
          'COMPOSITE',
        ],
        ['Test', { invitations: { delete: [{ id: 'i' }] } }, 'COMPOSITE'],
        [
          'Organization',
          {
            questions: { create: { slug: 's' }, deleteMany: { slug: 'x' } },
            tests: { update: { where: { id: 't' }, data: { name: 'n' } } },
          },
          'ORG_ID',
        ],
      ];
      for (const [model, data, fkClass] of cases) {
        expect({ fkClass, refused: refusedBy(model, data) }).toEqual({ fkClass, refused: false });
      }
    });
  });

  it('TC-008 the guard does not change the arguments it was given', () => {
    const args = {
      where: { id: 'x' },
      data: { sections: { create: { title: 'a', position: 0 } }, name: 'n' },
    };
    const copy = structuredClone(args);
    scope('Test', 'update', args);
    expect(args).toEqual(copy);
  });
});
