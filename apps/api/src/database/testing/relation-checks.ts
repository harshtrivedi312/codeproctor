// Completeness rules for the foreign key classification and the relation side table
// (org-scope-relations.ts), as a pure function over the table and the parsed schema. The real test
// runs it on the real table and expects no problems; it is also run on deliberately broken input
// to show that each rule can fail.
import type { ForeignKey, FkKind, RelationSide } from '../org-scope-relations';
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

/** The kind a foreign key must have, from the schema and the scope map alone. */
export function expectedKind(
  model: string,
  field: SchemaField,
  scope: Readonly<Record<string, OrgScopeRule>>,
): FkKind {
  const rule = scope[model];
  if (field.name === 'org' && field.type === 'Organization' && rule?.kind === 'direct') {
    return 'org-column';
  }
  if (field.foreignKeyFields.length > 1) return 'composite';
  if (rule?.kind === 'path' && rule.path[0] === field.name) return 'scope-hop';
  return field.type === 'User' ? 'staff-ref' : 'cross-chain';
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
    const kind = expectedKind(key.model, field, scope);
    if (kind !== key.kind) {
      problems.push(`${id} is classified ${key.kind} but its kind is ${kind}.`);
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
