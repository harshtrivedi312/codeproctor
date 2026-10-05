// What the scope tests know about the Prisma schema, from two sources that must agree:
//
// - The generated client's own metadata (its runtime data model, the module that the removed
//   `Prisma.dmmf` used to expose): model names, field names, database column names and the model
//   each relation points to. Prisma 7 keeps it in the client instance as `_runtimeDataModel`; it is
//   what the client itself queries with, so it is never older than the generated code.
// - prisma/schema.prisma, read as text, only for what the runtime data model leaves out: whether a
//   relation field is a list, optional, or the side that holds the foreign key.
//
// A model added to schema.prisma shows up in both, so the scope tests see it. If the generated
// client is stale (someone forgot `pnpm db:generate`), the two disagree and a test says so.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createPrismaClient } from '../create-prisma-client';

export interface FieldMeta {
  readonly name: string;
  readonly type: string;
  readonly kind: string;
  /** Column name (`org_id`), when the field is mapped. */
  readonly dbName?: string;
  /** Relation fields only, from schema.prisma. */
  readonly isList?: boolean;
  readonly isOptional?: boolean;
  /** True on the side of a relation that holds the foreign key (`@relation(fields: [...])`). */
  readonly holdsForeignKey?: boolean;
}

export interface ModelMeta {
  readonly name: string;
  readonly fields: readonly FieldMeta[];
}

const runtimeModelSchema = z.object({
  models: z.record(
    z.string(),
    z.object({
      fields: z.array(
        z.object({
          name: z.string(),
          kind: z.string(),
          type: z.string(),
          dbName: z.string().nullish(),
        }),
      ),
    }),
  ),
});

/** Model and field metadata as the generated client reports it. */
export async function readGeneratedModels(): Promise<Record<string, ModelMeta>> {
  // The URL is never used: constructing a client does not connect.
  const client = createPrismaClient('postgresql://nobody:nothing@127.0.0.1:1/none');
  try {
    const raw = (client as unknown as { _runtimeDataModel?: unknown })._runtimeDataModel;
    const parsed = runtimeModelSchema.parse(raw);
    return Object.fromEntries(
      Object.entries(parsed.models).map(([name, model]) => [
        name,
        {
          name,
          fields: model.fields.map((f) => ({
            name: f.name,
            type: f.type,
            kind: f.kind,
            ...(f.dbName ? { dbName: f.dbName } : {}),
          })),
        },
      ]),
    );
  } finally {
    await client.$disconnect();
  }
}

export interface SchemaField {
  readonly name: string;
  readonly type: string;
  readonly isList: boolean;
  readonly isOptional: boolean;
  readonly holdsForeignKey: boolean;
  readonly dbName?: string;
}

const SCHEMA_PATH = resolve(__dirname, '../../../../../prisma/schema.prisma');
const FIELD_LINE = /^\s+([A-Za-z_]\w*)\s+([A-Za-z_]\w*)(\[\])?(\?)?(?:\s+(.*))?$/;

/**
 * Models and fields parsed from prisma/schema.prisma. A small line parser: `prisma format` keeps
 * every field on one line, which is all it relies on.
 */
export function readSchemaModels(): Record<string, Record<string, SchemaField>> {
  const models: Record<string, Record<string, SchemaField>> = {};
  let current: Record<string, SchemaField> | undefined;
  for (const line of readFileSync(SCHEMA_PATH, 'utf8').split('\n')) {
    const start = /^model\s+(\w+)\s*\{/.exec(line);
    if (start?.[1] !== undefined) {
      current = {};
      models[start[1]] = current;
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith('}')) {
      current = undefined;
      continue;
    }
    const field = FIELD_LINE.exec(line);
    if (field?.[1] === undefined || field[2] === undefined || line.trim().startsWith('//'))
      continue;
    const attributes = field[5] ?? '';
    const dbName = /@map\("([^"]+)"\)/.exec(attributes)?.[1];
    current[field[1]] = {
      name: field[1],
      type: field[2],
      isList: field[3] !== undefined,
      isOptional: field[4] !== undefined,
      holdsForeignKey: /@relation\([^)]*\bfields:\s*\[/.test(attributes),
      ...(dbName === undefined ? {} : { dbName }),
    };
  }
  return models;
}

/** The generated metadata with cardinality from the schema file added to the relation fields. */
export async function readModelMetas(): Promise<Record<string, ModelMeta>> {
  const generated = await readGeneratedModels();
  const schema = readSchemaModels();
  return Object.fromEntries(
    Object.entries(generated).map(([name, model]) => [
      name,
      {
        name,
        fields: model.fields.map((field): FieldMeta => {
          const parsed = schema[name]?.[field.name];
          if (field.kind !== 'object' || parsed === undefined) return field;
          return {
            ...field,
            isList: parsed.isList,
            isOptional: parsed.isOptional,
            holdsForeignKey: parsed.holdsForeignKey,
          };
        }),
      },
    ]),
  );
}
