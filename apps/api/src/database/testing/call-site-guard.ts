// Finds files that use a PRIVATE entry of the database layer. Used by call-sites.spec.ts, the first slice of the
// FU-DB-67 call-site test (PR 3 widens it to runSystem, runInOrg, runRawSql, the two session entries and the
// store methods, and adds the AST check for the grants: FU-DB-189). CS-4.4 says the grant API is private to
// org-context.ts, and the candidate-facts setter, its claim and the session detach are private too (ADR 0013
// CS-4.1, ADR 0006 section 8.5): TypeScript cannot hide a method of a class that is injected everywhere, so the
// pin is this scan, with an explicit per-file allowlist.
//
// A USE needs an allowlist entry; a MENTION does not. After the comments are stripped (stripComments), a file
// uses a name when it has any of
//   - a call or a definition: `withGrant(`, `.withGrant (`, `withGrant<T>(`;
//   - a member access: `.withGrant` (a bind, a reference, a type query), with or without a call;
//   - a string that is exactly the name: `orgContext['withGrant']`, `Reflect.get(…, 'withGrant')`;
//   - the name inside braces: an import, an export or a re-export, a destructuring, an object shorthand.
// A comment that names it, and a message that says it in prose, are mentions: they force no entry, and they
// do not keep a stale entry alive (the stale check keys on uses).
//
// FAIL-SAFE. The stripper removes only what it is sure is a comment: a `//` or `/*` that starts the line or
// follows whitespace or one of `;{}(),` while no string or template is open; a regex literal that contains a
// quote can confuse it for the rest of that line, and then it strips LESS, never more. If the file ends inside
// an open string, template or block comment, nothing is stripped at all. So a doubt costs an extra entry, not a
// missed call. What it cannot see is a name built at run time (`'with' + 'Grant'`), a unicode escape in the
// identifier, `require` of the compiled file and `moduleRef.get`: the PR 3 AST check and lint list them
// (FU-DB-189). `OrgContextService.prototype` is pinned member by member in org-context-session.spec.ts.
import { reexportsOf, resolveSpecifier, specifiersOf } from './import-guard';
import type { SourceFile } from './import-guard';

/** The private names (identifiers) this slice pins. */
export const GUARDED_NAMES = [
  'withGrant',
  'claimCandidateFactsSetter',
  'setCandidateFacts',
  'detachForSessionJob',
  // The per-session write locks (database/session-locks.ts, ADR 0013 section 5.7, ADR 0015 section 6): the
  // lock core. Only SessionStateService wraps them (hub ruling, ADR PR #205), so its file is the one entry
  // outside the defining file; the import guard pins the importers of the module the same way.
  'guardLive',
  'lockForAccommodation',
  'lockAnySession',
  // The cross-organisation read of scheduled_windows (ADR 0017 section 4.7, C-53): `runSystem('SCHEDULE_CAPACITY',
  // ...)` is a string that is exactly the name, so a file that enters the reason needs an entry. None outside
  // database/ today: the schedule code (backend track) adds its one file in its own reviewed PR.
  'SCHEDULE_CAPACITY',
] as const;
export type GuardedName = (typeof GUARDED_NAMES)[number];

/** One file that may use some of the names. */
export interface CallSiteEntry {
  /** The names the file may use. Anything else of the seven is a violation in this file. */
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

/** True before `index` when the text there may start a comment: the start of the text, a space, or `;{}(),`. */
function mayStartComment(text: string, index: number): boolean {
  if (index === 0) return true;
  const before = text.charAt(index - 1);
  return (
    before === ' ' ||
    before === '\t' ||
    before === '\n' ||
    before === '\r' ||
    ';{}(),'.includes(before)
  );
}

/**
 * The source with its comments replaced by spaces (newlines kept), or the source itself when the lexer ends in
 * the middle of a string, template or block comment. Strings and templates are left as they are: a bracket
 * access and a message are matched on their own text.
 */
export function stripComments(source: string): string {
  const out: string[] = [];
  // 'n' normal, 's' single-quoted, 'd' double-quoted, 't' template (the stack holds the `${` brace depths).
  let state: 'n' | 's' | 'd' | 't' = 'n';
  const templateDepths: number[] = [];
  let braces = 0;
  let i = 0;
  while (i < source.length) {
    const c = source.charAt(i);
    const next = source.charAt(i + 1);
    if (state === 'n') {
      if (c === '/' && next === '/' && mayStartComment(source, i)) {
        while (i < source.length && source.charAt(i) !== '\n') {
          out.push(' ');
          i++;
        }
        continue;
      }
      if (c === '/' && next === '*' && mayStartComment(source, i)) {
        const end = source.indexOf('*/', i + 2);
        if (end === -1) return source; // an open block comment: do not trust the lexer
        for (; i < end + 2; i++) out.push(source.charAt(i) === '\n' ? '\n' : ' ');
        continue;
      }
      if (c === "'") state = 's';
      else if (c === '"') state = 'd';
      else if (c === '`') state = 't';
      else if (c === '{') braces++;
      else if (c === '}') {
        // The end of a `${ ... }` expression returns to the template that opened it.
        if (templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === braces) {
          templateDepths.pop();
          state = 't';
        }
        braces--;
      }
      out.push(c);
      i++;
      continue;
    }
    // inside a string or a template
    if (c === '\\') {
      out.push(c, next);
      i += 2;
      continue;
    }
    if (state === 's' && (c === "'" || c === '\n')) state = 'n';
    else if (state === 'd' && (c === '"' || c === '\n')) state = 'n';
    else if (state === 't') {
      if (c === '`') state = 'n';
      else if (c === '$' && next === '{') {
        braces++;
        templateDepths.push(braces);
        state = 'n';
        out.push(c, next);
        i += 2;
        continue;
      }
    }
    out.push(c);
    i++;
  }
  return state === 'n' && templateDepths.length === 0 ? out.join('') : source;
}

/** The patterns that make a name a USE (see the header). */
function usePatterns(name: string): RegExp[] {
  return [
    new RegExp(`\\b${name}\\s*(?:<[^<>()]*>)?\\s*\\(`), // a call or a definition
    new RegExp(`\\.\\s*${name}\\b`), // a member access
    new RegExp(`['"\`]${name}['"\`]`), // a bracket access, Reflect.get, a string key
    new RegExp(`\\{[^{}]*\\b${name}\\b[^{}]*\\}`), // an import, an export, a destructuring, a shorthand
  ];
}

/** The guarded names that `source` really uses, comments stripped. */
export function usesOf(
  source: string,
  names: readonly GuardedName[] = GUARDED_NAMES,
): GuardedName[] {
  const code = stripComments(source);
  return names.filter((name) => usePatterns(name).some((pattern) => pattern.test(code)));
}

/** The pairs `path: name` where a file uses a guarded name it is not allowed to, sorted. */
export function findCallSiteViolations(
  files: readonly SourceFile[],
  allowed: CallSiteList,
  names: readonly GuardedName[] = GUARDED_NAMES,
): string[] {
  const out: string[] = [];
  for (const file of files) {
    const entry = Object.hasOwn(allowed, file.path) ? allowed[file.path] : undefined;
    const code = stripComments(file.text);
    for (const name of usesOf(file.text, names)) {
      // A re-export hands the name to every importer of this file, who are not on the list.
      const reexported = reexportsOf(code).some(({ clause }) =>
        new RegExp(`\\b${name}\\b`).test(clause),
      );
      if (reexported) out.push(`${file.path}: re-exports ${name}`);
      else if (entry === undefined || !entry.names.includes(name))
        out.push(`${file.path}: ${name}`);
    }
  }
  return out.sort();
}

/** The allowlisted names that a file does not USE any more: a stale entry would silently widen the list. */
export function findStaleEntries(files: readonly SourceFile[], allowed: CallSiteList): string[] {
  const out: string[] = [];
  for (const [path, entry] of Object.entries(allowed)) {
    const file = files.find((f) => f.path === path);
    if (file === undefined) {
      out.push(`${path}: the file does not exist`);
      continue;
    }
    const used = usesOf(file.text);
    for (const name of entry.names) {
      if (!used.includes(name)) out.push(`${path}: no longer uses ${name}`);
    }
  }
  return out.sort();
}

/** The files that import `modulePath` (as `database/candidate-facts`), by any import form. */
export function importersOf(files: readonly SourceFile[], modulePath: string): string[] {
  return files
    .filter((file) =>
      specifiersOf(stripComments(file.text)).some(
        (specifier) => resolveSpecifier(file.path, specifier) === modulePath,
      ),
    )
    .map((file) => file.path)
    .sort();
}
