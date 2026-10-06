// The retention markers and the erasure gates are reserved (ADR 0004 9.2 and 9.5; FR-704, NFR-05).
// `audit_logs` is append-only, so a marker written by the wrong code can never be withdrawn, and an
// unrelated audit row must never be able to suppress a deletion. Only the files listed here may
// mention the actions, whether as the constant, a string literal, an assembled name or raw SQL.
// Everything else fails this test: apps/api/src (specs and the retention test helpers excepted),
// `prisma/`, `infra/` and apps/worker (the email worker will write ERASURE_EMAIL_*: it is added to
// the allowlist in the PR that builds it, which is the review point).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { reservedActionHits } from '../test/retention/reserved-actions-scan';

const REPO = resolve(__dirname, '../../../..');
const ROOTS = ['apps/api/src', 'prisma', 'infra', 'apps/worker'];
const SKIP_DIRS = new Set([
  'node_modules',
  'generated',
  'dist',
  '.venv',
  '__pycache__',
  '.git',
  'migrations',
]);
const EXTENSIONS = ['.ts', '.mjs', '.js', '.py', '.sh', '.sql'];

/** The only files that may name a reserved action or its constant, relative to the repository root. */
const ALLOWED: Record<string, string> = {
  'apps/api/src/retention/retention.constants.ts': 'defines them',
  'apps/api/src/retention/retention.repository.ts': 'RetentionService writes and reads the markers',
  'apps/api/src/retention/erasure/erasure.repository.ts':
    'erasure writes the completion, notice and fence rows and reads the email markers (never RETENTION_*_DONE)',
  'apps/api/src/retention/erasure/erasure.ports.ts':
    'prose only: the notice port documents who writes ERASURE_EMAIL_SENT and ERASURE_EMAIL_FAILED',
  'infra/backup/erasure-list.sh':
    'prose only: its comment names the ERASURE_COMPLETED event; it writes no audit row',
  'apps/api/src/test/retention/retention-harness.ts':
    'test helper: reads markers with the owner role',
  // Documentation of the rule itself and the tests of it:
  'apps/api/src/test/retention/reserved-actions-scan.ts': 'the scanner names what it looks for',
};

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (SKIP_DIRS.has(entry)) continue;
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (
      EXTENSIONS.some((e) => path.endsWith(e)) &&
      !/\.(spec|test|e2e-spec)\.(ts|mjs|js)$/.test(path) &&
      !/\/test_[^/]*\.py$/.test(path)
    ) {
      out.push(path);
    }
  }
  return out;
}

describe('reserved retention and erasure audit actions (FR-704, NFR-05)', () => {
  it('only the allowlisted files mention a marker, a reserved action or a piece of one', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of files(join(REPO, root))) {
        const rel = relative(REPO, file);
        if (Object.hasOwn(ALLOWED, rel)) continue;
        for (const hit of reservedActionHits(readFileSync(file, 'utf8')))
          offenders.push(`${rel}: ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the scanner catches literals, constants, assembled names and template names (guard the guard)', () => {
    const offenders = [
      "await tx.auditLog.create({ data: { action: 'RETENTION_FACE_DONE' } });",
      "INSERT INTO audit_logs (action) VALUES ('ERASURE_COMPLETED')",
      'const a = RETENTION_MARKER_ACTIONS.MEDIA;',
      "const a = 'RETENTION_' + 'MEDIA_DONE';",
      'const a = `RETENTION_${tier}_DONE`;',
      "const a = ['ERASURE_', 'EMAIL_SENT'].join('');",
      "const a = 'ERASURE_' + 'EMAIL_FAILED';",
      "const a = 'ERASURE_SESSION' + '_PURGED';",
      "const a = 'ERASURE_LIST' + '_COMPLETED';",
    ];
    for (const sample of offenders) expect(reservedActionHits(sample)).not.toEqual([]);
    expect(reservedActionHits("action: 'RETENTION_RUN'")).toEqual([]);
    expect(reservedActionHits("action: 'SESSION_EXPIRED'")).toEqual([]);
  });

  it('the allowlist names real files that really use the markers (it cannot go stale)', () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(reservedActionHits(readFileSync(join(REPO, rel), 'utf8')).length).toBeGreaterThan(0);
    }
  });

  it('the constants hold exactly the ten reserved action names', () => {
    const text = readFileSync(join(REPO, 'apps/api/src/retention/retention.constants.ts'), 'utf8');
    for (const name of [
      'RETENTION_FACE_DONE',
      'RETENTION_MEDIA_DONE',
      'RETENTION_RESULTS_DONE',
      'ERASURE_EMAIL_SENT',
      'ERASURE_EMAIL_FAILED',
      'ERASURE_COMPLETED',
      'ERASURE_NOTICE_RECORDED',
      'ERASURE_SESSION_FENCED',
      'ERASURE_SESSION_PURGED',
      'ERASURE_LIST_COMPLETED',
    ]) {
      expect(text).toContain(`'${name}'`);
    }
  });
});
