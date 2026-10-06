// Finds files that use a PRIVATE entry of the database layer. Used by call-sites.spec.ts, the first slice of the
// FU-DB-67 call-site test (PR 3 widens it to runSystem, runInOrg, runRawSql, the two session entries and the
// store methods). CS-4.4 says the grant API is private to org-context.ts, and the candidate-facts setter, its
// claim and the session detach are private too (ADR 0013 CS-4.1, ADR 0006 section 8.5): TypeScript cannot hide a
// method of a class that is injected everywhere, so the pin is this scan, with an explicit per-file allowlist.
//
// What counts as a use: the bare word (`\bwithGrant\b`) anywhere in a non-test source file, comments and
// strings included. That is on purpose: a call, a destructuring, a bracket access (`orgContext['withGrant']`),
// `Reflect.get(…, 'withGrant')`, an import and a re-export all contain the word, and no lexer is needed (a
// regex literal with a quote would confuse one). The cost is that a comment naming it is a hit too, so the file
// that mentions it must be on the list: a new mention is the review point. What it cannot see is a name built
// at run time (`'with' + 'Grant'`); `OrgContextService.prototype` is pinned member by member in
// org-context-session.spec.ts, and the PR 3 lint bans the dynamic forms.
import { reexportsOf, resolveSpecifier, specifiersOf } from './import-guard';
import type { SourceFile } from './import-guard';

/** The private names (identifiers) this slice pins. */
export const GUARDED_NAMES = [
  'withGrant',
  'claimCandidateFactsSetter',
  'setCandidateFacts',
  'detachForSessionJob',
] as const;
export type GuardedName = (typeof GUARDED_NAMES)[number];

/** One file that may use some of the names. */
export interface CallSiteEntry {
  /** The names the file may use. Anything else of the four is a violation in this file. */
  readonly names: readonly GuardedName[];
  /** Why this file may (shown when the guard fails and read by the reviewer). */
  readonly why: string;
  /**
   * For a file that calls `withGrant`: the CS-4.4 grant sites it holds, by `GRANT_SITES` name (one entry of the
   * table per site; a service with two grants, SectionGateService and ConsentService, names both). A file
   * outside src/database that allows `withGrant` must name at least one.
   */
  readonly sites?: readonly string[];
}

export type CallSiteList = Readonly<Record<string, CallSiteEntry>>;

/** The pairs `path: name` where a file uses a guarded name it is not allowed to, sorted. */
export function findCallSiteViolations(
  files: readonly SourceFile[],
  allowed: CallSiteList,
  names: readonly GuardedName[] = GUARDED_NAMES,
): string[] {
  const out: string[] = [];
  for (const file of files) {
    const entry = Object.hasOwn(allowed, file.path) ? allowed[file.path] : undefined;
    for (const name of names) {
      const uses = new RegExp(`\\b${name}\\b`).test(file.text);
      if (!uses) continue;
      // A re-export hands the name to every importer of this file, who are not on the list.
      const reexported = reexportsOf(file.text).some(({ clause }) =>
        new RegExp(`\\b${name}\\b`).test(clause),
      );
      if (reexported) out.push(`${file.path}: re-exports ${name}`);
      else if (entry === undefined || !entry.names.includes(name))
        out.push(`${file.path}: ${name}`);
    }
  }
  return out.sort();
}

/** The allowlisted names that a file does not use any more: a stale entry would silently widen the list. */
export function findStaleEntries(files: readonly SourceFile[], allowed: CallSiteList): string[] {
  const out: string[] = [];
  for (const [path, entry] of Object.entries(allowed)) {
    const file = files.find((f) => f.path === path);
    if (file === undefined) {
      out.push(`${path}: the file does not exist`);
      continue;
    }
    for (const name of entry.names) {
      if (!new RegExp(`\\b${name}\\b`).test(file.text)) out.push(`${path}: no longer uses ${name}`);
    }
  }
  return out.sort();
}

/** The files that import `modulePath` (as `database/candidate-facts`), by any import form. */
export function importersOf(files: readonly SourceFile[], modulePath: string): string[] {
  return files
    .filter((file) =>
      specifiersOf(file.text).some(
        (specifier) => resolveSpecifier(file.path, specifier) === modulePath,
      ),
    )
    .map((file) => file.path)
    .sort();
}
