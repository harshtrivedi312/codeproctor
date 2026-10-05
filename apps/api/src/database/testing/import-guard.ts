// Finds files that use something they should not, by what they import. Used by
// import-guard.spec.ts to keep the unscoped Prisma client, the client factory and BE-01's raw
// pg Pool token out of new code: each of them bypasses the org scope.
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

/** The files that break a rule: they use the module or identifier and are not on its allowlist. */
export function findViolations(files: readonly SourceFile[], rule: GuardRule): string[] {
  return files
    .filter((file) => !rule.allowed.includes(file.path))
    .filter((file) => {
      const importsModule =
        rule.module !== undefined &&
        specifiersOf(file.text).some((spec) => resolveSpecifier(file.path, spec) === rule.module);
      const usesIdentifier =
        rule.identifier !== undefined && new RegExp(`\\b${rule.identifier}\\b`).test(file.text);
      return importsModule || usesIdentifier;
    })
    .map((file) => file.path)
    .sort();
}
