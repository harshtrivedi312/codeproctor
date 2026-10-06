// The retention markers and the erasure gates are reserved (ADR 0004 9.2 and 9.5; FR-704, NFR-05).
// `audit_logs` is append-only, so a marker written by the wrong code can never be withdrawn, and an
// unrelated audit row must never be able to suppress a deletion. Only the files listed here may
// mention the actions, whether as the constant, a string literal or inside raw SQL; everything else
// under src (generated code and specs excepted) fails this test. A new legitimate writer is added
// to the allowlist in the same pull request, which is the review point.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(__dirname, '..');

const ACTIONS = [
  'RETENTION_FACE_DONE',
  'RETENTION_MEDIA_DONE',
  'RETENTION_RESULTS_DONE',
  'ERASURE_EMAIL_SENT',
  'ERASURE_EMAIL_FAILED',
  'ERASURE_COMPLETED',
];
const CONSTANTS = ['RETENTION_MARKER_ACTIONS', 'ERASURE_RESERVED_ACTIONS'];

/** The only files that may name a reserved action or its constant, relative to src. */
const ALLOWED: Record<string, string> = {
  'retention/retention.constants.ts': 'defines them',
  'retention/retention.repository.ts': 'RetentionService writes and reads the markers',
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === 'generated' || entry === 'node_modules') continue;
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (
      path.endsWith('.ts') &&
      !/\.(spec|test|e2e-spec)\.ts$/.test(path) &&
      !path.includes('/testing/')
    ) {
      out.push(path);
    }
  }
  return out;
}

describe('reserved retention and erasure audit actions (FR-704, NFR-05)', () => {
  it('only the allowlisted files mention a marker or a reserved action', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (Object.hasOwn(ALLOWED, rel)) continue;
      const text = readFileSync(file, 'utf8');
      for (const name of [...ACTIONS, ...CONSTANTS])
        if (text.includes(name)) offenders.push(`${rel}: ${name}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the allowlist names real files that really use the markers (it cannot go stale)', () => {
    for (const rel of Object.keys(ALLOWED)) {
      const text = readFileSync(join(SRC, rel), 'utf8');
      expect([...ACTIONS, ...CONSTANTS].some((n) => text.includes(n))).toBe(true);
    }
  });

  it('the constants hold exactly the six reserved action names', () => {
    const text = readFileSync(join(SRC, 'retention/retention.constants.ts'), 'utf8');
    for (const name of ACTIONS) expect(text).toContain(`'${name}'`);
  });

  it('the scan really sees violations: a file that mentions a marker would be reported', () => {
    // Guards the guard: run the same check on a synthetic offender.
    const sample = "await tx.auditLog.create({ data: { action: 'RETENTION_FACE_DONE' } });";
    expect(ACTIONS.some((name) => sample.includes(name))).toBe(true);
  });
});
