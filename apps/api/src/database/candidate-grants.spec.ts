// ADR 0013 CS-4.4, the pure part of the GRANTS: what each of the eleven grant sites unlocks in a CANDIDATE
// scope, on the rewritten arguments (session-scope-args.ts, candidate-interim.ts, session-scope-map.ts),
// and the submissions RUN filter. No database. withGrant itself (the active flag, nesting, ids) is in
// org-context-grant.spec.ts; the same rules against a real Postgres are in cs4-columns-grants.spec.ts.
// NFR-04, TC-008.
import { isDeepStrictEqual } from 'node:util';
import { OrgScopeViolationError } from './errors';
import type { CandidateFacts, SessionActor } from './org-context';
import { CANDIDATE_READ, scalarColumnsOf } from './candidate-interim';
import { ORG_SCOPE } from './org-scope-map';
import type { ModelName } from './org-scope-map';
import { applySessionScope } from './session-scope-args';
import { CANDIDATE_MODELS, GRANT_SITES } from './session-scope-map';
import type { GrantSite, GrantView } from './session-scope-map';
import { readModelMetas } from './testing/data-model';

const ORG = '11111111-1111-4111-8111-111111111111';
const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const FACTS: CandidateFacts = {
  candidateId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
  invitationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
  testId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3',
};

type Args = Record<string, unknown>;

function call(
  model: ModelName,
  operation: string,
  args: Args,
  grant?: GrantView,
  actor: SessionActor = 'CANDIDATE',
) {
  return applySessionScope({
    model,
    rule: ORG_SCOPE[model],
    operation,
    args,
    orgId: ORG,
    session: { actor, sessionId: SID },
    facts: FACTS,
    grant,
  });
}

const grantFor = (
  site: GrantSite,
  ids: GrantView['ids'] = [SID],
  columns?: string[],
): GrantView => ({
  model: site.model,
  columns: columns ?? [...site.columns],
  ids,
  mode: site.mode,
});
const site = (name: string): GrantSite => {
  const found = GRANT_SITES.find((s) => s.name.startsWith(name));
  if (found === undefined) throw new Error(`no grant site ${name}`);
  return found;
};
/** A bigint id for media_chunks, a uuid for the others. */
const idsOf = (s: GrantSite): GrantView['ids'] => (s.idKind === 'bigint' ? [7n] : [SID]);
/** The filter `id IN ids` the extension ANDs in, for a rows grant. */
const idFilter = (grant: GrantView): unknown => ({ id: { in: [...grant.ids] } });
/** The conjuncts of the rewritten where: every AND entry, plus the where's own keys as one object. */
const andOf = (args: Args): unknown[] => {
  const { AND, ...own } = (args.where ?? {}) as { AND?: unknown[] } & Args;
  return [...(AND ?? []), own];
};
const update = { lastHeartbeat: new Date() };

describe('the eleven CS-4.4 grant sites (ADR 0013 CS-4.4; ADR 0006 section 8.5; NFR-04, TC-008)', () => {
  it('TC-008 there are eleven sites: the ten of the ADR table and the consents create (item 9, PR #178)', () => {
    expect(GRANT_SITES).toHaveLength(11);
    expect(GRANT_SITES.map((s) => s.name)).toEqual([
      'SessionStateService',
      'KeyService',
      'DeviceInfoService',
      'StorageService',
      'OrgSettingsService',
      'TestSettingsService',
      'AccommodationsService',
      'SectionGateService (step 1)',
      'SectionGateService (step 2)',
      'ConsentService (consent text)',
      'ConsentService (create)',
    ]);
    expect(new Set(GRANT_SITES.map((s) => s.name)).size).toBe(11);
    expect(GRANT_SITES.filter((s) => s.mode === 'create').map((s) => s.name)).toEqual([
      'ConsentService (create)',
    ]);
  });

  it('TC-008 each site is the model and columns of ADR 0013 CS-4.4 (Prisma field names)', () => {
    const table: Record<string, [string, string[]]> = {
      SessionStateService: ['Session', ['status', 'pauseReasons', 'submittedAt']],
      KeyService: ['Session', ['hmacKeyEnc']],
      DeviceInfoService: ['Session', ['deviceInfo']],
      StorageService: ['MediaChunk', ['objectKey']],
      OrgSettingsService: ['Organization', ['settings']],
      TestSettingsService: ['Test', ['settings']],
      AccommodationsService: ['Invitation', ['accommodations']],
      'SectionGateService (step 1)': ['SessionQuestion', ['testQuestionId']],
      'SectionGateService (step 2)': ['TestQuestion', ['id', 'sectionId']],
      'ConsentService (consent text)': [
        'ConsentText',
        ['id', 'version', 'bodyMd', 'legalApprovedAt'],
      ],
      'ConsentService (create)': [
        'Consent',
        ['sessionId', 'consentTextId', 'signedName', 'signedAt', 'declinedAt', 'ip', 'userAgent'],
      ],
    };
    for (const s of GRANT_SITES) {
      expect({ name: s.name, model: s.model, columns: [...s.columns] }).toEqual({
        name: s.name,
        model: table[s.name]?.[0],
        columns: table[s.name]?.[1],
      });
    }
  });

  it('TC-008 every column of every site is a column of its model, and the id kind is the primary key of the model', async () => {
    const metas = await readModelMetas();
    for (const s of GRANT_SITES) {
      const fields = metas[s.model]?.fields ?? [];
      for (const column of s.columns) {
        expect(`${s.model}.${column}:${fields.some((f) => f.name === column)}`).toBe(
          `${s.model}.${column}:true`,
        );
      }
      const id = fields.find((f) => f.name === 'id');
      expect({ site: s.name, type: id?.type }).toEqual({
        site: s.name,
        type: s.idKind === 'bigint' ? 'BigInt' : 'String',
      });
    }
  });

  it('TC-008 what the sites unlock is exactly what the rules make grant-only: explicit-only reads, granted writes, the two gated models and the consents create', () => {
    for (const model of new Set(GRANT_SITES.map((s) => s.model))) {
      const unlocked = new Set(
        GRANT_SITES.filter((s) => s.model === model).flatMap((s) => s.columns),
      );
      const rule = CANDIDATE_MODELS[model];
      const read = CANDIDATE_READ[model];
      const expected = new Set<string>([
        ...(read?.explicit ?? []),
        ...(rule?.kind === 'session' ? (rule.grantedUpdate ?? []) : []),
        ...(rule?.kind === 'session' ? (rule.grantedCreate ?? []) : []),
        ...(rule?.kind === 'grant-only' ? (read?.read ?? []) : []),
      ]);
      expect({ model, unlocked: [...unlocked].sort() }).toEqual({
        model,
        unlocked: [...expected].sort(),
      });
    }
    // And no other model has an explicit-only column, a granted write or a gated read.
    const sitesModels = new Set(GRANT_SITES.map((s) => s.model));
    for (const [model, rule] of Object.entries(CANDIDATE_MODELS)) {
      if (sitesModels.has(model as ModelName)) continue;
      expect(CANDIDATE_READ[model as ModelName]?.explicit).toEqual([]);
      expect(rule?.kind).not.toBe('grant-only');
      if (rule?.kind === 'session') {
        expect(rule.grantedUpdate).toBeUndefined();
        expect(rule.grantedCreate).toBeUndefined();
      }
    }
  });
});

describe('a grant unlocks the READ of an explicit-only column, on its model only (NFR-04, TC-008)', () => {
  const explicitSites = GRANT_SITES.filter((s) =>
    s.columns.some((c) => CANDIDATE_READ[s.model]?.explicit.includes(c)),
  );

  it.each(explicitSites.map((s) => [s.name, s] as const))(
    'TC-008 %s: without the grant the column throws in every place, with it it is readable in all of them',
    (_name, s) => {
      const columns = s.columns.filter((c) => CANDIDATE_READ[s.model]?.explicit.includes(c));
      expect(columns.length).toBeGreaterThan(0);
      const grant = grantFor(s, idsOf(s));
      for (const column of columns) {
        const places: Array<[string, Args]> = [
          ['findFirst', { select: { [column]: true } }],
          ['findFirst', { where: { [column]: { not: null } } }],
          ['findMany', { orderBy: { [column]: 'asc' } }],
          ['findMany', { distinct: [column] }],
          ['count', { select: { [column]: true } }],
          ['count', { where: { [column]: { not: null } } }],
          ['aggregate', { _count: { [column]: true } }],
          ['groupBy', { by: [column], _count: true }],
        ];
        for (const [operation, args] of places) {
          expect(() => call(s.model, operation, args)).toThrow(
            new RegExp(`the column ${column} is not available`),
          );
          expect({ operation, ok: tryOk(() => call(s.model, operation, args, grant)) }).toEqual({
            operation,
            ok: true,
          });
        }
      }
    },
  );

  it.each(explicitSites.map((s) => [s.name, s] as const))(
    'TC-008 %s: the grant ANDs id IN ids onto every query on its model, and the other filters stay',
    (_name, s) => {
      const grant = grantFor(s, idsOf(s));
      const column = s.columns[0] as string;
      for (const operation of [
        'findUnique',
        'findFirst',
        'findMany',
        'count',
        'aggregate',
        'groupBy',
      ]) {
        const args: Args =
          operation === 'aggregate'
            ? { _count: { [column]: true } }
            : operation === 'groupBy'
              ? { by: [column], _count: true }
              : { select: { [column]: true }, where: { [column]: { not: null } } };
        const out = call(s.model, operation, args, grant).args;
        expect(andOf(out).filter((f) => isDeepStrictEqual(f, idFilter(grant)))).toHaveLength(1);
        // The org filter is still there, and (session models) so is the session filter.
        expect(andOf(out).length).toBeGreaterThanOrEqual(2);
      }
    },
  );

  it.each(explicitSites.map((s) => [s.name, s] as const))(
    "TC-008 %s: it unlocks only that model (the same column name on another model stays refused) and only the site's columns",
    (_name, s) => {
      const column = s.columns[0] as string;
      for (const other of GRANT_SITES.filter((o) => o.model !== s.model && o.mode === 'rows')) {
        const grant = grantFor(other, idsOf(other));
        expect(() => call(s.model, 'findFirst', { select: { [column]: true } }, grant)).toThrow(
          new RegExp(`the column ${column} is not available`),
        );
      }
    },
  );

  it('TC-008 the settings of an organization and of a test are two grants: one does not open the other', () => {
    const org = site('OrgSettingsService');
    const test = site('TestSettingsService');
    expect(() =>
      call('Test', 'findFirst', { select: { settings: true } }, grantFor(org, [ORG])),
    ).toThrow(/the column settings is not available/);
    expect(() =>
      call('Organization', 'findFirst', { select: { settings: true } }, grantFor(test, [OTHER])),
    ).toThrow(/the column settings is not available/);
    expect(() =>
      call('Organization', 'findFirst', { select: { settings: true } }, grantFor(org, [ORG])),
    ).not.toThrow();
    expect(() =>
      call('Test', 'findFirst', { select: { settings: true } }, grantFor(test, [FACTS.testId])),
    ).not.toThrow();
  });

  it('TC-008 a grant names columns of ONE service: KeyService does not open deviceInfo, DeviceInfoService does not open hmacKeyEnc', () => {
    const key = grantFor(site('KeyService'));
    const device = grantFor(site('DeviceInfoService'));
    expect(() => call('Session', 'findFirst', { select: { deviceInfo: true } }, key)).toThrow(
      /the column deviceInfo is not available/,
    );
    expect(() => call('Session', 'findFirst', { select: { hmacKeyEnc: true } }, device)).toThrow(
      /the column hmacKeyEnc is not available/,
    );
    expect(() => call('Session', 'findFirst', { select: { hmacKeyEnc: true } }, key)).not.toThrow();
    expect(() =>
      call('Session', 'findFirst', { select: { deviceInfo: true } }, device),
    ).not.toThrow();
  });

  it('TC-008 explicit-only means explicit under the grant too: the default select still omits the column', () => {
    for (const s of explicitSites) {
      const grant = grantFor(s, idsOf(s));
      const column = s.columns.find((c) => CANDIDATE_READ[s.model]?.explicit.includes(c)) as string;
      const omit = call(s.model, 'findFirst', {}, grant).args.omit as Record<string, true>;
      expect({ site: s.name, omitted: omit[column] }).toEqual({ site: s.name, omitted: true });
    }
  });

  it('TC-008 a grant never widens the model: it reads no other hidden column, and a read-only model stays read-only', () => {
    // KeyService on sessions: invitationId (the guard reads it outside the scope) stays hidden.
    expect(() =>
      call(
        'Session',
        'findFirst',
        { select: { invitationId: true } },
        grantFor(site('KeyService')),
      ),
    ).toThrow(/the column invitationId is not available/);
    expect(() =>
      call(
        'Organization',
        'update',
        { where: {}, data: { settings: {} } },
        grantFor(site('OrgSettingsService'), [ORG]),
      ),
    ).toThrow(/read-only in a CANDIDATE scope/);
    for (const operation of [
      'create',
      'createMany',
      'upsert',
      'delete',
      'deleteMany',
      'updateMany',
    ]) {
      expect(() =>
        call(
          'Invitation',
          operation,
          { where: {}, data: {}, create: {}, update: {} },
          grantFor(site('AccommodationsService'), [FACTS.invitationId]),
        ),
      ).toThrow(/read-only in a CANDIDATE scope/);
    }
    // storage: the object key is writable by the model's own list, grant or not, and the grant adds no other column.
    expect(() =>
      call(
        'MediaChunk',
        'update',
        { where: { id: 1n }, data: { deletedAt: new Date() } },
        grantFor(site('StorageService'), [7n]),
      ),
    ).toThrow(/deletedAt cannot be written by a candidate update here/);
  });

  it('TC-008 SERVICE is not limited and a grant changes nothing for it: no id IN, no omit', () => {
    for (const s of explicitSites) {
      const out = call(
        s.model,
        'findFirst',
        { select: { [s.columns[0] as string]: true } },
        grantFor(s, idsOf(s)),
        'SERVICE',
      ).args;
      expect(
        andOf(out).filter((f) => isDeepStrictEqual(f, idFilter(grantFor(s, idsOf(s))))),
      ).toEqual([]);
      expect(out).not.toHaveProperty('omit');
    }
  });
});

describe('a grant unlocks the WRITE of the session state columns (CS-4.4: SessionStateService, DeviceInfoService)', () => {
  const state = grantFor(site('SessionStateService'));
  const device = grantFor(site('DeviceInfoService'));
  const key = grantFor(site('KeyService'));
  const UPDATES = ['update', 'updateMany', 'updateManyAndReturn'] as const;
  const updateArgs = (operation: string, data: Args): Args =>
    operation === 'upsert'
      ? { where: { id: SID }, create: {}, update: data }
      : { where: { id: SID }, data };

  it.each(['status', 'pauseReasons', 'submittedAt'])(
    'TC-008 sessions.%s: refused without the grant, written under SessionStateService, in every update operation',
    (column) => {
      const data = { [column]: column === 'pauseReasons' ? { set: ['PROCTOR'] } : new Date() };
      for (const operation of UPDATES) {
        expect(() => call('Session', operation, updateArgs(operation, data))).toThrow(
          new RegExp(`${column} cannot be written by a candidate update here`),
        );
        expect(() => call('Session', operation, updateArgs(operation, data), state)).not.toThrow();
        // The other grants of the model do not unlock it.
        for (const other of [device, key]) {
          expect(() => call('Session', operation, updateArgs(operation, data), other)).toThrow(
            new RegExp(`${column} cannot be written by a candidate update here`),
          );
        }
      }
    },
  );

  it('TC-008 sessions.deviceInfo is written under DeviceInfoService only, and read there too', () => {
    for (const operation of UPDATES) {
      expect(() =>
        call('Session', operation, updateArgs(operation, { deviceInfo: { a: 1 } })),
      ).toThrow(/deviceInfo cannot be written by a candidate update here/);
      expect(() =>
        call('Session', operation, updateArgs(operation, { deviceInfo: { a: 1 } }), state),
      ).toThrow(/deviceInfo cannot be written by a candidate update here/);
      expect(() =>
        call('Session', operation, updateArgs(operation, { deviceInfo: { a: 1 } }), device),
      ).not.toThrow();
    }
    // The fenced write of DeviceInfoService: updateMany where the value read is still there.
    expect(() =>
      call(
        'Session',
        'updateMany',
        { where: { id: SID, deviceInfo: { equals: { a: 1 } } }, data: { deviceInfo: { a: 2 } } },
        device,
      ),
    ).not.toThrow();
  });

  it('TC-008 a grant unlocks the columns it names and no other: status alone does not open pauseReasons or submittedAt', () => {
    const onlyStatus = grantFor(site('SessionStateService'), [SID], ['status']);
    expect(() =>
      call('Session', 'update', updateArgs('update', { status: 'PAUSED' }), onlyStatus),
    ).not.toThrow();
    for (const column of ['pauseReasons', 'submittedAt']) {
      expect(() =>
        call('Session', 'update', updateArgs('update', { [column]: null }), onlyStatus),
      ).toThrow(new RegExp(`${column} cannot be written by a candidate update here`));
    }
    // One row naming a granted and an ungranted column throws, whatever the order.
    for (const data of [
      { status: 'PAUSED', authEpoch: 3 },
      { authEpoch: 3, status: 'PAUSED' },
      { status: 'PAUSED', lastHeartbeat: new Date(), totalScore: 1 },
    ]) {
      expect(() => call('Session', 'update', updateArgs('update', data), state)).toThrow(
        OrgScopeViolationError,
      );
    }
    // lastHeartbeat is the model's own column: allowed with or without a grant.
    expect(() => call('Session', 'update', updateArgs('update', update))).not.toThrow();
    expect(() => call('Session', 'update', updateArgs('update', update), state)).not.toThrow();
  });

  it('TC-008 the grant writes the column and nothing else of the row: it never unlocks the keys, the scores or the session keys', () => {
    for (const column of [
      'id',
      'orgId',
      'invitationId',
      'hmacKeyEnc',
      'authEpoch',
      'startedAt',
      'deadlineAt',
      'pausedMs',
      'proctorPausedAt',
      'totalScore',
      'riskScore',
      'riskBand',
      'reportKey',
      'retentionAnchorAt',
      'createdAt',
    ]) {
      for (const operation of UPDATES) {
        for (const grant of [state, device, key]) {
          expect({
            column,
            operation,
            refused: !tryOk(() =>
              call('Session', operation, updateArgs(operation, { [column]: 1 }), grant),
            ),
          }).toEqual({ column, operation, refused: true });
        }
      }
    }
  });

  it('TC-008 KeyService unlocks the READ of the sealed key and no write: hmacKeyEnc is not written by a candidate, grant or not', () => {
    for (const operation of UPDATES) {
      expect(() =>
        call('Session', operation, updateArgs(operation, { hmacKeyEnc: Buffer.from('x') }), key),
      ).toThrow(/hmacKeyEnc cannot be written by a candidate update here/);
    }
  });

  it('TC-008 a grant does not make a model writable: no session create, with or without the grant', () => {
    for (const operation of ['create', 'createMany', 'createManyAndReturn', 'upsert']) {
      expect(() =>
        call(
          'Session',
          operation,
          { data: { status: 'PAUSED' }, create: {}, update: {}, where: {} },
          state,
        ),
      ).toThrow(/cannot create this row/);
    }
    for (const operation of ['delete', 'deleteMany']) {
      expect(() => call('Session', operation, { where: { id: SID } }, state)).toThrow(
        /a candidate deletes nothing/,
      );
    }
  });

  it('TC-008 the grant ANDs id IN ids onto its updates, next to the session filter: a grant of A cannot reach B', () => {
    for (const operation of UPDATES) {
      const out = call(
        'Session',
        operation,
        updateArgs(operation, { status: 'PAUSED' }),
        state,
      ).args;
      expect(andOf(out)).toContainEqual(idFilter(state));
      expect(andOf(out)).toContainEqual({ id: SID }); // the session filter of the scope is still there
    }
  });

  it('TC-008 SERVICE writes the state columns with no grant (the jobs and CS-4.4a)', () => {
    for (const operation of UPDATES) {
      expect(() =>
        call(
          'Session',
          operation,
          updateArgs(operation, { status: 'GRADED', hmacKeyEnc: null }),
          undefined,
          'SERVICE',
        ),
      ).not.toThrow();
    }
  });
});

describe('the two models that are readable only under a grant (CS-4.3: consent_texts, test_questions)', () => {
  const text = site('ConsentService (consent text)');
  const gate = site('SectionGateService (step 2)');

  it.each([
    ['ConsentText', text],
    ['TestQuestion', gate],
  ] as const)(
    'TC-008 %s: under its grant a read passes, filtered by id IN ids, and only the grant columns are readable',
    (model, s) => {
      const grant = grantFor(s, [OTHER]);
      for (const operation of ['findUnique', 'findFirst', 'findMany', 'count']) {
        const out = call(model, operation, { where: { id: OTHER } }, grant).args;
        expect(andOf(out)).toContainEqual(idFilter(grant));
      }
      // The columns of the grant are readable; anything else of the model is not.
      for (const column of s.columns) {
        expect(() =>
          call(
            model,
            'findMany',
            { select: { [column]: true }, orderBy: { [column]: 'asc' } },
            grant,
          ),
        ).not.toThrow();
      }
      for (const column of scalarColumnsOf(model).filter((c) => !s.columns.includes(c))) {
        for (const args of [
          { select: { [column]: true } },
          { where: { [column]: 1 } },
          { orderBy: { [column]: 'asc' } },
        ]) {
          expect(() => call(model, 'findMany', args, grant)).toThrow(
            new RegExp(`the column ${column} is not available`),
          );
        }
      }
    },
  );

  it('TC-008 the default select of a gated model is the grant columns, and a narrower grant narrows it', () => {
    const full = call('ConsentText', 'findMany', {}, grantFor(text, [OTHER])).args.omit as Record<
      string,
      true
    >;
    expect(Object.keys(full).sort()).toEqual([
      'createdAt',
      'createdById',
      'legalApprovedBy',
      'orgId',
    ]);
    const narrow = grantFor(text, [OTHER], ['id', 'version']);
    const omit = call('ConsentText', 'findMany', {}, narrow).args.omit as Record<string, true>;
    expect(Object.keys(omit).sort()).toEqual(
      ['bodyMd', 'createdAt', 'createdById', 'legalApprovedAt', 'legalApprovedBy', 'orgId'].sort(),
    );
    expect(() => call('ConsentText', 'findMany', { select: { bodyMd: true } }, narrow)).toThrow(
      /the column bodyMd is not available/,
    );
    // A grant that leaves out `id` cannot even filter by it.
    const noId = grantFor(gate, [OTHER], ['sectionId']);
    expect(() => call('TestQuestion', 'findFirst', { where: { id: OTHER } }, noId)).toThrow(
      /the column id is not available/,
    );
    expect(() =>
      call('TestQuestion', 'findFirst', { select: { sectionId: true } }, noId),
    ).not.toThrow();
  });

  it("TC-008 test_questions under its grant is also filtered by the session's own questions (the stricter reading, FU-DB-212): another candidate's test question is not reached by a wrong id", () => {
    const grant = grantFor(gate, [OTHER]);
    for (const operation of [
      'findUnique',
      'findFirst',
      'findMany',
      'count',
      'aggregate',
      'groupBy',
    ]) {
      const out = call(
        'TestQuestion',
        operation,
        operation === 'groupBy' ? { by: ['sectionId'], _count: true } : { where: { id: OTHER } },
        grant,
      ).args;
      expect(andOf(out)).toContainEqual({ sessionQuestions: { some: { sessionId: SID } } });
      expect(andOf(out)).toContainEqual(idFilter(grant));
    }
    // consent_texts has no such filter: it is org-wide text, filtered by the org and the ids.
    expect(
      JSON.stringify(call('ConsentText', 'findMany', {}, grantFor(text, [OTHER])).args),
    ).not.toContain('sessionQuestions');
  });

  it('TC-008 the question content stays out of test_questions even under the grant: the version, the rule, the points, the position', () => {
    const grant = grantFor(gate, [OTHER]);
    for (const column of ['questionVersionId', 'randomRule', 'points', 'position']) {
      expect(() =>
        call('TestQuestion', 'findFirst', { select: { [column]: true } }, grant),
      ).toThrow(new RegExp(`the column ${column} is not available`));
    }
  });

  it('TC-008 both are read-only under the grant: every write operation throws', () => {
    for (const [model, s] of [
      ['ConsentText', text],
      ['TestQuestion', gate],
    ] as const) {
      for (const operation of [
        'create',
        'createMany',
        'update',
        'updateMany',
        'upsert',
        'delete',
        'deleteMany',
      ]) {
        expect(() =>
          call(
            model,
            operation,
            { where: {}, data: {}, create: {}, update: {} },
            grantFor(s, [OTHER]),
          ),
        ).toThrow(/read-only in a CANDIDATE scope/);
      }
    }
  });

  it('TC-008 the grant carries its ids to the filter as given: the two ids of the consent text read, one id of the step 2 read', () => {
    const two = grantFor(text, [OTHER, SID]);
    expect(andOf(call('ConsentText', 'findMany', {}, two).args)).toContainEqual({
      id: { in: [OTHER, SID] },
    });
    // A caller's own id filter only narrows within the ids.
    const out = call('ConsentText', 'findMany', { where: { id: 'someone-else' } }, two).args;
    expect(out.where).toMatchObject({ id: 'someone-else' });
    expect(andOf(out)).toContainEqual({ id: { in: [OTHER, SID] } });
  });

  it('TC-008 SectionGateService step 1 reads session_questions.testQuestionId, and does not make session_questions writable beyond its own list', () => {
    const step1 = grantFor(site('SectionGateService (step 1)'), [OTHER]);
    const out = call(
      'SessionQuestion',
      'findFirst',
      { select: { testQuestionId: true } },
      step1,
    ).args;
    expect(andOf(out)).toContainEqual({ id: { in: [OTHER] } });
    // testQuestionId stays immutable for a candidate: the grant is a read.
    expect(() =>
      call(
        'SessionQuestion',
        'update',
        { where: { id: OTHER }, data: { testQuestionId: OTHER } },
        step1,
      ),
    ).toThrow(/testQuestionId is a session key/);
  });
});

describe('the submissions RUN filter (CS-4.4: results, passed and total are RUN-row columns; score is never readable)', () => {
  const RUN = { kind: 'RUN' };
  const columns = ['results', 'passed', 'total'] as const;

  it.each(columns)(
    'TC-008 %s: wherever it appears (select, where, having, orderBy, distinct, by, an aggregate) kind = RUN is ANDed in',
    (column) => {
      const places: Array<[string, Args]> = [
        ['findMany', { select: { id: true, [column]: true } }],
        ['findFirst', { where: { [column]: { not: null } } }],
        ['findFirst', { where: { OR: [{ id: 'x' }, { NOT: { [column]: 1 } }] } }],
        ['findMany', { orderBy: { [column]: 'asc' } }],
        ['findMany', { distinct: [column] }],
        ['count', { where: { kind: 'SUBMIT', [column]: 1 } }],
        ['count', { select: { _all: true, [column]: true } }],
        ['aggregate', { _sum: { [column]: true } }],
        ['aggregate', { _max: { [column]: true } }],
        ['groupBy', { by: [column], _count: true }],
        ['groupBy', { by: ['kind'], _count: true, having: { [column]: { gt: 1 } } }],
        ['groupBy', { by: ['kind'], _count: true, orderBy: { _min: { [column]: 'asc' } } }],
      ];
      // `results` is JSON and `passed` and `total` are numbers: the aggregates that Postgres refuses
      // are not the extension's business, so only the filter is asserted.
      for (const [operation, args] of places) {
        expect({ operation, filters: andOf(call('Submission', operation, args).args) }).toEqual({
          operation,
          filters: expect.arrayContaining([RUN]) as unknown,
        });
      }
    },
  );

  it('TC-008 count({ where: { kind: SUBMIT, passed: N } }) therefore runs with kind SUBMIT AND kind RUN: it can only be 0', () => {
    const where = call('Submission', 'count', { where: { kind: 'SUBMIT', passed: 3 } }).args
      .where as { kind: string; AND: unknown[] };
    expect(where.kind).toBe('SUBMIT');
    expect(where.AND).toContainEqual(RUN);
  });

  it('TC-008 a query that names none of them runs with no RUN filter, and so does the default select (it omits them)', () => {
    for (const [operation, args] of [
      ['findMany', { select: { id: true, kind: true, language: true } }],
      ['findMany', {}],
      ['count', { where: { kind: 'SUBMIT' } }],
      ['aggregate', { _count: true }],
      ['groupBy', { by: ['kind'], _count: true }],
    ] as const) {
      expect(andOf(call('Submission', operation, args).args)).not.toContainEqual(RUN);
    }
    const omit = call('Submission', 'findMany', {}).args.omit as Record<string, true>;
    expect(Object.keys(omit).sort()).toEqual(['passed', 'results', 'score', 'sourceCode', 'total']);
  });

  it('TC-008 score and sourceCode are never readable, RUN filter or not', () => {
    for (const column of ['score', 'sourceCode']) {
      for (const args of [
        { select: { [column]: true } },
        { select: { id: true, results: true }, where: { [column]: 1 } },
        { orderBy: { [column]: 'asc' } },
        { select: { id: true, passed: true }, distinct: [column] },
      ]) {
        expect(() => call('Submission', 'findMany', args)).toThrow(
          new RegExp(`the column ${column} is not available`),
        );
      }
      expect(() => call('Submission', 'aggregate', { _sum: { [column]: true } })).toThrow(
        new RegExp(`the column ${column} is not available`),
      );
    }
  });

  it('TC-008 the filter is ANDed next to the session filter and the org filter, never instead of them', () => {
    const out = call('Submission', 'findMany', { select: { results: true } }).args;
    expect(andOf(out)).toEqual(
      expect.arrayContaining([
        { sessionQuestion: { sessionId: SID } },
        { sessionQuestion: { session: { orgId: ORG } } },
        RUN,
      ]),
    );
  });

  it.each(columns)(
    'TC-008 %s is writable on a create of a RUN row only: on a SUBMIT row, with no kind, and in a batch with one such row, it throws',
    (column) => {
      const row = (kind: unknown) => ({
        sessionQuestionId: OTHER,
        language: 'python',
        sourceCode: 'x',
        ...(kind === undefined ? {} : { kind }),
        [column]: column === 'results' ? [] : 1,
      });
      for (const operation of ['create', 'createMany', 'createManyAndReturn']) {
        const args = (r: unknown): Args => ({ data: operation === 'create' ? r : [r] });
        expect(() => call('Submission', operation, args(row('RUN')))).not.toThrow();
        for (const kind of ['SUBMIT', undefined, 'run', null]) {
          expect(() => call('Submission', operation, args(row(kind)))).toThrow(
            /can be written only on a row whose kind is RUN/,
          );
        }
      }
      expect(() => call('Submission', 'createMany', { data: [row('RUN'), row('SUBMIT')] })).toThrow(
        /can be written only on a row whose kind is RUN/,
      );
      // A SUBMIT row without those columns is the plain CS-4.4 create.
      expect(() =>
        call('Submission', 'create', {
          data: { sessionQuestionId: OTHER, kind: 'SUBMIT', language: 'python', sourceCode: 'x' },
        }),
      ).not.toThrow();
    },
  );

  it('TC-008 a create that reads results, passed or total back is allowed for RUN rows only (there is no where to filter)', () => {
    const base = { sessionQuestionId: OTHER, language: 'python', sourceCode: 'x' };
    for (const column of columns) {
      expect(() =>
        call('Submission', 'create', {
          data: { ...base, kind: 'RUN' },
          select: { [column]: true },
        }),
      ).not.toThrow();
      expect(() =>
        call('Submission', 'create', {
          data: { ...base, kind: 'SUBMIT' },
          select: { [column]: true },
        }),
      ).toThrow(/can be read only on RUN rows/);
      expect(() =>
        call('Submission', 'createManyAndReturn', {
          data: [
            { ...base, kind: 'RUN' },
            { ...base, kind: 'SUBMIT' },
          ],
          select: { [column]: true },
        }),
      ).toThrow(/can be read only on RUN rows/);
    }
    // Without those columns in the select nothing is read, so a SUBMIT row is fine.
    expect(() =>
      call('Submission', 'create', { data: { ...base, kind: 'SUBMIT' }, select: { id: true } }),
    ).not.toThrow();
  });

  it('TC-008 a submission has no candidate update, and no grant adds one', () => {
    for (const operation of ['update', 'updateMany', 'updateManyAndReturn', 'upsert']) {
      expect(() =>
        call('Submission', operation, {
          where: { id: 'x' },
          data: { results: [] },
          create: {},
          update: { results: [] },
        }),
      ).toThrow(/cannot update this row: CS-4\.4 grants create only/);
    }
  });

  it('TC-008 SERVICE reads and writes every column of every row: the RUN filter is a CANDIDATE rule', () => {
    const out = call(
      'Submission',
      'findMany',
      { select: { results: true, score: true } },
      undefined,
      'SERVICE',
    ).args;
    expect(andOf(out)).not.toContainEqual(RUN);
    expect(() =>
      call(
        'Submission',
        'create',
        {
          data: {
            sessionQuestionId: OTHER,
            kind: 'SUBMIT',
            language: 'x',
            sourceCode: 'x',
            score: 90,
            results: [],
            passed: 1,
            total: 2,
          },
        },
        undefined,
        'SERVICE',
      ),
    ).not.toThrow();
  });
});

function tryOk(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}
