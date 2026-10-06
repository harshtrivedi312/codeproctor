// Who may use, wrap and export the per-session write locks (database/session-locks.ts), as mechanical rules for the
// FU-DB-67 call-site test (call-sites.spec.ts reads the real tree with them, lock-call-sites.spec.ts pins every rule on
// synthetic files). The hub's rulings (#205, #211, #213) and the re-reviews of #208 fix three layers:
//
//   1. WHICH FILES. Only the SessionStateService file imports `database/session-locks` (import guard). Outside
//      `database/`, a lock may be named only in the files of LOCK_ALLOWED_FILES: guardLive and lockAnySession in the
//      SessionStateService and SessionJobProcessor files, lockForAccommodation in the SessionStateService, accommodation
//      writers and retention repository files. The paths are Backend B's real ones (#98, #206) and Database B's.
//   2. WHAT EACH FILE MAY DO (checked when the file exists, text rules over the comment-stripped source):
//      - SESSION_STATE_FILE: each core is imported by NAME under an alias (never as a namespace) and called exactly
//        once, inside the wrapper METHOD of the same name; the alias is used nowhere else; every other mention of a lock
//        name is the wrapper's definition or a member call. Member calls of the wrappers inside the file are counted
//        with ANY receiver (`this.`, `self.`, `this?.`, `(this as X).`, `super.`): exactly ONE `.guardLive(` call, inside
//        the brace-matched `proctorResume` body, and ZERO `.lockAnySession(` and `.lockForAccommodation(` calls (the
//        accommodation routes call the last from session/accommodations.ts, the jobs call the first from the processor).
//      - SESSION_PROCESSOR_FILE: `.guardLive(` exactly once, inside `withLiveSession`; `.lockAnySession(` exactly once,
//        inside `withAnySession`; every mention of a lock name is a member call.
//      - the accommodation and retention files: every mention of a lock name is a member call.
//   3. NO EXPORT. No file outside `database/` exports a lock, an alias of one, or a function or static property that
//      wraps one under a new name (findLockExports). There is no allowlist: the SessionStateService file is checked too.
//
// All of it is a TEXT scan after the comments are stripped (stripComments): a name built at run time, a string that spells
// a call, or code that is not formatted as the repository's prettier formats it can be missed or can fail the other way.
// A doubt costs an extra finding, never a missed one, wherever the scan can tell. LIMITS, so a reviewer does not rely on
// more than this: `matchingBrace` and `findMethod` skip strings and templates but NOT regex literals (a quote inside a
// regex literal can unbalance a body: the caller then reports "no wrapper found" or a count, never a pass); the
// exported-function check works on lines (it assumes prettier's column-0 layout); a lock reached through a computed
// property or an eval is not seen. The rules are documented for Backend B and Database B in
// apps/api/src/database/README.md ("Who calls what").
import { stripComments } from './call-site-guard';
import type { CallSiteList } from './call-site-guard';
import type { SourceFile } from './import-guard';

/** The three lock names (a subset of GUARDED_NAMES). */
export const LOCK_NAMES = ['guardLive', 'lockForAccommodation', 'lockAnySession'] as const;
export type LockName = (typeof LOCK_NAMES)[number];

/** SessionStateService (Backend B, #98 and #206): the wrappers; the only file that imports the cores. */
export const SESSION_STATE_FILE = 'session/session-state.service.ts';
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
  import: `only ${SESSION_STATE_FILE} imports database/session-locks`,
  guardLive:
    `${SESSION_PROCESSOR_FILE} (withLiveSession, exactly one .guardLive( call) and ${SESSION_STATE_FILE} ` +
    'with the single STAFF method proctorResume (exactly one .guardLive( call with any receiver, inside proctorResume)',
  lockAnySession:
    `${SESSION_PROCESSOR_FILE} (withAnySession, exactly one .lockAnySession( call) and ${SESSION_STATE_FILE} ` +
    '(the wrapper only: no member call of it in that file); each why naming withAnySession',
  lockForAccommodation:
    `the STAFF accommodation routes (${ACCOMMODATIONS_FILE} and ${SESSION_STATE_FILE}: PATCH, redact-note, ` +
    `video-check PUT) and one org-job file, ${RETENTION_LOCK_FILE} (RetentionRepository.casAccommodations in a ` +
    'plain runInOrg: the erasure, R-4 and R-10 jobs)',
  stateFile:
    'each core imported by name under an alias (no namespace import) and called exactly once, inside the wrapper ' +
    'method of the same name, nowhere else; member calls counted with any receiver: one .guardLive( call, inside ' +
    'proctorResume, and no .lockAnySession( or .lockForAccommodation( call',
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

/** A method of a class: where its name is and where its brace-matched body is (`bodyStart` is the `{`). */
export interface MethodSpan {
  readonly nameIndex: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

/**
 * The first method named `name` that has a body (an overload signature has none): a line that starts with
 * optional modifiers and the name and `(`, the parameters, an optional return type (generic angle brackets are
 * skipped, so `Promise<{ a: 1 }>` does not end the header), and a brace-matched body. A call at the start of a
 * statement (`guardLive(tx);`) has no body and is not a method. undefined when there is none, or the braces do not
 * balance.
 */
export function findMethod(code: string, name: string): MethodSpan | undefined {
  const header = new RegExp(
    `(?:^|\\n)[ \\t]*(?:(?:public|private|protected|static|async|override)\\s+)*(${escapeName(name)})\\s*(?:<[^>(]*>)?\\s*\\(`,
    'g',
  );
  for (const match of code.matchAll(header)) {
    const nameIndex = match.index + match[0].lastIndexOf(name);
    const open = match.index + match[0].length - 1;
    const close = matchingParen(code, open);
    if (close === undefined) continue;
    let angle = 0;
    let bodyStart: number | undefined;
    for (let i = close + 1; i < code.length; i += 1) {
      const c = code.charAt(i);
      if (c === '<') angle += 1;
      else if (c === '>' && code.charAt(i - 1) !== '=') angle -= 1;
      else if (c === '{' && angle <= 0) {
        bodyStart = i;
        break;
      } else if ((c === ';' || c === '}') && angle <= 0) break;
    }
    if (bodyStart === undefined) continue;
    const bodyEnd = matchingBrace(code, bodyStart);
    if (bodyEnd === undefined) return undefined;
    return { nameIndex, bodyStart, bodyEnd };
  }
  return undefined;
}

const inside = (index: number, span: MethodSpan): boolean =>
  index > span.bodyStart && index < span.bodyEnd;

// ---- imports of the cores ---------------------------------------------------------------------------------------------

interface LockImports {
  /** The source ranges of the import statements of database/session-locks. */
  readonly ranges: Array<[number, number]>;
  /** Per lock name, the local names it is imported as (`guardLive as core` gives `core`; no `as` gives `guardLive`). */
  readonly named: Map<LockName, string[]>;
  /** The names of `import * as ns from '.../session-locks'`. */
  readonly namespaces: string[];
}

const LOCKS_SPECIFIER = /(?:^|\/)session-locks(?:\.[mc]?[jt]s)?$/;

function parseLockImports(code: string): LockImports {
  const ranges: Array<[number, number]> = [];
  const named = new Map<LockName, string[]>();
  const namespaces: string[] = [];
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
  return { ranges, named, namespaces };
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
 * The SessionStateService file: wrappers over the cores. Each core is imported by name under an alias (a namespace
 * import is refused: it would hand the whole core to the file) and called exactly once, inside its own wrapper. The
 * wrappers are called from the file with ANY receiver: `.guardLive(` exactly once, inside `proctorResume`;
 * `.lockAnySession(` and `.lockForAccommodation(` never.
 */
export function stateFileProblems(
  path: string,
  code: string,
  names: readonly LockName[],
): string[] {
  const out: string[] = [];
  const imports = parseLockImports(code);
  if (imports.namespaces.length > 0) {
    out.push(
      `${path}: a namespace import of database/session-locks is refused: import the locks by name, each under an alias`,
    );
  }
  for (const name of names) {
    const wrapper = findMethod(code, name);
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
    const resume = findMethod(code, 'proctorResume');
    const calls = memberCalls(code, 'guardLive');
    if (resume === undefined) out.push(`${path}: no proctorResume method with a body found`);
    if (calls.length !== 1) {
      out.push(
        `${path}: ${calls.length} .guardLive( member calls (any receiver), exactly one is allowed, inside proctorResume`,
      );
    } else if (resume !== undefined && !inside(calls[0] as number, resume)) {
      out.push(`${path}: the .guardLive( call is not inside proctorResume`);
    }
  }
  return [...new Set(out)];
}

/** The SessionJobProcessor file: `.guardLive(` only in withLiveSession, `.lockAnySession(` only in withAnySession. */
export function processorFileProblems(
  path: string,
  code: string,
  names: readonly LockName[],
): string[] {
  const out: string[] = [];
  const entries: Array<[LockName, string]> = [
    ['guardLive', 'withLiveSession'],
    ['lockAnySession', 'withAnySession'],
  ];
  for (const [name, method] of entries) {
    if (!names.includes(name)) continue;
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
 *   - with `files` (the sources by path), each listed file that exists obeys its per-file rules: stateFileProblems,
 *     processorFileProblems, and for the accommodation and retention files member calls only.
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
    // The per-file rules, for the files that exist.
    const code = textOf(path);
    if (code === undefined) continue;
    if (path === SESSION_STATE_FILE) out.push(...stateFileProblems(path, code, locks));
    else if (path === SESSION_PROCESSOR_FILE) out.push(...processorFileProblems(path, code, locks));
    else out.push(...memberCallOnlyProblems(path, code, LOCK_NAMES));
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
 *     `export default { guardLive }`, `export function guardLive() {}`, `module.exports = { guardLive }`, and the same
 *     through a local alias (`exports <name>`);
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
    const importsTheCore = imports.ranges.length > 0;
    if (
      !importsTheCore &&
      !names.some((name) => new RegExp(`\\b${escapeName(name)}\\b`).test(code))
    ) {
      continue;
    }
    // A namespace import is the whole core under one name: refused, and its name is an alias like the others.
    const aliases = aliasesOf(code, [...names, ...imports.namespaces]);
    const found = new Set<string>();
    if (imports.namespaces.length > 0) found.add('imports database/session-locks as a namespace');
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
