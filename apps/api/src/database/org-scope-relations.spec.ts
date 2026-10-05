// The foreign key classification (FU-DB-64) and the relation side table the nested-write guard
// reads (FU-DB-63) must match prisma/schema.prisma. No database needed.
import { ORG_SCOPE } from './org-scope-map';
import type { ModelName } from './org-scope-map';
import { FK_CLASSES, RULE_I_REFERENCES, relationKeys, relationOf } from './org-scope-relations';
import type { FkClass, ForeignKey, RuleIKind } from './org-scope-relations';
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

  it('TC-008 the schema has 58 foreign keys: 9 ORG_ID, 21 SCOPE_HOP, 3 COMPOSITE and 25 RULE_I', () => {
    const expected = { ORG_ID: 9, SCOPE_HOP: 21, COMPOSITE: 3, RULE_I: 25, total: 58 };
    // Counted from schema.prisma and the scope map alone, and from the table: both are 58.
    expect(schemaForeignKeys(readSchemaModels())).toHaveLength(58);
    expect(countClasses(readSchemaModels(), ORG_SCOPE)).toEqual(expected);
    expect(tally(FK_CLASSES)).toEqual(expected);
  });

  it('TC-008 the 25 RULE_I references are 12 staff references and 13 cross-chain references', () => {
    const kinds = (kind: RuleIKind): number => FK_CLASSES.filter((k) => k.ruleI === kind).length;
    expect({ staff: kinds('staff'), crossChain: kinds('cross-chain') }).toEqual({
      staff: 12,
      crossChain: 13,
    });
    // Only RULE_I keys carry a kind.
    expect(FK_CLASSES.filter((k) => k.fkClass !== 'RULE_I' && k.ruleI !== undefined)).toEqual([]);
    expect(FK_CLASSES.filter((k) => k.fkClass === 'RULE_I' && k.ruleI === undefined)).toEqual([]);
  });

  it('TC-008 RULE_I_REFERENCES is the 25 foreign keys rule (i) applies to', () => {
    expect(RULE_I_REFERENCES).toHaveLength(25);
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
      ]),
    );
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
  const sides = new Map<string, { target: ModelName; holdsFk: boolean }>([
    ['Child.org', { target: asModel('Organization'), holdsFk: true }],
    ['Organization.children', { target: asModel('Child'), holdsFk: false }],
    ['Child.owner', { target: asModel('Parent'), holdsFk: true }],
    ['Parent.children', { target: asModel('Child'), holdsFk: false }],
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
    expect(findRelationProblems(inputs({ fks: wrongClass }))).toEqual([
      expect.stringContaining('Child.owner is classified SCOPE_HOP but its class is RULE_I'),
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

  it('TC-008 fails when the side table has no entry, the wrong target, the wrong side, or an extra entry', () => {
    const without = new Map(sides);
    without.delete('Parent.children');
    expect(
      findRelationProblems(inputs({ relationOf: (m, f) => without.get(`${m}.${f}`) })),
    ).toEqual([expect.stringContaining('Parent.children is a relation field with no entry')]);

    const flipped = new Map(sides);
    flipped.set('Parent.children', { target: asModel('Child'), holdsFk: true });
    expect(
      findRelationProblems(inputs({ relationOf: (m, f) => flipped.get(`${m}.${f}`) })),
    ).toEqual([
      expect.stringContaining('Parent.children: the side table says the foreign key is here'),
    ]);

    const retargeted = new Map(sides);
    retargeted.set('Parent.children', { target: asModel('Parent'), holdsFk: false });
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
