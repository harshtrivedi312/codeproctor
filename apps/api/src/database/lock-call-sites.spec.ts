// The rules for who may use, wrap and export the per-session write locks (testing/lock-call-sites.ts), on SYNTHETIC
// source files: no database, no real tree. call-sites.spec.ts runs the same rules over the real tree (where, today,
// no file outside database/ names a lock). Every rule here has a mutation in the review notes of #208.
// FU-DB-67, NFR-04, TC-008.
import type { CallSiteList } from './testing/call-site-guard';
import type { SourceFile } from './testing/import-guard';
import {
  ACCOMMODATIONS_FILE,
  LOCK_ALLOWED_FILES,
  LOCK_CALLER_RULES,
  LOCK_IMPORT_ALLOWED_FILES,
  LOCK_NAMES,
  RETENTION_LOCK_FILE,
  SESSION_PROCESSOR_FILE,
  SESSION_STATE_FILE,
  SESSION_STATE_CLASS,
  findClassBody,
  findLockExports,
  findMethod,
  lockCallSiteProblems,
  lockImportProblems,
  matchingBrace,
  processorFileProblems,
  stateFileProblems,
} from './testing/lock-call-sites';

const file = (path: string, text: string): SourceFile => ({ path, text });

/** A SessionStateService file as Backend B writes it: aliased imports, one wrapper per lock, one resume call. */
const STATE_TEXT = `import { guardLive as coreGuardLive, lockAnySession as coreLockAnySession, lockForAccommodation as coreLockForAccommodation } from '../database/session-locks';
import type { SessionLockTx } from '../database/session-locks';

export class SessionStateService {
  async guardLive(tx: SessionLockTx, sessionId: string): Promise<'LIVE' | 'ERASED'> {
    return coreGuardLive(tx, sessionId);
  }

  async lockForAccommodation(tx: SessionLockTx, sessionId: string) {
    return coreLockForAccommodation(tx, sessionId);
  }

  async lockAnySession(tx: SessionLockTx, sessionId: string) {
    return coreLockAnySession(tx, sessionId);
  }

  async proctorResume(sessionId: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const result = await this.guardLive(tx, sessionId);
      return result === 'ERASED' ? 'gone' : 'resumed';
    });
  }
}
`;
const PROCESSOR_TEXT = `export abstract class SessionJobProcessor {
  protected async withLiveSession(sid: string, fn: () => Promise<void>) {
    return this.prisma.client.$transaction(async (tx) => {
      if ((await this.state.guardLive(tx, sid)) === 'LIVE') await fn();
    });
  }

  protected async withAnySession(sid: string, fn: () => Promise<void>) {
    return this.prisma.client.$transaction(async (tx) => {
      await this.state.lockAnySession(tx, sid);
      await fn();
    });
  }
}
`;
const ACCOMMODATIONS_TEXT = `export class Accommodations {
  async patch(tx: Tx, sid: string) {
    const status = await this.state.lockForAccommodation(tx, sid);
    return status;
  }
}
`;
const RETENTION_TEXT = `export class RetentionRepository {
  async casAccommodations(tx: Tx, sid: string) {
    return this.state.lockForAccommodation(tx, sid);
  }
}
`;

const GOOD: CallSiteList = {
  [SESSION_STATE_FILE]: {
    names: ['guardLive', 'lockForAccommodation', 'lockAnySession'],
    why: 'SessionStateService: the wrappers of the three locks; its single STAFF method proctorResume calls guardLive; withAnySession and the accommodation writers (PATCH, redact-note, video-check PUT) use the other two',
  },
  [SESSION_PROCESSOR_FILE]: {
    names: ['guardLive', 'lockAnySession'],
    why: 'SessionJobProcessor: withLiveSession calls guardLive, withAnySession calls lockAnySession',
  },
  [ACCOMMODATIONS_FILE]: {
    names: ['lockForAccommodation'],
    why: 'AccommodationsService: the STAFF accommodation writers (PATCH, redact-note, video-check PUT)',
  },
  [RETENTION_LOCK_FILE]: {
    names: ['lockForAccommodation'],
    why: 'RetentionRepository.casAccommodations, plain runInOrg: the erasure, R-4 and R-10 jobs',
  },
};
const GOOD_FILES: SourceFile[] = [
  file(SESSION_STATE_FILE, STATE_TEXT),
  file(SESSION_PROCESSOR_FILE, PROCESSOR_TEXT),
  file(ACCOMMODATIONS_FILE, ACCOMMODATIONS_TEXT),
  file(RETENTION_LOCK_FILE, RETENTION_TEXT),
];
const withEntry = (path: string, entry: CallSiteList[string]): CallSiteList => ({
  ...GOOD,
  [path]: entry,
});
/** The problems with `GOOD` when one file's text is replaced. */
const problemsWith = (path: string, text: string): string[] =>
  lockCallSiteProblems(
    GOOD,
    GOOD_FILES.map((f) => (f.path === path ? file(path, text) : f)),
  );

describe('the real paths and the rules in words (S-B of the re-review of #208): FU-DB-67, NFR-04, TC-008', () => {
  it("TC-008 the pinned paths are Backend B's (#98, #206) and Database B's", () => {
    expect(SESSION_STATE_FILE).toBe('session/session-state.service.ts');
    expect(SESSION_PROCESSOR_FILE).toBe('session/session-job.processor.ts');
    expect(ACCOMMODATIONS_FILE).toBe('session/accommodations.ts');
    expect(RETENTION_LOCK_FILE).toBe('retention/retention.repository.ts');
  });

  it('TC-008 the allowed files per lock, and the one file the import guard may list', () => {
    expect(LOCK_ALLOWED_FILES).toEqual({
      guardLive: [SESSION_STATE_FILE, SESSION_PROCESSOR_FILE],
      lockAnySession: [SESSION_STATE_FILE, SESSION_PROCESSOR_FILE],
      lockForAccommodation: [SESSION_STATE_FILE, ACCOMMODATIONS_FILE, RETENTION_LOCK_FILE],
    });
    expect([...LOCK_IMPORT_ALLOWED_FILES]).toEqual([SESSION_STATE_FILE]);
    expect([...LOCK_NAMES]).toEqual(['guardLive', 'lockForAccommodation', 'lockAnySession']);
  });

  it('TC-008 the rules are written out for Backend B and Database B', () => {
    expect(LOCK_CALLER_RULES.import).toContain(SESSION_STATE_FILE);
    expect(LOCK_CALLER_RULES.guardLive).toContain('withLiveSession');
    expect(LOCK_CALLER_RULES.guardLive).toContain('proctorResume');
    expect(LOCK_CALLER_RULES.lockAnySession).toContain('withAnySession');
    expect(LOCK_CALLER_RULES.lockForAccommodation).toContain(RETENTION_LOCK_FILE);
    expect(LOCK_CALLER_RULES.lockForAccommodation).toContain('PATCH, redact-note');
    expect(LOCK_CALLER_RULES.lockForAccommodation).toContain(
      `${SESSION_STATE_FILE} holds the wrapper only`,
    );
    expect(LOCK_CALLER_RULES.import).toContain('import { x as alias } from');
    expect(LOCK_CALLER_RULES.stateFile).toContain('alias');
    expect(LOCK_CALLER_RULES.stateFile).toContain('return <alias>(<param1>, <param2>);');
    expect(LOCK_CALLER_RULES.stateFile).toContain('.proctorResume(');
    expect(LOCK_CALLER_RULES.otherFiles).toContain('member call');
    expect(LOCK_CALLER_RULES.exports).toContain('wraps');
  });
});

describe('the import guard allowlist is a subset of the SessionStateService file (S-B): FU-DB-67, NFR-04, TC-008', () => {
  it('TC-008 empty and the SessionStateService file pass; any other file fails, by name', () => {
    expect(lockImportProblems([])).toEqual([]);
    expect(lockImportProblems([SESSION_STATE_FILE])).toEqual([]);
    expect(lockImportProblems([SESSION_STATE_FILE, SESSION_PROCESSOR_FILE])).toEqual([
      `${SESSION_PROCESSOR_FILE}: only ${SESSION_STATE_FILE} may import database/session-locks`,
    ]);
    expect(lockImportProblems([ACCOMMODATIONS_FILE, RETENTION_LOCK_FILE])).toHaveLength(2);
    expect(lockImportProblems(['candidate/session-state.service.ts'])).toHaveLength(1);
  });
});

describe('S-B: the entries of CALL_SITES for a lock are a subset of the real paths (FU-DB-67, NFR-04, TC-008)', () => {
  it('TC-008 the complete list passes, with the files checked', () => {
    expect(lockCallSiteProblems(GOOD, GOOD_FILES)).toEqual([]);
    expect(lockCallSiteProblems(GOOD)).toEqual([]); // without files, only the entries are checked
    expect(
      lockCallSiteProblems({
        'database/session-locks.ts': { names: ['guardLive'], why: 'defines it' },
      }),
    ).toEqual([]);
    expect(lockCallSiteProblems({})).toEqual([]);
  });

  it.each([
    ['guardLive', ACCOMMODATIONS_FILE],
    ['guardLive', RETENTION_LOCK_FILE],
    ['guardLive', 'x/other.ts'],
    ['lockAnySession', ACCOMMODATIONS_FILE],
    ['lockAnySession', RETENTION_LOCK_FILE],
    ['lockAnySession', 'x/other.ts'],
    ['lockForAccommodation', SESSION_PROCESSOR_FILE],
    ['lockForAccommodation', 'x/other.ts'],
    ['lockForAccommodation', 'retention/retention.service.ts'],
    ['guardLive', 'candidate/session-state.service.ts'],
  ] as const)('TC-008 %s listed for %s fails: not an allowed call site', (name, path) => {
    const problems = lockCallSiteProblems({
      [path]: {
        names: [name],
        why: 'withLiveSession proctorResume withAnySession accommodation PATCH erasure R-4 R-10',
      },
    });
    expect(problems).toContain(
      `${path}: not an allowed ${name} call site (allowed: ${LOCK_ALLOWED_FILES[name].join(', ')})`,
    );
  });

  it('TC-008 a third file for guardLive fails, and so does a lock named inside database/ other than the defining file', () => {
    expect(
      lockCallSiteProblems(
        withEntry('x/extra.ts', { names: ['guardLive'], why: 'withLiveSession again' }),
      ),
    ).toEqual(
      expect.arrayContaining([expect.stringContaining('x/extra.ts: not an allowed guardLive')]),
    );
    expect(
      lockCallSiteProblems({
        ...GOOD,
        'database/other.ts': { names: ['guardLive'], why: 'withLiveSession' },
      }),
    ).toEqual([
      'database/other.ts: only database/session-locks.ts may name a session lock inside database/',
    ]);
  });

  it('TC-008 the why of an entry names its callers', () => {
    expect(
      lockCallSiteProblems({
        ...GOOD,
        [SESSION_PROCESSOR_FILE]: { names: ['guardLive'], why: 'SessionJobProcessor, some method' },
      }),
    ).toEqual([`${SESSION_PROCESSOR_FILE}: a guardLive entry's why must name withLiveSession`]);
    expect(
      lockCallSiteProblems({
        ...GOOD,
        [SESSION_STATE_FILE]: { names: ['guardLive'], why: 'SessionStateService, a method' },
      }),
    ).toEqual([`${SESSION_STATE_FILE}: a guardLive entry's why must name proctorResume`]);
    expect(
      lockCallSiteProblems({
        ...GOOD,
        [SESSION_PROCESSOR_FILE]: {
          names: ['guardLive', 'lockAnySession'],
          why: 'withLiveSession only',
        },
      }),
    ).toEqual([`${SESSION_PROCESSOR_FILE}: a lockAnySession entry's why must name withAnySession`]);
    expect(
      lockCallSiteProblems({
        ...GOOD,
        [RETENTION_LOCK_FILE]: { names: ['lockForAccommodation'], why: 'the erasure job only' },
      }),
    ).toEqual([
      `${RETENTION_LOCK_FILE}: a retention lockForAccommodation entry's why must name the R-10 job`,
      `${RETENTION_LOCK_FILE}: a retention lockForAccommodation entry's why must name the R-4 job`,
    ]);
    for (const route of ['PATCH', 'redact-note', 'video-check']) {
      expect(
        lockCallSiteProblems({
          ...GOOD,
          [ACCOMMODATIONS_FILE]: {
            names: ['lockForAccommodation'],
            why: `the accommodation writers, ${route}`,
          },
        }),
      ).toEqual([]);
    }
    expect(
      lockCallSiteProblems({
        ...GOOD,
        [ACCOMMODATIONS_FILE]: {
          names: ['lockForAccommodation'],
          why: 'the accommodation writers',
        },
      }),
    ).toEqual([
      `${ACCOMMODATIONS_FILE}: a lockForAccommodation entry's why must name the accommodation writer and one of PATCH, redact-note, video-check`,
    ]);
  });
});

describe('S-B, B1, S3, S4: the SessionStateService file: aliased cores, one call each, inside the same-named wrapper (FR-704, NFR-05, NFR-04, TC-008)', () => {
  const state = (text: string, names = LOCK_NAMES): string[] =>
    stateFileProblems(SESSION_STATE_FILE, text, names);

  it('TC-008 the file as Backend B writes it passes', () => {
    expect(state(STATE_TEXT)).toEqual([]);
  });

  it('TC-008 S4 a namespace import of the core is refused: the state file imports the locks by name, each under an alias', () => {
    const text = `import * as locks from '../database/session-locks';
export class S {
  async guardLive(tx: Tx, sid: string) { return locks.guardLive(tx, sid); }
  async lockForAccommodation(tx: Tx, sid: string) { return locks.lockForAccommodation(tx, sid); }
  async lockAnySession(tx: Tx, sid: string) { return locks.lockAnySession(tx, sid); }
  async proctorResume(sid: string) { return this.guardLive(tx, sid); }
}
`;
    const problems = state(text);
    expect(problems).toContain(
      `${SESSION_STATE_FILE}: a namespace import of database/session-locks is refused: import the locks by name, each under an alias`,
    );
    for (const name of LOCK_NAMES) {
      expect(problems).toContain(
        `${SESSION_STATE_FILE}: the core ${name} is not imported from database/session-locks under an alias`,
      );
    }
    // Next to the named imports it is refused all the same.
    expect(
      state(
        STATE_TEXT.replace(
          'import type',
          "import * as whole from '../database/session-locks';\nimport type",
        ),
      ),
    ).toEqual([
      `${SESSION_STATE_FILE}: a namespace import of database/session-locks is refused: import the locks by name, each under an alias`,
    ]);
  });

  it('TC-008 a core imported under its own name fails: import it under an alias', () => {
    const text = STATE_TEXT.replace('guardLive as coreGuardLive', 'guardLive');
    expect(state(text)).toEqual(
      expect.arrayContaining([
        `${SESSION_STATE_FILE}: the core guardLive is imported under its own name: import it under an alias (guardLive as core...)`,
      ]),
    );
  });

  it('TC-008 a core that is not imported fails', () => {
    const text = STATE_TEXT.replace(
      "import { guardLive as coreGuardLive, lockAnySession as coreLockAnySession, lockForAccommodation as coreLockForAccommodation } from '../database/session-locks';",
      '',
    );
    expect(state(text)).toEqual(
      expect.arrayContaining([
        `${SESSION_STATE_FILE}: the core guardLive is not imported from database/session-locks under an alias`,
      ]),
    );
  });

  it('TC-008 the core called twice, or in another method, fails', () => {
    const twice = STATE_TEXT.replace(
      'return coreLockAnySession(tx, sessionId);',
      'await coreLockAnySession(tx, sessionId);\n    return coreLockAnySession(tx, sessionId);',
    );
    expect(state(twice)).toEqual([
      `${SESSION_STATE_FILE}: the core lockAnySession is called 2 times, exactly one call is allowed, inside the lockAnySession wrapper`,
    ]);
    const elsewhere = STATE_TEXT.replace(
      'return coreGuardLive(tx, sessionId);',
      'return coreLockAnySession(tx, sessionId);',
    ).replace('return coreLockAnySession(tx, sessionId);\n  }\n}', 'return 1;\n  }\n}');
    expect(state(elsewhere)).not.toEqual([]);
    const none = STATE_TEXT.replace('return coreGuardLive(tx, sessionId);', 'return 1;');
    expect(state(none)).toEqual([
      `${SESSION_STATE_FILE}: the core guardLive is called 0 times, exactly one call is allowed, inside the guardLive wrapper`,
    ]);
  });

  it('TC-008 the core called in a method of ANOTHER name fails (the call is outside its own wrapper)', () => {
    const text = STATE_TEXT.replace(
      'async lockForAccommodation(tx: SessionLockTx, sessionId: string) {\n    return coreLockForAccommodation(tx, sessionId);',
      'async lockForAccommodation(tx: SessionLockTx, sessionId: string) {\n    return 1;',
    ).replace(
      'async lockAnySession(tx: SessionLockTx, sessionId: string) {\n    return coreLockAnySession(tx, sessionId);',
      'async lockAnySession(tx: SessionLockTx, sessionId: string) {\n    return coreLockForAccommodation(tx, sessionId);',
    );
    expect(state(text)).toEqual(
      expect.arrayContaining([
        `${SESSION_STATE_FILE}: the core lockForAccommodation is called outside the lockForAccommodation wrapper method`,
      ]),
    );
  });

  it('TC-008 the alias used anywhere else fails: kept in a property, returned, passed, or called in an exported function', () => {
    for (const extra of [
      'export const exposed = coreGuardLive;',
      'const kept = { fn: coreGuardLive };',
      'register(coreGuardLive);',
      'export function g(tx: Tx, s: string) { return coreGuardLive(tx, s); }',
    ]) {
      expect({ extra, problems: state(STATE_TEXT + '\n' + extra).length > 0 }).toEqual({
        extra,
        problems: true,
      });
    }
    expect(state(STATE_TEXT + '\nexport const exposed = coreGuardLive;')).toEqual(
      expect.arrayContaining([
        `${SESSION_STATE_FILE}: the alias coreGuardLive of guardLive is used other than as its single call inside the wrapper`,
      ]),
    );
  });

  it('TC-008 a wrapper method must exist with a body, and a bare mention of the name is not a wrapper', () => {
    const missing = STATE_TEXT.replace(/ {2}async lockAnySession[\s\S]*?\n {2}}\n\n/, '');
    expect(state(missing)).toEqual(
      expect.arrayContaining([
        `${SESSION_STATE_FILE}: no wrapper method lockAnySession with a body found`,
      ]),
    );
    // The bare-mention rule alone: the wrapper is intact, a second mention of the name is not a definition or a member call.
    expect(state(STATE_TEXT + '\nconst holder = { lockAnySession: 1 };')).toEqual([
      `${SESSION_STATE_FILE}: lockAnySession is mentioned other than as its wrapper definition or a member call`,
    ]);
    expect(state(STATE_TEXT + '\nconst { lockAnySession } = holder;')).toEqual([
      `${SESSION_STATE_FILE}: lockAnySession is mentioned other than as its wrapper definition or a member call`,
    ]);
    // A renamed method is no wrapper (the bare mention is then the only other finding next to the missing wrapper).
    expect(state(STATE_TEXT.replace('async lockAnySession(', 'lockAnySessionX('))).toEqual(
      expect.arrayContaining([
        `${SESSION_STATE_FILE}: no wrapper method lockAnySession with a body found`,
      ]),
    );
  });

  it('TC-008 exactly ONE .guardLive( member call (any receiver), inside the brace-matched proctorResume body', () => {
    const two = STATE_TEXT.replace(
      'const result = await this.guardLive(tx, sessionId);',
      'await this.guardLive(tx, sessionId);\n      const result = await this.guardLive(tx, sessionId);',
    );
    expect(state(two)).toEqual([
      `${SESSION_STATE_FILE}: 2 .guardLive( member calls (any receiver), exactly one is allowed, inside proctorResume`,
    ]);
    const none = STATE_TEXT.replace(
      'const result = await this.guardLive(tx, sessionId);',
      "const result = 'ERASED';",
    );
    expect(state(none)).toEqual([
      `${SESSION_STATE_FILE}: 0 .guardLive( member calls (any receiver), exactly one is allowed, inside proctorResume`,
    ]);
    const outside = STATE_TEXT.replace(
      'const result = await this.guardLive(tx, sessionId);',
      "const result = 'ERASED';",
    ).replace(
      '  async proctorResume(',
      '  async another(tx: Tx, sessionId: string) {\n    return this.guardLive(tx, sessionId);\n  }\n\n  async proctorResume(',
    );
    expect(state(outside)).toEqual([
      `${SESSION_STATE_FILE}: the .guardLive( call is not inside proctorResume`,
    ]);
    const noResume = STATE_TEXT.replace('async proctorResume(', 'async resumeSession(');
    expect(state(noResume)).toEqual(
      expect.arrayContaining([`${SESSION_STATE_FILE}: no proctorResume method with a body found`]),
    );
  });

  /** A second STAFF method that calls a wrapper, added after proctorResume. */
  const withMethod = (body: string): string =>
    STATE_TEXT.replace(
      /\n}\n$/,
      `\n\n  async closeIngest(tx: Tx, sid: string) {\n    ${body}\n  }\n}\n`,
    );

  it.each([
    ['this', 'await this.guardLive(tx, sid);'],
    ['self', 'await self.guardLive(tx, sid);'],
    ['optional chaining on the receiver', 'await this?.guardLive(tx, sid);'],
    ['a cast receiver', 'await (this as unknown as S).guardLive(tx, sid);'],
    ['super', 'await super.guardLive(tx, sid);'],
    ['another object', 'await this.helper.guardLive(tx, sid);'],
    ['whitespace after the dot', 'await this. guardLive(tx, sid);'],
    ['a line break after the dot', 'await this.\n      guardLive(tx, sid);'],
  ])('TC-008 B1 a second .guardLive( call with %s outside proctorResume fails', (_what, body) => {
    expect(state(withMethod(body))).toEqual([
      `${SESSION_STATE_FILE}: 2 .guardLive( member calls (any receiver), exactly one is allowed, inside proctorResume`,
    ]);
  });

  it('TC-008 B1 a guardLive call that is the ONLY one but sits outside proctorResume fails with any receiver', () => {
    for (const receiver of ['self', 'this?', '(this as S)', 'super']) {
      const text = STATE_TEXT.replace(
        'const result = await this.guardLive(tx, sessionId);',
        "const result = 'ERASED';",
      ).replace(
        /\n}\n$/,
        `\n\n  async other(tx: Tx, sid: string) {\n    return ${receiver}.guardLive(tx, sid);\n  }\n}\n`,
      );
      expect({ receiver, problems: state(text) }).toEqual({
        receiver,
        problems: [`${SESSION_STATE_FILE}: the .guardLive( call is not inside proctorResume`],
      });
    }
  });

  it.each([
    ['this.lockAnySession', 'await this.lockAnySession(tx, sid);', 'lockAnySession'],
    ['self.lockAnySession', 'await self.lockAnySession(tx, sid);', 'lockAnySession'],
    ['this?.lockAnySession', 'await this?.lockAnySession(tx, sid);', 'lockAnySession'],
    ['a cast', 'await (this as unknown as S).lockAnySession(tx, sid);', 'lockAnySession'],
    [
      'this.lockForAccommodation',
      'await this.lockForAccommodation(tx, sid);',
      'lockForAccommodation',
    ],
    [
      'super.lockForAccommodation',
      'await super.lockForAccommodation(tx, sid);',
      'lockForAccommodation',
    ],
    ['another object', 'await this.other.lockForAccommodation(tx, sid);', 'lockForAccommodation'],
  ])(
    'TC-008 S3 %s in a state method fails: no member call of lockAnySession or lockForAccommodation is allowed in the state file (closeIngest would write into an ERASED session)',
    (_what, body, name) => {
      expect(state(withMethod(body))).toEqual([
        `${SESSION_STATE_FILE}: 1 .${name}( member calls in the state file (any receiver), none are allowed`,
      ]);
    },
  );

  it('TC-008 S3 a wrapper that calls ANOTHER wrapper fails too, inside proctorResume as well', () => {
    const text = STATE_TEXT.replace(
      "return result === 'ERASED' ? 'gone' : 'resumed';",
      "await this.lockAnySession(tx, sessionId);\n      return result === 'ERASED' ? 'gone' : 'resumed';",
    );
    expect(state(text)).toEqual([
      `${SESSION_STATE_FILE}: 1 .lockAnySession( member calls in the state file (any receiver), none are allowed`,
    ]);
  });

  it("TC-008 B1 optional-call and bracket forms are not calls the rules miss: `.guardLive?.(`, `this['guardLive'](` and `.guardLive.call(` fail", () => {
    for (const body of [
      'await this.guardLive?.(tx, sid);',
      "await this['guardLive'](tx, sid);",
      'await this.guardLive.call(this, tx, sid);',
      'const f = this.lockAnySession.bind(this);',
    ]) {
      expect({ body, problems: state(withMethod(body)).length > 0 }).toEqual({
        body,
        problems: true,
      });
    }
  });

  it('TC-008 N4 a guardLive reference that is not a call fails (.bind, a property read), with or without whitespace after the dot', () => {
    for (const reference of [
      'this.guardLive.bind(this)',
      'this. guardLive.bind(this)',
      'this.\n  guardLive.bind(this)',
    ]) {
      expect(state(STATE_TEXT + `\nconst f = ${reference};`)).toEqual(
        expect.arrayContaining([
          `${SESSION_STATE_FILE}: guardLive is referenced as a property, not called`,
        ]),
      );
    }
  });

  it('TC-008 comments and strings with braces do not confuse the body matching', () => {
    const text = STATE_TEXT.replace(
      'const result = await this.guardLive(tx, sessionId);',
      "// a } in a comment\n      const note = '}{'; const t = `${1}`;\n      const result = await this.guardLive(tx, sessionId);",
    );
    expect(state(text)).toEqual([]);
  });

  const OTHERS = `${SESSION_STATE_FILE}: database/session-locks is reached other than by an import { name as alias } from statement (a require, import(), import x = require, a side-effect import or a re-export): refused`;

  it.each([
    ['import x = require(...)', "import coreAll = require('../database/session-locks');"],
    ['const x = require(...)', "const coreAll = require('../database/session-locks');"],
    ['let x = require(...)', "let coreAll = require('../database/session-locks.js');"],
    ['const x = await import(...)', "const coreAll = await import('../database/session-locks');"],
    [
      'a typed const = require(...)',
      "const coreAll: unknown = require('../database/session-locks');",
    ],
    ['a template-literal specifier', 'const coreAll = require(`../database/session-locks`);'],
    ['import(...).then(...)', "void import('../database/session-locks').then(() => undefined);"],
    ['a side-effect import', "import '../database/session-locks';"],
  ])(
    'TC-008 S-1 %s next to the named imports is refused: the core is reached by an import { x as alias } from statement and no other way',
    (_what, extra) => {
      const problems = state(STATE_TEXT + '\n' + extra);
      expect(problems).toEqual([OTHERS]);
    },
  );

  it('TC-008 S-1 a re-export of the module from the state file is refused, and so are the cores taken from require instead of an import', () => {
    expect(state(STATE_TEXT + "\nexport { guardLive } from '../database/session-locks';")).toEqual(
      expect.arrayContaining([OTHERS]),
    );
    expect(
      state(STATE_TEXT + "\nconst f = require('../database/session-locks').guardLive;"),
    ).toEqual(expect.arrayContaining([OTHERS]));
    // No import statement of the module at all: the cores come from a destructured require.
    const viaRequire = STATE_TEXT.replace(/^import \{[^\n]*session-locks';\n/, '').replace(
      /^import type [^\n]*\n/m,
      "const { guardLive: coreGuardLive, lockAnySession: coreLockAnySession, lockForAccommodation: coreLockForAccommodation } = require('../database/session-locks');\n",
    );
    const problems = state(viaRequire);
    expect(problems).toContain(OTHERS);
    for (const name of LOCK_NAMES) {
      expect(problems).toContain(
        `${SESSION_STATE_FILE}: the core ${name} is not imported from database/session-locks under an alias`,
      );
    }
  });

  it('TC-008 S-1 a specifier of another module, or the type-only import of the core, is not a finding', () => {
    expect(
      state(STATE_TEXT + "\nconst x = require('../database/other');\nvoid import('./elsewhere');"),
    ).toEqual([]);
    expect(
      state(
        STATE_TEXT.replace(
          "import type { SessionLockTx } from '../database/session-locks';",
          "import type { SessionLockTx } from '../database/session-locks.js';",
        ),
      ),
    ).toEqual([]);
  });

  // ---- N2: a thin wrapper, nothing else ----------------------------------------------------------------------------

  const SHAPE = (name: string): string =>
    `${SESSION_STATE_FILE}: the ${name} wrapper is not exactly "return <alias>(<param1>, <param2>);": a thin wrapper holds nothing else`;

  it.each([
    [
      'a closure stored on this instead of the call',
      'this.leak = (a: Tx, b: string) => coreLockAnySession(a, b);\n    return 1;',
    ],
    [
      'a statement before the return',
      'this.audit(sessionId);\n    return coreLockAnySession(tx, sessionId);',
    ],
    [
      'a second statement after the call',
      'const r = await coreLockAnySession(tx, sessionId);\n    this.seen = r;\n    return r;',
    ],
    ['the arguments swapped', 'return coreLockAnySession(sessionId, tx);'],
    ['an extra argument', 'return coreLockAnySession(tx, sessionId, true);'],
    ['one argument only', 'return coreLockAnySession(tx);'],
    ['a literal argument', "return coreLockAnySession(tx, 'x');"],
    [
      'a chained call on the result',
      'return coreLockAnySession(tx, sessionId).then((status) => status);',
    ],
    ['a condition around the call', 'return tx ? coreLockAnySession(tx, sessionId) : undefined;'],
    ['no return', 'await coreLockAnySession(tx, sessionId);'],
  ])(
    'TC-008 N2 a lockAnySession wrapper with %s fails: the body must be exactly return <alias>(<param1>, <param2>);',
    (_what, body) => {
      const text = STATE_TEXT.replace('return coreLockAnySession(tx, sessionId);', body);
      expect(state(text)).toEqual([SHAPE('lockAnySession')]);
    },
  );

  it.each([
    [
      'one parameter',
      'async lockAnySession(tx: SessionLockTx) {\n    return coreLockAnySession(tx, tx);',
    ],
    [
      'three parameters',
      'async lockAnySession(tx: SessionLockTx, sessionId: string, extra: boolean) {\n    return coreLockAnySession(tx, sessionId);',
    ],
    [
      'a destructured parameter',
      'async lockAnySession({ tx }: { tx: SessionLockTx }, sessionId: string) {\n    return coreLockAnySession(tx, sessionId);',
    ],
  ])('TC-008 N2 a lockAnySession wrapper with %s fails', (_what, header) => {
    const text = STATE_TEXT.replace(
      'async lockAnySession(tx: SessionLockTx, sessionId: string) {\n    return coreLockAnySession(tx, sessionId);',
      header,
    );
    expect(state(text)).toEqual([SHAPE('lockAnySession')]);
  });

  it.each([
    ['an await', 'return await coreLockAnySession(tx, sessionId);'],
    ['no semicolon', 'return coreLockAnySession(tx, sessionId)'],
    [
      'a line break per argument and a trailing comma',
      'return coreLockAnySession(\n      tx,\n      sessionId,\n    );',
    ],
  ])('TC-008 N2 a lockAnySession wrapper with %s is still the thin wrapper', (_what, body) => {
    expect(state(STATE_TEXT.replace('return coreLockAnySession(tx, sessionId);', body))).toEqual(
      [],
    );
  });

  it('TC-008 N2 a comment in the wrapper body is not part of the shape (the comments are stripped first)', () => {
    const text = STATE_TEXT.replace(
      'return coreLockAnySession(tx, sessionId);',
      '// the lock\n    return coreLockAnySession(tx, sessionId); // done',
    );
    expect(problemsWith(SESSION_STATE_FILE, text)).toEqual([]);
  });

  it('TC-008 N2 other parameter names are fine when both are handed on, in order', () => {
    const text = STATE_TEXT.replace(
      'async lockForAccommodation(tx: SessionLockTx, sessionId: string) {\n    return coreLockForAccommodation(tx, sessionId);',
      'async lockForAccommodation(client: SessionLockTx, id: string): Promise<SessionStatus> {\n    return coreLockForAccommodation(client, id);',
    );
    expect(state(text)).toEqual([]);
  });

  // ---- N3: proctorResume is the one door to guardLive; the wrappers are looked up in the SessionStateService class ------

  it.each([
    ['this', 'await this.proctorResume(sid);'],
    ['self', 'await self.proctorResume(sid);'],
    ['this?', 'await this?.proctorResume(sid);'],
    ['a cast receiver', 'await (this as unknown as S).proctorResume(sid);'],
    ['another object', 'await this.helper.proctorResume(sid);'],
    ['a line break after the dot', 'await this.\n      proctorResume(sid);'],
    ['an optional call', 'await this.proctorResume?.(sid);'],
    ['.call', 'await this.proctorResume.call(this, sid);'],
    ['.apply', 'await this.proctorResume.apply(this, [sid]);'],
    ['.bind', 'const f = this.proctorResume.bind(this);'],
  ])(
    'TC-008 N3 a .proctorResume( call with %s in another state method fails: none is allowed in the file',
    (_what, body) => {
      expect(state(withMethod(body))).toEqual([
        `${SESSION_STATE_FILE}: 1 .proctorResume( member calls in the state file (any receiver), none are allowed: the controller calls it from outside the file`,
      ]);
    },
  );

  it('TC-008 N3 the proctorResume definition and a plain mention of its name are not calls', () => {
    expect(state(STATE_TEXT)).toEqual([]);
    expect(
      state(
        STATE_TEXT.replace('return result', "const proctorResumeLabel = 'x';\n      return result"),
      ),
    ).toEqual([]);
  });

  it('TC-008 N3 a SECOND class with a method named like a wrapper cannot supply the wrapper: the lookup is inside the SessionStateService class', () => {
    const decoy = `class Decoy {\n  async guardLive(tx: Tx, sid: string) {\n    return coreGuardLive(tx, sid);\n  }\n}\n\n`;
    const withoutWrapper = STATE_TEXT.replace('return coreGuardLive(tx, sessionId);', 'return 1;');
    const text = withoutWrapper.replace(
      'export class SessionStateService',
      `${decoy}export class SessionStateService`,
    );
    expect(state(text)).toEqual([
      `${SESSION_STATE_FILE}: the core guardLive is called outside the guardLive wrapper method`,
    ]);
  });

  it('TC-008 N3 a SECOND class with a proctorResume method cannot hold the guardLive call', () => {
    const decoy = `class Decoy {\n  async proctorResume(tx: Tx, sid: string) {\n    return this.guardLive(tx, sid);\n  }\n}\n\n`;
    const text = STATE_TEXT.replace(
      'const result = await this.guardLive(tx, sessionId);',
      "const result = 'ERASED';",
    ).replace('export class SessionStateService', `${decoy}export class SessionStateService`);
    expect(state(text)).toEqual([
      `${SESSION_STATE_FILE}: the .guardLive( call is not inside proctorResume`,
    ]);
  });

  it('TC-008 N3 a state file with no SessionStateService class fails, and a variable class is not the class', () => {
    expect(state(STATE_TEXT.replace('class SessionStateService', 'class StateService'))).toEqual(
      expect.arrayContaining([
        `${SESSION_STATE_FILE}: no class ${SESSION_STATE_CLASS} with a body found`,
      ]),
    );
    expect(
      state(
        STATE_TEXT.replace(
          'export class SessionStateService',
          'export const SessionStateService = class',
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        `${SESSION_STATE_FILE}: no class ${SESSION_STATE_CLASS} with a body found`,
      ]),
    );
  });

  // ---- N6: ways to reach a wrapper that are not a plain member call ---------------------------------------------------

  it.each([
    [
      'a destructuring of this',
      'const { lockAnySession } = this;\n    await lockAnySession(tx, sid);',
    ],
    ['a bare call', 'await lockAnySession(tx, sid);'],
  ])(
    'TC-008 N6 %s fails: a bare mention of a lock name is neither its definition nor a member call',
    (_what, body) => {
      expect(state(withMethod(body))).toEqual([
        `${SESSION_STATE_FILE}: lockAnySession is mentioned other than as its wrapper definition or a member call`,
      ]);
    },
  );

  it.each([
    [
      'Reflect.apply(this.lockAnySession, ...)',
      'await Reflect.apply(this.lockAnySession, this, [tx, sid]);',
    ],
    [
      'a function held and called with .call',
      'const f = this.lockAnySession;\n    await f.call(this, tx, sid);',
    ],
    [
      'a function held and called with .apply',
      'const f = this.lockAnySession;\n    await f.apply(this, [tx, sid]);',
    ],
    [
      'a function put in a list',
      'const fs = [this.lockAnySession];\n    await fs[0]?.call(this, tx, sid);',
    ],
    ['a function handed to another call', 'register(this.lockAnySession);'],
  ])(
    'TC-008 N6 %s fails: a reference to a wrapper that is not a call is refused',
    (_what, body) => {
      expect(state(withMethod(body))).toEqual([
        `${SESSION_STATE_FILE}: lockAnySession is referenced as a property, not called`,
      ]);
    },
  );

  it('TC-008 N6 an arrow-property caller of a wrapper fails: it is a member call in the state file', () => {
    const text = STATE_TEXT.replace(
      '  async proctorResume(',
      '  private readonly run = (tx: Tx, sid: string) => this.lockAnySession(tx, sid);\n\n  async proctorResume(',
    );
    expect(state(text)).toEqual([
      `${SESSION_STATE_FILE}: 1 .lockAnySession( member calls in the state file (any receiver), none are allowed`,
    ]);
  });

  it('TC-008 N6 an arrow-property WRAPPER is no wrapper: the method with a body is required, and the name is a bare mention', () => {
    const text = STATE_TEXT.replace(
      / {2}async lockAnySession[\s\S]*?\n {2}}\n/,
      '  lockAnySession = (tx: SessionLockTx, sessionId: string) => coreLockAnySession(tx, sessionId);\n',
    );
    expect(state(text)).toEqual([
      `${SESSION_STATE_FILE}: no wrapper method lockAnySession with a body found`,
      `${SESSION_STATE_FILE}: lockAnySession is mentioned other than as its wrapper definition or a member call`,
    ]);
  });

  it('TC-008 N6 a SECOND class that calls a core fails: the core is called once, inside its own wrapper', () => {
    const text =
      STATE_TEXT +
      '\nclass Other {\n  run(tx: Tx, sid: string) {\n    return coreGuardLive(tx, sid);\n  }\n}\n';
    expect(state(text)).toEqual([
      `${SESSION_STATE_FILE}: the core guardLive is called 2 times, exactly one call is allowed, inside the guardLive wrapper`,
    ]);
  });

  it('TC-008 N7 a lock name in a string or a log message fails like code (fail closed), a comment does not', () => {
    expect(
      problemsWith(SESSION_STATE_FILE, withMethod("this.logger.log('guardLive done');")),
    ).toEqual([
      `${SESSION_STATE_FILE}: guardLive is mentioned other than as its wrapper definition or a member call`,
    ]);
    expect(
      problemsWith(SESSION_STATE_FILE, withMethod("this.logger.log('lockAnySession done');")),
    ).toEqual([
      `${SESSION_STATE_FILE}: lockAnySession is mentioned other than as its wrapper definition or a member call`,
    ]);
    expect(
      problemsWith(
        SESSION_STATE_FILE,
        withMethod('// guardLive and lockAnySession are wrapped above\n    return 1;'),
      ),
    ).toEqual([]);
  });
});

describe('S-B: the SessionJobProcessor file: .guardLive( in withLiveSession, .lockAnySession( in withAnySession (FR-704, NFR-05, NFR-04, TC-008)', () => {
  const processor = (text: string): string[] =>
    processorFileProblems(SESSION_PROCESSOR_FILE, text, ['guardLive', 'lockAnySession']);

  it('TC-008 the file as Backend B writes it passes', () => {
    expect(processor(PROCESSOR_TEXT)).toEqual([]);
  });

  it('TC-008 .guardLive( outside withLiveSession, or twice, or not at all, fails', () => {
    const swapped = PROCESSOR_TEXT.replace(
      'this.state.guardLive(tx, sid)',
      'this.state.lockAnySession(tx, sid)',
    ).replace(
      'await this.state.lockAnySession(tx, sid);\n      await fn();',
      'await this.state.guardLive(tx, sid);\n      await fn();',
    );
    expect(processor(swapped)).toEqual(
      expect.arrayContaining([
        `${SESSION_PROCESSOR_FILE}: the .guardLive( call is not inside withLiveSession`,
      ]),
    );
    const twice = PROCESSOR_TEXT.replace(
      "if ((await this.state.guardLive(tx, sid)) === 'LIVE') await fn();",
      "await this.state.guardLive(tx, sid);\n      if ((await this.state.guardLive(tx, sid)) === 'LIVE') await fn();",
    );
    expect(processor(twice)).toEqual([
      `${SESSION_PROCESSOR_FILE}: 2 .guardLive( calls, exactly one is allowed, inside withLiveSession`,
    ]);
    const none = PROCESSOR_TEXT.replace(
      "if ((await this.state.guardLive(tx, sid)) === 'LIVE') await fn();",
      'await fn();',
    );
    expect(processor(none)).toEqual([
      `${SESSION_PROCESSOR_FILE}: 0 .guardLive( calls, exactly one is allowed, inside withLiveSession`,
    ]);
  });

  it('TC-008 N4 whitespace or a line break after the dot, and a ?. receiver, are still counted as calls', () => {
    const spaced = PROCESSOR_TEXT.replace(
      "if ((await this.state.guardLive(tx, sid)) === 'LIVE') await fn();",
      "await this.state. guardLive(tx, sid);\n      if ((await this.state?.\n        guardLive(tx, sid)) === 'LIVE') await fn();",
    );
    expect(processor(spaced)).toEqual([
      `${SESSION_PROCESSOR_FILE}: 2 .guardLive( calls, exactly one is allowed, inside withLiveSession`,
    ]);
  });

  it('TC-008 .lockAnySession( outside withAnySession, or twice, fails', () => {
    const inLive = PROCESSOR_TEXT.replace(
      'await this.state.lockAnySession(tx, sid);\n      await fn();',
      'await fn();',
    ).replace(
      "if ((await this.state.guardLive(tx, sid)) === 'LIVE') await fn();",
      "await this.state.lockAnySession(tx, sid);\n      if ((await this.state.guardLive(tx, sid)) === 'LIVE') await fn();",
    );
    expect(processor(inLive)).toEqual(
      expect.arrayContaining([
        `${SESSION_PROCESSOR_FILE}: the .lockAnySession( call is not inside withAnySession`,
      ]),
    );
    const twice = PROCESSOR_TEXT.replace(
      'await this.state.lockAnySession(tx, sid);',
      'await this.state.lockAnySession(tx, sid);\n      await this.state.lockAnySession(tx, sid);',
    );
    expect(processor(twice)).toEqual([
      `${SESSION_PROCESSOR_FILE}: 2 .lockAnySession( calls, exactly one is allowed, inside withAnySession`,
    ]);
  });

  it('TC-008 a missing withLiveSession or withAnySession method fails, and a lock name that is not a member call fails', () => {
    expect(processor(PROCESSOR_TEXT.replace('withLiveSession', 'runLive'))).toEqual(
      expect.arrayContaining([
        `${SESSION_PROCESSOR_FILE}: no withLiveSession method with a body found`,
      ]),
    );
    expect(processor(PROCESSOR_TEXT.replace('withAnySession', 'runAny'))).toEqual(
      expect.arrayContaining([
        `${SESSION_PROCESSOR_FILE}: no withAnySession method with a body found`,
      ]),
    );
    expect(processor(PROCESSOR_TEXT + '\nconst held = guardLive;')).toEqual([
      `${SESSION_PROCESSOR_FILE}: guardLive is used other than as a member call (this.state.guardLive(...))`,
    ]);
    expect(processor(PROCESSOR_TEXT + '\nconst held = this.state.lockAnySession;')).toEqual([
      `${SESSION_PROCESSOR_FILE}: lockAnySession is used other than as a member call (this.state.lockAnySession(...))`,
    ]);
  });
});

describe('S-B: the accommodation and retention files call the wrapper as a member, nothing else (FR-704, NFR-04, TC-008)', () => {
  it.each([ACCOMMODATIONS_FILE, RETENTION_LOCK_FILE])(
    'TC-008 %s: a bare name, a reference or a held function fails',
    (path) => {
      const text = path === ACCOMMODATIONS_FILE ? ACCOMMODATIONS_TEXT : RETENTION_TEXT;
      expect(problemsWith(path, text)).toEqual([]);
      expect(problemsWith(path, text + '\nconst held = this.state.lockForAccommodation;')).toEqual([
        `${path}: lockForAccommodation is used other than as a member call (this.state.lockForAccommodation(...))`,
      ]);
      expect(problemsWith(path, text + '\nlockForAccommodation(tx, sid);')).toEqual([
        `${path}: lockForAccommodation is used other than as a member call (this.state.lockForAccommodation(...))`,
      ]);
    },
  );

  it('TC-008 a comment that names a lock is not a use', () => {
    expect(
      problemsWith(RETENTION_LOCK_FILE, RETENTION_TEXT + '\n// lockForAccommodation is the lock\n'),
    ).toEqual([]);
  });
});

describe('S-B, S3, S4: no export of a lock, an alias, or a wrapper of one (FR-704, NFR-04, TC-008)', () => {
  const exported = (text: string, path = SESSION_STATE_FILE): string[] =>
    findLockExports([file(path, text)]);

  it('TC-008 S3 every way to export a lock without `from` is found: a rename, a variable, a default, an object, an array, a function, a class, CommonJS', () => {
    for (const name of ['guardLive', 'lockForAccommodation', 'lockAnySession']) {
      for (const text of [
        `import { ${name} } from '../database/session-locks';\nexport { ${name} };`,
        `import { ${name} } from '../database/session-locks';\nexport { ${name} as g };`,
        `import { ${name} } from '../database/session-locks';\nexport type { ${name} };`,
        `import { ${name} as g } from '../database/session-locks';\nexport { g };`,
        `export const g = ${name};`,
        `export const g: unknown = ${name};`,
        `export let g = ${name};`,
        `export default ${name};`,
        `export default { ${name} };`,
        `export default [${name}];`,
        `export const locks = { ${name} };`,
        `export const locks = { a: 1, ${name}, b: 2 };`,
        `const g = ${name};\nexport { g };`,
        `const g = ${name};\nconst h = g;\nexport { h };`,
        `const locks = { ${name} };\nexport default locks;`,
        `const { ${name}: g } = locks;\nexport { g };`,
        `export function ${name}() { return 1; }`,
        `export async function ${name}() { return 1; }`,
        `export const ${name} = () => 1;`,
        `export class ${name} {}`,
        `module.exports = ${name};`,
        `module.exports = { ${name} };`,
        `exports.g = ${name};`,
        `exports['g'] = ${name};`,
      ]) {
        expect({ text, found: exported(text).length > 0 }).toEqual({ text, found: true });
      }
    }
    expect(exported('export { guardLive as g };')).toEqual([
      `${SESSION_STATE_FILE}: exports g`,
      `${SESSION_STATE_FILE}: exports guardLive`,
    ]);
    expect(exported('const g = guardLive;\nexport { g };')).toEqual([
      `${SESSION_STATE_FILE}: exports g`,
    ]);
  });

  it('TC-008 S-B an exported function, arrow or object that WRAPS a lock under a new name is found', () => {
    for (const text of [
      'export function g(tx, s) { return guardLive(tx, s) }',
      'export async function g(tx, s) {\n  return lockAnySession(tx, s);\n}',
      'export const g = (tx, s) => guardLive(tx, s);',
      'export const g = async (tx, s) => {\n  const r = await lockForAccommodation(tx, s);\n  return r;\n};',
      'export const g = function (tx, s) {\n  return guardLive(tx, s);\n};',
      'export const api = {\n  run: (tx, s) => guardLive(tx, s),\n};',
      'export default function (tx, s) {\n  return guardLive(tx, s);\n}',
      "import { guardLive as core } from '../database/session-locks';\nexport const g = (tx, s) => core(tx, s);",
      "import { guardLive as core } from '../database/session-locks';\nexport function g(tx, s) {\n  return core(tx, s);\n}",
    ]) {
      const found = exported(text).filter((line) => line.includes('wrapper of'));
      expect({ text, found: found.length > 0 }).toEqual({ text, found: true });
    }
    expect(exported('export function g(tx, s) { return guardLive(tx, s) }')).toEqual([
      `${SESSION_STATE_FILE}: exports a wrapper of guardLive`,
    ]);
  });

  it('TC-008 S-B a static property that holds or calls a lock is found, a same-named method is not', () => {
    for (const text of [
      'export class S {\n  static g = guardLive;\n}',
      'export class S {\n  static readonly g = (tx, s) => guardLive(tx, s);\n}',
      "import { guardLive as core } from '../database/session-locks';\nexport class S {\n  static g = core;\n}",
      'export class S {\n  static guardLive = lockAnySession;\n}',
    ]) {
      const found = exported(text).filter((line) => line.includes('static property'));
      expect({ text, found: found.length > 0 }).toEqual({ text, found: true });
    }
    expect(exported(STATE_TEXT)).toEqual([]);
  });

  it('TC-008 S3 the wrapper class is not an export of the lock: methods named like the locks, calls, imports, comments are fine', () => {
    for (const text of [
      STATE_TEXT,
      PROCESSOR_TEXT,
      'export default class SessionStateService { guardLive() {} }',
      'export class A { static guardLive() {} }',
      'export const service = new SessionStateService();',
      'export { SessionStateService };',
      'export { SessionStateService as default };',
      '// export { guardLive };\nexport const x = 1;',
      'export const guardLiveWith = 1;',
      'export const lockAnySessionLater = 1;',
      'await this.state.guardLive(tx, sid);\nexport const x = 1;',
      'export function other(tx) {\n  return this.state.guardLive(tx, sid);\n}',
    ]) {
      expect({ text, found: exported(text) }).toEqual({ text, found: [] });
    }
  });

  it('TC-008 S4 a namespace import of the core is refused and is an alias: exporting it exports the whole core', () => {
    const ns = "import * as core from '../database/session-locks';";
    for (const text of [
      `${ns}\nexport { core };`,
      `${ns}\nexport default core;`,
      `${ns}\nexport const c = core;`,
      `${ns}\nexport const locks = { core };`,
      `${ns}\nconst held = core;\nexport { held };`,
      `${ns}\nmodule.exports = core;`,
    ]) {
      const found = exported(text);
      expect({
        text,
        refused: found.includes(
          `${SESSION_STATE_FILE}: imports database/session-locks as a namespace`,
        ),
      }).toEqual({
        text,
        refused: true,
      });
      expect({ text, exports: found.some((line) => line.includes('exports ')) }).toEqual({
        text,
        exports: true,
      });
    }
    // The file names no lock, only the module: it is not skipped, and the import alone is refused.
    expect(exported(ns)).toEqual([
      `${SESSION_STATE_FILE}: imports database/session-locks as a namespace`,
    ]);
    // A named import with no use of a lock name is fine, and a namespace of another module is not this module.
    expect(exported("import { SessionLockTx } from '../database/session-locks';")).toEqual([]);
    expect(exported("import * as other from '../database/other';\nexport { other };")).toEqual([]);
  });

  it("TC-008 N4 TypeScript's `export =` form is found, for a name, an object, an array and an alias", () => {
    for (const name of ['guardLive', 'lockForAccommodation', 'lockAnySession']) {
      for (const text of [
        `export = ${name};`,
        `export=${name};`,
        `export = { ${name} };`,
        `export = [${name}];`,
        `const g = ${name};\nexport = g;`,
        `const locks = { ${name} };\nexport = locks;`,
      ]) {
        expect({ text, found: exported(text).length > 0 }).toEqual({ text, found: true });
      }
    }
    expect(exported('export = guardLive;')).toEqual([`${SESSION_STATE_FILE}: exports guardLive`]);
    expect(exported('export = other;')).toEqual([]);
  });

  describe('S-1: the core reached by import x = require, require() or import() is the whole core under one name (FR-704, NFR-04, TC-008)', () => {
    const REACHES = `${SESSION_STATE_FILE}: reaches database/session-locks other than by an import { name } from statement`;
    const WHOLE = `${SESSION_STATE_FILE}: imports database/session-locks as a namespace`;

    it.each([
      ['import x = require', "import core = require('../database/session-locks');"],
      ['const x = require', "const core = require('../database/session-locks');"],
      ['let x = require', "let core = require('../database/session-locks');"],
      ['var x = require, double quotes', 'var core = require("../database/session-locks");'],
      ['a typed const = require', "const core: unknown = require('../database/session-locks');"],
      ['const x = await import', "const core = await import('../database/session-locks');"],
      ['const x = import', "const core = import('../database/session-locks');"],
      ['a template-literal specifier', 'const core = await import(`../database/session-locks`);'],
      ['a specifier with an extension', "const core = require('../database/session-locks.js');"],
    ])(
      'TC-008 S-1 %s is refused: its name is an alias, and the module is reached other than by a named import',
      (_what, handle) => {
        expect(exported(handle)).toEqual([REACHES, WHOLE].sort());
        for (const use of [
          'export { core };',
          'export default core;',
          'export const c = core;',
          'export const locks = { core };',
          'const held = core;\nexport { held };',
          'module.exports = core;',
          'export = core;',
        ]) {
          const found = exported(`${handle}\n${use}`);
          expect({
            use,
            refused: found.includes(WHOLE),
            exports: found.some((l) => l.includes(' exports ')),
          }).toEqual({
            use,
            refused: true,
            exports: true,
          });
        }
      },
    );

    it('TC-008 S-1 a file that only requires or imports() the module, with no handle and no lock name, is not skipped', () => {
      expect(exported("void import('../database/session-locks');")).toEqual([REACHES]);
      expect(exported("require('../database/session-locks');")).toEqual([REACHES]);
      expect(exported("export const g = require('../database/session-locks').guardLive;")).toEqual(
        expect.arrayContaining([REACHES]),
      );
      expect(exported("import '../database/session-locks';")).toEqual([REACHES]);
      expect(exported("export * from '../database/session-locks';")).toEqual([REACHES]);
    });

    it('TC-008 S-1 a named import of the module, and the same forms for another module, are not findings', () => {
      expect(exported("import { SessionLockTx } from '../database/session-locks';")).toEqual([]);
      expect(
        exported("import type { SessionLockTx } from '../database/session-locks.js';"),
      ).toEqual([]);
      expect(exported("const other = require('../database/other');\nexport { other };")).toEqual(
        [],
      );
      expect(exported("const m = await import('./session-locks-helper');")).toEqual([]);
    });
  });

  it('TC-008 S3 FAIL-SAFE: a string that spells an export is flagged like code (strings are not stripped), a comment is not', () => {
    expect(exported("export const m = 'export { guardLive }';")).toEqual([
      `${SESSION_STATE_FILE}: exports guardLive`,
    ]);
    expect(exported("// export { guardLive }\nexport const m = 'text';")).toEqual([]);
  });

  it('TC-008 S3 a file that names no lock is skipped, and the findings are sorted by path', () => {
    expect(findLockExports([file('a/none.ts', 'export const x = 1;')])).toEqual([]);
    expect(
      findLockExports([
        file('b/two.ts', 'export { lockAnySession };'),
        file('a/one.ts', 'export { guardLive };'),
      ]),
    ).toEqual(['a/one.ts: exports guardLive', 'b/two.ts: exports lockAnySession']);
  });
});

describe('the text tools: brace matching and method spans (NFR-04, TC-008)', () => {
  it('TC-008 matchingBrace skips strings, templates with ${} and nested braces, and gives up on unbalanced text', () => {
    const code = "a { b: '}', c: `x ${ { d: 1 }.d } y`, e: { f: 2 } } tail";
    const open = code.indexOf('{');
    expect(code.slice(open, (matchingBrace(code, open) as number) + 1)).toBe(
      "{ b: '}', c: `x ${ { d: 1 }.d } y`, e: { f: 2 } }",
    );
    expect(matchingBrace('{ never closed', 0)).toBeUndefined();
  });

  it('TC-008 findMethod finds the body of a method with a generic or object return type, skips an overload signature and a bare call', () => {
    const code = `class A {
  foo(): void;
  foo(x?: number): Promise<{ a: number }> {
    return Promise.resolve({ a: 1 });
  }

  async bar<T>(x: T) {
    foo(1);
    return x;
  }
}
`;
    const foo = findMethod(code, 'foo');
    expect(foo).toBeDefined();
    expect(code.slice((foo?.bodyStart as number) + 1, foo?.bodyEnd)).toContain('Promise.resolve');
    const bar = findMethod(code, 'bar');
    expect(code.slice((bar?.bodyStart as number) + 1, bar?.bodyEnd)).toContain('return x');
    expect(findMethod(code, 'baz')).toBeUndefined();
  });

  it('TC-008 N3 findClassBody finds a declared class (export, default, abstract, generics, extends and implements), not a variable class or a longer name', () => {
    for (const header of [
      'class A',
      'export class A',
      'export default class A',
      'export abstract class A',
      'export class A<T extends { x: 1 }> extends B<{ y: 2 }> implements C, D',
      '@Injectable()\nexport class A',
    ]) {
      const code = `${header} {\n  m() {\n    return { a: 1 };\n  }\n}\nconst tail = 1;\n`;
      const body = findClassBody(code, 'A');
      expect({
        header,
        body: body === undefined ? undefined : code.slice(body.bodyStart, body.bodyEnd + 1),
      }).toEqual({
        header,
        body: '{\n  m() {\n    return { a: 1 };\n  }\n}',
      });
    }
    expect(findClassBody('export const A = class {\n  m() {}\n};', 'A')).toBeUndefined();
    expect(findClassBody('class AB {\n  m() {}\n}', 'A')).toBeUndefined();
    expect(findClassBody('class A;', 'A')).toBeUndefined();
    expect(findClassBody('class A {\n  m() {\n', 'A')).toBeUndefined();
  });

  it('TC-008 N3 findMethod within a class body ignores a method of the same name in another class', () => {
    const code = `class First {\n  run() {\n    return 1;\n  }\n}\n\nclass Second {\n  run() {\n    return 2;\n  }\n}\n`;
    const first = findMethod(code, 'run');
    expect(code.slice((first?.bodyStart as number) + 1, first?.bodyEnd)).toContain('return 1');
    const body = findClassBody(code, 'Second') as { bodyStart: number; bodyEnd: number };
    const second = findMethod(code, 'run', body);
    expect(code.slice((second?.bodyStart as number) + 1, second?.bodyEnd)).toContain('return 2');
    expect(findMethod(code, 'missing', body)).toBeUndefined();
    const only = findClassBody(code, 'First') as { bodyStart: number; bodyEnd: number };
    expect(
      findMethod(code.replace('run() {\n    return 1', 'other() {\n    return 1'), 'run', only),
    ).toBeUndefined();
  });

  it('TC-008 N2 findMethod reports the parameter parentheses', () => {
    const code =
      'class A {\n  async m(a: number, b: string): Promise<void> {\n    return;\n  }\n}\n';
    const m = findMethod(code, 'm');
    expect(code.slice((m?.openParen as number) + 1, m?.closeParen)).toBe('a: number, b: string');
  });
});
