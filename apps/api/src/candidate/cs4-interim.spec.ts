// ADR 0013 CS-4 interim conditions (static half). Until the database layer enforces the candidate
// scope structurally (runAsCandidate, column allowlists), these scans keep the candidate and session
// code honest: no route takes a client id except consentTextId, and no Prisma call in the candidate
// or session code is built from request input. The runtime half (every query carries the token's
// session or org predicate) is in candidate-session.e2e-spec.ts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const SRC = resolve(__dirname, '..');
const DIRS = ['candidate', 'session'];

function files(dir: string): Array<{ path: string; text: string }> {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'testing' ? [] : files(full);
    const path = relative(SRC, full).split(sep).join('/');
    return path.endsWith('.ts') && !/\.(spec|e2e-spec)\.ts$/.test(path)
      ? [{ path, text: readFileSync(full, 'utf8') }]
      : [];
  });
}

/** Every non-test source file under `dir`, whatever the folder (the generated client is skipped). */
function allSources(dir: string): Array<{ path: string; text: string }> {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const path = relative(SRC, full).split(sep).join('/');
    if (statSync(full).isDirectory()) {
      return name === 'generated' || name === 'testing' || path === 'test' ? [] : allSources(full);
    }
    return path.endsWith('.ts') && !/\.(spec|e2e-spec)\.ts$/.test(path)
      ? [{ path, text: readFileSync(full, 'utf8') }]
      : [];
  });
}

const sources = DIRS.flatMap((d) => files(join(SRC, d)));

/** [start, end) of the body of `async name(` in `text`; throws when the method is gone. */
function methodRange(text: string, name: string): [number, number] {
  const at = text.search(new RegExp(`async ${name}\\(`));
  if (at < 0) throw new Error(`method ${name} not found`);
  // Match the parameter list's own parentheses (a default object or call may sit inside it).
  let depth = 0;
  let close = -1;
  for (let i = text.indexOf('(', at); i < text.length; i++) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')' && --depth === 0) {
      close = i;
      break;
    }
  }
  // Skip a return type such as Promise<{ a: string }> before the body's opening brace.
  let angle = 0;
  let open = -1;
  for (let i = close + 1; i < text.length; i++) {
    if (text[i] === '<') angle += 1;
    else if (text[i] === '>' && text[i - 1] !== '=') angle -= 1;
    else if (text[i] === '{' && angle <= 0) {
      open = i;
      break;
    }
  }
  depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && --depth === 0) return [at, i + 1];
  }
  return [at, text.length];
}

/** Text of the balanced parentheses that start at `open`. */
function parens(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

export function prismaCalls(text: string): Array<{ call: string; args: string; index: number }> {
  const out: Array<{ call: string; args: string; index: number }> = [];
  for (const m of text.matchAll(/\b(?:client|tx|db)\s*\.\s*([a-z][A-Za-z]+)\s*\.\s*(\w+)\s*\(/g)) {
    out.push({
      call: `${m[1] ?? ''}.${m[2] ?? ''}`,
      args: parens(text, (m.index ?? 0) + m[0].length - 1),
      index: m.index ?? 0,
    });
  }
  return out;
}

describe('ADR 0013 CS-4 interim: nothing a client sends picks a row', () => {
  it('CS-4 interim, CS-1: no candidate route has a path or query parameter', () => {
    for (const f of sources.filter((x) => x.path.endsWith('.controller.ts'))) {
      expect(f.text).not.toMatch(/@Param\(/);
      expect(f.text).not.toMatch(/@Query\(/);
      expect(f.text).not.toMatch(/@Headers\(/);
    }
  });

  it('CS-4 interim, CS-2: the only client-sent id in any candidate DTO is consentTextId (and the invitation token)', () => {
    const dto = readFileSync(join(SRC, 'candidate/dto/candidate.dto.ts'), 'utf8');
    // Request DTOs are the classes whose names end in Dto and are not response shapes.
    const requests = ['LinkDto', 'StartSessionDto', 'SignConsentDto', 'HeartbeatDto'];
    const idLike: string[] = [];
    for (const name of requests) {
      const start = dto.indexOf(`export class ${name}`);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = dto.indexOf('\nexport class', start + 10);
      const body = dto.slice(start, end < 0 ? undefined : end);
      for (const m of body.matchAll(/^\s+(\w+)[!?]?:/gm)) {
        if (/(^id$|Id$|Key$|Token$)/.test(m[1] ?? '')) idLike.push(`${name}.${m[1] ?? ''}`);
      }
    }
    expect(idLike.sort()).toEqual(['LinkDto.invitationToken', 'SignConsentDto.consentTextId']);
  });

  it('CS-4 interim, CS-3: no Prisma call in candidate or session code is built from request input', () => {
    const offenders: string[] = [];
    for (const f of sources) {
      for (const { call, args } of prismaCalls(f.text)) {
        // `dto`, `input`, `body`, `req`, `params` are the names request data travels under here.
        if (/\b(dto|input|body|req|request|params|query)\b\s*\./.test(args)) {
          offenders.push(`${f.path}: ${call}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('CS-4 interim: every Prisma call names a predicate (session, invitation, org, token hash or an id taken from the context)', () => {
    const PREDICATE =
      /\b(sessionId|ctx\.|invitation|candidateId|testId|orgId|tokenHash|currentId|textId|consent\.|session\.|link\.|sections|versionId|sectionId|id:)/;
    const unfiltered: string[] = [];
    for (const f of sources) {
      // Only the two discovery methods read across orgs on purpose, under runSystem('BACKGROUND_JOB').
      // The random-rule scan of the question bank is org-scoped by the extension and bounded.
      const exempt =
        f.path === 'candidate/session-jobs.service.ts'
          ? ['discoverDisconnected', 'sweepConsentPdfs'].map((m) => methodRange(f.text, m))
          : f.path === 'candidate/test-start.service.ts'
            ? [methodRange(f.text, 'assignRandom')]
            : [];
      for (const { call, args, index } of prismaCalls(f.text)) {
        if (exempt.some(([a, b]) => index >= a && index < b)) continue;
        if (!PREDICATE.test(args)) unfiltered.push(`${f.path}: ${call}`);
      }
    }
    // The only calls without a predicate are the discovery and sweep methods and assignRandom,
    // all exempted by method above.
    expect(unfiltered).toEqual([]);
  });

  it('CS-4 interim: the scan finds the calls it is meant to judge', () => {
    expect(sources.flatMap((f) => prismaCalls(f.text)).length).toBeGreaterThan(40);
    expect(
      prismaCalls('this.prisma.client.session.update({ where: { id }, data: { a: dto.x } })'),
    ).toHaveLength(1);
    expect(prismaCalls('x.session.update(dto.sessionId)')).toHaveLength(0);
    const sample =
      "class A {\n  async m(opts = { a: 1 }): Promise<{ b: string }> {\n    return { b: 'x' };\n  }\n  async n() {}\n}";
    const [a, b] = methodRange(sample, 'm');
    expect(sample.slice(a, b)).toContain("return { b: 'x' };");
    expect(sample.slice(a, b)).not.toContain('async n');
  });

  it('CS-4 interim, DL-31: in all of apps/api/src outside database/, only candidate-scope.ts calls runAsCandidate or setCandidateFacts or imports candidate-facts', () => {
    const everything = allSources(SRC).filter((f) => !f.path.startsWith('database/'));
    expect(everything.length).toBeGreaterThan(100);
    const hits = (re: RegExp): string[] =>
      everything
        .filter((f) => re.test(f.text))
        .map((f) => f.path)
        .sort();
    expect(hits(/runAsCandidate\s*\(|setCandidateFacts\s*\(/)).toEqual([
      'candidate/candidate-scope.ts',
    ]);
    expect(hits(/candidate-facts/)).toEqual(['candidate/candidate-scope.ts']);
    // runInOrg inside the candidate module: the guard's step 1 and asOrg, the pre-token routes, the jobs.
    expect(
      sources
        .filter((f) => /\.runInOrg\(/.test(f.text))
        .map((f) => f.path)
        .sort(),
    ).toEqual([
      'candidate/candidate-auth.service.ts',
      'candidate/candidate-scope.ts',
      'candidate/consent-pdf.service.ts',
      'candidate/session-jobs.service.ts',
    ]);
  });
});
