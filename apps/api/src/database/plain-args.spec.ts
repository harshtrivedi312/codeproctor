// Query arguments must be plain, in every scope (review of #185, B1; CLAUDE.md rule 3). Prisma 7.10 turns a key
// named `__proto__` that JSON.parse made an own property into the prototype of the args the extension receives,
// and honours inherited keys in nested `where` and `data`; the scope checks read own keys only. plain-args.ts
// refuses both, in the hook, before any other check. No database: the client points at a closed port, so a
// query that is ALLOWED fails with a connection error, which tells it apart from a refusal (OrgScopeError).
// The same inputs against Postgres, with the statement count and the rows, are in cs4-columns-grants.spec.ts.
// NFR-04, TC-008.
import { runInNewContext } from 'node:vm';
import { setCandidateFacts } from './candidate-facts';
import { createPrismaClient } from './create-prisma-client';
import { OrgScopeError, OrgScopeViolationError } from './errors';
import { assertCandidateColumns } from './candidate-interim';
import { OrgContextService } from './org-context';
import { createOrgScopedClient } from './org-scope.extension';
import {
  assertPlainArgs,
  isPlainPrototype,
  JSON_COLUMNS,
  JSON_VALUE_OPERATORS,
  MAX_STRUCTURE_DEPTH,
  ownArgs,
  ownValue,
} from './plain-args';
import { applyOrgScope } from './org-scope-args';
import { ORG_SCOPE } from './org-scope-map';
import { applySessionScope } from './session-scope-args';
import { Prisma } from '../generated/prisma/client.js';
import { readModelMetas } from './testing/data-model';

const ORG = '11111111-1111-4111-8111-111111111111';
const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const FACTS = {
  candidateId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
  invitationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
  testId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3',
};
const refused = /query arguments must be plain objects/;

/** A JSON body as a request would carry it: `__proto__` is an OWN property here. */
const json = (text: string): never => JSON.parse(text) as never;
const POLLUTED_SELECT = '{"__proto__":{"select":{"id":true}}}';

describe('plain-args: the pure check (review of #185, B1; NFR-04, TC-008)', () => {
  const plain = (args: unknown): void => assertPlainArgs('Session', 'findMany', args);

  describe('what is refused', () => {
    it('TC-008 a top-level object whose prototype carries keys: JSON.parse with an own __proto__, and Object.create', () => {
      const own = json(POLLUTED_SELECT);
      // JSON.parse made an own property; the test builds the object Prisma hands to the hook.
      expect(Object.hasOwn(own, '__proto__')).toBe(true);
      expect(() => plain(own)).toThrow(refused);
      const handed = Object.create({ select: { id: true } }) as object;
      expect(() => plain(handed)).toThrow(refused);
      // A prototype that merely exists is refused too, with or without keys.
      expect(() => plain(Object.create({}))).toThrow(refused);
      expect(() => plain(Object.create(Object.create(null) as object))).toThrow(refused);
      class Args {
        where = {};
      }
      expect(() => plain(new Args())).toThrow(refused);
    });

    it('TC-008 an own __proto__ key at the top level, even when the prototype is still Object.prototype', () => {
      expect(() => plain(json('{"__proto__":{},"where":{}}'))).toThrow(/own "__proto__" key/);
    });

    it.each([
      'where',
      'select',
      'omit',
      'include',
      'orderBy',
      'having',
      'cursor',
      '_count',
      'groupBy',
    ])(
      'TC-008 %s: a nested structure object with an inherited key, an own __proto__ or a foreign prototype is refused',
      (key) => {
        for (const bad of [
          Object.create({ hmacKeyEnc: true }) as object,
          json('{"id":true,"__proto__":{"hmacKeyEnc":true}}'),
          Object.assign(Object.create({}) as object, { id: true }),
        ]) {
          expect(() => plain({ [key]: bad })).toThrow(refused);
        }
      },
    );

    it('TC-008 deep inside a where: AND, OR, NOT, arrays and a relation filter are walked', () => {
      const bad = Object.create({ id: OTHER }) as object;
      for (const where of [
        { AND: [{ id: 'x' }, bad] },
        { OR: [{ NOT: bad }] },
        { NOT: { AND: [[bad]] } },
        { sessions: { some: bad } },
        { id: { not: { not: bad } } },
        { deviceInfo: { path: [bad], equals: 1 } },
        { status: { equals: bad } },
      ]) {
        expect(() => plain({ where })).toThrow(refused);
      }
      expect(() => plain({ orderBy: [{ id: 'asc' }, bad] })).toThrow(refused);
      expect(() => plain({ select: { questions: { where: bad } } })).toThrow(refused);
    });

    it(`TC-008 a structure nested more than ${MAX_STRUCTURE_DEPTH} levels is refused, never a RangeError`, () => {
      let where: unknown = { id: 'x' };
      for (let i = 0; i < 100_000; i++) where = { NOT: where };
      expect(() => plain({ where })).toThrow(/nested more than 64 levels/);
      let list: unknown = [{ id: 'x' }];
      for (let i = 0; i < 100_000; i++) list = [list];
      expect(() => plain({ where: { AND: list } })).toThrow(/nested more than 64 levels/);
      // The limit itself is not off by one.
      let ok: unknown = { id: 'x' };
      for (let i = 0; i < MAX_STRUCTURE_DEPTH - 1; i++) ok = { NOT: ok };
      expect(() => plain({ where: ok })).not.toThrow();
    });

    it.each(['data', 'create', 'update'])(
      'TC-008 %s: the row, and one level below a column, refuse an inherited key and an own __proto__',
      (key) => {
        const inherited = Object.assign(Object.create({ status: 'PAUSED' }) as object, {
          lastHeartbeat: new Date(),
        });
        // A data row needs a plain prototype too (FU-DB-281), so the prototype check refuses it first.
        expect(() => plain({ [key]: inherited })).toThrow(
          /a prototype other than Object.prototype/,
        );
        expect(() =>
          plain({ [key]: json('{"lastHeartbeat":"x","__proto__":{"status":"PAUSED"}}') }),
        ).toThrow(/own "__proto__" key/);
        // One level below: a { set } or { increment } object, or a JSON value.
        expect(() =>
          plain({ [key]: { points: Object.create({ increment: 5 }) as object } }),
        ).toThrow(/a prototype other than Object.prototype/);
        expect(() => plain({ [key]: { settings: json('{"a":1,"__proto__":{"b":2}}') } })).toThrow(
          /own "__proto__" key/,
        );
      },
    );

    it('TC-008 every row of a createMany, and a createMany given one row', () => {
      const bad = Object.create({ source: 'SERVER' }) as object;
      for (const data of [[{ a: 1 }, { a: 2 }, bad], bad, [[bad]]]) {
        expect(() => plain({ data })).toThrow(/a prototype other than Object.prototype/);
      }
    });

    it('TC-008 the message names the model, the operation and the place, never a value', () => {
      let message = '';
      try {
        assertPlainArgs('Session', 'update', {
          where: { id: 'secret-id-value' },
          data: Object.create({ status: 'secret-status-value' }) as object,
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('Session.update');
      expect(message).toContain('data');
      expect(message).not.toContain('secret');
    });
  });

  describe('what passes (no over-refusal)', () => {
    it('TC-008 absent, empty and null-prototype arguments, plain and null-prototype nested objects', () => {
      for (const args of [undefined, null, {}, Object.create(null)])
        expect(() => plain(args)).not.toThrow();
      const nullProto = Object.assign(Object.create(null) as object, {
        where: Object.assign(Object.create(null) as object, { id: 'x' }),
        select: { id: true },
      });
      expect(() => plain(nullProto)).not.toThrow();
    });

    it('TC-008 a normal query of every shape: filters, ordering, paging, aggregates, writes', () => {
      for (const args of [
        {
          where: {
            id: 'x',
            OR: [{ status: 'PAUSED' }, { NOT: { startedAt: { lt: new Date() } } }],
          },
        },
        {
          select: { id: true, status: true },
          orderBy: [{ startedAt: 'asc' }, { id: 'desc' }],
          take: 10,
          skip: 1,
        },
        {
          by: ['status'],
          _count: { _all: true },
          _max: { startedAt: true },
          having: { status: { in: ['A'] } },
        },
        { where: { sessions: { some: { id: 'x' } } }, cursor: { id: 'x' }, distinct: ['status'] },
        {
          data: {
            status: 'PAUSED',
            pausedMs: { increment: 5 },
            pauseReasons: { set: ['PROCTOR'] },
          },
        },
        { data: [{ a: 1 }, { a: 2 }], skipDuplicates: true },
        { create: { a: 1 }, update: { a: { set: 2 } }, where: { id: 'x' } },
        { where: { deviceInfo: { path: ['a', 'b'], equals: { c: [1, 2, { d: null }] } } } },
      ]) {
        expect(() => plain(args)).not.toThrow();
      }
    });

    it('TC-008 values that are objects but not structure: Date, Buffer, Uint8Array, Decimal, the Json null sentinels, field references', () => {
      const fields = createPrismaClient('postgresql://nobody:nothing@127.0.0.1:1/none');
      try {
        const ref = (fields as unknown as { session: { fields: Record<string, unknown> } }).session
          .fields.deadlineAt;
        expect(ref).toBeDefined();
        for (const value of [
          new Date(),
          Buffer.from('x'),
          new Uint8Array(2),
          new Prisma.Decimal('1.5'),
          Prisma.DbNull,
          Prisma.JsonNull,
          Prisma.AnyNull,
          ref,
          1n,
          Symbol('s'),
        ]) {
          expect(() =>
            plain({ where: { x: { equals: value } }, data: { y: value } }),
          ).not.toThrow();
        }
      } finally {
        void fields.$disconnect();
      }
    });

    it('TC-008 a class instance is refused everywhere the hook looks, a data row included (FU-DB-281); through the client a DTO still works, as Prisma clones it first', () => {
      class Dto {
        status = 'PAUSED';
        method(): number {
          return 1;
        }
      }
      for (const args of [
        { data: new Dto() },
        { data: { settings: new Dto() } },
        { data: [new Dto()] },
        { where: new Dto() },
        new Dto(),
      ]) {
        expect(() => plain(args)).toThrow(/a prototype other than Object.prototype/);
      }
      // The client-level case (the hook sees Prisma's plain clone of the DTO) is in the "real client" block.
    });

    it('TC-008 Object.prototype of another realm (a vm context, as in a worker) is plain', () => {
      const foreign = runInNewContext('({ select: { id: true }, where: { id: "x" } })') as object;
      expect(Object.getPrototypeOf(foreign)).not.toBe(Object.prototype);
      expect(isPlainPrototype(Object.getPrototypeOf(foreign))).toBe(true);
      expect(() => plain(foreign)).not.toThrow();
      // But a prototype that JSON.parse could build is not, whichever realm built it.
      const parent = runInNewContext('({ select: { id: true } })') as object;
      expect(isPlainPrototype(parent)).toBe(false);
      expect(() => plain(Object.create(parent) as object)).toThrow(refused);
    });

    it('TC-008 JSON column contents are not walked: a deep payload costs nothing, and a createMany of 5000 rows is quick', () => {
      let deep: unknown = { leaf: true };
      for (let i = 0; i < 50_000; i++) deep = { next: deep };
      expect(() => plain({ data: { events: deep } })).not.toThrow();
      const rows = Array.from({ length: 5000 }, (_, i) => ({
        seq: i,
        events: [{ a: i, b: { c: [1, 2, 3] } }],
      }));
      const started = process.hrtime.bigint();
      plain({ data: rows });
      expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(250);
    });
  });
});

/** Prisma's brand of its null sentinels: its argument clone passes an object that carries it BY REFERENCE. */
const BRAND = Symbol.for('prisma.objectEnumValue');
const HIDDEN_KEY = /a non-enumerable key|an accessor|a symbol key|a Proxy/;

describe('plain-args: hidden keys, anywhere in the tree (FU-DB-281; #261 delta review, S1; NFR-04, TC-008)', () => {
  const plain = (args: unknown): void => assertPlainArgs('Session', 'findMany', args);

  /** Each shape hides something from an own-enumerable walk that Prisma's [[Get]] (or a trap) still answers. */
  const HIDDEN: Array<[string, () => object]> = [
    [
      'a non-enumerable own select',
      () => Object.defineProperty({}, 'select', { value: { hmacKeyEnc: true } }),
    ],
    [
      'a non-enumerable own include',
      () => Object.defineProperty({}, 'include', { value: { invitation: true } }),
    ],
    [
      'an enumerable getter',
      () => Object.defineProperty({}, 'id', { get: () => true, enumerable: true }),
    ],
    ['a non-enumerable getter', () => Object.defineProperty({}, 'include', { get: () => ({}) })],
    [
      'a setter alone',
      () => Object.defineProperty({}, 'id', { set: () => undefined, enumerable: true }),
    ],
    ['a symbol key', () => ({ [Symbol('hidden')]: true })],
    ["Prisma's brand, which its clone passes by reference", () => ({ [BRAND]: true })],
    ['a Proxy', () => new Proxy({}, {})],
    [
      'a Proxy whose get trap answers select',
      () =>
        new Proxy({}, { get: (_t, key) => (key === 'select' ? { hmacKeyEnc: true } : undefined) }),
    ],
  ];

  /** Every place the walk visits, with the hiding object put there. */
  const PLACES: Array<[string, (bad: object) => unknown]> = [
    ['the arguments', (bad) => bad],
    ['where', (bad) => ({ where: bad })],
    ['where, under AND', (bad) => ({ where: { AND: [{ id: 'x' }, bad] } })],
    ['where, a relation filter', (bad) => ({ where: { invitation: { is: bad } } })],
    ['where, the filter of a Json column', (bad) => ({ where: { deviceInfo: bad } })],
    ['select', (bad) => ({ select: bad })],
    ['select, the args of a relation', (bad) => ({ select: { id: true, invitation: bad } })],
    ['select, _count', (bad) => ({ select: { id: true, _count: bad } })],
    ['include, the args of a relation', (bad) => ({ include: { invitation: bad } })],
    [
      'include, deep',
      (bad) => ({ include: { invitation: { include: { candidate: { select: bad } } } } }),
    ],
    ['omit', (bad) => ({ omit: bad })],
    ['orderBy', (bad) => ({ orderBy: [{ id: 'asc' }, bad] })],
    ['having', (bad) => ({ having: bad })],
    ['cursor', (bad) => ({ cursor: bad })],
    ['an aggregate', (bad) => ({ _count: bad })],
    ['data, the row', (bad) => ({ data: bad })],
    ['data, one level below a column', (bad) => ({ data: { deviceInfo: bad } })],
    ['a createMany row', (bad) => ({ data: [{ orgId: 'x' }, bad] })],
    ['an upsert create', (bad) => ({ where: { id: 'x' }, create: bad, update: {} })],
    ['an upsert update', (bad) => ({ where: { id: 'x' }, create: {}, update: bad })],
  ];

  it.each(PLACES)('TC-008 %s: every hidden-key shape is refused', (_place, put) => {
    for (const [shape, make] of HIDDEN) {
      expect({ shape, refused: !passes(() => plain(put(make()))) }).toEqual({
        shape,
        refused: true,
      });
      expect(() => plain(put(make()))).toThrow(HIDDEN_KEY);
    }
  });

  it('TC-008 the checks run before any getter of the caller does, and the message names no key and no value', () => {
    let reads = 0;
    const bad = Object.defineProperty({}, 'include', {
      get: () => {
        reads += 1;
        return { secretRelation: true };
      },
      enumerable: true,
    });
    let message = '';
    try {
      plain({ select: { id: true, invitation: bad } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(reads).toBe(0);
    expect(message).toMatch(/an accessor \(a getter or a setter\) in select is refused/);
    expect(message).not.toMatch(/include|secret/);
  });

  it('TC-008 arrays: a foreign prototype, a Proxy, a symbol key, a named key, a getter or a non-enumerable index are refused in structure and createMany rows', () => {
    class List extends Array<unknown> {}
    const ARRAYS: Array<[string, () => unknown[]]> = [
      ['an Array subclass', () => List.from([{ id: 'x' }])],
      [
        'an array on another array',
        () => Object.setPrototypeOf([{ id: 'x' }], [] as unknown[]) as unknown[],
      ],
      ['a Proxy of an array', () => new Proxy([{ id: 'x' }], {})],
      ['the brand', () => Object.assign([{ id: 'x' }], { [BRAND]: true })],
      ['a named key', () => Object.assign([{ id: 'x' }], { select: { id: true } })],
      [
        'a non-enumerable named key',
        () => Object.defineProperty([{ id: 'x' }], 'select', { value: { id: true } }),
      ],
      [
        'a getter at an index',
        () => Object.defineProperty([], '0', { get: () => ({ id: 'x' }), enumerable: true }),
      ],
      [
        'a non-enumerable index',
        () => Object.defineProperty([], '0', { value: { id: 'x' }, enumerable: false }),
      ],
    ];
    const PUT: Array<[string, (list: unknown[]) => unknown]> = [
      ['where AND', (list) => ({ where: { AND: list } })],
      ['orderBy', (list) => ({ orderBy: list })],
      ['distinct', (list) => ({ distinct: list })],
      ['createMany rows', (list) => ({ data: list })],
    ];
    for (const [shape, make] of ARRAYS) {
      for (const [place, put] of PUT) {
        expect({ shape, place, refused: !passes(() => plain(put(make()))) }).toEqual({
          shape,
          place,
          refused: true,
        });
      }
    }
    // One level below a data column an array is a value (a scalar list, a Json array): its prototype, a Proxy and a
    // symbol key are refused, and its elements and named keys are not looked at (Prisma reads it as a value).
    for (const [shape, make] of ARRAYS.slice(0, 4)) {
      expect({ shape, refused: !passes(() => plain({ data: { pauseReasons: make() } })) }).toEqual({
        shape,
        refused: true,
      });
    }
    expect(() =>
      plain({ data: { pauseReasons: Object.assign(['PROCTOR'], { note: 1 }) } }),
    ).not.toThrow();
    expect(() => plain({ where: { AND: [{ id: 'x' }, [{ id: 'y' }]] } })).not.toThrow();
    // A sparse array has holes, not hidden keys.
    // eslint-disable-next-line no-sparse-arrays
    expect(() => plain({ orderBy: [{ id: 'asc' }, , { status: 'desc' }] })).not.toThrow();
  });

  it('TC-008 a value object is skipped only when it is the real thing: a look-alike, or a real one with something added, is walked and refused', () => {
    const client = createPrismaClient('postgresql://nobody:nothing@127.0.0.1:1/none');
    try {
      const ref = (client as unknown as { session: { fields: Record<string, object> } }).session
        .fields.deadlineAt as object;
      const refProto = Object.getPrototypeOf(ref) as object;
      const polluted = (): object => Object.create({ hmacKeyEnc: true }) as object;
      const FAKES: Array<[string, () => object]> = [
        ['a Date with an own key', () => Object.assign(new Date(), { select: { id: true } })],
        [
          'a Date with a non-enumerable own key',
          () => Object.defineProperty(new Date(), 'select', { value: { id: true } }),
        ],
        ['a Date with the brand', () => Object.assign(new Date(), { [BRAND]: true })],
        ['a Date subclass', () => new (class extends Date {})()],
        ['a Proxy of a Date', () => new Proxy(new Date(), {})],
        ['a Uint8Array subclass', () => new (class extends Uint8Array {})(2)],
        ['a byte array with the brand', () => Object.assign(new Uint8Array(2), { [BRAND]: true })],
        ['a DataView', () => new DataView(new ArrayBuffer(2))],
        ['a Decimal with an own key', () => Object.assign(new Prisma.Decimal(1), { select: {} })],
        [
          'a Decimal with a getter',
          () => Object.defineProperty(new Prisma.Decimal(1), 's', { get: () => 1 }),
        ],
        [
          'a Decimal look-alike on a prototype with a key (the old duck test skipped it)',
          () => Object.assign(polluted(), { s: 1, e: 0, d: [1], toStringTag: '[object Decimal]' }),
        ],
        [
          'a field reference with a key added',
          () => Object.assign(Object.create(refProto) as object, ref, { select: {} }),
        ],
        [
          'a field reference with the brand',
          () => Object.assign(Object.create(refProto) as object, ref, { [BRAND]: true }),
        ],
        ['an object built on a field reference', () => Object.create(ref) as object],
        ['a Proxy of a field reference', () => new Proxy(ref, {})],
        [
          'a field reference look-alike on a prototype with a key (the old duck test skipped it)',
          () =>
            Object.assign(polluted(), {
              modelName: 'Session',
              name: 'id',
              typeName: 'String',
              isList: false,
              isEnum: false,
            }),
        ],
      ];
      const PUT: Array<[string, (value: object) => unknown]> = [
        ['a where operand', (value) => ({ where: { startedAt: { equals: value } } })],
        ['a data column', (value) => ({ data: { lastHeartbeat: value } })],
        ['a select entry', (value) => ({ select: { id: value } })],
      ];
      for (const [shape, make] of FAKES) {
        for (const [place, put] of PUT) {
          expect({ shape, place, refused: !passes(() => plain(put(make()))) }).toEqual({
            shape,
            place,
            refused: true,
          });
        }
      }
      // The real ones still pass, of this realm and of another (a vm context), and a large Buffer costs nothing.
      const big = Buffer.alloc(1 << 20);
      const REAL: unknown[] = [
        new Date(),
        runInNewContext('new Date()'),
        Buffer.from('x'),
        Buffer.from('xyz').subarray(1),
        new Uint8Array(2),
        runInNewContext('new Uint8Array(2)'),
        new Prisma.Decimal('1.5'),
        Prisma.DbNull,
        ref,
        (client as unknown as { session: { fields: Record<string, object> } }).session.fields.id,
      ];
      for (const value of REAL) {
        expect(() =>
          plain({ where: { startedAt: { equals: value } }, data: { lastHeartbeat: value } }),
        ).not.toThrow();
      }
      const started = process.hrtime.bigint();
      plain({ data: { signature: big }, where: { signature: { equals: big } } });
      expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(20);
    } finally {
      void client.$disconnect();
    }
  });
});

describe('plain-args: own-key reads (defence in depth against a polluted Object.prototype)', () => {
  it('TC-008 ownValue and ownArgs never read an inherited key', () => {
    const inherited = Object.create({ select: { id: true } }) as Record<string, unknown>;
    expect(ownValue(inherited, 'select')).toBeUndefined();
    expect(ownValue({ select: 1 }, 'select')).toBe(1);
    expect(ownValue(null, 'select')).toBeUndefined();
    expect(ownValue('x', 'select')).toBeUndefined();
    expect(ownArgs(inherited).select).toBeUndefined();
    expect(Object.getPrototypeOf(ownArgs({ a: 1 }))).toBeNull();
    expect(ownArgs({ a: 1 })).toEqual({ a: 1 });
  });

  it('TC-008 a polluted Object.prototype with select, where, data and cursor changes nothing the scope decides', () => {
    const keys = ['select', 'omit', 'where', 'data', 'cursor', 'include', 'orderBy', 'having'];
    for (const key of keys) {
      Object.defineProperty(Object.prototype, key, {
        value: key === 'cursor' ? { id: OTHER } : { id: true },
        configurable: true,
        enumerable: false,
        writable: true,
      });
    }
    try {
      // CANDIDATE: no own select, so the default omit is added, and no cursor is seen.
      const candidate = applySessionScope({
        model: 'Session',
        rule: ORG_SCOPE.Session,
        operation: 'findMany',
        args: { take: 1 },
        orgId: ORG,
        session: { actor: 'CANDIDATE', sessionId: SID },
        facts: FACTS,
      });
      expect(candidate.args.omit).toMatchObject({ hmacKeyEnc: true, invitationId: true });
      expect(Object.hasOwn(candidate.args, 'select')).toBe(false);
      // The org scope forwards no cursor and no data it never saw.
      const org = applyOrgScope({
        model: 'Session',
        rule: ORG_SCOPE.Session,
        operation: 'update',
        args: { where: { id: SID }, data: { lastHeartbeat: 1 } },
        orgId: ORG,
      });
      expect(Object.keys(org).sort()).toEqual(['data', 'where']);
    } finally {
      for (const key of keys) delete (Object.prototype as Record<string, unknown>)[key];
    }
    expect(Object.hasOwn(Object.prototype, 'select')).toBe(false);
  });
});

describe('plain-args: the column check read straight (no own-key copy in front of it)', () => {
  it('TC-008 assertCandidateColumns reads select, omit, where, orderBy, distinct, by and the aggregates as the caller owns them', () => {
    const polluted: Record<string, unknown> = {
      select: { hmacKeyEnc: true },
      omit: { id: true },
      where: { hmacKeyEnc: 'k' },
      having: { hmacKeyEnc: 'k' },
      orderBy: { hmacKeyEnc: 'asc' },
      distinct: ['hmacKeyEnc'],
      by: ['hmacKeyEnc'],
      _count: { hmacKeyEnc: true },
      _max: { hmacKeyEnc: true },
    };
    for (const [key, value] of Object.entries(polluted)) {
      Object.defineProperty(Object.prototype, key, {
        value,
        configurable: true,
        enumerable: false,
        writable: true,
      });
    }
    try {
      // The caller owns nothing but `take`: no select to check, no hidden column named anywhere, and the
      // default omit is added.
      const verdict = assertCandidateColumns('Session', 'findMany', { take: 1 }, false, undefined);
      expect(verdict.omit).toMatchObject({ hmacKeyEnc: true, invitationId: true });
      expect(verdict.omit).not.toHaveProperty('id');
      expect(verdict.runFilter).toBe(false);
    } finally {
      for (const key of Object.keys(polluted))
        delete (Object.prototype as Record<string, unknown>)[key];
    }
    expect(Object.hasOwn(Object.prototype, 'select')).toBe(false);
  });
});

describe('plain-args: the operand of a Json filter is a value, not structure (re-review of #185, S1; FR-704, NFR-05, NFR-04, TC-008)', () => {
  /** A stored document (what the database returns, or JSON.parse makes) with an own __proto__ at several depths. */
  const stored = (): unknown =>
    json(
      '{"extraTimePct":25,"notes":{"a":{"b":{"__proto__":{"x":1},"c":[{"__proto__":{"y":2}}]}}},"__proto__":{"top":true}}',
    );
  const deep = (levels: number): unknown => {
    let value: unknown = { leaf: true };
    for (let i = 0; i < levels; i++) value = { next: value };
    return value;
  };
  const operands = (): Array<[string, unknown]> => [
    ['own __proto__ at depth 0, 3 and in an array', stored()],
    ['100 levels deep', deep(100)],
    ['100000 levels deep', deep(100_000)],
    ['an array of stored documents', [stored(), deep(100)]],
    [
      'a document that looks like a field reference',
      {
        modelName: 'Session',
        name: 'deviceInfo',
        typeName: 'Json',
        isList: false,
      },
    ],
    [
      'a class instance with an inherited enumerable key',
      Object.create({ inherited: 1 }) as object,
    ],
    ['null', null],
  ];
  const jsonColumns = Object.entries(JSON_COLUMNS).flatMap(([model, columns]) =>
    (columns ?? []).map((column) => [model, column] as const),
  );

  it('TC-008 JSON_COLUMNS is exactly the Json columns of the schema, as the generated client reports them (a new Json column fails here until it is listed)', async () => {
    const metas = await readModelMetas();
    const fromSchema: Record<string, string[]> = {};
    for (const [model, meta] of Object.entries(metas)) {
      const columns = meta.fields
        .filter((f) => f.kind === 'scalar' && f.type === 'Json')
        .map((f) => f.name)
        .sort();
      if (columns.length > 0) fromSchema[model] = columns;
    }
    expect(
      Object.fromEntries(
        Object.entries(JSON_COLUMNS).map(([model, columns]) => [
          model,
          [...(columns ?? [])].sort(),
        ]),
      ),
    ).toEqual(fromSchema);
    expect(Object.keys(JSON_COLUMNS).length).toBe(12);
    expect(Object.isFrozen(JSON_COLUMNS.Session)).toBe(true);
  });

  it('TC-008 the value operators are exactly the ten of the review', () => {
    expect([...JSON_VALUE_OPERATORS].sort()).toEqual(
      [
        'array_contains',
        'array_ends_with',
        'array_starts_with',
        'equals',
        'in',
        'not',
        'notIn',
        'string_contains',
        'string_ends_with',
        'string_starts_with',
      ].sort(),
    );
  });

  it.each(jsonColumns)(
    'TC-008 %s.%s: every value operator takes a stored document with own __proto__ keys, one nested past the limit, and the other odd operands, in a where and a having',
    (model, column) => {
      for (const operator of JSON_VALUE_OPERATORS) {
        for (const [label, operand] of operands()) {
          for (const place of ['where', 'having']) {
            expect({
              model,
              column,
              operator,
              label,
              place,
              ok: passes(() =>
                assertPlainArgs(model, 'updateMany', {
                  [place]: { id: 'x', [column]: { [operator]: operand } },
                  data: {},
                }),
              ),
            }).toEqual({ model, column, operator, label, place, ok: true });
          }
        }
      }
    },
  );

  it('TC-008 the compare-and-set of retention and the org settings, as written: { equals: stored } next to the id, with a deep or polluted document', () => {
    for (const operand of [stored(), deep(200)]) {
      expect(() =>
        assertPlainArgs('Invitation', 'updateMany', {
          where: { id: 'x', accommodations: { equals: operand } },
          data: { accommodations: { a: 1 } },
        }),
      ).not.toThrow();
      expect(() =>
        assertPlainArgs('Organization', 'updateMany', {
          where: { id: 'x', settings: { equals: operand } },
          data: { settings: { a: 1 } },
        }),
      ).not.toThrow();
    }
    // Prisma.JsonNull and DbNull are values already.
    expect(() =>
      assertPlainArgs('Organization', 'updateMany', {
        where: { id: 'x', settings: { equals: Prisma.JsonNull } },
        data: {},
      }),
    ).not.toThrow();
  });

  it('TC-008 the exemption holds under AND, OR, NOT, arrays and through a relation filter to the related model', () => {
    const operand = stored();
    for (const where of [
      { AND: [{ id: 'x' }, { deviceInfo: { equals: operand } }] },
      { OR: [{ NOT: { deviceInfo: { not: operand } } }] },
      { NOT: [{ deviceInfo: { in: [operand] } }] },
    ]) {
      expect(() => assertPlainArgs('Session', 'findMany', { where })).not.toThrow();
    }
    // Invitation -> sessions (to many) and Session -> invitation (to one): the related model's Json columns.
    for (const where of [
      { sessions: { some: { deviceInfo: { equals: operand } } } },
      { sessions: { every: { AND: [{ deviceInfo: { string_contains: 'x' } }] } } },
      { sessions: { none: { deviceInfo: { equals: operand } } } },
    ]) {
      expect(() => assertPlainArgs('Invitation', 'findMany', { where })).not.toThrow();
    }
    expect(() =>
      assertPlainArgs('Session', 'findMany', {
        where: { invitation: { is: { accommodations: { equals: operand } } } },
      }),
    ).not.toThrow();
    expect(() =>
      assertPlainArgs('Session', 'findMany', {
        where: { invitation: { accommodations: { equals: operand } } },
      }),
    ).not.toThrow();
  });

  it('TC-008 everything else is still walked: the filter object, a path, a mode, a non-Json column, a column of another model, an operator off the list, an unknown model', () => {
    const polluted = json('{"a":{"__proto__":{"x":1}}}');
    const refusedArgs: Array<[string, string, unknown]> = [
      // the filter object itself
      ['Session', 'findMany', { where: { deviceInfo: json('{"equals":1,"__proto__":{"x":1}}') } }],
      ['Session', 'findMany', { where: { deviceInfo: Object.create({ equals: 1 }) as object } }],
      // path and mode and any operator that is not a value operator
      ['Session', 'findMany', { where: { deviceInfo: { path: [polluted], equals: 1 } } }],
      ['Session', 'findMany', { where: { deviceInfo: { mode: polluted, equals: 1 } } }],
      ['Session', 'findMany', { where: { deviceInfo: { gt: polluted } } }],
      ['Session', 'findMany', { where: { deviceInfo: { unknownOperator: polluted } } }],
      // a column of the model that is not Json
      ['Session', 'findMany', { where: { status: { equals: polluted } } }],
      ['Session', 'findMany', { where: { id: { not: polluted } } }],
      // the Json column of ANOTHER model: invitations.accommodations is not a Session column
      ['Session', 'findMany', { where: { accommodations: { equals: polluted } } }],
      ['Test', 'findMany', { where: { deviceInfo: { equals: polluted } } }],
      // a model the table does not know: nothing is exempt
      ['NotAModel', 'findMany', { where: { deviceInfo: { equals: polluted } } }],
      // a relation filter to a model that has no such Json column
      [
        'Invitation',
        'findMany',
        { where: { sessions: { some: { accommodations: { equals: polluted } } } } },
      ],
      // a where nested in a select or an include has no model here: walked whole (fail closed)
      [
        'Invitation',
        'findMany',
        { select: { sessions: { where: { deviceInfo: { equals: polluted } } } } },
      ],
      // a polluted wrapper
      ['Session', 'findMany', { where: json('{"id":"x","__proto__":{"a":1}}') }],
      ['Session', 'findMany', { where: { AND: [json('{"__proto__":{"a":1}}')] } }],
      ['Session', 'findMany', { having: json('{"__proto__":{"a":1}}') }],
      ['Session', 'findMany', json('{"where":{"id":"x"},"__proto__":{"select":{"id":true}}}')],
    ];
    for (const [model, operation, args] of refusedArgs) {
      expect({
        model,
        args: JSON.stringify(args).slice(0, 60),
        refused: !passes(() => assertPlainArgs(model, operation, args)),
      }).toEqual({
        model,
        args: JSON.stringify(args).slice(0, 60),
        refused: true,
      });
    }
  });

  it('TC-008 a field reference as the operand is a value for plain-args (the candidate scope refuses it on its own), and a document with a look-alike inside is not one', () => {
    const client = createPrismaClient('postgresql://nobody:nothing@127.0.0.1:1/none');
    try {
      const ref = (client as unknown as { session: { fields: Record<string, unknown> } }).session
        .fields.deviceInfo;
      expect(ref).toBeDefined();
      expect(() =>
        assertPlainArgs('Session', 'findMany', { where: { deviceInfo: { equals: ref } } }),
      ).not.toThrow();
    } finally {
      void client.$disconnect();
    }
  });

  it('TC-008 the depth limit still applies to the structure around the operand, and a 100000-level operand costs nothing', () => {
    let where: unknown = { deviceInfo: { equals: deep(100_000) } };
    for (let i = 0; i < 100; i++) where = { NOT: where };
    expect(() => assertPlainArgs('Session', 'findMany', { where })).toThrow(
      /nested more than 64 levels/,
    );
    const started = process.hrtime.bigint();
    assertPlainArgs('Session', 'findMany', { where: { deviceInfo: { equals: deep(100_000) } } });
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(100);
  });
});

/** True when `fn` does not throw (a refusal is false), for tables of cases. */
function passes(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

describe('plain-args: through the real client, in every scope (review of #185, B1; NFR-04, TC-008)', () => {
  const orgContext = new OrgContextService();
  const base = createPrismaClient('postgresql://nobody:nothing@127.0.0.1:1/none');
  const client = createOrgScopedClient(base, orgContext);

  afterAll(async () => {
    await base.$disconnect();
  });

  type Run = (fn: () => Promise<unknown>) => Promise<unknown>;
  const scopes: Array<[string, Run]> = [
    [
      'CANDIDATE',
      (fn) =>
        orgContext.runAsCandidate(ORG, SID, () => {
          setCandidateFacts(orgContext, FACTS);
          return fn();
        }),
    ],
    ['SERVICE', (fn) => orgContext.runAsSessionJob(ORG, SID, fn)],
    ['STAFF', (fn) => orgContext.runAsUser({ orgId: ORG, userId: OTHER, role: 'RECRUITER' }, fn)],
    ['plain org', (fn) => orgContext.runInOrg(ORG, fn)],
    ['system', (fn) => orgContext.runSystem('AUTH_BOOTSTRAP', fn)],
  ];

  const outcome = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );

  const calls: Array<[string, (args: never) => Promise<unknown>]> = [
    ['findFirst', (a) => client.session.findFirst(a)],
    ['findMany', (a) => client.session.findMany(a)],
    ['findUnique', (a) => client.session.findUnique(a)],
    ['count', (a) => client.session.count(a)],
    ['aggregate', (a) => client.session.aggregate(a)],
    ['groupBy', (a) => (client.session.groupBy as (a: never) => Promise<unknown>)(a)],
    ['update', (a) => client.session.update(a)],
    ['updateMany', (a) => client.session.updateMany(a)],
    ['updateManyAndReturn', (a) => client.session.updateManyAndReturn(a)],
    ['delete', (a) => client.session.delete(a)],
    ['create', (a) => client.session.create(a)],
    ['createMany', (a) => client.session.createMany(a)],
    ['createManyAndReturn', (a) => client.session.createManyAndReturn(a)],
    ['upsert', (a) => client.session.upsert(a)],
  ];

  describe.each(scopes)('%s scope', (_name, run) => {
    it.each(calls)(
      'TC-008 %s: JSON.parse with an own __proto__ carrying a select is refused before the query',
      async (_operation, call) => {
        const error = await run(() => outcome(call(json(POLLUTED_SELECT))));
        expect(error).toBeInstanceOf(OrgScopeViolationError);
        expect((error as Error).message).toMatch(refused);
      },
    );

    // Prisma 7.10 clones the arguments before the hook sees them: an INHERITED key (Object.create) is copied to an
    // own key, so every check sees it; a key named `__proto__` that JSON.parse made an own property becomes the
    // prototype of the top-level args, and stays an own key in a nested object. Both are refused here.
    it('TC-008 an own __proto__ at any depth is refused: nested where, AND, select, orderBy, data row, a column value, a createMany row, an upsert branch', async () => {
      const proto = '"__proto__":{"hmacKeyEnc":"k"}';
      for (const make of [
        () => client.session.findFirst({ where: json(`{"id":"x",${proto}}`) }),
        () => client.session.findFirst({ where: { AND: [json(`{${proto}}`)] } }),
        () => client.session.count({ where: { OR: [{ id: 'x' }, { NOT: json(`{${proto}}`) }] } }),
        () =>
          client.session.findFirst({ select: json('{"id":true,"__proto__":{"hmacKeyEnc":true}}') }),
        () =>
          client.session.findMany({
            orderBy: [json('{"id":"asc","__proto__":{"hmacKeyEnc":"asc"}}')],
          }),
        () =>
          client.session.update({
            where: { id: SID },
            data: json(
              '{"lastHeartbeat":"2026-10-06T00:00:00.000Z","__proto__":{"status":"PAUSED"}}',
            ),
            select: { id: true },
          }),
        () =>
          client.session.update({
            where: { id: SID },
            data: { deviceInfo: json('{"a":1,"__proto__":{"b":2}}') },
            select: { id: true },
          }),
        () =>
          client.session.createMany({
            data: [
              { orgId: ORG, invitationId: OTHER },
              json('{"orgId":"x","__proto__":{"status":"PAUSED"}}'),
            ],
          }),
        () =>
          client.session.upsert({
            where: { id: SID },
            create: json('{"orgId":"x","__proto__":{"status":"PAUSED"}}'),
            update: { lastHeartbeat: new Date() },
          }),
        () =>
          client.session.findFirst(
            Object.assign(Object.create(null) as object, json(POLLUTED_SELECT)),
          ),
      ]) {
        const error = await run(() => outcome(make()));
        expect(error).toBeInstanceOf(OrgScopeViolationError);
        expect((error as Error).message).toMatch(refused);
      }
    });

    // FU-DB-281: Prisma's clone passes an object BY REFERENCE when `value[Symbol.for('prisma.objectEnumValue')]` is
    // true, so its hidden keys reach the hook and then Prisma's `Wt({ select, include })`. Refused before the query.
    it("TC-008 FU-DB-281: an object with Prisma's brand (kept by reference past its clone) and a hidden select, a getter include or a trap is refused before the query", async () => {
      const carriers: Array<() => object> = [
        () => Object.defineProperty({ [BRAND]: true }, 'select', { value: { hmacKeyEnc: true } }),
        () =>
          Object.defineProperty({ [BRAND]: true }, 'include', {
            get: () => ({ invitation: true }),
          }),
        () =>
          new Proxy(
            {},
            {
              get: (_t, key) =>
                key === BRAND ? true : key === 'select' ? { hmacKeyEnc: true } : undefined,
            },
          ),
      ];
      const makes: Array<(carrier: object) => Promise<unknown>> = [
        (c) => client.session.findFirst({ select: { id: true, _count: c } } as never),
        (c) => client.session.findFirst({ include: { invitation: c } } as never),
        (c) => client.session.count({ where: { AND: [c] } } as never),
        (c) => client.session.update({ where: { id: SID }, data: c } as never),
      ];
      for (const carrier of carriers) {
        for (const make of makes) {
          const error = await run(() => outcome(make(carrier())));
          expect(error).toBeInstanceOf(OrgScopeViolationError);
          expect((error as Error).message).toMatch(HIDDEN_KEY);
        }
      }
    });

    it('TC-008 FU-DB-281: without the brand, Prisma clones first: a non-enumerable key, a symbol key, a getter and a plain Proxy reach the hook as plain own keys (or not at all), so they are not refused', async () => {
      for (const where of [
        Object.defineProperty({ id: SID }, 'hmacKeyEnc', { value: 'guess' }),
        { id: SID, [Symbol('hidden')]: 'guess' },
        Object.defineProperty({}, 'id', { get: () => SID, enumerable: true }),
        new Proxy({ id: SID }, {}),
      ]) {
        const error = await run(() => outcome(client.session.findFirst({ where } as never)));
        expect(error).toBeDefined();
        expect(error).not.toBeInstanceOf(OrgScopeError);
      }
    });

    it('TC-008 a plain query, and a query with null-prototype arguments, are not refused (they reach the closed port)', async () => {
      for (const make of [
        () => client.session.findFirst({ select: { id: true }, where: { id: SID } }),
        () =>
          client.session.findFirst(
            Object.assign(Object.create(null) as object, {
              select: { id: true },
              where: Object.assign(Object.create(null) as object, { id: SID }),
            }) as never,
          ),
        () => client.session.count({ where: { startedAt: { lt: new Date() } } }),
      ]) {
        const error = await run(() => outcome(make()));
        expect(error).toBeDefined();
        expect(error).not.toBeInstanceOf(OrgScopeError);
      }
    });
  });

  it('TC-008 an inherited key (Object.create) reaches the hook as an own key, so the scope checks refuse it: a candidate cannot write status or filter on a hidden column that way', async () => {
    const candidate = scopes[0]?.[1] as Run;
    const inheritedStatus = Object.assign(Object.create({ status: 'PAUSED' }) as object, {
      lastHeartbeat: new Date(),
    });
    const writeError = await candidate(() =>
      outcome(client.session.update({ where: { id: SID }, data: inheritedStatus })),
    );
    expect((writeError as Error).message).toMatch(
      /status cannot be written by a candidate update here/,
    );
    const readError = await candidate(() =>
      outcome(client.session.count({ where: Object.create({ hmacKeyEnc: 'guess' }) as never })),
    );
    expect((readError as Error).message).toMatch(/the column hmacKeyEnc is not available/);
    const topError = await candidate(() =>
      outcome(client.session.findFirst(Object.create({ select: { hmacKeyEnc: true } }) as never)),
    );
    expect((topError as Error).message).toMatch(/the column hmacKeyEnc is not available/);
  });

  it('TC-008 FU-DB-281: a DTO row, a Date, a Buffer and a Decimal still pass through the client (Prisma hands the hook its plain clone and real values)', async () => {
    class HeartbeatDto {
      lastHeartbeat = new Date();
      touch(): number {
        return 1;
      }
    }
    const staff = scopes[2]?.[1] as Run;
    for (const make of [
      () => client.session.update({ where: { id: SID }, data: new HeartbeatDto() }),
      () =>
        client.testQuestion.update({
          where: { id: OTHER },
          data: { points: new Prisma.Decimal('5.5') },
        }),
      () => client.keystrokeBatch.findFirst({ where: { signature: { equals: Buffer.from('x') } } }),
      () => client.session.count({ where: { startedAt: { lt: new Date() } } }),
    ]) {
      const error = await staff(() => outcome(make()));
      expect(error).toBeDefined();
      expect(error).not.toBeInstanceOf(OrgScopeError);
    }
  });

  it('TC-008 raw queries are not model arguments: the hatch still decides them (nothing here walks a template)', async () => {
    await expect(orgContext.runInOrg(ORG, () => client.$queryRaw`SELECT 1`)).rejects.toThrow(
      /raw SQL bypasses org scoping/,
    );
  });
});
