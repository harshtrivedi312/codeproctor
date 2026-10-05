// Reads the reference DDL in docs/database.md (the authoritative schema, ADR 0008) so the schema
// tests compare the database with the document and not with a copy of it. Not a test file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './test-support.mjs';

/** Splits on commas that are not inside parentheses. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  let quoted = false;
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
const RULES = { 'ON DELETE CASCADE': 'CASCADE', 'ON DELETE SET NULL': 'SET NULL' };

/**
 * @returns {{
 *   tables: Map<string, { columns: Map<string, { notNull: boolean }>, foreignKeys: { columns: string[], parent: string, onDelete: string }[], primaryKey: string[] }>,
 *   enums: Map<string, string[]>,
 *   indexes: { table: string, columns: string, partial: boolean }[],
 * }}
 */
export function parseReferenceDdl() {
  const doc = readFileSync(join(REPO_ROOT, 'docs/database.md'), 'utf8');
  const sql = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .join('\n')
    .replace(/--[^\n]*/g, '');
  const tables = new Map();
  const enums = new Map();
  const indexes = [];
  for (const statement of sql.split(';').map((s) => s.trim())) {
    let m = /^CREATE TYPE (\w+)\s+AS ENUM\s*\(([\s\S]*)\)$/i.exec(statement);
    if (m) {
      enums.set(
        m[1],
        [...m[2].matchAll(/'([^']*)'/g)].map((v) => v[1]),
      );
      continue;
    }
    m = /^CREATE (?:UNIQUE )?INDEX (?:\w+ )?ON (\w+)\s*\(([^)]*)\)(\s+WHERE[\s\S]*)?$/i.exec(
      statement,
    );
    if (m) {
      indexes.push({
        table: m[1],
        columns: m[2].replace(/\s+/g, ' ').trim().toLowerCase(),
        partial: Boolean(m[3]),
        unique: /^CREATE UNIQUE/i.test(statement),
      });
      continue;
    }
    m = /^CREATE TABLE (\w+)\s*\(([\s\S]*)\)$/i.exec(statement);
    if (m) {
      const table = { columns: new Map(), foreignKeys: [], primaryKey: [] };
      for (const item of splitTopLevel(m[2])) {
        const tc = TABLE_CONSTRAINT.test(item);
        if (!tc) {
          const [name] = item.split(/\s+/);
          const pk = /\bPRIMARY KEY\b/i.test(item);
          table.columns.set(name, { notNull: pk || /\bNOT NULL\b/i.test(item) });
          if (pk) table.primaryKey = [name];
          const ref = /\bREFERENCES (\w+)\s*\(([^)]*)\)\s*(ON DELETE (?:CASCADE|SET NULL))?/i.exec(
            item,
          );
          if (ref) {
            table.foreignKeys.push({
              columns: [name],
              parent: ref[1],
              onDelete: ref[3] ? RULES[ref[3].toUpperCase().replace(/\s+/g, ' ')] : 'NO ACTION',
            });
          }
          continue;
        }
        const pk = /^PRIMARY KEY\s*\(([^)]*)\)/i.exec(item);
        if (pk) table.primaryKey = pk[1].split(',').map((c) => c.trim());
        const fk = /^FOREIGN KEY\s*\(([^)]*)\)\s*REFERENCES (\w+)/i.exec(item);
        if (fk) {
          table.foreignKeys.push({
            columns: fk[1].split(',').map((c) => c.trim()),
            parent: fk[2],
            onDelete: 'NO ACTION',
          });
        }
      }
      tables.set(m[1], table);
      continue;
    }
    m =
      /^ALTER TABLE (\w+)\s+ADD\s+(?:CONSTRAINT \w+\s+)?FOREIGN KEY\s*\(([^)]*)\)\s*REFERENCES (\w+)[^)]*\)\s*(ON DELETE (?:CASCADE|SET NULL))?/i.exec(
        statement,
      );
    if (m) {
      tables.get(m[1])?.foreignKeys.push({
        columns: m[2].split(',').map((c) => c.trim()),
        parent: m[3],
        onDelete: m[4] ? RULES[m[4].toUpperCase().replace(/\s+/g, ' ')] : 'NO ACTION',
      });
      // Nothing is added to indexes: a foreign key is not an index.
    }
  }
  indexes.forEach((i) => void i);
  return { tables, enums, indexes };
}
