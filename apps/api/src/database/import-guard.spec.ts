// One guard that keeps three things out of new code (architect condition Q9, review S4). Each of
// them reaches Postgres without the org scope:
//   - database/prisma.module: BE-02's interim unscoped Prisma client, for auth only (FU-DB-58);
//   - database/create-prisma-client: building a client of your own;
//   - PG_POOL: BE-01's raw pg Pool token.
// New business modules inject PrismaService from database/prisma.service.ts instead.
//
// It reads every non-test file under apps/api/src and matches `from '…'`, `require('…')` and
// `import('…')`, with or without the `.js` extension, against an explicit per-file allowlist.
// Tests are not scanned: *.spec.ts, *.e2e-spec.ts, src/test and src/database/testing.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { findViolations, resolveSpecifier, specifiersOf } from './testing/import-guard';
import type { GuardRule, SourceFile } from './testing/import-guard';

const SRC = resolve(__dirname, '..');

export const RULES: readonly GuardRule[] = [
  {
    name: 'database/prisma.module',
    module: 'database/prisma.module',
    why: "BE-02's interim unscoped client, for auth only (FU-DB-58). Inject PrismaService from database/prisma.service.ts.",
    allowed: [], // deleted with FU-DB-58: auth runs on the scoped client
  },
  {
    name: 'database/create-prisma-client',
    module: 'database/create-prisma-client',
    why: 'Building a client of your own skips the org scope. Inject PrismaService from database/prisma.service.ts.',
    allowed: ['database/prisma.service.ts'],
  },
  {
    name: 'PG_POOL',
    identifier: 'PG_POOL',
    why: "BE-01's raw pg Pool has no org scope. Use PrismaService, or runRawSql for a reviewed raw query.",
    allowed: ['infrastructure/infrastructure.module.ts', 'health/health.service.ts'],
  },
];

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

describe('import guard: nothing new reaches Postgres around the org scope (NFR-04)', () => {
  const files = readSource(SRC);

  it('TC-008 the scan reads the real source, so an empty scan cannot pass', () => {
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['auth/auth.service.ts', 'app.module.ts']));
    expect(paths).not.toContain('auth/auth.e2e-spec.ts');
    expect(paths.some((p) => p.startsWith('generated/'))).toBe(false);
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
        RULES[0] as GuardRule,
        stray(
          'billing/billing.service.ts',
          "import { PrismaService } from '../database/prisma.module';",
        ),
      ],
      [
        RULES[0] as GuardRule,
        stray('billing/a.ts', 'import { P } from "../database/prisma.module.js";'),
      ],
      [
        RULES[0] as GuardRule,
        stray('billing/b.ts', "const { P } = require('../database/prisma.module');"),
      ],
      [
        RULES[0] as GuardRule,
        stray('billing/c.ts', "const m = await import('../database/prisma.module.js');"),
      ],
      [
        RULES[1] as GuardRule,
        stray(
          'billing/d.ts',
          "import { createPrismaClient } from '../database/create-prisma-client';",
        ),
      ],
      [
        RULES[1] as GuardRule,
        stray('database/e.ts', "import { createPrismaClient } from './create-prisma-client.js';"),
      ],
      [
        RULES[1] as GuardRule,
        stray('billing/f.ts', "const f = require('../database/create-prisma-client');"),
      ],
      [
        RULES[1] as GuardRule,
        stray('billing/g.ts', "const m = await import('../database/create-prisma-client.js');"),
      ],
      [
        RULES[2] as GuardRule,
        stray('billing/h.ts', "import { PG_POOL } from '../infrastructure/infrastructure.module';"),
      ],
      [
        RULES[2] as GuardRule,
        stray(
          'billing/i.ts',
          "const { PG_POOL } = require('../infrastructure/infrastructure.module');",
        ),
      ],
      [
        RULES[2] as GuardRule,
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
    const rule: GuardRule = { ...(RULES[0] as GuardRule), allowed: ['auth/auth.service.ts'] };
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
