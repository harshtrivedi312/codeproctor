// Reads the reference DDL in docs/database.md (the authoritative schema, ADR 0008) so the schema
// tests compare the database with the document and not with a copy of it. Not a test file.
// A statement it does not understand throws: silently skipping it would leave part of the schema
// unchecked.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './test-support.mjs';

/** Splits on commas that are not inside parentheses or quotes. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const ch of text) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === '(') depth++;
    if (!quoted && ch === ')') depth--;
    if (ch === ',' && depth === 0 && !quoted) {
      parts.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

const TABLE_CONSTRAINT = /^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i;
const list = (s) => s.split(',').map((c) => c.trim());
const onDelete = (text) => {
  if (/ON DELETE CASCADE/i.test(text)) return 'CASCADE';
  if (/ON DELETE SET NULL/i.test(text)) return 'SET NULL';
  return 'NO ACTION';
};

/** The type a column has in pg_attribute / information_schema (udt_name). */
export function udtName(docType) {
  const t = docType.toLowerCase().replace(/\(.*\)/, '');
  const array = t.endsWith('[]');
  const base = array ? t.slice(0, -2) : t;
  const map = {
    int: 'int4',
    integer: 'int4',
    bigint: 'int8',
    smallint: 'int2',
    boolean: 'bool',
    varchar: 'varchar',
  };
  const udt = map[base] ?? base;
  return array ? `_${udt}` : udt;
}

/** Words that identify a partial-index predicate without PostgreSQL's re-printing (casts, parentheses). */
export function predicateKey(text) {
  const words = text.replace(/::\w+/g, '').match(/'[^']*'|\b[a-z_][a-z0-9_]*\b/gi) ?? [];
  // IS, NOT and NULL stay in the key: IS NULL and IS NOT NULL are different predicates.
  return words
    .filter((w) => !/^(where|in|any|array)$/i.test(w))
    .map((w) => w.toLowerCase())
    .sort()
    .join(' ');
}

/**
 * @typedef {{ type: string, notNull: boolean, boolDefault: string | null }} Column
 * @typedef {{ columns: string[], parent: string, parentColumns: string[], onDelete: string }} ForeignKey
 */
export function parseReferenceDdl() {
  const doc = readFileSync(join(REPO_ROOT, 'docs/database.md'), 'utf8');
  const sql = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .join('\n')
    .replace(/--[^\n]*/g, '');
  /** @type {Map<string, { columns: Map<string, Column>, foreignKeys: ForeignKey[], primaryKey: string[] }>} */
  const tables = new Map();
  /** @type {Map<string, string[]>} */
  const enums = new Map();
  /** @type {{ table: string, columns: string, predicate: string | null }[]} */
  const indexes = [];
  /** @type {Set<string>} "table|col,col" */
  const uniques = new Set();

  for (const statement of sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '')) {
    let m = /^CREATE EXTENSION\b/i.exec(statement);
    if (m) continue;
    m = /^CREATE TYPE (\w+)\s+AS ENUM\s*\(([\s\S]*)\)$/i.exec(statement);
    if (m) {
      enums.set(
        m[1],
        [...m[2].matchAll(/'([^']*)'/g)].map((v) => v[1]),
      );
      continue;
    }
    m =
      /^CREATE (UNIQUE )?INDEX (?:\w+ )?ON (\w+)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)(?:\s+WHERE\s+([\s\S]*))?$/i.exec(
        statement,
      );
    if (m) {
      const columns = m[3].replace(/\s+/g, ' ').trim().toLowerCase();
      if (m[1]) uniques.add(`${m[2]}|${columns}`);
      else indexes.push({ table: m[2], columns, predicate: m[4] ? predicateKey(m[4]) : null });
      continue;
    }
    m = /^CREATE TABLE (\w+)\s*\(([\s\S]*)\)$/i.exec(statement);
    if (m) {
      const name = m[1];
      const table = { columns: new Map(), foreignKeys: [], primaryKey: [] };
      for (const item of splitTopLevel(m[2])) {
        if (!TABLE_CONSTRAINT.test(item)) {
          const [col, ...rest] = item.split(/\s+/);
          const type = /^(\w+(?:\([^)]*\))?(?:\[\])?)/.exec(rest.join(' '))?.[1];
          if (!type) throw new Error(`database.md: cannot read the type of ${name}.${col}`);
          const pk = /\bPRIMARY KEY\b/i.test(item);
          const def = /\bDEFAULT\s+(true|false)\b/i.exec(item);
          table.columns.set(col, {
            type,
            notNull: pk || /\bNOT NULL\b/i.test(item),
            boolDefault: def ? def[1].toLowerCase() : null,
          });
          if (pk) table.primaryKey = [col];
          if (/\bUNIQUE\b/i.test(item.replace(/CHECK\s*\(.*\)/i, '')))
            uniques.add(`${name}|${col}`);
          const ref = /\bREFERENCES (\w+)\s*\(([^)]*)\)/i.exec(item);
          if (ref) {
            table.foreignKeys.push({
              columns: [col],
              parent: ref[1],
              parentColumns: list(ref[2]),
              onDelete: onDelete(item),
            });
          }
          continue;
        }
        let c = /^PRIMARY KEY\s*\(([^)]*)\)/i.exec(item);
        if (c) {
          table.primaryKey = list(c[1]);
          continue;
        }
        c = /^UNIQUE\s*\(([^)]*)\)/i.exec(item);
        if (c) {
          uniques.add(`${name}|${list(c[1]).join(',')}`);
          continue;
        }
        c = /^FOREIGN KEY\s*\(([^)]*)\)\s*REFERENCES (\w+)\s*\(([^)]*)\)/i.exec(item);
        if (c) {
          table.foreignKeys.push({
            columns: list(c[1]),
            parent: c[2],
            parentColumns: list(c[3]),
            onDelete: onDelete(item),
          });
          continue;
        }
        if (!/^CHECK\b/i.test(item))
          throw new Error(`database.md: unrecognised constraint in ${name}: ${item.slice(0, 60)}`);
      }
      tables.set(name, table);
      continue;
    }
    m =
      /^ALTER TABLE (\w+)\s+ADD\s+(?:CONSTRAINT \w+\s+)?FOREIGN KEY\s*\(([^)]*)\)\s*REFERENCES (\w+)\s*\(([^)]*)\)/i.exec(
        statement,
      );
    if (m) {
      tables.get(m[1])?.foreignKeys.push({
        columns: list(m[2]),
        parent: m[3],
        parentColumns: list(m[4]),
        onDelete: onDelete(statement),
      });
      continue;
    }
    if (/^(CREATE|ALTER)\b/i.test(statement)) {
      throw new Error(
        `database.md: the schema test does not understand: ${statement.slice(0, 80)}`,
      );
    }
  }
  return { tables, enums, indexes, uniques };
}
