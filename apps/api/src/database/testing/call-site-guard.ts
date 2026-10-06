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

// ---- the per-session write locks (database/session-locks.ts): who may EXPORT them, and who may be listed ---------

/** The three lock names (a subset of GUARDED_NAMES). */
export const LOCK_NAMES = ['guardLive', 'lockForAccommodation', 'lockAnySession'] as const;
export type LockName = (typeof LOCK_NAMES)[number];

const escapeName = (name: string): string => name.replace(/[$]/g, '\\$&');
const IDENT = '[A-Za-z_$][\\w$]*';

/**
 * The local names that stand for one of `names` in `code`: the names themselves, a rename in braces
 * (`guardLive as g`, in an import or an export), a variable that holds one (`const g = guardLive`) or an
 * object or array of them (`const locks = { guardLive }`), and a destructuring rename (`{ guardLive: g }`).
 * Followed to a fixed point, so an alias of an alias counts. A text scan: a name built at run time is not seen.
 */
function aliasesOf(code: string, names: readonly string[]): Set<string> {
  const aliases = new Set<string>(names);
  for (let round = 0; round < 4; round++) {
    const before = aliases.size;
    for (const name of [...aliases].map(escapeName)) {
      const patterns = [
        new RegExp(`\\b${name}\\s+as\\s+(${IDENT})`, 'g'),
        new RegExp(`\\b${name}\\s*:\\s*(${IDENT})`, 'g'),
        new RegExp(
          `\\b(?:const|let|var)\\s+(${IDENT})(?:\\s*:[^=;]+)?\\s*=\\s*(?:${name}\\b|[{\\[][^{}\\[\\]]*\\b${name}\\b)`,
          'g',
        ),
      ];
      for (const pattern of patterns) {
        for (const match of code.matchAll(pattern)) aliases.add(match[1] as string);
      }
    }
    if (aliases.size === before) break;
  }
  return aliases;
}

/** How a source text can export `name` (one lock name or an alias of one) without `export ... from`. */
function exportForms(name: string): RegExp[] {
  const n = escapeName(name);
  return [
    // export { guardLive }, export { guardLive as g }, export { g as guardLive }, export type { ... }
    new RegExp(`\\bexport\\s+(?:type\\s+)?\\{[^}]*\\b${n}\\b[^}]*\\}`),
    // export default guardLive, export default function guardLive
    new RegExp(`\\bexport\\s+default\\s+(?:async\\s+)?(?:function\\s*\\*?\\s*)?${n}\\b`),
    // export default { guardLive }, export default [guardLive]
    new RegExp(`\\bexport\\s+default\\s+[{\\[][^{}\\[\\]]*\\b${n}\\b`),
    // export const guardLive = ..., export function guardLive() {}, export class guardLive {}
    new RegExp(`\\bexport\\s+(?:const|let|var)\\s+${n}\\b`),
    new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s*\\*?\\s*${n}\\b`),
    new RegExp(`\\bexport\\s+(?:abstract\\s+)?class\\s+${n}\\b`),
    // export const g = guardLive, export const locks = { guardLive }, export const l = [guardLive]
    new RegExp(
      `\\bexport\\s+(?:const|let|var)\\s+${IDENT}(?:\\s*:[^=;]+)?\\s*=\\s*(?:${n}\\b|[{\\[][^{}\\[\\]]*\\b${n}\\b)`,
    ),
    // module.exports = guardLive, exports.g = guardLive, module.exports = { guardLive }
    new RegExp(
      `\\b(?:module\\.)?exports(?:\\.[\\w$]+|\\[[^\\]]+\\])?\\s*=\\s*(?:${n}\\b|[{\\[][^{}\\[\\]]*\\b${n}\\b)`,
    ),
  ];
}

/**
 * The files that EXPORT a lock name, or an alias of one, other than through `export ... from` (reexportsOf and
 * the import guard catch that): `export { guardLive as g }`, `export const g = guardLive`,
 * `export default guardLive`, `export default { guardLive }`, `export function guardLive() {}`,
 * `module.exports = { guardLive }`, and the same through a local alias. A class that merely has a METHOD with
 * the name (`export class SessionStateService { guardLive() {} }`) exports none of them, and is not found.
 * Pass the files OUTSIDE `database/`: no file there may export a lock, the SessionStateService file included.
 * It has no allowlist, on purpose: Backend B's file is checked by the same test, which is the mechanical
 * review point. Lines are `path: exports <name>`, sorted.
 */
export function findLockExports(
  files: readonly SourceFile[],
  names: readonly string[] = LOCK_NAMES,
): string[] {
  const out: string[] = [];
  for (const file of files) {
    const code = stripComments(file.text);
    if (!names.some((name) => new RegExp(`\\b${escapeName(name)}\\b`).test(code))) continue;
    const found = new Set<string>();
    for (const alias of aliasesOf(code, names)) {
      if (exportForms(alias).some((form) => form.test(code))) found.add(alias);
    }
    for (const alias of found) out.push(`${file.path}: exports ${alias}`);
  }
  return out.sort();
}

/** The rules for the entries of CALL_SITES that name a lock, in words (README, the `why` texts, the failures). */
export const LOCK_CALLER_RULES = {
  guardLive:
    'at most two files outside database/: SessionJobProcessor.withLiveSession (why names withLiveSession) and ' +
    'SessionStateService with its single STAFF method proctorResume (why names proctorResume); the ' +
    'proctorResume file has exactly one `this.guardLive(` call, the withLiveSession file exactly one `.guardLive(` call',
  lockAnySession:
    'at most two files outside database/ (SessionStateService and SessionJobProcessor), each why naming withAnySession',
  lockForAccommodation:
    'an accommodation writer (why names the accommodation writer, via SessionStateService) or, at most one, ' +
    'retention/retention.repository.ts (why names the erasure, R-4 and R-10 jobs)',
} as const;

/** The pinned retention call site of lockForAccommodation (Database B: RetentionRepository.casAccommodations). */
export const RETENTION_LOCK_FILE = 'retention/retention.repository.ts';
/** Most files outside retention that may use lockForAccommodation: SessionStateService and AccommodationsService. */
const MAX_ACCOMMODATION_FILES = 2;

const hasWord = (text: string, word: string): boolean => new RegExp(word).test(text);
const callCount = (code: string, pattern: RegExp): number =>
  [...code.matchAll(new RegExp(pattern.source, 'g'))].length;

/**
 * The problems with the entries of `list` that name a lock (FU-DB-67; the hub's rulings on who calls what), as
 * readable lines, sorted. Empty when the list obeys every rule:
 *   - inside database/, only `database/session-locks.ts` may name a lock (it defines them);
 *   - guardLive: at most two entries outside database/; each why names `withLiveSession` or `proctorResume`; at
 *     most one names each; with `files`, the proctorResume file has exactly one `this.guardLive(` call and the
 *     withLiveSession file exactly one `.guardLive(` call (a text count, which a reviewer backs up);
 *   - lockAnySession: at most two entries outside database/, each why naming `withAnySession`;
 *   - lockForAccommodation: each entry outside database/ is an accommodation writer (why names the accommodation
 *     writer; at most two such files) or `retention/retention.repository.ts` (at most one retention file, why
 *     naming the erasure, R-4 and R-10 jobs); anything else is an extra entry and fails.
 * Database B adds the retention entry in its own PR (not before: the stale-entry check would fail).
 */
export function lockCallSiteProblems(
  list: CallSiteList,
  files: readonly SourceFile[] = [],
): string[] {
  const out: string[] = [];
  const entries = Object.entries(list).filter(([path]) => path !== 'database/session-locks.ts');
  const naming = (name: LockName) => entries.filter(([, entry]) => entry.names.includes(name));
  const textOf = (path: string): string | undefined => {
    const file = files.find((f) => f.path === path);
    return file === undefined ? undefined : stripComments(file.text);
  };

  for (const [path, entry] of entries) {
    if (
      path.startsWith('database/') &&
      entry.names.some((n) => (LOCK_NAMES as readonly string[]).includes(n))
    ) {
      out.push(`${path}: only database/session-locks.ts may name a session lock inside database/`);
    }
  }

  const guard = naming('guardLive');
  if (guard.length > 2) {
    out.push(`guardLive: ${guard.length} entries, at most two (${LOCK_CALLER_RULES.guardLive})`);
  }
  let withLive = 0;
  let proctor = 0;
  for (const [path, entry] of guard) {
    const live = hasWord(entry.why, 'withLiveSession');
    const resume = hasWord(entry.why, 'proctorResume');
    if (!live && !resume) {
      out.push(`${path}: a guardLive entry's why must name withLiveSession or proctorResume`);
    }
    if (live) withLive += 1;
    if (resume) proctor += 1;
    const code = textOf(path);
    if (code !== undefined && resume) {
      const n = callCount(code, /\bthis\.guardLive\s*\(/);
      if (n !== 1) {
        out.push(
          `${path}: proctorResume file has ${n} this.guardLive( calls, exactly one is allowed`,
        );
      }
      if (!/\bproctorResume\s*\(/.test(code)) out.push(`${path}: no proctorResume method found`);
    }
    if (code !== undefined && live) {
      const n = callCount(code, /\.guardLive\s*\(/);
      if (n !== 1) {
        out.push(
          `${path}: withLiveSession file has ${n} .guardLive( calls, exactly one is allowed`,
        );
      }
    }
  }
  if (withLive > 1) out.push('guardLive: more than one entry names withLiveSession');
  if (proctor > 1) out.push('guardLive: more than one entry names proctorResume');

  const any = naming('lockAnySession');
  if (any.length > 2) {
    out.push(
      `lockAnySession: ${any.length} entries, at most two (${LOCK_CALLER_RULES.lockAnySession})`,
    );
  }
  for (const [path, entry] of any) {
    if (!hasWord(entry.why, 'withAnySession')) {
      out.push(`${path}: a lockAnySession entry's why must name withAnySession`);
    }
  }

  const accommodation = naming('lockForAccommodation');
  const retention = accommodation.filter(([path]) => path.startsWith('retention/'));
  const writers = accommodation.filter(([path]) => !path.startsWith('retention/'));
  if (retention.length > 1) {
    out.push(`lockForAccommodation: more than one retention file, only ${RETENTION_LOCK_FILE}`);
  }
  for (const [path, entry] of retention) {
    if (path !== RETENTION_LOCK_FILE) {
      out.push(
        `${path}: the only retention file that may use lockForAccommodation is ${RETENTION_LOCK_FILE}`,
      );
    }
    for (const word of ['erasure', 'R-4', 'R-10']) {
      if (!hasWord(entry.why, word)) {
        out.push(`${path}: a retention lockForAccommodation entry's why must name the ${word} job`);
      }
    }
  }
  if (writers.length > MAX_ACCOMMODATION_FILES) {
    out.push(
      `lockForAccommodation: ${writers.length} accommodation-writer files, at most ${MAX_ACCOMMODATION_FILES} (SessionStateService and AccommodationsService)`,
    );
  }
  for (const [path, entry] of writers) {
    if (!hasWord(entry.why, 'ccommodation')) {
      out.push(
        `${path}: a lockForAccommodation entry's why must name an accommodation writer (or be ${RETENTION_LOCK_FILE})`,
      );
    }
  }
  return out.sort();
}
