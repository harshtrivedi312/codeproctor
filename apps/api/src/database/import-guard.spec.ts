// One guard that keeps five things out of new code (architect condition Q9, review S4, FU-DB-91).
// Each of them reaches Postgres without the org scope:
//   - database/prisma.module: BE-02's interim unscoped Prisma client, removed (FU-DB-58); it must not come back;
//   - database/create-prisma-client: building a client of your own;
//   - PG_POOL: BE-01's raw pg Pool token;
//   - the `pg` package: a raw connection or pool of your own;
//   - the `@prisma/adapter-pg` package: building a driver adapter, hence a client, of your own.
// New business modules inject PrismaService from database/prisma.service.ts instead.
//
// A sixth rule is not about the org scope but about WHO may take the per-session write lock:
//   - database/session-locks: guardLive, lockForAccommodation and lockAnySession (ADR 0013 section 5.7,
//     FU-DB-67). Only SessionStateService may import it (the others are wrappers' callers), so the allowlist
//     is empty until Backend B adds exactly that one file.
//
// It reads every non-test file under apps/api/src and matches `from '…'`, `require('…')` and
// `import('…')`, with or without the `.js` extension, against an explicit per-file allowlist. A
// re-export (`export … from`) of a guarded module, package or identifier is refused even in an
// allowlisted file. Tests are not scanned: *.spec.ts, *.e2e-spec.ts, src/test and
// src/database/testing.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  findViolations,
  reexportsOf,
  resolveSpecifier,
  specifiersOf,
} from './testing/import-guard';
import type { GuardRule, SourceFile } from './testing/import-guard';
import {
  ACCOMMODATIONS_FILE,
  RETENTION_LOCK_FILE,
  SESSION_PROCESSOR_FILE,
  SESSION_STATE_FILE,
  lockImportProblems,
} from './testing/lock-call-sites';

const SRC = resolve(__dirname, '..');

export const RULES: readonly GuardRule[] = [
  {
    name: 'database/prisma.module',
    module: 'database/prisma.module',
    why: "BE-02's interim unscoped client was removed (FU-DB-58) and must not come back. Inject PrismaService from database/prisma.service.ts.",
    allowed: [], // deleted with FU-DB-58: auth and the guard run on the scoped client
  },
  {
    name: 'database/create-prisma-client',
    module: 'database/create-prisma-client',
    why: 'Building a client of your own skips the org scope. Inject PrismaService from database/prisma.service.ts.',
    allowed: ['database/prisma.service.ts'],
  },
  {
    name: 'pg',
    package: 'pg',
    why: 'A raw pg connection or pool has no org scope. Use PrismaService, or runRawSql for a reviewed raw query.',
    allowed: ['infrastructure/infrastructure.module.ts', 'health/health.service.ts'],
  },
  {
    name: '@prisma/adapter-pg',
    package: '@prisma/adapter-pg',
    why: 'A driver adapter of your own builds a client of your own. Only the client factory may.',
    allowed: ['database/create-prisma-client.ts'],
  },
  {
    name: 'database/session-locks',
    module: 'database/session-locks',
    why:
      'The lock core (ADR 0013 section 5.7, ADR 0006 section 8.5, ADR 0015 section 6; FU-DB-67; hub rulings, ' +
      '#205 and its follow-ups). ONLY the SessionStateService file imports this module: Backend B adds exactly ' +
      'that file to `allowed` in its PR, and nothing else. SessionStateService.guardLive, .lockForAccommodation ' +
      'and .lockAnySession are thin wrappers, and everyone else calls the wrappers. Who calls what is pinned in ' +
      'call-sites.spec.ts (CALL_SITES): guardLive from SessionJobProcessor.withLiveSession and the single STAFF ' +
      'method SessionStateService.proctorResume only; lockAnySession from SessionJobProcessor.withAnySession ' +
      'only; lockForAccommodation from the STAFF accommodation routes (PATCH, redact-note, video-check PUT) ' +
      'through SessionStateService and from RetentionRepository.casAccommodations in a plain runInOrg ' +
      "(erasure, R-4 and R-10) only. The core itself refuses at run time everything outside each lock's own " +
      'allowlist (the merged ADR 0006 section 8.5): guardLive passes in SERVICE and STAFF, lockAnySession in ' +
      'SERVICE only, lockForAccommodation in STAFF and a plain runInOrg (not SERVICE: R-4 has no SERVICE caller), ' +
      'and all three refuse a CANDIDATE scope and system scope; a STAFF or SERVICE call under the ' +
      'SessionStateService grant is fine (ADR 0015 section 6, ADR 0013 section 5.7). That entry in `allowed` is ' +
      'the review point.',
    allowed: ['session/session-state.service.ts'], // exactly the SessionStateService file, nothing else (FU-BEB-111)
  },
  {
    name: 'PG_POOL',
    identifier: 'PG_POOL',
    why: "BE-01's raw pg Pool has no org scope. Use PrismaService, or runRawSql for a reviewed raw query.",
    allowed: ['infrastructure/infrastructure.module.ts', 'health/health.service.ts'],
  },
];

const ruleNamed = (name: string): GuardRule => {
  const found = RULES.find((rule) => rule.name === name);
  if (found === undefined) throw new Error(`no rule named ${name}`);
  return found;
};

/** The source extensions the real-tree scan reads (SF-1 of review r5 of #208): the six tsc compiles under NodeNext. */
const SOURCE_EXTENSIONS = /\.(ts|mts|cts|js|mjs|cjs)$/;

function isTestFile(path: string): boolean {
  return (
    // SF-1 of review r6 of #208: only `.spec.ts` and `.e2e-spec.ts` are tests (jest.config.js runs those, and
    // tsconfig.build.json leaves only those out of dist), so a `*.spec.cts` or `*.spec.mjs` is scanned as source.
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
    // SF-1 (review r5 of #208): the six source extensions that tsc compiles under NodeNext, not `.ts` alone.
    return SOURCE_EXTENSIONS.test(path) && !isTestFile(path)
      ? [{ path, text: readFileSync(full, 'utf8') }]
      : [];
  });
}

describe('import guard: nothing new reaches Postgres around the org scope (NFR-04)', () => {
  const files = readSource(SRC);

  it('TC-008 the scan reads the real source, so an empty scan cannot pass', () => {
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['auth/auth.service.ts', 'app.module.ts']));
    expect(paths).not.toContain('auth/auth.e2e-spec.ts');
    expect(paths.some((p) => p.startsWith('generated/'))).toBe(false);
  });

  it('TC-008 SF-1 (review r5 of #208): the real-tree scan reads all six source extensions, not .ts alone', () => {
    for (const path of ['a.ts', 'a.mts', 'a.cts', 'a.js', 'a.mjs', 'a.cjs']) {
      expect({ path, scanned: SOURCE_EXTENSIONS.test(path) }).toEqual({ path, scanned: true });
    }
    expect(SOURCE_EXTENSIONS.test('a.md')).toBe(false);
  });

  it('TC-008 SF-1 (review r4 of #208): no specifier in the real tree has an escape in it (TypeScript resolves the decoded string, every rule here reads the raw text)', () => {
    const escaped = files.flatMap((f) =>
      specifiersOf(f.text)
        .filter((s) => s.includes('\\'))
        .map((s) => `${f.path}: ${s}`),
    );
    expect(escaped).toEqual([]);
  });

  it.each(RULES)('TC-008 only the listed files use $name', (rule) => {
    const offenders = findViolations(files, rule);
    expect({ rule: rule.name, offenders, why: rule.why }).toEqual({
      rule: rule.name,
      offenders: [],
      why: rule.why,
    });
  });

  it.each(RULES)('TC-008 every allowlisted file for $name exists and really uses it', (rule) => {
    // A stale entry would silently widen the allowlist.
    for (const path of rule.allowed) {
      const file = files.find((f) => f.path === path);
      expect({ path, exists: file !== undefined }).toEqual({ path, exists: true });
      const uses = findViolations([file as SourceFile], { ...rule, allowed: [] });
      expect({ path, uses: uses.length }).toEqual({ path, uses: 1 });
    }
  });
});

describe('import guard patterns (NFR-04)', () => {
  it('TC-008 specifiersOf finds from, require and import() in single and double quotes', () => {
    const source = [
      "import { A } from '../database/prisma.module';",
      'import { B } from "../database/prisma.module.js";',
      "import type { C } from './create-prisma-client';",
      "export * from '../database/prisma.module';",
      "const { D } = require('../database/prisma.module');",
      'const E = require("../database/prisma.module.js");',
      "const F = await import('../database/prisma.module');",
      "const G = (await import('../database/prisma.module.js')).PrismaService;",
      "import '../database/prisma.module';",
      'import {\n  H,\n  I,\n} from "../database/prisma.module";',
    ].join('\n');
    expect(specifiersOf(source)).toEqual([
      '../database/prisma.module',
      '../database/prisma.module.js',
      './create-prisma-client',
      '../database/prisma.module',
      '../database/prisma.module',
      '../database/prisma.module.js',
      '../database/prisma.module',
      '../database/prisma.module.js',
      '../database/prisma.module',
      '../database/prisma.module',
    ]);
  });

  it('TC-008 resolveSpecifier names the module from any folder, with or without .js', () => {
    expect(resolveSpecifier('health/health.service.ts', '../database/prisma.module')).toBe(
      'database/prisma.module',
    );
    expect(resolveSpecifier('database/x.ts', './prisma.module.js')).toBe('database/prisma.module');
    expect(resolveSpecifier('a/b/c.ts', '../../database/create-prisma-client.js')).toBe(
      'database/create-prisma-client',
    );
    expect(resolveSpecifier('x.ts', './database/prisma.module')).toBe('database/prisma.module');
    expect(resolveSpecifier('x.ts', '@nestjs/common')).toBeUndefined();
  });

  it('TC-008 the guard fails on a stray importer, in every import form, for every rule', () => {
    const stray = (path: string, text: string): SourceFile => ({ path, text });
    const strays: Array<[GuardRule, SourceFile]> = [
      [
        ruleNamed('database/prisma.module'),
        stray(
          'billing/billing.service.ts',
          "import { PrismaService } from '../database/prisma.module';",
        ),
      ],
      [
        ruleNamed('database/prisma.module'),
        stray('billing/a.ts', 'import { P } from "../database/prisma.module.js";'),
      ],
      [
        ruleNamed('database/prisma.module'),
        stray('billing/b.ts', "const { P } = require('../database/prisma.module');"),
      ],
      [
        ruleNamed('database/prisma.module'),
        stray('billing/c.ts', "const m = await import('../database/prisma.module.js');"),
      ],
      [
        ruleNamed('database/create-prisma-client'),
        stray(
          'billing/d.ts',
          "import { createPrismaClient } from '../database/create-prisma-client';",
        ),
      ],
      [
        ruleNamed('database/create-prisma-client'),
        stray('database/e.ts', "import { createPrismaClient } from './create-prisma-client.js';"),
      ],
      [
        ruleNamed('database/create-prisma-client'),
        stray('billing/f.ts', "const f = require('../database/create-prisma-client');"),
      ],
      [
        ruleNamed('database/create-prisma-client'),
        stray('billing/g.ts', "const m = await import('../database/create-prisma-client.js');"),
      ],
      [
        ruleNamed('PG_POOL'),
        stray('billing/h.ts', "import { PG_POOL } from '../infrastructure/infrastructure.module';"),
      ],
      [
        ruleNamed('PG_POOL'),
        stray(
          'billing/i.ts',
          "const { PG_POOL } = require('../infrastructure/infrastructure.module');",
        ),
      ],
      [
        ruleNamed('PG_POOL'),
        stray(
          'billing/j.ts',
          "const t = (await import('../infrastructure/infrastructure.module')).PG_POOL;",
        ),
      ],
    ];
    for (const [rule, file] of strays) {
      expect({ rule: rule.name, found: findViolations([file], rule) }).toEqual({
        rule: rule.name,
        found: [file.path],
      });
    }
  });

  it('TC-008 the guard accepts the allowlisted files and unrelated imports', () => {
    // The real list is empty since FU-DB-58, so test the matching with a synthetic allowlist.
    const rule: GuardRule = {
      ...ruleNamed('database/prisma.module'),
      allowed: ['auth/auth.service.ts'],
    };
    const allowed: SourceFile = {
      path: 'auth/auth.service.ts',
      text: "import { PrismaService } from '../database/prisma.module';",
    };
    const unrelated: SourceFile = {
      path: 'billing/billing.service.ts',
      text: "import { PrismaService } from '../database/prisma.service';\nimport { x } from './prisma.module.helpers';",
    };
    expect(findViolations([allowed, unrelated], rule)).toEqual([]);
    // A folder is not an allowlist: a sibling of an allowed file is still refused.
    const sibling: SourceFile = {
      path: 'auth/other.service.ts',
      text: "import { PrismaService } from '../database/prisma.module';",
    };
    expect(findViolations([sibling], rule)).toEqual(['auth/other.service.ts']);
  });
});

describe('import guard: bare packages and re-exports (NFR-04, FU-DB-91)', () => {
  const stray = (path: string, text: string): SourceFile => ({ path, text });
  const pg = ruleNamed('pg');
  const adapter = ruleNamed('@prisma/adapter-pg');

  it('TC-008 pg is allowed only in the infrastructure module and the health service', () => {
    expect(pg.allowed).toEqual([
      'infrastructure/infrastructure.module.ts',
      'health/health.service.ts',
    ]);
    expect(adapter.allowed).toEqual(['database/create-prisma-client.ts']);
  });

  it('TC-008 the guard fails on a stray pg or @prisma/adapter-pg import, in every import form', () => {
    for (const [rule, text] of [
      [pg, "import { Pool } from 'pg';"],
      [pg, 'import { Pool } from "pg";'],
      [pg, "import pg from 'pg';"],
      [pg, "import type { Pool } from 'pg';"],
      [pg, "const { Client } = require('pg');"],
      [pg, "const { Client } = await import('pg');"],
      [pg, "import { Client } from 'pg/lib/client';"],
      [pg, "const pool = new (require('pg').Pool)();"],
      [adapter, "import { PrismaPg } from '@prisma/adapter-pg';"],
      [adapter, "const { PrismaPg } = require('@prisma/adapter-pg');"],
      [adapter, "const m = await import('@prisma/adapter-pg');"],
    ] as const) {
      expect({
        rule: rule.name,
        text,
        found: findViolations([stray('billing/db.ts', text)], rule),
      }).toEqual({
        rule: rule.name,
        text,
        found: ['billing/db.ts'],
      });
    }
  });

  it('TC-008 only the guarded package matches: pg-pool, pg-connection-string, a relative ./pg and other adapters do not', () => {
    for (const text of [
      "import Pool from 'pg-pool';",
      "import { parse } from 'pg-connection-string';",
      "import { x } from './pg';",
      "import { x } from '../pg/helpers';",
      "import { PrismaMariaDb } from '@prisma/adapter-mariadb';",
      "import type { PrismaClient } from '@prisma/client';",
      "const note = 'we do not import pg here';",
    ]) {
      expect({ text, found: findViolations([stray('billing/db.ts', text)], pg) }).toEqual({
        text,
        found: [],
      });
    }
    expect(
      findViolations(
        [stray('billing/db.ts', "import { PrismaMariaDb } from '@prisma/adapter-mariadb';")],
        adapter,
      ),
    ).toEqual([]);
  });

  it('TC-008 an allowlisted file may import its package, and the allowlist is per file', () => {
    expect(
      findViolations([stray('health/health.service.ts', "import { Pool } from 'pg';")], pg),
    ).toEqual([]);
    expect(
      findViolations(
        [
          stray(
            'database/create-prisma-client.ts',
            "import { PrismaPg } from '@prisma/adapter-pg';",
          ),
        ],
        adapter,
      ),
    ).toEqual([]);
    // Another file next to an allowed one, and the factory's neighbour, are still refused.
    expect(
      findViolations([stray('health/other.service.ts', "import { Pool } from 'pg';")], pg),
    ).toEqual(['health/other.service.ts']);
    expect(
      findViolations(
        [stray('database/prisma.service.ts', "import { PrismaPg } from '@prisma/adapter-pg';")],
        adapter,
      ),
    ).toEqual(['database/prisma.service.ts']);
  });

  it('TC-008 reexportsOf finds every export-from form', () => {
    const source = [
      "export * from 'pg';",
      "export * as pgModule from 'pg';",
      "export { Pool } from 'pg';",
      'export { Pool as P, Client } from "pg";',
      "export type { PoolConfig } from 'pg';",
      "export {\n  PG_POOL,\n} from '../infrastructure/infrastructure.module';",
      "export { x } from './not-guarded';",
      "const exported = 'export { Pool } from pg';",
      'export const PG = 1;',
    ].join('\n');
    expect(reexportsOf(source).map((r) => r.specifier)).toEqual([
      'pg',
      'pg',
      'pg',
      'pg',
      'pg',
      '../infrastructure/infrastructure.module',
      './not-guarded',
    ]);
  });

  it('TC-008 a re-export of a guarded package, module or identifier is refused even in an allowlisted file', () => {
    // The allowlisted files hand the guarded thing to every importer of them.
    expect(
      findViolations([stray('health/health.service.ts', "export { Pool } from 'pg';")], pg),
    ).toEqual(['health/health.service.ts']);
    expect(
      findViolations([stray('infrastructure/infrastructure.module.ts', "export * from 'pg';")], pg),
    ).toEqual(['infrastructure/infrastructure.module.ts']);
    expect(
      findViolations(
        [
          stray(
            'database/create-prisma-client.ts',
            "export { PrismaPg } from '@prisma/adapter-pg';",
          ),
        ],
        adapter,
      ),
    ).toEqual(['database/create-prisma-client.ts']);
    expect(
      findViolations(
        [stray('database/prisma.module.ts', "export { PrismaService } from './prisma.module';")],
        ruleNamed('database/prisma.module'),
      ),
    ).toEqual(['database/prisma.module.ts']);
    expect(
      findViolations(
        [
          stray(
            'database/prisma.service.ts',
            "export { createPrismaClient } from './create-prisma-client.js';",
          ),
        ],
        ruleNamed('database/create-prisma-client'),
      ),
    ).toEqual(['database/prisma.service.ts']);
    expect(
      findViolations(
        [
          stray(
            'infrastructure/infrastructure.module.ts',
            "export { PG_POOL } from './elsewhere';",
          ),
        ],
        ruleNamed('PG_POOL'),
      ),
    ).toEqual(['infrastructure/infrastructure.module.ts']);
    // A re-export of something unguarded is fine, and a plain export in an allowed file too.
    expect(
      findViolations(
        [
          stray(
            'health/health.service.ts',
            "export { helper } from './helper';\nexport const PG = 1;",
          ),
        ],
        pg,
      ),
    ).toEqual([]);
  });
});

describe('import guard: the session write locks have no importer yet (FU-DB-67, FR-704, NFR-04)', () => {
  const stray = (path: string, text: string): SourceFile => ({ path, text });
  // Looked up before each test, not when the suite loads: a removed rule then fails these tests by name.
  let locks: GuardRule;
  beforeEach(() => {
    locks = ruleNamed('database/session-locks');
  });

  it('TC-008 the rule exists, names the module, and its allowlist is exactly the SessionStateService file (FU-BEB-111)', () => {
    expect(locks.module).toBe('database/session-locks');
    expect(locks.allowed).toEqual(['session/session-state.service.ts']);
    // The reason is the review point: it says who adds what, in which pull request, and who must not.
    expect(locks.why).toContain('ONLY the SessionStateService file imports this module');
    expect(locks.why).toContain('exactly that file');
    expect(locks.why).toContain('and nothing else');
    expect(locks.why).toContain('SessionJobProcessor.withLiveSession');
    expect(locks.why).toContain('SessionStateService.proctorResume');
    expect(locks.why).toContain('withAnySession');
    expect(locks.why).toContain('RetentionRepository.casAccommodations');
    expect(locks.why).toContain('PATCH, redact-note, video-check PUT');
    expect(locks.why).toContain('plain runInOrg');
    expect(locks.why).toContain('lockAnySession in SERVICE only');
    expect(locks.why).toContain('R-4 has no SERVICE caller');
    expect(locks.why).toContain('CANDIDATE scope and system scope');
    expect(locks.why).toContain('under the SessionStateService grant is fine');
    expect(locks.why).toContain('#205');
    expect(locks.why).toContain('review point');
  });

  it('TC-008 S-B the allowlist is a subset of the one real SessionStateService path (session/session-state.service.ts)', () => {
    expect(lockImportProblems(locks.allowed)).toEqual([]);
    expect(SESSION_STATE_FILE).toBe('session/session-state.service.ts');
    // A rule that lists any other file fails, by name.
    expect(lockImportProblems([...locks.allowed, SESSION_PROCESSOR_FILE])).toEqual([
      `${SESSION_PROCESSOR_FILE}: only ${SESSION_STATE_FILE} may import database/session-locks`,
    ]);
    expect(lockImportProblems([ACCOMMODATIONS_FILE])).toHaveLength(1);
    expect(lockImportProblems([RETENTION_LOCK_FILE])).toHaveLength(1);
  });

  it('TC-008 only the SessionStateService file may be added: SessionJobProcessor and the retention jobs still fail beside it', () => {
    const allowed: GuardRule = { ...locks, allowed: [SESSION_STATE_FILE] };
    const importLocks = "import { guardLive } from '../database/session-locks';";
    expect(findViolations([stray(SESSION_STATE_FILE, importLocks)], allowed)).toEqual([]);
    for (const path of [
      SESSION_PROCESSOR_FILE,
      ACCOMMODATIONS_FILE,
      RETENTION_LOCK_FILE,
      'retention/retention.service.ts',
      'session/other.service.ts',
    ]) {
      expect(findViolations([stray(path, importLocks)], allowed)).toEqual([path]);
    }
  });

  it('TC-008 an importer of database/session-locks outside database/ fails, in every import form', () => {
    for (const [path, text] of [
      [
        'jobs/session-job.processor.ts',
        "import { lockAnySession } from '../database/session-locks';",
      ],
      [
        'jobs/session-job.processor.ts',
        'import { guardLive } from "../database/session-locks.js";',
      ],
      [
        'accommodations/accommodations.service.ts',
        "import { lockForAccommodation } from '../database/session-locks';",
      ],
      ['billing/a.ts', "import type { SessionLockTx } from '../database/session-locks';"],
      ['billing/b.ts', "const { guardLive } = require('../database/session-locks');"],
      ['billing/c.ts', "const m = await import('../database/session-locks.js');"],
      ['billing/d.ts', "import '../database/session-locks';"],
      ['a/b/c.ts', "import { guardLive } from '../../database/session-locks';"],
    ] as const) {
      expect({ text, found: findViolations([stray(path, text)], locks) }).toEqual({
        text,
        found: [path],
      });
    }
  });

  it('TC-008 a sibling inside database/ is not exempt either: the allowlist is per file, and empty', () => {
    expect(
      findViolations(
        [stray('database/prisma.service.ts', "import { guardLive } from './session-locks';")],
        locks,
      ),
    ).toEqual(['database/prisma.service.ts']);
  });

  it('TC-008 a re-export from index.ts fails, in every export-from form', () => {
    for (const text of [
      "export { guardLive } from './session-locks';",
      "export { guardLive, lockForAccommodation } from './session-locks.js';",
      "export * from './session-locks';",
      "export * as locks from './session-locks';",
      "export type { SessionLockTx } from './session-locks';",
      "export {\n  guardLive,\n} from './session-locks';",
    ]) {
      expect({ text, found: findViolations([stray('database/index.ts', text)], locks) }).toEqual({
        text,
        found: ['database/index.ts'],
      });
    }
  });

  it('TC-008 a re-export is refused even in a file that is on the allowlist', () => {
    const allowed: GuardRule = { ...locks, allowed: [SESSION_STATE_FILE] };
    expect(
      findViolations(
        [stray(SESSION_STATE_FILE, "import { guardLive } from '../database/session-locks';")],
        allowed,
      ),
    ).toEqual([]);
    expect(
      findViolations(
        [stray(SESSION_STATE_FILE, "export { guardLive } from '../database/session-locks';")],
        allowed,
      ),
    ).toEqual([SESSION_STATE_FILE]);
  });

  it('TC-008 S2: a template-literal specifier (backticks, no ${}) is an import too, in every form', () => {
    for (const text of [
      'const m = await import(`../database/session-locks`);',
      'const { guardLive } = require(`../database/session-locks`);',
      'import { guardLive } from `../database/session-locks`;',
      'export { guardLive } from `../database/session-locks`;',
      'import(`../database/session-locks.js`);',
    ]) {
      expect({ text, found: findViolations([stray('billing/t.ts', text)], locks) }).toEqual({
        text,
        found: ['billing/t.ts'],
      });
    }
    expect(specifiersOf('await import(`./a`); require(`./b`); x = `plain ${y} text`;')).toEqual([
      './a',
      './b',
    ]);
  });

  it('TC-008 S2: the module is found through every extension a specifier can carry: .js .ts .mjs .mts .cjs .cts', () => {
    for (const ext of ['', '.js', '.ts', '.mjs', '.mts', '.cjs', '.cts']) {
      expect(resolveSpecifier('billing/x.ts', `../database/session-locks${ext}`)).toBe(
        'database/session-locks',
      );
      expect({
        ext,
        found: findViolations(
          [stray('billing/x.ts', `import { guardLive } from '../database/session-locks${ext}';`)],
          locks,
        ),
      }).toEqual({ ext, found: ['billing/x.ts'] });
    }
    // A longer extension or a different module name is not the module.
    expect(resolveSpecifier('billing/x.ts', '../database/session-locks.json')).toBe(
      'database/session-locks.json',
    );
    expect(resolveSpecifier('billing/x.ts', '../database/session-locks.d.ts')).toBe(
      'database/session-locks.d',
    );
  });

  it('TC-008 unrelated imports do not match: errors.ts, the barrel and a similarly named module', () => {
    for (const text of [
      "import { SessionNotFoundError } from '../database/errors';",
      "import { SessionNotFoundError } from '../database';",
      "import { x } from '../database/session-locks-helper';",
      "import { x } from './session-locks';", // a ./session-locks outside database/ is another module
    ]) {
      expect({ text, found: findViolations([stray('billing/x.ts', text)], locks) }).toEqual({
        text,
        found: [],
      });
    }
  });

  it('TC-008 the real database/index.ts does not export the locks, and no real file imports them', () => {
    const files = readSource(SRC);
    const index = files.find((f) => f.path === 'database/index.ts');
    expect(index).toBeDefined();
    expect(findViolations([index as SourceFile], locks)).toEqual([]);
    expect(reexportsOf(index?.text ?? '').map((r) => r.specifier)).not.toContain('./session-locks');
    // The whole real tree, with the empty allowlist: nothing outside the spec files imports it.
    expect(findViolations(files, locks)).toEqual([]);
    // The module is really there, so the rule guards something.
    expect(files.some((f) => f.path === 'database/session-locks.ts')).toBe(true);
  });
});
