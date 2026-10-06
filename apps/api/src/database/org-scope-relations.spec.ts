// The foreign key classification (FU-DB-64) and the relation side table the nested-write guard
// reads (FU-DB-63) must match prisma/schema.prisma. No database needed.
import { ORG_SCOPE } from './org-scope-map';
import type { ModelName } from './org-scope-map';
import {
  FK_CLASSES,
  RULE_I_REFERENCES,
  relationKeys,
  relationOf,
  scopeHopColumn,
} from './org-scope-relations';
import type { FkClass, ForeignKey, RelationSide, RuleIKind } from './org-scope-relations';
import { readSchemaModels } from './testing/data-model';
import type { SchemaField } from './testing/data-model';
import { countClasses, findRelationProblems, schemaForeignKeys } from './testing/relation-checks';
import type { RelationInputs, SchemaModels } from './testing/relation-checks';

const real = (): RelationInputs => ({
  fks: FK_CLASSES,
  schema: readSchemaModels(),
  scope: ORG_SCOPE,
  relationOf,
  relationKeys: relationKeys(),
});

const tally = (keys: readonly ForeignKey[]) => ({
  ORG_ID: keys.filter((k) => k.fkClass === 'ORG_ID').length,
  SCOPE_HOP: keys.filter((k) => k.fkClass === 'SCOPE_HOP').length,
  COMPOSITE: keys.filter((k) => k.fkClass === 'COMPOSITE').length,
  RULE_I: keys.filter((k) => k.fkClass === 'RULE_I').length,
  total: keys.length,
});

describe('foreign key classification (NFR-04, FR-103; FU-DB-64)', () => {
  it('TC-008 every foreign key in schema.prisma is classified exactly once, and the relation side table matches the schema', () => {
    expect(findRelationProblems(real())).toEqual([]);
  });

  it('TC-008 the schema has 59 foreign keys: 9 ORG_ID, 21 SCOPE_HOP, 3 COMPOSITE and 26 RULE_I', () => {
    const expected = { ORG_ID: 9, SCOPE_HOP: 21, COMPOSITE: 3, RULE_I: 26, total: 59 };
    // Counted from schema.prisma and the scope map alone, and from the table: both are 59.
    expect(schemaForeignKeys(readSchemaModels())).toHaveLength(59);
    expect(countClasses(readSchemaModels(), ORG_SCOPE)).toEqual(expected);
    expect(tally(FK_CLASSES)).toEqual(expected);
  });

  it('TC-008 the 26 RULE_I references are 13 staff references and 13 cross-chain references', () => {
    const kinds = (kind: RuleIKind): number => FK_CLASSES.filter((k) => k.ruleI === kind).length;
    expect({ staff: kinds('staff'), crossChain: kinds('cross-chain') }).toEqual({
      staff: 13,
      crossChain: 13,
    });
    // Only RULE_I keys carry a kind.
    expect(FK_CLASSES.filter((k) => k.fkClass !== 'RULE_I' && k.ruleI !== undefined)).toEqual([]);
    expect(FK_CLASSES.filter((k) => k.fkClass === 'RULE_I' && k.ruleI === undefined)).toEqual([]);
  });

  it('TC-008 RULE_I_REFERENCES is the 26 foreign keys rule (i) applies to', () => {
    expect(RULE_I_REFERENCES).toHaveLength(26);
    expect(RULE_I_REFERENCES.every((k) => k.fkClass === 'RULE_I')).toBe(true);
    const ids = RULE_I_REFERENCES.map((k) => `${k.model}.${k.field}`);
    // The ones the review and the follow-ups name.
    expect(ids).toEqual(
      expect.arrayContaining([
        'Organization.currentConsentText',
        'Question.currentVersion',
        'Consent.consentText',
        'SessionQuestion.testQuestion',
        'SessionQuestion.questionVersion',
        'SessionQuestion.variant',
        'KeystrokeBatch.sessionQuestion',
        'WebhookDelivery.session',
        'TestQuestion.questionVersion',
        'SessionSection.section',
        'Question.createdBy',
        'SessionReview.reviewer',
        'AuditLog.actor',
        'IdentityCheck.reviewedBy',
        'IdentityCheck.videoCheckBy',
      ]),
    );
  });

  it('TC-008 FR-305 ADR 0015 4: identity_checks.video_check_by is a staff rule (i) reference, not org-composite, with its own back relation', () => {
    const key = FK_CLASSES.find((k) => k.model === 'IdentityCheck' && k.field === 'videoCheckBy');
    expect(key).toEqual({
      model: 'IdentityCheck',
      field: 'videoCheckBy',
      target: 'User',
      back: 'videoCheckedIdentityChecks',
      fkClass: 'RULE_I',
      ruleI: 'staff',
    });
    expect(RULE_I_REFERENCES).toContain(key);
    // The key is held in one column, video_check_by, and is told apart from reviewed_by by name.
    const schema = readSchemaModels();
    expect(schema['IdentityCheck']?.['videoCheckBy']?.foreignKeyFields).toEqual(['videoCheckById']);
    expect(schema['IdentityCheck']?.['reviewedBy']?.foreignKeyFields).toEqual(['reviewedById']);
    // Both sides of both IdentityCheck to User relations are in the side table, as RULE_I.
    expect(relationOf('IdentityCheck', 'videoCheckBy')).toEqual({
      target: 'User',
      holdsFk: true,
      fkClass: 'RULE_I',
    });
    expect(relationOf('User', 'videoCheckedIdentityChecks')).toEqual({
      target: 'IdentityCheck',
      holdsFk: false,
      fkClass: 'RULE_I',
    });
    expect(relationOf('IdentityCheck', 'reviewedBy')?.fkClass).toBe('RULE_I');
    expect(relationOf('User', 'reviewedIdentityChecks')?.fkClass).toBe('RULE_I');
  });

  it('TC-008 FR-305 ADR 0015 4: a model with two relations to the same target is classified once per relation', () => {
    const toUser = FK_CLASSES.filter((k) => k.model === 'IdentityCheck' && k.target === 'User');
    expect(toUser.map((k) => k.field).sort()).toEqual(['reviewedBy', 'videoCheckBy']);
    expect(toUser.map((k) => k.back).sort()).toEqual([
      'reviewedIdentityChecks',
      'videoCheckedIdentityChecks',
    ]);
  });

  it('TC-008 every model that has a scope path has exactly one scope-hop foreign key, its first hop', () => {
    const paths = Object.entries(ORG_SCOPE).flatMap(([model, rule]) =>
      rule.kind === 'path' ? [`${model}.${rule.path[0]}`] : [],
    );
    const hops = FK_CLASSES.filter((k) => k.fkClass === 'SCOPE_HOP').map(
      (k) => `${k.model}.${k.field}`,
    );
    expect(hops.sort()).toEqual(paths.sort());
  });

  it('TC-008 scopeHopColumn names the scalar column of every path model first hop, as the schema holds it (FU-DB-107)', () => {
    const schema = readSchemaModels();
    for (const [model, rule] of Object.entries(ORG_SCOPE)) {
      const column = scopeHopColumn(model as ModelName);
      if (rule.kind !== 'path') {
        expect(column).toBeUndefined();
        continue;
      }
      expect(schema[model]?.[rule.path[0]]?.foreignKeyFields).toEqual([column]);
      // It is a plain scalar column of the model, not a relation.
      expect(schema[model]?.[column ?? '']?.holdsForeignKey).toBe(false);
      expect(schema[model]?.[column ?? '']?.type).not.toBe(schema[model]?.[rule.path[0]]?.type);
    }
    expect(scopeHopColumn('TestSection')).toBe('testId');
    expect(scopeHopColumn('ProctorEvent')).toBe('sessionId');
    expect(scopeHopColumn('RefreshToken')).toBe('userId');
    expect(scopeHopColumn('Submission')).toBe('sessionQuestionId');
    expect(scopeHopColumn('FlagDecision')).toBe('eventId');
    expect(scopeHopColumn('WebhookDelivery')).toBe('endpointId');
    expect(scopeHopColumn('Session')).toBeUndefined();
    expect(scopeHopColumn('Organization')).toBeUndefined();
  });
});

describe('foreign key classification checks can fail (NFR-04)', () => {
  // A small stand-in schema and scope map, so each rule is shown to fail on its own.
  const field = (name: string, type: string, fk: readonly string[] = []): SchemaField => ({
    name,
    type,
    isList: false,
    isOptional: false,
    holdsForeignKey: fk.length > 0,
    foreignKeyFields: fk,
  });
  const schema: SchemaModels = {
    Organization: { id: field('id', 'String'), children: field('children', 'Child') },
    Child: {
      id: field('id', 'String'),
      org: field('org', 'Organization', ['orgId']),
      owner: field('owner', 'Parent', ['ownerId']),
    },
    Parent: { id: field('id', 'String'), children: field('children', 'Child') },
  };
  const scope = {
    Organization: { kind: 'self' },
    Child: { kind: 'direct' },
    Parent: { kind: 'unscoped', reason: 'test' },
  } as const;
  const asModel = (name: string): ModelName => name as ModelName;
  const fk = (
    model: string,
    f: string,
    target: string,
    back: string,
    fkClass: FkClass,
    ruleI?: RuleIKind,
  ): ForeignKey => ({
    model: asModel(model),
    field: f,
    target: asModel(target),
    back,
    fkClass,
    ...(ruleI === undefined ? {} : { ruleI }),
  });
  const good: ForeignKey[] = [
    fk('Child', 'org', 'Organization', 'children', 'ORG_ID'),
    fk('Child', 'owner', 'Parent', 'children', 'RULE_I', 'cross-chain'),
  ];
  const sides = new Map<string, RelationSide>([
    ['Child.org', { target: asModel('Organization'), holdsFk: true, fkClass: 'ORG_ID' }],
    ['Organization.children', { target: asModel('Child'), holdsFk: false, fkClass: 'ORG_ID' }],
    ['Child.owner', { target: asModel('Parent'), holdsFk: true, fkClass: 'RULE_I' }],
    ['Parent.children', { target: asModel('Child'), holdsFk: false, fkClass: 'RULE_I' }],
  ]);
  const inputs = (over: Partial<RelationInputs> = {}): RelationInputs => ({
    fks: good,
    schema,
    scope,
    relationOf: (model, f) => sides.get(`${model}.${f}`),
    relationKeys: [...sides.keys()],
    ...over,
  });

  it('TC-008 passes on a consistent table', () => {
    expect(findRelationProblems(inputs())).toEqual([]);
  });

  it('TC-008 fails for a foreign key nobody has classified (a newly added foreign key)', () => {
    const problems = findRelationProblems(inputs({ fks: good.slice(0, 1) }));
    expect(problems).toEqual([
      expect.stringContaining('Child.owner is a foreign key in the schema nobody has classified'),
    ]);
  });

  it('TC-008 fails for a foreign key classified twice, or classified but not in the schema', () => {
    expect(findRelationProblems(inputs({ fks: [...good, good[0] as ForeignKey] }))).toEqual([
      expect.stringContaining('Child.org is classified 2 times'),
    ]);
    const ghost = fk('Child', 'ghost', 'Parent', 'children', 'RULE_I', 'cross-chain');
    expect(findRelationProblems(inputs({ fks: [...good, ghost] }))).toEqual([
      expect.stringContaining('Child.ghost is classified but is not a foreign key'),
    ]);
  });

  it('TC-008 fails for a wrong class or kind, a wrong target or a wrong back relation', () => {
    const wrongClass = [
      good[0] as ForeignKey,
      fk('Child', 'owner', 'Parent', 'children', 'SCOPE_HOP'),
    ];
    // The side table (RULE_I) now disagrees with the entry too, which is reported as well.
    expect(findRelationProblems(inputs({ fks: wrongClass }))).toEqual([
      expect.stringContaining('Child.owner is classified SCOPE_HOP but its class is RULE_I'),
      expect.stringContaining('Child.owner: the side table says class RULE_I'),
      expect.stringContaining('Parent.children: the side table says class RULE_I'),
    ]);
    const wrongKind = [
      good[0] as ForeignKey,
      fk('Child', 'owner', 'Parent', 'children', 'RULE_I', 'staff'),
    ];
    expect(findRelationProblems(inputs({ fks: wrongKind }))).toEqual([
      expect.stringContaining('Child.owner is RULE_I staff but its kind is cross-chain'),
    ]);
    const noKind = [good[0] as ForeignKey, fk('Child', 'owner', 'Parent', 'children', 'RULE_I')];
    expect(findRelationProblems(inputs({ fks: noKind }))).toEqual([
      expect.stringContaining('Child.owner is RULE_I (no kind) but its kind is cross-chain'),
    ]);
    const wrongTarget = [
      good[0] as ForeignKey,
      fk('Child', 'owner', 'Organization', 'children', 'RULE_I', 'cross-chain'),
    ];
    expect(findRelationProblems(inputs({ fks: wrongTarget })).join('\n')).toContain(
      'Child.owner points to Parent in the schema, not Organization',
    );
    const wrongBack = [
      good[0] as ForeignKey,
      fk('Child', 'owner', 'Parent', 'nothing', 'RULE_I', 'cross-chain'),
    ];
    expect(findRelationProblems(inputs({ fks: wrongBack }))).toEqual([
      expect.stringContaining('Parent.nothing is not the relation that points back'),
    ]);
  });

  it('TC-008 fails when a side of the side table carries the wrong class (the nested-write guard reads it)', () => {
    const wrong = new Map(sides);
    wrong.set('Parent.children', {
      target: asModel('Child'),
      holdsFk: false,
      fkClass: 'SCOPE_HOP',
    });
    expect(findRelationProblems(inputs({ relationOf: (m, f) => wrong.get(`${m}.${f}`) }))).toEqual([
      expect.stringContaining(
        'Parent.children: the side table says class SCOPE_HOP, the foreign key is RULE_I',
      ),
    ]);
    wrong.set('Child.owner', { target: asModel('Parent'), holdsFk: true, fkClass: 'ORG_ID' });
    wrong.set('Parent.children', sides.get('Parent.children') as RelationSide);
    expect(findRelationProblems(inputs({ relationOf: (m, f) => wrong.get(`${m}.${f}`) }))).toEqual([
      expect.stringContaining(
        'Child.owner: the side table says class ORG_ID, the foreign key is RULE_I',
      ),
    ]);
  });

  it('TC-008 fails when a SCOPE_HOP key is held in a column that is not its relation field plus Id (scopeHopColumn derives it)', () => {
    const oddSchema: SchemaModels = {
      Child: { id: field('id', 'String'), owner: field('owner', 'Parent', ['parentRef']) },
      Parent: { id: field('id', 'String'), children: field('children', 'Child') },
    };
    const oddScope = {
      Child: { kind: 'path', path: ['owner'] },
      Parent: { kind: 'unscoped', reason: 'test' },
    } as const;
    const hop = [fk('Child', 'owner', 'Parent', 'children', 'SCOPE_HOP')];
    const oddSides = new Map<string, RelationSide>([
      ['Child.owner', { target: asModel('Parent'), holdsFk: true, fkClass: 'SCOPE_HOP' }],
      ['Parent.children', { target: asModel('Child'), holdsFk: false, fkClass: 'SCOPE_HOP' }],
    ]);
    const broken = (schemaToCheck: SchemaModels): string[] =>
      findRelationProblems({
        fks: hop,
        schema: schemaToCheck,
        scope: oddScope,
        relationOf: (m, f) => oddSides.get(`${m}.${f}`),
        relationKeys: [...oddSides.keys()],
      });
    expect(broken(oddSchema)).toEqual([
      expect.stringContaining('Child.owner is a SCOPE_HOP key held in parentRef, not ownerId'),
    ]);
    const conventional: SchemaModels = {
      ...oddSchema,
      Child: { id: field('id', 'String'), owner: field('owner', 'Parent', ['ownerId']) },
    };
    expect(broken(conventional)).toEqual([]);
  });

  it('TC-008 a two-column key is COMPOSITE only when it includes orgId', () => {
    const withKey = (columns: string[]): SchemaModels => ({
      ...schema,
      Child: {
        ...(schema.Child as Record<string, SchemaField>),
        owner: field('owner', 'Parent', columns),
      },
    });
    // The side table agrees with the entry in both cases, so only the class rule is tested.
    const asComposite = new Map(sides);
    for (const key of ['Child.owner', 'Parent.children']) {
      asComposite.set(key, { ...(sides.get(key) as RelationSide), fkClass: 'COMPOSITE' });
    }
    const check = (columns: string[]): string[] =>
      findRelationProblems(
        inputs({
          schema: withKey(columns),
          fks: [good[0] as ForeignKey, fk('Child', 'owner', 'Parent', 'children', 'COMPOSITE')],
          relationOf: (m, f) => asComposite.get(`${m}.${f}`),
        }),
      );
    // Two columns, neither the org: the database cannot refuse a parent in another org.
    expect(check(['ownerId', 'kind'])).toEqual([
      expect.stringContaining('Child.owner is classified COMPOSITE but its class is RULE_I'),
    ]);
    expect(check(['ownerId', 'orgId'])).toEqual([]);
  });

  it('TC-008 fails when the side table has no entry, the wrong target, the wrong side, or an extra entry', () => {
    const without = new Map(sides);
    without.delete('Parent.children');
    expect(
      findRelationProblems(inputs({ relationOf: (m, f) => without.get(`${m}.${f}`) })),
    ).toEqual([expect.stringContaining('Parent.children is a relation field with no entry')]);

    const flipped = new Map(sides);
    flipped.set('Parent.children', {
      target: asModel('Child'),
      holdsFk: true,
      fkClass: 'RULE_I',
    });
    expect(
      findRelationProblems(inputs({ relationOf: (m, f) => flipped.get(`${m}.${f}`) })),
    ).toEqual([
      expect.stringContaining('Parent.children: the side table says the foreign key is here'),
    ]);

    const retargeted = new Map(sides);
    retargeted.set('Parent.children', {
      target: asModel('Parent'),
      holdsFk: false,
      fkClass: 'RULE_I',
    });
    expect(
      findRelationProblems(inputs({ relationOf: (m, f) => retargeted.get(`${m}.${f}`) })),
    ).toEqual([
      expect.stringContaining('Parent.children: the side table says Parent, the schema says Child'),
    ]);

    expect(findRelationProblems(inputs({ relationKeys: [...sides.keys(), 'Child.id'] }))).toEqual([
      expect.stringContaining('Child.id is in the relation side table but is not a relation field'),
    ]);
  });
});
