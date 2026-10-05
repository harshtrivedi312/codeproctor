// Finds files that use something they should not, by what they import. Used by
// import-guard.spec.ts to keep the unscoped Prisma client, the client factory, BE-01's raw pg Pool
// token, and the `pg` and `@prisma/adapter-pg` packages out of new code: each of them bypasses the
// org scope.
import { dirname, relative, resolve, sep } from 'node:path';

export interface SourceFile {
  /** Path relative to apps/api/src, with forward slashes: `auth/auth.service.ts`. */
  readonly path: string;
  readonly text: string;
}

export interface GuardRule {
  readonly name: string;
  /** Why the thing is guarded, and what to use instead. Shown when the guard fails. */
  readonly why: string;
  /** The module that must not be imported, as a path under src without extension. */
  readonly module?: string;
  /** A package that must not be imported: `pg` also matches `pg/lib/...`, not `pg-pool`. */
  readonly package?: string;
  /** An identifier that must not appear. */
  readonly identifier?: string;
  /** The only files that may use it. Explicit paths, never folders. */
  readonly allowed: readonly string[];
}

// from '…' (import and export), import '…', require('…') and import('…'), single or double quotes.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;

/** Every module specifier in `source`, in any of the import forms. */
export function specifiersOf(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((match) => match[2] as string);
}

/**
 * The module a relative specifier points at, as `database/prisma.module`: relative to src, with
 * the `.js` or `.ts` extension removed. Bare specifiers (packages) give `undefined`.
 */
export function resolveSpecifier(fromPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const root = resolve('/src-root');
  const target = relative(root, resolve(root, dirname(fromPath), specifier));
  return target
    .split(sep)
    .join('/')
    .replace(/\.(js|ts)$/, '');
}

/** True when `specifier` is the guarded package, or a path inside it. */
function isPackage(specifier: string, name: string): boolean {
  return specifier === name || specifier.startsWith(`${name}/`);
}

function matchesSpecifier(file: SourceFile, specifier: string, rule: GuardRule): boolean {
  if (rule.module !== undefined && resolveSpecifier(file.path, specifier) === rule.module)
    return true;
  return rule.package !== undefined && isPackage(specifier, rule.package);
}

// export * from '…', export * as x from '…', export { a } from '…', export type { a } from '…'.
const REEXPORT =
  /\bexport\s+(?:type\s+)?(\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\2/g;

/** Every re-export in `source`: what it exports (the clause) and the module it comes from. */
export function reexportsOf(source: string): Array<{ clause: string; specifier: string }> {
  return [...source.matchAll(REEXPORT)].map((match) => ({
    clause: match[1] as string,
    specifier: match[3] as string,
  }));
}

/**
 * The files that break a rule. A file breaks it by importing the module or package, or by using the
 * identifier, unless it is on the allowlist. A file that RE-EXPORTS a guarded module, package or
 * identifier breaks it even when it is on the allowlist: a re-export hands the guarded thing to every
 * importer of that file, who are not on the list.
 */
export function findViolations(files: readonly SourceFile[], rule: GuardRule): string[] {
  return files
    .filter((file) => {
      const reexports = reexportsOf(file.text).some(
        ({ clause, specifier }) =>
          matchesSpecifier(file, specifier, rule) ||
          (rule.identifier !== undefined && new RegExp(`\\b${rule.identifier}\\b`).test(clause)),
      );
      if (reexports) return true;
      if (rule.allowed.includes(file.path)) return false;
      const importsGuarded = specifiersOf(file.text).some((spec) =>
        matchesSpecifier(file, spec, rule),
      );
      const usesIdentifier =
        rule.identifier !== undefined && new RegExp(`\\b${rule.identifier}\\b`).test(file.text);
      return importsGuarded || usesIdentifier;
    })
    .map((file) => file.path)
    .sort();
}
