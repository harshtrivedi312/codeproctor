// The first slice of the FU-DB-67 call-site test (review of #185, S1; PR 3 widens it). CS-4.4 says the grant
// API is private, and TypeScript cannot hide a method of an injected class, so this scan pins every USE of
//   - `withGrant` (the eleven CS-4.4 grant sites),
//   - `claimCandidateFactsSetter` (the claim-once closure of the candidate-facts setter),
//   - `setCandidateFacts` (CandidateSessionGuard only),
//   - `detachForSessionJob` (the SessionJobProcessor base class only),
// to an explicit per-file allowlist (CALL_SITES below). It reads every non-test file under apps/api/src
// (*.spec.ts, *.e2e-spec.ts and their .js forms, src/test, src/database/testing and src/generated are not
// scanned), with the extensions .ts, .mts, .cts, .js, .mjs and .cjs, and FAILS on any other file extension it
// does not know to be a non-source file. A use is a call, a definition, a member access, a bracket access or an
// exact string, or the name inside braces (an import, a re-export, a destructuring); a mention in a comment or
// in prose is not one (testing/call-site-guard.ts says how, and why it is fail-safe).
//
// TODAY the list holds the database folder's own definitions and nothing else: BE-07's guard,
// SessionJobProcessor and the grant-site services are NOT allowed yet. A new call site must be added to
// CALL_SITES in the same PR, which is the review point; for `withGrant` the entry names the CS-4.4 grant
// site(s) the file holds, one `GRANT_SITES` name per site.
//
// HARD GATE for PR 3, before the first BE-07 grant site merges (FU-DB-189, FU-DB-190): this guard pins FILES,
// not GRANTS. An allowlisted file could call `withGrant` with the wrong model or columns, or forward a request
// that a parameter carries. PR 3 adds an AST check: each `withGrant(` in a listed file takes an object literal
// whose `model` and `columns` literals match that file's declared `sites`, and no function forwards a
// parameter as the request. Known misses of this text scan until then: a name built at run time, a unicode
// escape in the identifier, `require` of the compiled file, `moduleRef.get`. NFR-04, TC-008.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import {
  findCallSiteViolations,
  findStaleEntries,
  GUARDED_NAMES,
  importersOf,
  stripComments,
  usesOf,
} from './testing/call-site-guard';
import type { CallSiteList } from './testing/call-site-guard';
import type { SourceFile } from './testing/import-guard';
import { GRANT_SITES } from './session-scope-map';

const SRC = resolve(__dirname, '..');

/**
 * Every file that may use a guarded name. Explicit paths, never folders. BE-07 adds ONE ENTRY PER FILE, with
 * `sites` naming the GRANT_SITES it holds, in the PR that builds it:
 *   'common/candidate/candidate-session.guard.ts':   { names: ['setCandidateFacts'], why: 'CandidateSessionGuard (DL-31)' },
 *   'jobs/session-job.processor.ts':                 { names: ['detachForSessionJob'], why: 'SessionJobProcessor base class' },
 *   'candidate/session-state.service.ts':            { names: ['withGrant'], sites: ['SessionStateService'], why: '…' },
 */
export const CALL_SITES: CallSiteList = {
  'database/org-context.ts': {
    names: ['withGrant', 'claimCandidateFactsSetter', 'detachForSessionJob'],
    why: 'defines them: the grant entry, the claim-once setter closure and the session detach',
  },
  'database/candidate-facts.ts': {
    names: ['claimCandidateFactsSetter', 'setCandidateFacts'],
    why: 'claims the setter once per process and exports setCandidateFacts for CandidateSessionGuard',
  },
};

/** The source extensions that are scanned. */
const SCANNED_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'] as const;
/** Extensions under src that are known not to be source. Any other extension fails the scan test. */
const NON_SOURCE_EXTENSIONS = ['.md'] as const;

function isTestFile(path: string): boolean {
  return (
    /\.(spec|e2e-spec)\.(ts|mts|cts|js|mjs|cjs)$/.test(path) ||
    path.startsWith('test/') ||
    path.startsWith('database/testing/') ||
    path.startsWith('generated/')
  );
}

/** Every file under `dir`, as a path relative to src. */
function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory()
      ? listFiles(full)
      : [relative(SRC, full).split(sep).join('/')];
  });
}

function readSource(): SourceFile[] {
  return listFiles(SRC)
    .filter(
      (path) =>
        (SCANNED_EXTENSIONS as readonly string[]).includes(extname(path)) && !isTestFile(path),
    )
    .map((path) => ({ path, text: readFileSync(join(SRC, path), 'utf8') }));
}

describe('call-site guard: the private entries of the database layer (FU-DB-67 slice, #185 S1; NFR-04, TC-008)', () => {
  const files = readSource();

  it('TC-008 the scan reads the real source, so an empty scan cannot pass', () => {
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining(['database/org-context.ts', 'auth/auth.service.ts', 'app.module.ts']),
    );
    expect(paths).not.toContain('database/call-sites.spec.ts');
    expect(paths.some((p) => p.startsWith('generated/') || p.startsWith('test/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('database/testing/'))).toBe(false);
  });

  it('TC-008 every file under src has a scanned source extension or a known non-source one: another source extension fails here instead of being skipped', () => {
    const unknown = listFiles(SRC).filter((path) => {
      const ext = extname(path);
      return (
        !(SCANNED_EXTENSIONS as readonly string[]).includes(ext) &&
        !(NON_SOURCE_EXTENSIONS as readonly string[]).includes(ext)
      );
    });
    expect(unknown).toEqual([]);
  });

  it('TC-008 the extension rules: .ts .mts .cts .js .mjs .cjs are scanned (a spec of any of them is not), .tsx and the rest are unknown', () => {
    for (const ext of ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']) {
      expect(SCANNED_EXTENSIONS as readonly string[]).toContain(ext);
      expect(isTestFile(`x/a.spec${ext}`)).toBe(true);
      expect(isTestFile(`x/a.e2e-spec${ext}`)).toBe(true);
      expect(isTestFile(`x/a${ext}`)).toBe(false);
    }
    for (const ext of ['.tsx', '.jsx', '.vue', '.coffee', '.json']) {
      expect(SCANNED_EXTENSIONS as readonly string[]).not.toContain(ext);
      expect(NON_SOURCE_EXTENSIONS as readonly string[]).not.toContain(ext);
    }
  });

  it('TC-008 the four names are the ones CS-4.4 and ADR 0006 section 8.5 call private', () => {
    expect([...GUARDED_NAMES]).toEqual([
      'withGrant',
      'claimCandidateFactsSetter',
      'setCandidateFacts',
      'detachForSessionJob',
    ]);
  });

  it('TC-008 only the listed files use withGrant, claimCandidateFactsSetter, setCandidateFacts or detachForSessionJob', () => {
    expect(findCallSiteViolations(files, CALL_SITES)).toEqual([]);
  });

  it('TC-008 every listed file exists and still uses every name it is allowed (a stale entry would widen the list)', () => {
    expect(findStaleEntries(files, CALL_SITES)).toEqual([]);
  });

  it('TC-008 today the list holds the two database files that define the private entries, and nothing else: BE-07 sites are not allowed yet', () => {
    expect(Object.keys(CALL_SITES).sort()).toEqual([
      'database/candidate-facts.ts',
      'database/org-context.ts',
    ]);
    // The grant sites are not allowed anywhere yet: no entry names one.
    expect(Object.values(CALL_SITES).some((entry) => entry.sites !== undefined)).toBe(false);
  });

  it('TC-008 database files that only MENTION a name in a comment need no entry: org-scope.extension.ts, candidate-interim.ts and index.ts name withGrant in comments', () => {
    for (const path of [
      'database/org-scope.extension.ts',
      'database/candidate-interim.ts',
      'database/index.ts',
    ]) {
      const file = files.find((f) => f.path === path);
      expect(file).toBeDefined();
      expect(/\bwithGrant\b/.test(file?.text ?? '')).toBe(true); // the word is there, in a comment
      expect(usesOf(file?.text ?? '')).toEqual([]); // and it is not a use
    }
  });

  it('TC-008 the comment stripper completes on every real source file (the fail-safe fallback is not silently in use): a file with comments comes back with them removed', () => {
    const gaveUp = files
      .filter((f) => /^\s*(\/\/|\/\*|\*)/m.test(f.text))
      .filter((f) => stripComments(f.text) === f.text)
      .map((f) => f.path);
    expect(gaveUp).toEqual([]);
  });

  it('TC-008 an entry outside the database folder that allows withGrant names the CS-4.4 grant sites it holds, each a real GRANT_SITES name', () => {
    const real = new Set(GRANT_SITES.map((site) => site.name));
    for (const [path, entry] of Object.entries(CALL_SITES)) {
      if (!path.startsWith('database/') && entry.names.includes('withGrant')) {
        expect({ path, sites: entry.sites?.length ?? 0 }).not.toEqual({ path, sites: 0 });
      }
      for (const site of entry.sites ?? []) {
        expect({ path, site, real: real.has(site) }).toEqual({ path, site, real: true });
      }
    }
  });

  it('TC-008 the candidate-facts module is imported only by the database module (side effect) and, with BE-07, the guard', () => {
    expect(importersOf(files, 'database/candidate-facts')).toEqual(['database/database.module.ts']);
  });

  it('TC-008 no file outside the database folder uses any of the four names (a service injecting OrgContextService does not call them)', () => {
    const outside = files.filter((file) => !file.path.startsWith('database/'));
    expect(outside.length).toBeGreaterThan(20);
    expect(findCallSiteViolations(outside, {})).toEqual([]);
  });
});

describe('call-site guard patterns (NFR-04, TC-008)', () => {
  const file = (path: string, text: string): SourceFile => ({ path, text });
  const list: CallSiteList = {
    'a/guard.ts': { names: ['setCandidateFacts'], why: 'the guard' },
    'a/keys.service.ts': { names: ['withGrant'], why: 'KeyService', sites: ['KeyService'] },
  };
  const violations = (text: string, path = 'x/other.ts'): string[] =>
    findCallSiteViolations([file(path, text)], list);

  it('TC-008 every form of USE is found: a call, a spaced call, a generic call, a destructuring, a bracket access, Reflect.get, an import, a bind, a type query, an object shorthand', () => {
    const forms = [
      "await this.orgContext.withGrant({ model: 'Session' }, () => 1);",
      'await this.orgContext.withGrant ({ model: 1 }, f);',
      'await withGrant<string>(request, fn);',
      'const { withGrant } = this.orgContext;',
      'const { a, withGrant: g, b } = this.orgContext;',
      "this.orgContext['withGrant'](request, fn);",
      'this.orgContext["withGrant"](request, fn);',
      'this.orgContext[`withGrant`](request, fn);',
      "Reflect.get(OrgContextService.prototype, 'withGrant');",
      "import { withGrant } from '../database/org-context';",
      "import { a, type withGrant as w } from '../database/org-context';",
      'const fn = this.orgContext.withGrant.bind(this.orgContext);',
      'type T = typeof OrgContextService.prototype.withGrant;',
      'const o = { withGrant };',
      'const g = orgContext\n  .withGrant;',
      'const r = `${this.orgContext.withGrant(a, b)}`;',
    ];
    for (const text of forms) {
      expect({ text, found: violations(text) }).toEqual({ text, found: ['x/other.ts: withGrant'] });
    }
    for (const name of ['claimCandidateFactsSetter', 'setCandidateFacts', 'detachForSessionJob']) {
      expect(violations(`${name}(x);`)).toEqual([`x/other.ts: ${name}`]);
    }
  });

  it('TC-008 a MENTION is not a use: a line comment, a block comment, a JSDoc with a link, prose in a string, a longer identifier', () => {
    const mentions = [
      '// withGrant is called here',
      '/* withGrant(request, fn) */',
      '/**\n * See {@link withGrant}, which calls detachForSessionJob()\n * and setCandidateFacts({ a }).\n */\nexport const x = 1;',
      "const m = 'withGrant needs an org scope';",
      'const m = `a query that outlives withGrant is refused`;',
      "throw new Error('withGrant ' + 'is private');",
      'type G = GrantRequest;',
      'withGrantOf(x);',
      'const withGrants = 1;',
      'setCandidateFactsLater();',
      'const url = "http://example.test/withGrant";',
    ];
    for (const text of mentions) {
      expect({ text, found: violations(text) }).toEqual({ text, found: [] });
    }
  });

  it('TC-008 a use next to a comment is still a use, and a comment after a string that holds // is a comment', () => {
    expect(violations('c.withGrant(r); // withGrant')).toEqual(['x/other.ts: withGrant']);
    expect(violations("const u = 'http://x'; c.withGrant(r);")).toEqual(['x/other.ts: withGrant']);
    expect(violations("const u = 'http://x'; // c.withGrant(r)")).toEqual([]);
    expect(violations('/* a */ c.withGrant(r) /* b */')).toEqual(['x/other.ts: withGrant']);
    expect(violations('/*\n c.withGrant(r)\n*/\nc.other(r);')).toEqual([]);
    expect(violations('const t = `${c.withGrant(r)} // not a comment`;')).toEqual([
      'x/other.ts: withGrant',
    ]);
  });

  it('TC-008 FAIL-SAFE: a quote in a regex literal, an unterminated block comment and an unterminated template strip nothing more than they must, never a call', () => {
    // A regex with a quote opens a string to the end of the line: the comment on that line is KEPT, so a
    // mention there counts as a use (an extra entry), and the code on the next line is still read.
    expect(violations('const re = /[\'"]/; // withGrant(r)')).toEqual(['x/other.ts: withGrant']);
    expect(violations("const re = /'/;\nc.withGrant(r);")).toEqual(['x/other.ts: withGrant']);
    // An open block comment, or an open template: the text is returned as it is.
    expect(stripComments('a /* never closed\n withGrant(r)')).toBe(
      'a /* never closed\n withGrant(r)',
    );
    expect(violations('a /* never closed\n withGrant(r)')).toEqual(['x/other.ts: withGrant']);
    expect(stripComments('const t = `open ${a} // x')).toBe('const t = `open ${a} // x');
    // A // that does not start a comment (a regex like /^https?:\\/\\//, a division) strips nothing.
    expect(violations('const re = /^https?:\\/\\//; c.withGrant(r);')).toEqual([
      'x/other.ts: withGrant',
    ]);
    expect(violations('const half = a / b; c.withGrant(r) // c')).toEqual([
      'x/other.ts: withGrant',
    ]);
  });

  it('TC-008 stripComments keeps the line structure and the text outside the comments', () => {
    const source = 'a // one\nb /* two\nthree */ c\n`d // e` "f /* g */"\n';
    const stripped = stripComments(source);
    expect(stripped.split('\n')).toHaveLength(source.split('\n').length);
    expect(stripped).toContain('a ');
    expect(stripped).toContain('c');
    expect(stripped).not.toContain('one');
    expect(stripped).not.toContain('two');
    expect(stripped).not.toContain('three');
    // Inside a string or a template a comment marker is text.
    expect(stripped).toContain('`d // e`');
    expect(stripped).toContain('"f /* g */"');
    expect(stripComments('')).toBe('');
  });

  it('TC-008 an allowlisted file may use only the names it is listed for', () => {
    expect(violations('setCandidateFacts(o, f); detachForSessionJob(fn);', 'a/guard.ts')).toEqual([
      'a/guard.ts: detachForSessionJob',
    ]);
    expect(violations('orgContext.withGrant(r, fn);', 'a/keys.service.ts')).toEqual([]);
    expect(violations('orgContext.setCandidateFacts(o, f);', 'a/keys.service.ts')).toEqual([
      'a/keys.service.ts: setCandidateFacts',
    ]);
    // A mention of another name in a listed file is not a use.
    expect(
      violations('// detachForSessionJob is not ours\nsetCandidateFacts(o, f);', 'a/guard.ts'),
    ).toEqual([]);
  });

  it('TC-008 a re-export hands the name on, so it is refused even in a listed file, but not when only a comment says it', () => {
    for (const text of [
      "export { withGrant } from '../database/org-context';",
      "export { a, withGrant as grant } from './x';",
    ]) {
      expect(violations(text, 'a/keys.service.ts')).toEqual([
        'a/keys.service.ts: re-exports withGrant',
      ]);
    }
    expect(violations("// export { withGrant } from './x';", 'a/keys.service.ts')).toEqual([]);
  });

  it('TC-008 a stale entry is keyed on uses: a file that is gone, a name it no longer uses, and a name that only a comment mentions', () => {
    expect(findStaleEntries([file('a/keys.service.ts', 'nothing here')], list)).toEqual([
      'a/guard.ts: the file does not exist',
      'a/keys.service.ts: no longer uses withGrant',
    ]);
    expect(
      findStaleEntries(
        [
          file('a/guard.ts', '// setCandidateFacts(o, f)'),
          file('a/keys.service.ts', '/* withGrant(r) */'),
        ],
        list,
      ),
    ).toEqual([
      'a/guard.ts: no longer uses setCandidateFacts',
      'a/keys.service.ts: no longer uses withGrant',
    ]);
    expect(
      findStaleEntries(
        [
          file('a/guard.ts', 'setCandidateFacts(o, f)'),
          file('a/keys.service.ts', 'x.withGrant(r, f)'),
        ],
        list,
      ),
    ).toEqual([]);
  });

  it('TC-008 usesOf lists each used name once, in the order of GUARDED_NAMES', () => {
    expect(
      usesOf('detachForSessionJob(f); x.withGrant(r); x.withGrant(s); // setCandidateFacts(o)'),
    ).toEqual(['withGrant', 'detachForSessionJob']);
  });

  it('TC-008 importersOf resolves relative specifiers in every import form, and ignores a commented import', () => {
    const files = [
      file('database/database.module.ts', "import './candidate-facts';"),
      file('auth/guard.ts', "import { setCandidateFacts } from '../database/candidate-facts.js';"),
      file('auth/other.ts', "const m = require('../database/candidate-facts');"),
      file('auth/lazy.ts', "const m = await import('../database/candidate-facts');"),
      file('auth/none.ts', "import { x } from '../database/org-context';"),
      file('auth/commented.ts', "// import { x } from '../database/candidate-facts';"),
    ];
    expect(importersOf(files, 'database/candidate-facts')).toEqual([
      'auth/guard.ts',
      'auth/lazy.ts',
      'auth/other.ts',
      'database/database.module.ts',
    ]);
  });
});
