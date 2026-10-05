// Completeness rules for the foreign key classification and the relation side table
// (org-scope-relations.ts), as a pure function over the table and the parsed schema. The real test
// runs it on the real table and expects no problems; it is also run on deliberately broken input
// to show that each rule can fail.
import type { ForeignKey, FkClass, RelationSide, RuleIKind } from '../org-scope-relations';
import type { ModelName, OrgScopeRule } from '../org-scope-map';
import type { SchemaField } from './data-model';

export type SchemaModels = Readonly<Record<string, Readonly<Record<string, SchemaField>>>>;

export interface RelationInputs {
  readonly fks: readonly ForeignKey[];
  readonly schema: SchemaModels;
  readonly scope: Readonly<Record<string, OrgScopeRule>>;
  readonly relationOf: (model: ModelName, field: string) => RelationSide | undefined;
  /** Every `Model.field` the side table knows. */
  readonly relationKeys: readonly string[];
}

/** The foreign keys in the schema: relation fields that hold the key, as `Model.field`. */
export function schemaForeignKeys(schema: SchemaModels): string[] {
  return Object.entries(schema).flatMap(([model, fields]) =>
    Object.values(fields)
      .filter((field) => field.holdsForeignKey)
      .map((field) => `${model}.${field.name}`),
  );
}

/** The class (and, for RULE_I, the kind) a foreign key must have, from the schema and the scope map alone. */
export function expectedClass(
  model: string,
  field: SchemaField,
  scope: Readonly<Record<string, OrgScopeRule>>,
): { fkClass: FkClass; ruleI?: RuleIKind } {
  const rule = scope[model];
  if (field.name === 'org' && field.type === 'Organization' && rule?.kind === 'direct') {
    return { fkClass: 'ORG_ID' };
  }
  // A composite key is (id, org_id): it has to include the org, or the database cannot refuse a
  // parent in another org. Any other multi-column key is not COMPOSITE.
  if (field.foreignKeyFields.length > 1 && field.foreignKeyFields.includes('orgId')) {
    return { fkClass: 'COMPOSITE' };
  }
  if (rule?.kind === 'path' && rule.path[0] === field.name) return { fkClass: 'SCOPE_HOP' };
  return { fkClass: 'RULE_I', ruleI: field.type === 'User' ? 'staff' : 'cross-chain' };
}

/** How many foreign keys of each class the schema has, derived from the schema and the scope map. */
export function countClasses(
  schema: SchemaModels,
  scope: Readonly<Record<string, OrgScopeRule>>,
): { ORG_ID: number; SCOPE_HOP: number; COMPOSITE: number; RULE_I: number; total: number } {
  const counts = { ORG_ID: 0, SCOPE_HOP: 0, COMPOSITE: 0, RULE_I: 0, total: 0 };
  for (const [model, fields] of Object.entries(schema)) {
    for (const field of Object.values(fields)) {
      if (!field.holdsForeignKey) continue;
      counts[expectedClass(model, field, scope).fkClass] += 1;
      counts.total += 1;
    }
  }
  return counts;
}

export function findRelationProblems(input: RelationInputs): string[] {
  const { fks, schema, scope } = input;
  const problems: string[] = [];

  // 1. Every foreign key in the schema is classified exactly once, and nothing else is.
  const fromSchema = new Set(schemaForeignKeys(schema));
  const seen = new Map<string, number>();
  for (const key of fks) {
    const id = `${key.model}.${key.field}`;
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  for (const id of fromSchema) {
    const count = seen.get(id) ?? 0;
    if (count === 0) problems.push(`${id} is a foreign key in the schema nobody has classified.`);
    if (count > 1) problems.push(`${id} is classified ${count} times.`);
  }
  for (const id of seen.keys()) {
    if (!fromSchema.has(id))
      problems.push(`${id} is classified but is not a foreign key in the schema.`);
  }

  // 2. Each entry is consistent with the schema: target, back relation, kind.
  for (const key of fks) {
    const id = `${key.model}.${key.field}`;
    const field = schema[key.model]?.[key.field];
    if (field === undefined || !field.holdsForeignKey) continue; // reported above
    if (field.type !== key.target) {
      problems.push(`${id} points to ${field.type} in the schema, not ${key.target}.`);
    }
    const back = schema[key.target]?.[key.back];
    if (back === undefined || back.type !== key.model || back.holdsForeignKey) {
      problems.push(`${id}: ${key.target}.${key.back} is not the relation that points back.`);
    }
    if (key.fkClass === 'SCOPE_HOP' && field.foreignKeyFields.join(',') !== `${key.field}Id`) {
      // scopeHopColumn() derives the column from the relation field name.
      problems.push(
        `${id} is a SCOPE_HOP key held in ${field.foreignKeyFields.join(', ')}, not ${key.field}Id.`,
      );
    }
    const expected = expectedClass(key.model, field, scope);
    if (expected.fkClass !== key.fkClass) {
      problems.push(`${id} is classified ${key.fkClass} but its class is ${expected.fkClass}.`);
    } else if (expected.ruleI !== key.ruleI) {
      problems.push(
        `${id} is RULE_I ${key.ruleI ?? '(no kind)'} but its kind is ${expected.ruleI ?? '(none)'}.`,
      );
    }
  }

  // 3. The relation side table matches every relation field of the schema, both sides.
  const relationFields = new Set<string>();
  for (const [model, fields] of Object.entries(schema)) {
    for (const field of Object.values(fields)) {
      if (!(field.type in schema)) continue;
      const id = `${model}.${field.name}`;
      relationFields.add(id);
      const side = input.relationOf(model as ModelName, field.name);
      if (side === undefined) {
        problems.push(`${id} is a relation field with no entry in the relation side table.`);
        continue;
      }
      if (side.target !== field.type) {
        problems.push(`${id}: the side table says ${side.target}, the schema says ${field.type}.`);
      }
      // Both sides of a relation carry the class of its foreign key.
      const key = fks.find((k) =>
        field.holdsForeignKey
          ? k.model === model && k.field === field.name
          : k.target === model && k.back === field.name,
      );
      if (key !== undefined && side.fkClass !== key.fkClass) {
        problems.push(
          `${id}: the side table says class ${side.fkClass}, the foreign key is ${key.fkClass}.`,
        );
      }
      if (side.holdsFk !== field.holdsForeignKey) {
        problems.push(
          `${id}: the side table says the foreign key is ${side.holdsFk ? 'here' : 'on the related model'}, the schema says the opposite.`,
        );
      }
    }
  }
  for (const id of input.relationKeys) {
    if (!relationFields.has(id))
      problems.push(`${id} is in the relation side table but is not a relation field.`);
  }

  return problems;
}
