// The first slice of the FU-DB-67 call-site test (review of #185, S1; PR 3 widens it). CS-4.4 says the grant
// API is private, and TypeScript cannot hide a method of an injected class, so this scan pins every use of
//   - `withGrant` (the eleven CS-4.4 grant sites),
//   - `claimCandidateFactsSetter` (the claim-once closure of the candidate-facts setter),
//   - `setCandidateFacts` (CandidateSessionGuard only),
//   - `detachForSessionJob` (the SessionJobProcessor base class only),
// to an explicit per-file allowlist (CALL_SITES below). It reads every non-test file under apps/api/src
// (*.spec.ts, *.e2e-spec.ts, src/test, src/database/testing and src/generated are not scanned), and matches the
// bare word anywhere in a file, comments and strings included (testing/call-site-guard.ts says why).
//
// TODAY the list holds the database folder's own files and nothing else: BE-07's guard, SessionJobProcessor and
// the grant-site services are NOT allowed yet. A new call site must be added to CALL_SITES in the same PR,
// which is the review point; for `withGrant` the entry names the CS-4.4 grant site(s) the file holds, one
// `GRANT_SITES` name per site (FU-DB-189, FU-DB-190). NFR-04, TC-008.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  findCallSiteViolations,
  findStaleEntries,
  GUARDED_NAMES,
  importersOf,
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
  'database/org-scope.extension.ts': {
    names: ['withGrant'],
    why: 'reads the grant from the store; names withGrant in comments and messages, calls nothing',
  },
  'database/candidate-interim.ts': {
    names: ['withGrant'],
    why: 'the read control names the grant that unlocks an explicit-only column, in comments',
  },
  'database/index.ts': {
    names: ['withGrant', 'detachForSessionJob'],
    why: 'a comment: which members of OrgContextService are not exported on their own',
  },
};

function isTestFile(path: string): boolean {
  return (
    /\.(spec|e2e-spec)\.ts$/.test(path) ||
    path.startsWith('test/') ||
    path.startsWith('database/testing/') ||
    path.startsWith('generated/')
  );
}

function readSource(dir: string): SourceFile[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return readSource(full);
    const path = relative(SRC, full).split(sep).join('/');
    return path.endsWith('.ts') && !isTestFile(path)
      ? [{ path, text: readFileSync(full, 'utf8') }]
      : [];
  });
}

describe('call-site guard: the private entries of the database layer (FU-DB-67 slice, #185 S1; NFR-04, TC-008)', () => {
  const files = readSource(SRC);

  it('TC-008 the scan reads the real source, so an empty scan cannot pass', () => {
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining(['database/org-context.ts', 'auth/auth.service.ts', 'app.module.ts']),
    );
    expect(paths).not.toContain('database/call-sites.spec.ts');
    expect(paths.some((p) => p.startsWith('generated/') || p.startsWith('test/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('database/testing/'))).toBe(false);
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

  it('TC-008 today the list holds the database folder and nothing else: BE-07 sites are not allowed yet', () => {
    expect(Object.keys(CALL_SITES).every((path) => path.startsWith('database/'))).toBe(true);
    // The grant sites are not allowed anywhere yet: no entry names one.
    expect(Object.values(CALL_SITES).some((entry) => entry.sites !== undefined)).toBe(false);
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

  it('TC-008 every form of use is found: a call, a destructuring, a bracket access, Reflect.get, an import, a comment', () => {
    const forms = [
      "await this.orgContext.withGrant({ model: 'Session' }, () => 1);",
      'const { withGrant } = this.orgContext;',
      "this.orgContext['withGrant'](request, fn);",
      "Reflect.get(OrgContextService.prototype, 'withGrant');",
      "import { withGrant } from '../database/org-context';",
      '// withGrant is called here',
      'const fn = this.orgContext.withGrant.bind(this.orgContext);',
    ];
    for (const text of forms) {
      expect(findCallSiteViolations([file('x/other.ts', text)], list)).toEqual([
        'x/other.ts: withGrant',
      ]);
    }
    for (const name of ['claimCandidateFactsSetter', 'setCandidateFacts', 'detachForSessionJob']) {
      expect(findCallSiteViolations([file('x/other.ts', `${name}(x);`)], list)).toEqual([
        `x/other.ts: ${name}`,
      ]);
    }
  });

  it('TC-008 a longer identifier is not the name (GrantRequest, withGrantOf, setCandidateFactsLater)', () => {
    for (const text of [
      'type G = GrantRequest;',
      'withGrantOf(x);',
      'const withGrants = 1;',
      'setCandidateFactsLater();',
    ]) {
      expect(findCallSiteViolations([file('x/other.ts', text)], list)).toEqual([]);
    }
  });

  it('TC-008 an allowlisted file may use only the names it is listed for', () => {
    expect(
      findCallSiteViolations(
        [file('a/guard.ts', 'setCandidateFacts(o, f); detachForSessionJob(fn);')],
        list,
      ),
    ).toEqual(['a/guard.ts: detachForSessionJob']);
    expect(
      findCallSiteViolations([file('a/keys.service.ts', 'orgContext.withGrant(r, fn);')], list),
    ).toEqual([]);
    expect(
      findCallSiteViolations(
        [file('a/keys.service.ts', 'orgContext.setCandidateFacts(o, f);')],
        list,
      ),
    ).toEqual(['a/keys.service.ts: setCandidateFacts']);
  });

  it('TC-008 a re-export hands the name on, so it is refused even in a listed file', () => {
    for (const text of [
      "export { withGrant } from '../database/org-context';",
      "export { a, withGrant as grant } from './x';",
    ]) {
      expect(findCallSiteViolations([file('a/keys.service.ts', text)], list)).toEqual([
        'a/keys.service.ts: re-exports withGrant',
      ]);
    }
  });

  it('TC-008 a stale entry is reported: a file that is gone, and a name it no longer uses', () => {
    expect(findStaleEntries([file('a/keys.service.ts', 'nothing here')], list)).toEqual([
      'a/guard.ts: the file does not exist',
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

  it('TC-008 importersOf resolves relative specifiers in every import form', () => {
    const files = [
      file('database/database.module.ts', "import './candidate-facts';"),
      file('auth/guard.ts', "import { setCandidateFacts } from '../database/candidate-facts.js';"),
      file('auth/other.ts', "const m = require('../database/candidate-facts');"),
      file('auth/lazy.ts', "const m = await import('../database/candidate-facts');"),
      file('auth/none.ts', "import { x } from '../database/org-context';"),
    ];
    expect(importersOf(files, 'database/candidate-facts')).toEqual([
      'auth/guard.ts',
      'auth/lazy.ts',
      'auth/other.ts',
      'database/database.module.ts',
    ]);
  });
});
