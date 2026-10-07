// ADR 0013 section 5.7, CS-4.7: SessionJobProcessor is the only way a session job opens a write
// transaction or enters the SERVICE scope. This scan reads every non-test source file outside
// database/ and fails for any other file that calls runAsSessionJob or detachForSessionJob, or
// that runs a BullMQ Worker and opens a $transaction itself. The existing offenders are listed
// below as follow-ups (FU-BEB-112; identity: FU-INB-29); a new one needs a reviewed entry here.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { ANY_SESSION_CALLERS, ANY_SESSION_JOBS } from './session-job.processor';

const SRC = resolve(__dirname, '..');
const OWNER = 'session/session-job.processor.ts';

/** Worker files that still use the org scope instead of the processor (FU-BEB-112). */
// grading/grading-worker.ts (BE-11, P-24 D-68) moves onto the processor with the CS-4 PR 2 adoption.
// identity/identity-jobs.service.ts (BE-08b, D-67 demo exception, DL-64): FU-INB-29: moves onto
// SessionJobProcessor before the pilot, B-05 (a pre-pilot blocker; remove this entry then). It uses
// runSystem('BACKGROUND_JOB') for the reconcile read and runInOrg per row; FU-INB-29 covers both.
const RUNS_IN_ORG_SCOPE_TODAY = [
  'candidate/session-jobs.service.ts',
  'grading/grading-worker.ts',
  'identity/identity-jobs.service.ts',
];

function sources(dir: string): Array<{ path: string; text: string }> {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const path = relative(SRC, full).split(sep).join('/');
    if (statSync(full).isDirectory()) {
      return name === 'generated' || name === 'testing' || path === 'test' || path === 'database'
        ? []
        : sources(full);
    }
    return path.endsWith('.ts') && !/\.(spec|e2e-spec)\.ts$/.test(path)
      ? [{ path, text: readFileSync(full, 'utf8') }]
      : [];
  });
}

/** Source without comments and without the contents of string and template literals. */
const strip = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, "''");

function everyFile(dir: string): Array<{ path: string; text: string }> {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const path = relative(SRC, full).split(sep).join('/');
    if (statSync(full).isDirectory()) {
      return name === 'generated' || path === 'database' ? [] : everyFile(full);
    }
    return path.endsWith('.ts') ? [{ path, text: readFileSync(full, 'utf8') }] : [];
  });
}

describe('Session jobs write only through SessionJobProcessor (ADR 0013 5.7, CS-4.7)', () => {
  const all = sources(SRC);

  it('FR-505: only session-job.processor.ts calls runAsSessionJob or detachForSessionJob', () => {
    const hits = all
      .filter((f) => /\b(runAsSessionJob|detachForSessionJob)\s*\(/.test(strip(f.text)))
      .map((f) => f.path);
    expect(hits).toEqual([OWNER]);
  });

  it('FR-505: no BullMQ worker file opens a write transaction of its own', () => {
    const workers = all.filter((f) => /\bnew Worker\s*\(/.test(strip(f.text)));
    expect(workers.length).toBeGreaterThanOrEqual(2);
    const offenders = workers
      .filter((f) => /\$transaction\s*\(/.test(strip(f.text)))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('FR-505: a worker file must extend SessionJobProcessor, except the listed legacy ones', () => {
    const workers = all.filter((f) => /\bnew Worker\s*\(/.test(strip(f.text))).map((f) => f.path);
    const extending = all
      .filter((f) => /extends SessionJobProcessor\b/.test(strip(f.text)))
      .map((f) => f.path);
    const legacy = workers.filter((p) => !extending.includes(p)).sort();
    expect(legacy).toEqual([...RUNS_IN_ORG_SCOPE_TODAY].sort());
    expect(extending).toContain('session/verify-session.jobs.ts');
  });

  it('FR-505: a session-job file (a worker, or a SessionJobProcessor subclass) opens no org or system scope of its own', () => {
    const jobFiles = all.filter(
      (f) =>
        /\bnew Worker\s*\(/.test(strip(f.text)) ||
        /extends SessionJobProcessor\b/.test(strip(f.text)),
    );
    expect(jobFiles.map((f) => f.path)).toContain('session/verify-session.jobs.ts');
    const offenders = jobFiles
      .filter((f) => f.path !== OWNER && !RUNS_IN_ORG_SCOPE_TODAY.includes(f.path))
      .filter((f) => /\b(runInOrg|runSystem|runRawSql|runAsUser)\s*\(/.test(strip(f.text)))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('FR-505: a SessionJobProcessor subclass never holds the raw client (no this.prisma.client)', () => {
    const subclasses = all.filter((f) => /extends SessionJobProcessor\b/.test(strip(f.text)));
    expect(subclasses.length).toBeGreaterThanOrEqual(1);
    for (const f of subclasses) expect(strip(f.text)).not.toMatch(/\bthis\.prisma\b/);
    // The base class keeps its client private.
    const base = readFileSync(join(SRC, OWNER), 'utf8');
    expect(base).toMatch(/private readonly prisma: PrismaService/);
    expect(base).not.toMatch(/protected readonly prisma/);
  });

  it('FR-505: withAnySession callers are exactly the files of ANY_SESSION_CALLERS, each for listed jobs only', () => {
    const callers = all
      .filter((f) => f.path !== OWNER && /\bwithAnySession\s*\(/.test(strip(f.text)))
      .map((f) => f.path)
      .sort();
    expect(callers).toEqual(Object.keys(ANY_SESSION_CALLERS).sort());
    for (const jobs of Object.values(ANY_SESSION_CALLERS)) {
      for (const job of jobs) expect(ANY_SESSION_JOBS).toContain(job);
    }
    // The map starts empty: the first caller is a reviewed addition (ADR 0013 section 5.7).
    expect(Object.keys(ANY_SESSION_CALLERS)).toEqual([]);
  });

  it('FR-505: the scanner strips comments and string literals, so a mention does not count', () => {
    expect(
      strip('// runInOrg(x)\nconst a = \'runSystem(\' + "runRawSql(" + `runAsUser(`;'),
    ).not.toMatch(/runInOrg|runSystem|runRawSql|runAsUser/);
    expect(strip('this.orgContext.runInOrg(o, f);')).toMatch(/runInOrg\(/);
  });

  it('FR-505: the verify conditions only read (no create, update, delete or upsert in verify-conditions*)', () => {
    const files = everyFile(SRC).filter(
      (f) => /verify-conditions/.test(f.path) && !/\.spec\.ts$/.test(f.path),
    );
    expect(files.length).toBeGreaterThanOrEqual(2); // the port and the in-memory double
    for (const f of files) {
      expect([
        f.path,
        /\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/.test(strip(f.text)),
      ]).toEqual([f.path, false]);
    }
  });

  it('FR-505: nobody imports BullMQ Worker under another name (it would hide a worker from the scan), test helpers included', () => {
    const aliased = everyFile(SRC)
      .filter(
        (f) =>
          /\bWorker\s+as\s+\w+/.test(strip(f.text)) && !/session-job-writers\.spec/.test(f.path),
      )
      .map((f) => f.path);
    expect(aliased).toEqual([]);
  });

  /** [start, end) of the declaration of method `name` (modifiers and generics allowed). */
  function methodRange(text: string, name: string): [number, number] {
    const m = new RegExp(
      `\\n\\s*(?:protected |private |public )?(?:async )?${name}\\s*(?:<[^>]*>)?\\(`,
    ).exec(text);
    if (m === null) throw new Error(`method ${name} not found`);
    let depth = 0;
    let close = -1;
    for (let i = text.indexOf('(', m.index); i < text.length; i++) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')' && --depth === 0) {
        close = i;
        break;
      }
    }
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
      else if (text[i] === '}' && --depth === 0) return [m.index, i + 1];
    }
    return [m.index, text.length];
  }

  /** `text` with the given [start, end) ranges cut out. */
  const without = (text: string, ranges: Array<[number, number]>): string =>
    [...ranges]
      .sort((x, y) => y[0] - x[0])
      .reduce((out, [from, to]) => out.slice(0, from) + out.slice(to), text);

  it('ADR 0013 5.7, FU-DB-67: guardLive has exactly two callers: withLiveSession and SessionStateService.proctorResume (plus the wrapper that delegates)', () => {
    const callers = all
      .filter((f) => /\.guardLive\s*\(/.test(strip(f.text)))
      .map((f) => f.path)
      .sort();
    expect(callers).toEqual([
      'session/session-job.processor.ts',
      'session/session-state.service.ts',
    ]);

    // The processor: the call is inside withLiveSession and nowhere else in the file.
    const processor = all.find((f) => f.path === OWNER)?.text ?? '';
    const live = methodRange(processor, 'withLiveSession');
    expect(strip(processor.slice(live[0], live[1]))).toMatch(/\.guardLive\s*\(/);
    expect(strip(without(processor, [live]))).not.toMatch(/\.guardLive\s*\(/);

    // The state service: calls only inside proctorResume and the guardLive wrapper; the REST of the
    // file (everything outside both) has none.
    const state = all.find((f) => f.path === 'session/session-state.service.ts')?.text ?? '';
    const resume = methodRange(state, 'proctorResume');
    const wrapper = methodRange(state, 'guardLive');
    expect(strip(state.slice(resume[0], resume[1]))).toMatch(/this\.guardLive\s*\(/);
    expect(strip(state.slice(wrapper[0], wrapper[1]))).toMatch(/this\.locks\.guardLive\s*\(/);
    const rest = strip(without(state, [resume, wrapper]));
    expect(rest.length).toBeGreaterThan(1000);
    expect(rest).not.toMatch(/\.guardLive\s*\(/);
  });

  it('ADR 0013 5.7: lockAnySession is called only by withAnySession, and lockForAccommodation by nobody in the session-job layer', () => {
    const any = all
      .filter((f) => /\.lockAnySession\s*\(/.test(strip(f.text)))
      .map((f) => f.path)
      .sort();
    expect(any).toEqual(['session/session-job.processor.ts', 'session/session-state.service.ts']);
    const processor = all.find((f) => f.path === OWNER)?.text ?? '';
    const [aa, ab] = methodRange(processor, 'withAnySession');
    expect(strip(processor.slice(aa, ab))).toMatch(/\.lockAnySession\s*\(/);
    expect(strip(processor.slice(aa, ab))).not.toMatch(/\.guardLive\s*\(/);
    // In the state service the wrapper is the only place: nothing else in the file uses the port.
    const state = all.find((f) => f.path === 'session/session-state.service.ts')?.text ?? '';
    const wrappers = ['guardLive', 'lockAnySession', 'lockForAccommodation'].map((n) =>
      methodRange(state, n),
    );
    const restOfState = strip(without(state, [...wrappers, methodRange(state, 'proctorResume')]));
    expect(restOfState).not.toMatch(/\.lockAnySession\s*\(|\.lockForAccommodation\s*\(|\.locks\./);
    const accommodation = all
      .filter((f) => /\.lockForAccommodation\s*\(/.test(strip(f.text)))
      .map((f) => f.path);
    expect(accommodation).toEqual(['session/session-state.service.ts']);
  });
});
