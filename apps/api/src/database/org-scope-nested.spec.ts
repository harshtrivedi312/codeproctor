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
    // user.createdQuestions: the parent is a staff user, and the question carries its own org.
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
    ])('TC-008 user.update createdQuestions.%s is refused', (_name, nested) => {
      refused('User', 'update', { where: { id: 'x' }, data: { createdQuestions: nested } });
    });

    it('TC-008 a create or upsert of the parent carries the same check', () => {
      refused('User', 'create', {
        data: {
          email: 'a',
          fullName: 'a',
          role: 'RECRUITER',
          createdQuestions: { create: { ...question, orgId: ORG_B } },
        },
      });
      refused('User', 'upsert', {
        where: { id: 'x' },
        create: { orgId: ORG_A, createdQuestions: { create: { ...question, orgId: ORG_B } } },
        update: {},
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

    it('TC-008 a nest deeper than 16 relations is refused', () => {
      const chain = (depth: number): Args =>
        depth === 0 ? {} : { replaces: { create: chain(depth - 1) } };
      expect(() =>
        scope('RefreshToken', 'update', { where: { id: 'x' }, data: chain(10) }),
      ).not.toThrow();
      refused('RefreshToken', 'update', { where: { id: 'x' }, data: chain(20) });
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
        createdQuestions: {
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
      expect(() => scope('User', 'update', { where: { id: 'x' }, data })).not.toThrow();
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
