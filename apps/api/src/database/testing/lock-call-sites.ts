// Who may use, wrap and export the per-session write locks (database/session-locks.ts), as mechanical rules for the
// FU-DB-67 call-site test (call-sites.spec.ts reads the real tree with them, lock-call-sites.spec.ts pins every rule on
// synthetic files). The hub's rulings (#205, #211, #213) and the re-reviews of #208 fix three layers:
//
//   1. WHICH FILES. Only the SessionStateService file imports `database/session-locks` (import guard). Outside
//      `database/`, a lock may be named only in the files of LOCK_ALLOWED_FILES: guardLive and lockAnySession in the
//      SessionStateService and SessionJobProcessor files, lockForAccommodation in the SessionStateService, accommodation
//      writers and retention repository files. The paths are Backend B's real ones (#98, #206) and Database B's.
//   2. WHAT EACH FILE MAY DO (checked whenever the file exists, listed or not, text rules over the comment-stripped
//      source). The state and processor files are each in ONE OF TWO STATES, and there is no third: before Backend B's
//      switch-over (#206) they name no lock at all (and the state file does not import the core), which is how BE-07
//      (#98) left them on main; once a file names a lock, or the state file reaches the core in any form, it gets the
//      full shape below with nothing relaxed.
//      - SESSION_STATE_FILE: each core is imported by NAME under an alias, by an `import { x as alias } from` statement and
//        by no other way (never a namespace, never `import x = require`, `require(`, `import(`, a side-effect import or a
//        re-export of the module), and called exactly once, inside the wrapper METHOD of the same name in the
//        SessionStateService class, whose whole body is `return <alias>(<param1>, <param2>);` (a thin wrapper: nothing is
//        stored, wrapped or leaked); the alias is used nowhere else; every other mention of a lock name is the wrapper's
//        definition or a member call. Member calls of the wrappers inside the file are counted with ANY receiver
//        (`this.`, `self.`, `this?.`, `(this as X).`, `super.`): exactly ONE `.guardLive(` call, inside the
//        brace-matched `proctorResume` body, and ZERO `.lockAnySession(`, `.lockForAccommodation(` and
//        `.proctorResume(` calls (the accommodation routes call the second from session/accommodations.ts, the jobs
//        call the first from the processor, the controller calls proctorResume from outside the file).
//      - SESSION_PROCESSOR_FILE: `.guardLive(` exactly once, inside `withLiveSession`; `.lockAnySession(` exactly once,
//        inside `withAnySession`; every mention of a lock name is a member call.
//      - the accommodation and retention files: every mention of a lock name is a member call.
//   3. NO EXPORT. No file outside `database/` exports a lock, an alias of one, or a function or static property that
//      wraps one under a new name (findLockExports). There is no allowlist: the SessionStateService file is checked too.
//
// All of it is a TEXT scan over the source after the comments are stripped (stripComments). A doubt costs an extra
// finding, never a missed one, wherever the scan can tell: a lock name in a string or a log message fails like code, and
// code that is not formatted as the repository's prettier formats it can fail the other way. It is NOT a parser. LIMITS,
// so a reviewer does not rely on more than this:
//   - `stripComments`, `matchingBrace`, `matchingParen` and `findMethod` skip strings and templates but NOT regex
//     literals. A quote or a `/*` inside a regex literal (`/['"]/`, or a character class holding ` /*`) can unbalance a
//     body or hide code in what looks like a comment, and the result is then wrong in either direction: a "no wrapper
//     found" or a wrong count, but also a body that spans too much or too little. The rules do not promise to fail there;
//   - a name written with a unicode escape (`gu\u0061rdLive`), built at run time, reached through a computed property, an
//     eval or a `Reflect` call on a name that is not spelled in the file, and a lock that escapes through a closure
//     built from a parameter (the scan does not follow values), are not seen;
//   - the exported-function check works on lines (it assumes prettier's column-0 layout).
// FU-DB-189 builds the AST gate (CS-4 PR 3) that replaces this text scan; until then the rules above are the control.
// The rules are documented for Backend B and Database B in apps/api/src/database/README.md ("Who calls what").
import { stripComments } from './call-site-guard';
import type { CallSiteList } from './call-site-guard';
import { specifiersOf } from './import-guard';
import type { SourceFile } from './import-guard';

/** The three lock names (a subset of GUARDED_NAMES). */
export const LOCK_NAMES = ['guardLive', 'lockForAccommodation', 'lockAnySession'] as const;
export type LockName = (typeof LOCK_NAMES)[number];

/** SessionStateService (Backend B, #98 and #206): the wrappers; the only file that imports the cores. */
export const SESSION_STATE_FILE = 'session/session-state.service.ts';
/** The class of that file: the wrappers and `proctorResume` are looked up in its body, not in another class of the file. */
export const SESSION_STATE_CLASS = 'SessionStateService';
/** SessionJobProcessor (Backend B): `withLiveSession` and `withAnySession`. */
export const SESSION_PROCESSOR_FILE = 'session/session-job.processor.ts';
/** The accommodation writers (Backend B): the STAFF PATCH, redact-note and video-check PUT. */
export const ACCOMMODATIONS_FILE = 'session/accommodations.ts';
/** The retention org-job site (Database B): `RetentionRepository.casAccommodations`, in a plain `runInOrg`. */
export const RETENTION_LOCK_FILE = 'retention/retention.repository.ts';

/** The files that may be listed in CALL_SITES for each lock, outside `database/` (a subset rule: fewer is fine). */
export const LOCK_ALLOWED_FILES: Readonly<Record<LockName, readonly string[]>> = {
  guardLive: [SESSION_STATE_FILE, SESSION_PROCESSOR_FILE],
  lockAnySession: [SESSION_STATE_FILE, SESSION_PROCESSOR_FILE],
  lockForAccommodation: [SESSION_STATE_FILE, ACCOMMODATIONS_FILE, RETENTION_LOCK_FILE],
};

/** The files whose `allowed` entry the import guard may carry for `database/session-locks`. */
export const LOCK_IMPORT_ALLOWED_FILES: readonly string[] = [SESSION_STATE_FILE];

/** The rules, in words (README, the `why` texts, the failure messages). */
export const LOCK_CALLER_RULES = {
  import: `only ${SESSION_STATE_FILE} imports database/session-locks, by an import { x as alias } from statement`,
  guardLive:
    `${SESSION_PROCESSOR_FILE} (withLiveSession, exactly one .guardLive( call) and ${SESSION_STATE_FILE} ` +
    'with the single STAFF method proctorResume (exactly one .guardLive( call with any receiver, inside proctorResume)',
  lockAnySession:
    `${SESSION_PROCESSOR_FILE} (withAnySession, exactly one .lockAnySession( call) and ${SESSION_STATE_FILE} ` +
    '(the wrapper only: no member call of it in that file); each why naming withAnySession',
  lockForAccommodation:
    `the STAFF accommodation routes in ${ACCOMMODATIONS_FILE} (PATCH, redact-note, video-check PUT; ` +
    `${SESSION_STATE_FILE} holds the wrapper only, with no member call of it) and one org-job file, ` +
    `${RETENTION_LOCK_FILE} (RetentionRepository.casAccommodations in a plain runInOrg: the erasure, R-4 and R-10 jobs)`,
  stateFile:
    `no import of the core and no lock named at all (before the switch-over), or: each core imported by name under an alias by an import { x as alias } from statement (no namespace import, no ` +
    `import x = require, require(, import( or re-export of the module) and called exactly once, inside the wrapper ` +
    `method of the same name in the ${SESSION_STATE_CLASS} class, whose whole body is return <alias>(<param1>, ` +
    `<param2>); nowhere else; member calls counted with any receiver: one .guardLive( call, inside proctorResume, ` +
    `and no .lockAnySession(, .lockForAccommodation( or .proctorResume( call`,
  processorFile:
    'no lock named at all (before the switch-over), or: .guardLive( exactly once, inside withLiveSession, and ' +
    '.lockAnySession( exactly once, inside withAnySession, every mention of a lock name a member call',
  otherFiles: 'every mention of a lock name is a member call (`this.state.guardLive(`)',
  exports: 'no export of a lock, an alias, or a function or static property that wraps one',
} as const;

// ---- small text tools -----------------------------------------------------------------------------------------------

const escapeName = (name: string): string => name.replace(/[$]/g, '\\$&');
const IDENT = '[A-Za-z_$][\\w$]*';

const indexesOf = (code: string, pattern: RegExp): number[] =>
  [...code.matchAll(new RegExp(pattern.source, 'g'))].map((match) => match.index);

/**
 * The index of the `}` that closes the `{` at `open`, skipping strings and template literals (with `${ }`), or
 * undefined when the braces do not balance (a regex literal with a quote can do that: the caller then reports it).
 */
export function matchingBrace(code: string, open: number): number | undefined {
  const stack: Array<'brace' | 'template'> = [];
  let i = open;
  while (i < code.length) {
    const c = code.charAt(i);
    const top = stack[stack.length - 1];
    if (top === 'template') {
      if (c === '\\') i += 2;
      else if (c === '`') {
        stack.pop();
        i += 1;
      } else if (c === '$' && code.charAt(i + 1) === '{') {
        stack.push('brace');
        i += 2;
      } else i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      i += 1;
      while (i < code.length && code.charAt(i) !== c && code.charAt(i) !== '\n') {
        i += code.charAt(i) === '\\' ? 2 : 1;
      }
      i += 1;
      continue;
    }
    if (c === '`') {
      stack.push('template');
      i += 1;
      continue;
    }
    if (c === '{') stack.push('brace');
    else if (c === '}') {
      stack.pop();
      if (stack.length === 0) return i;
    }
    i += 1;
  }
  return undefined;
}

/** The index of the `)` that closes the `(` at `open` (strings skipped), or undefined. */
function matchingParen(code: string, open: number): number | undefined {
  let depth = 0;
  let i = open;
  while (i < code.length) {
    const c = code.charAt(i);
    if (c === "'" || c === '"' || c === '`') {
      i += 1;
      while (i < code.length && code.charAt(i) !== c) i += code.charAt(i) === '\\' ? 2 : 1;
    } else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return undefined;
}

/** A brace-matched body: `bodyStart` is the `{`, `bodyEnd` the `}`. */
export interface BodySpan {
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

/** A method of a class: where its name is, its parameter parentheses and its brace-matched body. */
export interface MethodSpan extends BodySpan {
  readonly nameIndex: number;
  /** The `(` and the `)` of the parameter list. */
  readonly openParen: number;
  readonly closeParen: number;
}

/**
 * The index of the `{` that opens a body after `from` (generic angle brackets and `extends`/`implements` clauses are
 * skipped), or undefined when a `;` or a closing brace comes first.
 */
function bodyOpenAfter(code: string, from: number): number | undefined {
  let angle = 0;
  for (let i = from; i < code.length; i += 1) {
    const c = code.charAt(i);
    if (c === '<') angle += 1;
    else if (c === '>' && code.charAt(i - 1) !== '=') angle -= 1;
    else if (c === '{' && angle <= 0) return i;
    else if ((c === ';' || c === '}') && angle <= 0) return undefined;
  }
  return undefined;
}

/**
 * The brace-matched body of `class <className>` (modifiers `export`, `default` and `abstract` allowed), or undefined
 * when there is no such class with a body, or the braces do not balance. A class assigned to a variable
 * (`const X = class {`) is not found: the rule wants the declaration.
 */
export function findClassBody(code: string, className: string): BodySpan | undefined {
  const header = new RegExp(
    `(?:^|\\n)[ \\t]*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${escapeName(className)}(?![\\w$])`,
    'g',
  );
  for (const match of code.matchAll(header)) {
    const bodyStart = bodyOpenAfter(code, match.index + match[0].length);
    if (bodyStart === undefined) continue;
    const bodyEnd = matchingBrace(code, bodyStart);
    return bodyEnd === undefined ? undefined : { bodyStart, bodyEnd };
  }
  return undefined;
}

/**
 * The first method named `name` that has a body (an overload signature has none): a line that starts with
 * optional modifiers and the name and `(`, the parameters, an optional return type (generic angle brackets are
 * skipped, so `Promise<{ a: 1 }>` does not end the header), and a brace-matched body. A call at the start of a
 * statement (`guardLive(tx);`) has no body and is not a method. With `within` (the body of a class, from
 * findClassBody) only a method that starts inside it is looked at, so a second class in the file cannot supply the
 * wrapper. undefined when there is none, or the braces do not balance.
 */
export function findMethod(code: string, name: string, within?: BodySpan): MethodSpan | undefined {
  const header = new RegExp(
    `(?:^|\\n)[ \\t]*(?:(?:public|private|protected|static|async|override)\\s+)*(${escapeName(name)})\\s*(?:<[^>(]*>)?\\s*\\(`,
    'g',
  );
  for (const match of code.matchAll(header)) {
    if (within !== undefined && !(match.index > within.bodyStart && match.index < within.bodyEnd)) {
      continue;
    }
    const nameIndex = match.index + match[0].lastIndexOf(name);
    const open = match.index + match[0].length - 1;
    const close = matchingParen(code, open);
    if (close === undefined) continue;
    const bodyStart = bodyOpenAfter(code, close + 1);
    if (bodyStart === undefined) continue;
    const bodyEnd = matchingBrace(code, bodyStart);
    if (bodyEnd === undefined) return undefined;
    return { nameIndex, bodyStart, bodyEnd, openParen: open, closeParen: close };
  }
  return undefined;
}

const inside = (index: number, span: BodySpan): boolean =>
  index > span.bodyStart && index < span.bodyEnd;

// ---- imports of the cores ---------------------------------------------------------------------------------------------

interface LockImports {
  /** The source ranges of the import statements of database/session-locks. */
  readonly ranges: Array<[number, number]>;
  /** Per lock name, the local names it is imported as (`guardLive as core` gives `core`; no `as` gives `guardLive`). */
  readonly named: Map<LockName, string[]>;
  /** The names of `import * as ns from '.../session-locks'`. */
  readonly namespaces: string[];
  /**
   * The names that hold the whole core without an `import { } from` statement: `import x = require('...')`,
   * `const x = require('...')`, `const x = await import('...')` (also `let` and `var`).
   */
  readonly handles: string[];
  /**
   * How many specifiers of database/session-locks, in ANY form (specifiersOf: `from`, `import(`, `import '...'`,
   * `require(`, so a re-export and a side-effect import too), are not one of `ranges`.
   */
  readonly others: number;
}

const LOCKS_SPECIFIER = /(?:^|\/)session-locks(?:\.[mc]?[jt]s)?$/;

// import x = require('...'), and const|let|var x = require('...') / await import('...') / import('...').
const HANDLE_FORMS: readonly RegExp[] = [
  new RegExp(
    `\\bimport\\s+(?:type\\s+)?(${IDENT})\\s*=\\s*require\\s*\\(\\s*(['"\`])([^'"\`\\n]+)\\2\\s*\\)`,
    'g',
  ),
  new RegExp(
    `\\b(?:const|let|var)\\s+(${IDENT})(?:\\s*:[^=;]+)?\\s*=\\s*(?:await\\s+)?(?:require|import)\\s*\\(\\s*(['"\`])([^'"\`\\n]+)\\2\\s*\\)`,
    'g',
  ),
];

function parseLockImports(code: string): LockImports {
  const ranges: Array<[number, number]> = [];
  const named = new Map<LockName, string[]>();
  const namespaces: string[] = [];
  const handles: string[] = [];
  const statement = /import\s+(?:type\s+)?([^;]*?)\s+from\s*(['"`])([^'"`\n]+)\2\s*;?/g;
  for (const match of code.matchAll(statement)) {
    if (!LOCKS_SPECIFIER.test(match[3] as string)) continue;
    const start = match.index;
    ranges.push([start, start + match[0].length]);
    const clause = match[1] as string;
    const namespace = new RegExp(`\\*\\s*as\\s+(${IDENT})`).exec(clause);
    if (namespace !== null) namespaces.push(namespace[1] as string);
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces === null) continue;
    for (const part of (braces[1] as string).split(',')) {
      const spec = new RegExp(`^\\s*(?:type\\s+)?(${IDENT})(?:\\s+as\\s+(${IDENT}))?\\s*$`).exec(
        part,
      );
      if (spec === null) continue;
      const imported = spec[1] as string;
      if (!(LOCK_NAMES as readonly string[]).includes(imported)) continue;
      const list = named.get(imported as LockName) ?? [];
      list.push(spec[2] ?? imported);
      named.set(imported as LockName, list);
    }
  }
  for (const form of HANDLE_FORMS) {
    for (const match of code.matchAll(form)) {
      if (LOCKS_SPECIFIER.test(match[3] as string)) handles.push(match[1] as string);
    }
  }
  // Every other way to reach the module: counted from the specifiers, so a form this parser does not know still counts.
  const reached = specifiersOf(code).filter((specifier) => LOCKS_SPECIFIER.test(specifier)).length;
  return { ranges, named, namespaces, handles, others: Math.max(0, reached - ranges.length) };
}

const inRanges = (index: number, ranges: ReadonlyArray<[number, number]>): boolean =>
  ranges.some(([a, b]) => index >= a && index < b);

// ---- the per-file rules -------------------------------------------------------------------------------------------------

/** True when the text before `index` ends with a dot, whitespace and line breaks between the dot and the name allowed. */
const afterDot = (code: string, index: number): boolean =>
  /\.\s*$/.test(code.slice(Math.max(0, index - 64), index));

/** Mentions of `name` that are not after a dot (a method definition, a bare call, a reference). */
const bareMentions = (code: string, name: string): number[] =>
  indexesOf(code, new RegExp(`(?<![\\w$])${escapeName(name)}(?![\\w$])`)).filter(
    (index) => !afterDot(code, index),
  );

/** A mention that is `.name(` : a member call (whitespace after the dot is fine). */
const isMemberCall = (code: string, index: number, name: string): boolean =>
  afterDot(code, index) && /^\s*\(/.test(code.slice(index + name.length));

/** A mention that begins a method definition: only modifiers before it on its line, and `(` after it. */
function isDefinitionLike(code: string, index: number, name: string): boolean {
  const lineStart = code.lastIndexOf('\n', index - 1) + 1;
  const before = code.slice(lineStart, index);
  return (
    /^\s*(?:(?:public|private|protected|static|async|override)\s+)*$/.test(before) &&
    /^\s*(?:<[^>(]*>)?\s*\(/.test(code.slice(index + name.length))
  );
}

/** Every mention of a lock name in `code` that is not a member call: the files that only CALL the wrappers. */
function memberCallOnlyProblems(path: string, code: string, names: readonly LockName[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    for (const index of indexesOf(code, new RegExp(`(?<![\\w$])${escapeName(name)}(?![\\w$])`))) {
      if (!isMemberCall(code, index, name)) {
        out.push(`${path}: ${name} is used other than as a member call (this.state.${name}(...))`);
        break;
      }
    }
  }
  return out;
}

/** The `\.\s*name` occurrences in `code` with the index where the name ends: any receiver, `?.` included. */
function memberMentions(code: string, name: string): Array<{ index: number; end: number }> {
  return [...code.matchAll(new RegExp(`\\.\\s*${escapeName(name)}(?![\\w$])`, 'g'))].map((m) => ({
    index: m.index,
    end: m.index + m[0].length,
  }));
}

/** The member CALLS of `name` in `code`, with any receiver: `.name(`, `?.name(`, `self.name(`, `(x as T).name(`, `super.name(`. */
const memberCalls = (code: string, name: string): number[] =>
  memberMentions(code, name)
    .filter(({ end }) => /^\s*\(/.test(code.slice(end)))
    .map(({ index }) => index);

/**
 * The names of the parameters in a parameter list (the text between the parentheses), split at top-level commas
 * (angle brackets, parentheses, brackets and braces nest): `tx: SessionLockTx, sessionId: string` gives `tx`,
 * `sessionId`. undefined when a parameter is not a plain name (a destructuring pattern, a rest parameter).
 */
function parameterNames(list: string): string[] | undefined {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    const c = list.charAt(i);
    if ('([{<'.includes(c)) depth += 1;
    else if (')]}'.includes(c) || (c === '>' && list.charAt(i - 1) !== '=')) depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  const names: string[] = [];
  for (const part of parts) {
    if (part.trim() === '') continue; // a trailing comma
    const match = new RegExp(
      `^\\s*(?:(?:public|private|protected|readonly)\\s+)*(${IDENT})\\s*\\??\\s*(?::|=|$)`,
    ).exec(part);
    if (match === null) return undefined;
    names.push(match[1] as string);
  }
  return names;
}

/**
 * True when the whole body of the wrapper is `return <alias>(<param1>, <param2>);` (an optional `await`, any
 * whitespace, an optional trailing comma and semicolon): the wrapper takes exactly two plain parameters, hands both,
 * in order, to one of the core's aliases, and does nothing else (no assignment, no stored closure, no second statement).
 */
function isThinWrapper(code: string, wrapper: MethodSpan, aliases: readonly string[]): boolean {
  const params = parameterNames(code.slice(wrapper.openParen + 1, wrapper.closeParen));
  if (params === undefined || params.length !== 2) return false;
  const body = code.slice(wrapper.bodyStart + 1, wrapper.bodyEnd).trim();
  const alias = aliases.map(escapeName).join('|');
  const [first, second] = params.map(escapeName);
  return new RegExp(
    `^return\\s+(?:await\\s+)?(?:${alias})\\s*\\(\\s*${first}\\s*,\\s*${second}\\s*,?\\s*\\)\\s*;?$`,
  ).test(body);
}

/**
 * The lock names that `code` mentions anywhere, in any form (a call, a definition, a reference, a string or a log
 * message; the comments are already stripped): the test of the pre-switch-over state of a file.
 */
const namedLocks = (code: string): LockName[] =>
  LOCK_NAMES.filter((name) => new RegExp(`(?<![\\w$])${escapeName(name)}(?![\\w$])`).test(code));

/**
 * The SessionStateService file, in one of TWO states and no third:
 *   - it does NOT reach database/session-locks (no import statement of it, no require, no import()): the state of the
 *     file before Backend B's switch-over. It must then name no lock at all: no wrapper, no member call, no string;
 *   - it DOES reach it, by any form: it gets the full shape below, for all three locks, with nothing relaxed.
 *
 * The full shape: wrappers over the cores. Each core is imported by name under an alias, by an
 * `import { x as alias } from` statement and no other way (a namespace import would hand the whole core to the file, and
 * a `require(`, `import(` or `import x = require` is a way round the parsed imports), and called exactly once, inside its
 * own wrapper, a method of the SessionStateService class whose whole body is `return <alias>(<param1>, <param2>);`. The
 * wrappers are called from the file with ANY receiver: `.guardLive(` exactly once, inside `proctorResume`;
 * `.lockAnySession(`, `.lockForAccommodation(` and `.proctorResume(` never.
 */
export function stateFileProblems(path: string, code: string): string[] {
  const out: string[] = [];
  const imports = parseLockImports(code);
  if (imports.ranges.length === 0 && imports.others === 0) {
    return namedLocks(code).map(
      (name) =>
        `${path}: ${name} is named in a state file that does not import database/session-locks: a file with no import names no lock at all (no wrapper, no member call, no string); one with the import needs the full wrapper shape`,
    );
  }
  const names = LOCK_NAMES;
  if (imports.namespaces.length > 0) {
    out.push(
      `${path}: a namespace import of database/session-locks is refused: import the locks by name, each under an alias`,
    );
  }
  if (imports.others > 0) {
    out.push(
      `${path}: database/session-locks is reached other than by an import { name as alias } from statement (a require, import(), import x = require, a side-effect import or a re-export): refused`,
    );
  }
  const stateClass = findClassBody(code, SESSION_STATE_CLASS);
  if (stateClass === undefined) {
    out.push(`${path}: no class ${SESSION_STATE_CLASS} with a body found`);
  }
  for (const name of names) {
    const wrapper = findMethod(code, name, stateClass);
    if (wrapper === undefined) {
      out.push(`${path}: no wrapper method ${name} with a body found`);
    }
    const locals = imports.named.get(name) ?? [];
    if (locals.includes(name)) {
      out.push(
        `${path}: the core ${name} is imported under its own name: import it under an alias (${name} as core...)`,
      );
    }
    const aliases = locals.filter((local) => local !== name);
    if (aliases.length === 0) {
      out.push(
        `${path}: the core ${name} is not imported from database/session-locks under an alias`,
      );
      continue;
    }
    // The only call of the core: exactly one, inside the wrapper method of the same name.
    const calls: number[] = [];
    for (const alias of aliases) {
      calls.push(...indexesOf(code, new RegExp(`(?<![.\\w$])${escapeName(alias)}\\s*\\(`)));
    }
    if (calls.length !== 1) {
      out.push(
        `${path}: the core ${name} is called ${calls.length} times, exactly one call is allowed, inside the ${name} wrapper`,
      );
    } else if (wrapper !== undefined && !inside(calls[0] as number, wrapper)) {
      out.push(`${path}: the core ${name} is called outside the ${name} wrapper method`);
    } else if (wrapper !== undefined && !isThinWrapper(code, wrapper, aliases)) {
      out.push(
        `${path}: the ${name} wrapper is not exactly "return <alias>(<param1>, <param2>);": a thin wrapper holds nothing else`,
      );
    }
    // The alias is used nowhere else: not passed, returned, assigned or kept as a property.
    for (const alias of aliases) {
      for (const index of bareMentions(code, alias)) {
        const isCall = calls.includes(index);
        if (!isCall && !inRanges(index, imports.ranges)) {
          out.push(
            `${path}: the alias ${alias} of ${name} is used other than as its single call inside the wrapper`,
          );
          break;
        }
      }
    }
    // Every other mention of the lock name is the wrapper's definition or a member call.
    for (const index of bareMentions(code, name)) {
      if (!inRanges(index, imports.ranges) && !isDefinitionLike(code, index, name)) {
        out.push(
          `${path}: ${name} is mentioned other than as its wrapper definition or a member call`,
        );
        break;
      }
    }
    // A property reference that is not a call (`.guardLive.bind(this)`, `.guardLive?.(tx)`): whitespace after the dot is fine.
    for (const { end } of memberMentions(code, name)) {
      if (!/^\s*\(/.test(code.slice(end))) {
        out.push(`${path}: ${name} is referenced as a property, not called`);
        break;
      }
    }
    // Member calls of the wrappers inside the file, with ANY receiver.
    if (name !== 'guardLive') {
      const inFile = memberCalls(code, name);
      if (inFile.length > 0) {
        out.push(
          `${path}: ${inFile.length} .${name}( member calls in the state file (any receiver), none are allowed`,
        );
      }
    }
  }
  if (names.includes('guardLive')) {
    const resume = findMethod(code, 'proctorResume', stateClass);
    const calls = memberCalls(code, 'guardLive');
    if (resume === undefined) out.push(`${path}: no proctorResume method with a body found`);
    if (calls.length !== 1) {
      out.push(
        `${path}: ${calls.length} .guardLive( member calls (any receiver), exactly one is allowed, inside proctorResume`,
      );
    } else if (resume !== undefined && !inside(calls[0] as number, resume)) {
      out.push(`${path}: the .guardLive( call is not inside proctorResume`);
    }
    // proctorResume is the one door to guardLive: nothing in the file may call it (a call, an optional call, .call, .apply, .bind).
    const resumeCalls = memberMentions(code, 'proctorResume').filter(({ end }) =>
      /^\s*(?:\(|\?\.\s*\(|\.\s*(?:call|apply|bind)\b)/.test(code.slice(end)),
    );
    if (resumeCalls.length > 0) {
      out.push(
        `${path}: ${resumeCalls.length} .proctorResume( member calls in the state file (any receiver), none are allowed: the controller calls it from outside the file`,
      );
    }
  }
  return [...new Set(out)];
}

/**
 * The SessionJobProcessor file, in one of TWO states and no third: it names no lock at all (the state before Backend B's
 * switch-over), or it has the full shape: `.guardLive(` exactly once, inside `withLiveSession`; `.lockAnySession(`
 * exactly once, inside `withAnySession`; every mention of a lock name a member call. One lock named is the full shape
 * for both. The processor never imports the core: the import guard allows only the state file.
 */
export function processorFileProblems(path: string, code: string): string[] {
  if (namedLocks(code).length === 0) return [];
  const out: string[] = [];
  const entries: Array<[LockName, string]> = [
    ['guardLive', 'withLiveSession'],
    ['lockAnySession', 'withAnySession'],
  ];
  for (const [name, method] of entries) {
    const span = findMethod(code, method);
    const calls = indexesOf(code, new RegExp(`\\.\\s*${name}\\s*\\(`));
    if (span === undefined) out.push(`${path}: no ${method} method with a body found`);
    if (calls.length !== 1) {
      out.push(
        `${path}: ${calls.length} .${name}( calls, exactly one is allowed, inside ${method}`,
      );
    } else if (span !== undefined && !inside(calls[0] as number, span)) {
      out.push(`${path}: the .${name}( call is not inside ${method}`);
    }
  }
  out.push(...memberCallOnlyProblems(path, code, LOCK_NAMES));
  return out;
}

// ---- the list rules -------------------------------------------------------------------------------------------------------

const hasWord = (text: string, word: string): boolean => new RegExp(word).test(text);

/**
 * The problems with the allowlist of the import-guard rule for `database/session-locks`: it may hold only the
 * SessionStateService file (a subset: empty is fine until Backend B adds it).
 */
export function lockImportProblems(allowed: readonly string[]): string[] {
  return allowed
    .filter((path) => !LOCK_IMPORT_ALLOWED_FILES.includes(path))
    .map((path) => `${path}: only ${SESSION_STATE_FILE} may import database/session-locks`)
    .sort();
}

/**
 * The problems with the entries of `list` that name a lock (FU-DB-67), as readable lines, sorted. Empty when the list
 * obeys every rule. Outside `database/`:
 *   - a lock may be listed only for the files of LOCK_ALLOWED_FILES (guardLive and lockAnySession: the
 *     SessionStateService and SessionJobProcessor files; lockForAccommodation: SessionStateService, the accommodation
 *     writers and the retention repository); inside `database/`, only `database/session-locks.ts` names a lock;
 *   - the `why` of an entry names its callers: guardLive `withLiveSession` (processor) and `proctorResume` (state);
 *     lockAnySession `withAnySession`; lockForAccommodation the accommodation writer and one of PATCH, redact-note,
 *     video-check (state and accommodations) or the erasure, R-4 and R-10 jobs (retention);
 *   - with `files` (the sources by path), the state and processor files obey their per-file rules whenever they exist,
 *     listed or not (stateFileProblems, processorFileProblems: each in its two states, no lock named or the full
 *     shape), and each listed accommodation or retention file that exists has member calls only.
 * Database B adds the retention entry in its own PR, not before (the stale-entry check fails while the call does not exist).
 */
export function lockCallSiteProblems(
  list: CallSiteList,
  files: readonly SourceFile[] = [],
): string[] {
  const out: string[] = [];
  const entries = Object.entries(list).filter(([path]) => path !== 'database/session-locks.ts');
  const textOf = (path: string): string | undefined => {
    const file = files.find((f) => f.path === path);
    return file === undefined ? undefined : stripComments(file.text);
  };
  for (const [path, entry] of entries) {
    const locks = LOCK_NAMES.filter((name) => entry.names.includes(name));
    if (locks.length === 0) continue;
    if (path.startsWith('database/')) {
      out.push(`${path}: only database/session-locks.ts may name a session lock inside database/`);
      continue;
    }
    for (const name of locks) {
      if (!LOCK_ALLOWED_FILES[name].includes(path)) {
        out.push(
          `${path}: not an allowed ${name} call site (allowed: ${LOCK_ALLOWED_FILES[name].join(', ')})`,
        );
      }
    }
    // The why of an entry names what its file does with each lock.
    if (locks.includes('guardLive')) {
      if (path === SESSION_STATE_FILE && !hasWord(entry.why, 'proctorResume')) {
        out.push(`${path}: a guardLive entry's why must name proctorResume`);
      }
      if (path === SESSION_PROCESSOR_FILE && !hasWord(entry.why, 'withLiveSession')) {
        out.push(`${path}: a guardLive entry's why must name withLiveSession`);
      }
    }
    if (locks.includes('lockAnySession') && !hasWord(entry.why, 'withAnySession')) {
      out.push(`${path}: a lockAnySession entry's why must name withAnySession`);
    }
    if (locks.includes('lockForAccommodation')) {
      if (path === RETENTION_LOCK_FILE) {
        for (const word of ['erasure', 'R-4', 'R-10']) {
          if (!hasWord(entry.why, word)) {
            out.push(
              `${path}: a retention lockForAccommodation entry's why must name the ${word} job`,
            );
          }
        }
      } else if (
        !hasWord(entry.why, 'ccommodation') ||
        !hasWord(entry.why, 'PATCH|redact-note|video-check')
      ) {
        out.push(
          `${path}: a lockForAccommodation entry's why must name the accommodation writer and one of PATCH, redact-note, video-check`,
        );
      }
    }
    // The per-file rules of the other listed files, when they exist (the state and processor files are checked below).
    const code = textOf(path);
    if (code === undefined || path === SESSION_STATE_FILE || path === SESSION_PROCESSOR_FILE)
      continue;
    out.push(...memberCallOnlyProblems(path, code, LOCK_NAMES));
  }
  // The state and processor files are checked whenever they exist, listed or not, in their two states (no lock named, or
  // the full shape): a file that is missing from `files` gives nothing here (the stale-entry check fails a listed one), and
  // the same entry with the file present obeys the rules, so a file that appears later is never passed vacuously.
  const stateCode = textOf(SESSION_STATE_FILE);
  if (stateCode !== undefined) out.push(...stateFileProblems(SESSION_STATE_FILE, stateCode));
  const processorCode = textOf(SESSION_PROCESSOR_FILE);
  if (processorCode !== undefined) {
    out.push(...processorFileProblems(SESSION_PROCESSOR_FILE, processorCode));
  }
  return [...new Set(out)].sort();
}

// ---- exports -------------------------------------------------------------------------------------------------------------------

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
    // export = guardLive, export = { guardLive } (TypeScript's CommonJS export)
    new RegExp(`\\bexport\\s*=\\s*(?:${n}\\b|[{\\[][^{}\\[\\]]*\\b${n}\\b)`),
  ];
}

/**
 * The text of each exported function, arrow or variable (a top-level `export function`, `export const` or
 * `export default`): from its line to the next line that starts in column 0 with something other than a closing
 * bracket (prettier indents every body). A class is not one: its methods are the wrappers.
 */
function exportedRegions(code: string): Array<{ text: string; declared: string | undefined }> {
  const lines = code.split('\n');
  const regions: Array<{ text: string; declared: string | undefined }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const header = new RegExp(
      `^export\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\s*\\*?\\s*(${IDENT})?|(?:const|let|var)\\s+(${IDENT})|\\(|\\{)`,
    ).exec(line);
    if (header === null) continue;
    let end = i + 1;
    while (end < lines.length && !/^\S/.test(lines[end] as string)) end += 1;
    // a closing line (`}`, `);`) belongs to the region
    if (end < lines.length && /^[})\]]/.test(lines[end] as string)) end += 1;
    const declared = header[1] ?? header[2];
    // The declared name of the function is not a call of itself: it is replaced by a placeholder in the header.
    const first =
      declared === undefined ? line : line.replace(header[0], header[0].replace(declared, '~'));
    regions.push({ text: [first, ...lines.slice(i + 1, end)].join('\n'), declared });
  }
  return regions;
}

/**
 * The files that EXPORT a lock name, or an alias of one, other than through `export ... from` (reexportsOf and
 * the import guard catch that), and the files that export or hold a WRAPPER of one under a new name:
 *   - `export { guardLive as g }`, `export const g = guardLive`, `export default guardLive`,
 *     `export default { guardLive }`, `export function guardLive() {}`, `module.exports = { guardLive }`,
 *     `export = { guardLive }`, and the same through a local alias (`exports <name>`);
 *   - the whole core under one name, which is refused whatever is done with it: `import * as core from ...`, and the
 *     handle of `import core = require(...)`, `const core = require(...)` or `const core = await import(...)`
 *     (`imports database/session-locks as a namespace`; the name is an alias like the others);
 *   - any other way to reach the module than an `import { name } from` statement (a `require(`, an `import(`, a
 *     side-effect import, `export * from`), counted from the specifiers (specifiersOf), so a file that only reaches the
 *     module and names no lock is not skipped (`reaches database/session-locks other than by an import { name } from
 *     statement`);
 *   - an exported function, arrow or variable whose text calls a lock or an alias, such as
 *     `export function g(tx, s) { return guardLive(tx, s) }` or `export const g = (tx, s) => core(tx, s)`
 *     (`exports a wrapper of <name>`);
 *   - a static property that holds or calls a lock or an alias, such as `static g = guardLive` or
 *     `static g = (tx, s) => guardLive(tx, s)` (`has a static property that wraps <name>`).
 * A class that merely has a METHOD with the name (`export class SessionStateService { async guardLive() {} }`) is
 * none of these, and is not found. Pass the files OUTSIDE `database/`: no file there may export a lock or a wrapper,
 * the SessionStateService file included. It has no allowlist, on purpose. Lines are sorted.
 */
export function findLockExports(
  files: readonly SourceFile[],
  names: readonly string[] = LOCK_NAMES,
): string[] {
  const out: string[] = [];
  for (const file of files) {
    const code = stripComments(file.text);
    const imports = parseLockImports(code);
    // Any specifier of the module, in any form (specifiersOf): a file that only `require(`s or `import(`s it is not skipped.
    const reachesTheCore = imports.ranges.length > 0 || imports.others > 0;
    if (
      !reachesTheCore &&
      !names.some((name) => new RegExp(`\\b${escapeName(name)}\\b`).test(code))
    ) {
      continue;
    }
    // A namespace import, or a handle from `import x = require(...)`, `const x = require(...)` or `await import(...)`, is
    // the whole core under one name: refused, and its name is an alias like the others.
    const wholeCore = [...imports.namespaces, ...imports.handles];
    const aliases = aliasesOf(code, [...names, ...wholeCore]);
    const found = new Set<string>();
    if (wholeCore.length > 0) found.add('imports database/session-locks as a namespace');
    if (imports.others > 0) {
      found.add('reaches database/session-locks other than by an import { name } from statement');
    }
    for (const alias of aliases) {
      if (exportForms(alias).some((form) => form.test(code))) found.add(`exports ${alias}`);
    }
    for (const region of exportedRegions(code)) {
      for (const alias of aliases) {
        const call = new RegExp(`(?<![.\\w$])${escapeName(alias)}\\s*\\(`);
        if (call.test(region.text)) found.add(`exports a wrapper of ${alias}`);
      }
    }
    for (const alias of aliases) {
      const staticProperty = new RegExp(
        `\\bstatic\\s+(?:readonly\\s+)?${IDENT}\\s*(?::[^=;]+)?=[^;]*(?<![.\\w$])${escapeName(alias)}(?![\\w$])`,
      );
      if (staticProperty.test(code)) found.add(`has a static property that wraps ${alias}`);
    }
    for (const what of found) out.push(`${file.path}: ${what}`);
  }
  return out.sort();
}
