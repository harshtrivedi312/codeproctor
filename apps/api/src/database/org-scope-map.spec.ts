// The org scope map must cover every model (ADR 0006 section 1). No database needed.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SYSTEM_SCOPE_REASONS } from './org-context';
import { ORG_SCOPE, UNSCOPED_MODELS, orgFilter } from './org-scope-map';
import type { OrgScopeRule } from './org-scope-map';
import { readGeneratedModels, readModelMetas, readSchemaModels } from './testing/data-model';
import type { ModelMeta } from './testing/data-model';
import { findScopeProblems } from './testing/scope-checks';

const SCHEMA_PATH = resolve(__dirname, '../../../../prisma/schema.prisma');

describe('org scope map (NFR-04, FR-103)', () => {
  it('TC-008 every model in the schema has an org scope entry, and every entry is a model', async () => {
    const problems = findScopeProblems(ORG_SCOPE, await readModelMetas());
    expect(problems).toEqual([]);
  });

  it('TC-008 the generated client and prisma/schema.prisma list the same models and fields', async () => {
    const generated = await readGeneratedModels();
    const schema = readSchemaModels();
    // The model names in the schema file, counted without the parser above.
    const names = [...readFileSync(SCHEMA_PATH, 'utf8').matchAll(/^model\s+(\w+)\s*\{/gm)].map(
      (m) => m[1],
    );
    expect(Object.keys(generated).sort()).toEqual([...names].sort());
    expect(Object.keys(schema).sort()).toEqual([...names].sort());
    expect(names).toHaveLength(31);
    for (const [name, model] of Object.entries(generated)) {
      expect(model.fields.map((f) => f.name).sort()).toEqual(
        Object.keys(schema[name] ?? {}).sort(),
      );
    }
  });

  it('TC-008 the nine models with an org_id column are exactly the direct entries (ADR 0006 section 5)', async () => {
    const metas = await readModelMetas();
    const withColumn = Object.values(metas)
      .filter((m) => m.fields.some((f) => f.dbName === 'org_id'))
      .map((m) => m.name)
      .sort();
    const direct = Object.entries(ORG_SCOPE)
      .filter(([, rule]) => rule.kind === 'direct')
      .map(([name]) => name)
      .sort();
    expect(direct).toEqual(withColumn);
    expect(direct).toEqual([
      'AuditLog',
      'Candidate',
      'ConsentText',
      'Invitation',
      'Question',
      'Session',
      'Test',
      'User',
      'WebhookEndpoint',
    ]);
  });

  it('TC-008 the scope paths named in ADR 0006 resolve to the filters the extension adds', () => {
    const orgId = 'org-1';
    expect(orgFilter(ORG_SCOPE.ProctorEvent, orgId)).toEqual({ session: { orgId } });
    expect(orgFilter(ORG_SCOPE.TestCase, orgId)).toEqual({
      questionVersion: { question: { orgId } },
    });
    expect(orgFilter(ORG_SCOPE.VariantTestCase, orgId)).toEqual({
      variant: { questionVersion: { question: { orgId } } },
    });
    expect(orgFilter(ORG_SCOPE.Submission, orgId)).toEqual({
      sessionQuestion: { session: { orgId } },
    });
    expect(orgFilter(ORG_SCOPE.Session, orgId)).toEqual({ orgId });
    expect(orgFilter(ORG_SCOPE.Organization, orgId)).toEqual({ id: orgId });
  });

  it('TC-008 no model is intentionally unscoped today', () => {
    // Adding an unscoped model is an architect decision. This list changes only with that decision.
    expect(UNSCOPED_MODELS).toEqual([]);
  });

  it('TC-008 every system scope reason is documented', () => {
    for (const [reason, text] of Object.entries(SYSTEM_SCOPE_REASONS)) {
      expect(text.length).toBeGreaterThan(20);
      expect(reason).toMatch(/^[A-Z_]+$/);
    }
  });
});

describe('org scope completeness check can fail (NFR-04)', () => {
  // A small stand-in schema, so each rule is shown to fail on its own.
  const field = (
    name: string,
    over: Partial<ModelMeta['fields'][number]> = {},
  ): ModelMeta['fields'][number] => ({ name, type: 'String', kind: 'scalar', ...over });
  const relation = (name: string, type: string, over = {}): ModelMeta['fields'][number] =>
    field(name, {
      type,
      kind: 'object',
      isList: false,
      isOptional: false,
      holdsForeignKey: true,
      ...over,
    });
  const orgId = field('orgId', { dbName: 'org_id' });

  const models: Record<string, ModelMeta> = {
    Parent: { name: 'Parent', fields: [field('id'), orgId] },
    Child: { name: 'Child', fields: [field('id'), relation('parent', 'Parent')] },
    Widget: { name: 'Widget', fields: [field('id')] },
  };
  const rules = (extra: Record<string, OrgScopeRule>): Record<string, OrgScopeRule> => ({
    Parent: { kind: 'direct' },
    Child: { kind: 'path', path: ['parent'] },
    ...extra,
  });

  it('TC-008 passes when every model is declared', () => {
    expect(
      findScopeProblems(
        rules({ Widget: { kind: 'unscoped', reason: 'Global lookup data.' } }),
        models,
      ),
    ).toEqual([]);
  });

  it('TC-008 fails for a model with neither org_id nor a scope path (a newly added model)', () => {
    const problems = findScopeProblems(rules({}), models);
    expect(problems).toEqual([
      expect.stringContaining('Widget has neither an org_id nor a scope path'),
    ]);
  });

  it('TC-008 fails for an entry that is not a model', () => {
    const problems = findScopeProblems(
      rules({ Widget: { kind: 'unscoped', reason: 'Global.' }, Ghost: { kind: 'direct' } }),
      models,
    );
    expect(problems).toEqual([expect.stringContaining('Ghost, which is not a model')]);
  });

  it('TC-008 fails for a direct entry on a model without an org_id column', () => {
    const problems = findScopeProblems(rules({ Widget: { kind: 'direct' } }), models);
    expect(problems).toEqual([
      expect.stringContaining('Widget is declared direct but has no field orgId'),
    ]);
  });

  it('TC-008 fails for an unscoped entry without a reason', () => {
    const problems = findScopeProblems(
      rules({ Widget: { kind: 'unscoped', reason: ' ' } }),
      models,
    );
    expect(problems).toEqual([expect.stringContaining('Widget is unscoped without a reason')]);
  });

  it('TC-008 fails for a path that does not end at a model with org_id', () => {
    const broken = {
      ...models,
      Leaf: { name: 'Leaf', fields: [relation('widget', 'Widget')] },
    };
    const problems = findScopeProblems(
      rules({
        Widget: { kind: 'unscoped', reason: 'Global.' },
        Leaf: { kind: 'path', path: ['widget'] },
      }),
      broken,
    );
    expect(problems).toEqual([
      expect.stringContaining('the path ends at Widget, which has no org_id'),
    ]);
  });

  it('TC-008 fails for a path through a list, an optional relation or the wrong side of a relation', () => {
    const withBadHops = (over: Partial<ModelMeta['fields'][number]>): string[] =>
      findScopeProblems(
        rules({
          Widget: { kind: 'unscoped', reason: 'Global.' },
          Leaf: { kind: 'path', path: ['parent'] },
        }),
        { ...models, Leaf: { name: 'Leaf', fields: [relation('parent', 'Parent', over)] } },
      );
    expect(withBadHops({ isList: true })).toEqual([expect.stringContaining('is a list')]);
    expect(withBadHops({ isOptional: true })).toEqual([expect.stringContaining('is optional')]);
    expect(withBadHops({ holdsForeignKey: false })).toEqual([
      expect.stringContaining('does not hold the foreign key'),
    ]);
  });

  it('TC-008 fails for a path that passes a model that already has org_id', () => {
    const deeper = {
      ...models,
      Leaf: { name: 'Leaf', fields: [relation('child', 'Child')] },
    };
    const problems = findScopeProblems(
      rules({
        Widget: { kind: 'unscoped', reason: 'Global.' },
        Leaf: { kind: 'path', path: ['child', 'parent'] },
      }),
      {
        ...deeper,
        Child: { name: 'Child', fields: [field('id'), orgId, relation('parent', 'Parent')] },
      },
    );
    expect(problems).toEqual(
      expect.arrayContaining([expect.stringContaining('already has org_id')]),
    );
  });

  it('TC-008 fails for a path-scoped or unscoped model that has its own org_id column', () => {
    const problems = findScopeProblems(rules({ Widget: { kind: 'unscoped', reason: 'Global.' } }), {
      ...models,
      Widget: { name: 'Widget', fields: [field('id'), orgId] },
    });
    expect(problems).toEqual([
      expect.stringContaining('has an org_id column but is declared unscoped'),
    ]);
  });
});
