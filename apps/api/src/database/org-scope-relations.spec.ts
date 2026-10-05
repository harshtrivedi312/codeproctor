// The foreign key classification (FU-DB-64) and the relation side table the nested-write guard
// reads (FU-DB-63) must match prisma/schema.prisma. No database needed.
import { ORG_SCOPE } from './org-scope-map';
import type { ModelName } from './org-scope-map';
import { FK_CLASSES, RULE_I_REFERENCES, relationKeys, relationOf } from './org-scope-relations';
import type { FkKind, ForeignKey } from './org-scope-relations';
import { readSchemaModels } from './testing/data-model';
import type { SchemaField } from './testing/data-model';
import { findRelationProblems, schemaForeignKeys } from './testing/relation-checks';
import type { RelationInputs, SchemaModels } from './testing/relation-checks';

const real = (): RelationInputs => ({
  fks: FK_CLASSES,
  schema: readSchemaModels(),
  scope: ORG_SCOPE,
  relationOf,
  relationKeys: relationKeys(),
});

const count = (kind: FkKind): number => FK_CLASSES.filter((k) => k.kind === kind).length;

describe('foreign key classification (NFR-04, FR-103; FU-DB-64)', () => {
  it('TC-008 every foreign key in schema.prisma is classified exactly once, and the relation side table matches the schema', () => {
    expect(findRelationProblems(real())).toEqual([]);
  });

  it('TC-008 the schema has 58 foreign keys: 9 org, 21 scope hops, 3 composite, 12 staff and 13 cross-chain references', () => {
    expect(schemaForeignKeys(readSchemaModels())).toHaveLength(58);
    expect(FK_CLASSES).toHaveLength(58);
    expect(count('org-column')).toBe(9);
    expect(count('scope-hop')).toBe(21);
    expect(count('composite')).toBe(3);
    expect(count('staff-ref')).toBe(12);
    expect(count('cross-chain')).toBe(13);
  });

  it('TC-008 RULE_I_REFERENCES is the 25 foreign keys rule (i) applies to (12 staff, 13 cross-chain)', () => {
    expect(RULE_I_REFERENCES).toHaveLength(25);
    expect(RULE_I_REFERENCES.every((k) => k.kind === 'staff-ref' || k.kind === 'cross-chain')).toBe(
      true,
    );
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
    const hops = FK_CLASSES.filter((k) => k.kind === 'scope-hop').map(
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
    kind: FkKind,
  ): ForeignKey => ({
    model: asModel(model),
    field: f,
    target: asModel(target),
    back,
    kind,
  });
  const good: ForeignKey[] = [
    fk('Child', 'org', 'Organization', 'children', 'org-column'),
    fk('Child', 'owner', 'Parent', 'children', 'cross-chain'),
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
    scope: scope as unknown as RelationInputs['scope'],
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
    const ghost = fk('Child', 'ghost', 'Parent', 'children', 'cross-chain');
    expect(findRelationProblems(inputs({ fks: [...good, ghost] }))).toEqual([
      expect.stringContaining('Child.ghost is classified but is not a foreign key'),
    ]);
  });

  it('TC-008 fails for a wrong kind, a wrong target or a wrong back relation', () => {
    const wrongKind = [
      good[0] as ForeignKey,
      fk('Child', 'owner', 'Parent', 'children', 'staff-ref'),
    ];
    expect(findRelationProblems(inputs({ fks: wrongKind }))).toEqual([
      expect.stringContaining('Child.owner is classified staff-ref but its kind is cross-chain'),
    ]);
    const wrongTarget = [
      good[0] as ForeignKey,
      fk('Child', 'owner', 'Organization', 'children', 'cross-chain'),
    ];
    expect(findRelationProblems(inputs({ fks: wrongTarget })).join('\n')).toContain(
      'Child.owner points to Parent in the schema, not Organization',
    );
    const wrongBack = [
      good[0] as ForeignKey,
      fk('Child', 'owner', 'Parent', 'nothing', 'cross-chain'),
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
