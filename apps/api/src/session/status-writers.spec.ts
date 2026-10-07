// Only SessionStateService may change sessions.status (backend.md Step 7, ADR 0013 CS-4.4a). This
// is a source scan, not a proof: it reads every non-test file under src and fails when any file
// other than session-state.service.ts passes `status` in the data of a write to the session model
// (create, update, updateMany, upsert and their variants) or writes the column with raw SQL. The
// scanner is itself tested below so it cannot rot into a test that finds nothing.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const SRC = resolve(__dirname, '..');
const OWNER = 'session/session-state.service.ts';
// The one other file that may pass `status` in the data of a session write (hub ruling on #208,
// option (a)): the session lock core. It writes the SAME value it read (`where.status` equals
// `data.status`), which takes the row lock (FOR NO KEY UPDATE) and never changes the status. Only
// session-state.service.ts may import it (the #208 pins and FU-DB-67), so SessionStateService
// stays the only code that can move a session between statuses. Both facts are tested below.
const LOCK_CORE = 'database/session-locks.ts';
const ALLOWED_OTHER: Record<string, string> = {
  [LOCK_CORE]:
    'a same-value compare-and-set that takes the row lock; never changes the status; imported only by SessionStateService (#208)',
};

const WRITE_CALL =
  /\bsession\s*\.\s*(?:create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert)\s*\(/g;
const RAW_STATUS_WRITE =
  /(?:update\s+"?sessions"?\s+set[\s\S]{0,600}?\bstatus\b|insert\s+into\s+"?sessions"?[\s\S]{0,600}?\bstatus\b)/i;

/** Text from `start` (an opening bracket) to its match, honouring strings and comments. */
function balanced(text: string, start: number): string {
  const open = text[start] as string;
  const close = open === '(' ? ')' : open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i] as string;
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i += 1;
      while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i += 1;
    } else if (c === open) {
      depth += 1;
    } else if (c === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

/** Does this object text have a `status` key at its own top level, not inside a nested value? */
function hasTopLevelStatus(objectText: string): boolean {
  let depth = 0;
  for (let i = 0; i < objectText.length; i++) {
    const c = objectText[i] as string;
    if (c === '{' || c === '[' || c === '(') depth += 1;
    else if (c === '}' || c === ']' || c === ')') depth -= 1;
    else if (depth === 1 && /\bstatus\b/.test(objectText.slice(i, i + 6))) {
      const before = objectText[i - 1] ?? ' ';
      const after = objectText.slice(i + 6).match(/^\s*([:,}])/);
      if (!/[A-Za-z0-9_$.]/.test(before) && after) return true;
    }
  }
  return false;
}

/** Messages for every write to the session model whose data names `status`. */
export function findStatusWrites(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(WRITE_CALL)) {
    const call = balanced(source, (match.index ?? 0) + match[0].length - 1);
    for (const key of ['data', 'create', 'update']) {
      for (const k of call.matchAll(new RegExp(`\\b${key}\\s*:\\s*\\{`, 'g'))) {
        const body = balanced(call, (k.index ?? 0) + k[0].length - 1);
        if (hasTopLevelStatus(body)) found.push(`${match[0].trim()} ... ${key}: { status }`);
      }
    }
    // data shorthand, e.g. update({ where, data })
    if (/\bdata\b\s*[,}]/.test(call) && !/\bdata\s*:/.test(call))
      found.push(`${match[0].trim()} ... data (shorthand)`);
  }
  if (RAW_STATUS_WRITE.test(source)) found.push('raw SQL that writes sessions.status');
  return found;
}

/**
 * Messages for every write to the session model in `source` that is NOT a same-value status
 * compare-and-set: its `data` must carry `status` and the call's `where` must carry the identical
 * expression, so the write can only re-assert the status it matched (it takes the row lock and
 * changes nothing). Used on the lock core only.
 */
export function findNonSameValueStatusWrites(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(WRITE_CALL)) {
    const call = balanced(source, (match.index ?? 0) + match[0].length - 1);
    const where = [...call.matchAll(/\bwhere\s*:\s*\{/g)].map((k) =>
      balanced(call, (k.index ?? 0) + k[0].length - 1),
    );
    const data = [...call.matchAll(/\bdata\s*:\s*\{/g)].map((k) =>
      balanced(call, (k.index ?? 0) + k[0].length - 1),
    );
    const valueOf = (body: string): string | null => {
      const m = body.match(/\bstatus\s*:\s*([^,}\n]+)/);
      return m?.[1]?.trim() ?? null;
    };
    const wanted = where.map(valueOf).find((v) => v !== null) ?? null;
    if (data.length === 0 || /\bdata\b\s*[,}]/.test(call.replace(/\bdata\s*:\s*\{[\s\S]*\}/, ''))) {
      found.push(`${match[0].trim()} ... data is not an object literal`);
      continue;
    }
    for (const body of data) {
      // Only the status column may be written, and only with the value the where matched.
      const keys = [...body.matchAll(/(?:^|[{,\s])([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]);
      const dataValue = valueOf(body);
      if (dataValue === null) found.push(`${match[0].trim()} ... data has no status`);
      else if (wanted === null || dataValue !== wanted)
        found.push(`${match[0].trim()} ... data.status (${dataValue}) differs from where.status`);
      if (keys.some((k) => k !== 'status'))
        found.push(`${match[0].trim()} ... data writes a column other than status`);
    }
  }
  if (RAW_STATUS_WRITE.test(source)) found.push('raw SQL that writes sessions.status');
  return found;
}

function isTestFile(path: string): boolean {
  return (
    /\.(spec|e2e-spec)\.ts$/.test(path) ||
    path.startsWith('test/') ||
    path.includes('/testing/') ||
    path.startsWith('generated/')
  );
}

function sources(dir: string): Array<{ path: string; text: string }> {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    const path = relative(SRC, full).split(sep).join('/');
    return path.endsWith('.ts') && !isTestFile(path)
      ? [{ path, text: readFileSync(full, 'utf8') }]
      : [];
  });
}

describe('Only SessionStateService writes sessions.status (FR-106, ADR 0013 CS-4.4a)', () => {
  it('FR-106: no file except session-state.service.ts writes the status column', () => {
    const offenders = sources(SRC)
      .filter((f) => f.path !== OWNER && !(f.path in ALLOWED_OTHER))
      .flatMap((f) => findStatusWrites(f.text).map((m) => `${f.path}: ${m}`));
    expect(offenders).toEqual([]);
  });

  it('FR-106, #208: the lock core (when present) writes status only as a same-value compare-and-set', () => {
    // Absent until Database A's #208 lands; present afterwards, and then it must hold.
    const core = sources(SRC).find((f) => f.path === LOCK_CORE);
    if (!core) return;
    expect(findNonSameValueStatusWrites(core.text)).toEqual([]);
    // It does write the column (the lock), so the same-value check is not vacuous.
    expect(findStatusWrites(core.text).length).toBeGreaterThan(0);
  });

  it('FR-106, #208: only session-state.service.ts imports the lock core', () => {
    const importers = sources(SRC)
      .filter((f) => f.path !== LOCK_CORE)
      .filter((f) => /['"][^'"\n]*\bsession-locks['"]/.test(f.text))
      .map((f) => f.path);
    expect(importers.every((p) => p === OWNER)).toBe(true);
  });

  it('FR-106, #208: the same-value check accepts a re-assert and refuses a real change', () => {
    const good = [
      'await tx.session.updateMany({ where: { id, orgId, status: read }, data: { status: read } });',
      "await tx.session.updateMany({ where: { id, status: 'OPENED' }, data: { status: 'OPENED' } });",
    ];
    for (const code of good) expect(findNonSameValueStatusWrites(code)).toEqual([]);
    const bad = [
      "await tx.session.updateMany({ where: { id, status: 'OPENED' }, data: { status: 'CONSENTED' } });",
      'await tx.session.updateMany({ where: { id }, data: { status: read } });',
      'await tx.session.updateMany({ where: { id, status: read }, data: { status: read, authEpoch: 1 } });',
      'await tx.session.updateMany({ where: { id, status: read }, data: { authEpoch: 1 } });',
      'const data = {}; await tx.session.updateMany({ where: { id, status: read }, data });',
      'await tx.$executeRaw`UPDATE sessions SET status = ${s} WHERE id = ${id}`;',
    ];
    for (const code of bad) expect(findNonSameValueStatusWrites(code).length).toBeGreaterThan(0);
  });

  it('FR-106: the owner file is scanned and does write the column (the scan can find a write)', () => {
    const owner = sources(SRC).find((f) => f.path === OWNER);
    expect(owner).toBeDefined();
    expect(findStatusWrites(owner?.text ?? '').length).toBeGreaterThan(0);
  });

  it('FR-106: the scanner catches the shapes of a status write', () => {
    const bad = [
      "await prisma.client.session.update({ where: { id }, data: { status: 'GRADED' } });",
      'await tx.session.updateMany({ where: { id }, data: { startedAt: now, status } });',
      "await db.session.create({ data: { orgId, invitationId, status: 'INVITED' } });",
      "await this.prisma.client.session.upsert({ where, update: { status: 'X' }, create: {} });",
      'await prisma.$executeRaw`UPDATE sessions SET status = ${s} WHERE id = ${id}`;',
      'const data = {}; await prisma.client.session.update({ where: { id }, data });',
    ];
    for (const code of bad) expect(findStatusWrites(code).length).toBeGreaterThan(0);
  });

  it('FR-106: the scanner does not flag other columns or status used as a filter', () => {
    const good = [
      'await prisma.client.session.update({ where: { id }, data: { authEpoch: { increment: 1 } } });',
      "await prisma.client.session.updateMany({ where: { id, status: 'OPENED' }, data: { lastHeartbeat: now } });",
      "await prisma.client.session.findMany({ where: { status: { in: ['IN_PROGRESS'] } } });",
      'await prisma.client.proctorEvent.create({ data: { sessionId, type, severity, status: 1 } });',
      "await prisma.client.session.update({ where: { id }, data: { deviceInfo: { status: 'ok' } } });",
    ];
    for (const code of good) expect(findStatusWrites(code)).toEqual([]);
  });
});
