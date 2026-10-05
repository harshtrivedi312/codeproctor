// Errors that are logged must not carry argument values (FU-DB-70; NFR-04: never log secrets,
// tokens, OTPs or candidate media keys). Three parts:
//   1. scrubPrismaError, on errors built by hand (no database);
//   2. real failing queries against Postgres, through the factory client and the org-scoped client:
//      what `errorFormat: 'minimal'` alone leaves in, and that the scrub takes it out;
//   3. the source never enables query logging (it prints every query with its parameters).
// "As logged" means what pino writes for an error: its standard error serializer (message, stack and
// own properties such as `meta`), plus util.inspect, which is what console and Nest's logger print.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { inspect } from 'node:util';
import { stdSerializers } from 'pino';
import { Prisma } from '../generated/prisma/client.js';
import { createPrismaClient } from './create-prisma-client';
import { scrubPrismaError } from './error-scrub';
import { OrgContextService } from './org-context';
import { createOrgScopedClient } from './org-scope.extension';
import { startMigratedDatabase } from './testing/migrated-postgres';
import type { MigratedDatabase } from './testing/migrated-postgres';
import { createTenant } from './testing/tenant-fixtures';
import type { TenantFixture } from './testing/tenant-fixtures';

const SECRET = 'SECRET-TOKEN-HASH-7f3a9c';

/** Everything a logger could print for this error, as one string. */
function asLogged(error: unknown): string {
  return [
    JSON.stringify(stdSerializers.err(error as Error)),
    inspect(error, { depth: 12 }),
    String((error as Error).message),
    String((error as Error).stack),
  ].join('\n');
}

const known = (
  code: string,
  message: string,
  meta: unknown,
): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: 'test',
    meta: meta as Record<string, unknown>,
  });

/**
 * The adapter's own error (`DriverAdapterError` of @prisma/driver-adapter-utils, which is not a
 * dependency of this app), built the way the adapter builds it: the message is the payload's
 * `message` or its `kind`, the payload becomes `cause`. Prisma tells it by `name` and an object
 * `cause`.
 */
class DriverAdapterError extends Error {
  override name = 'DriverAdapterError';
  override cause: Record<string, unknown>;
  constructor(payload: Record<string, unknown>) {
    super(typeof payload.message === 'string' ? payload.message : String(payload.kind));
    this.cause = payload;
  }
}

describe('scrubPrismaError (NFR-04)', () => {
  it('TC-008 a check violation loses the failing row, and keeps its class, code and constraint name', () => {
    const error = known(
      'P2039',
      '\nInvalid `prisma.invitation.create()` invocation:\n\n\nDatabase error. Code: `23514`. Message: `new row for relation "invitations" violates check constraint "invitations_check"`',
      {
        modelName: 'Invitation',
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: {
            originalCode: '23514',
            originalMessage:
              'new row for relation "invitations" violates check constraint "invitations_check"',
            kind: 'postgres',
            code: '23514',
            severity: 'ERROR',
            message:
              'new row for relation "invitations" violates check constraint "invitations_check"',
            detail: `Failing row contains (a, b, ${SECRET}, 2026-10-06, 2026-10-05).`,
          },
        },
      },
    );
    expect(scrubPrismaError(error)).toBe(error);
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(error.code).toBe('P2039');
    expect(asLogged(error)).not.toContain(SECRET);
    expect(asLogged(error)).not.toContain('Failing row');
    // The message names the constraint: that is a name, not a value.
    expect(error.message).toContain('invitations_check');
    expect(JSON.stringify(error.meta)).toContain('invitations_check');
  });

  it('TC-008 an echoed input value (invalid uuid, raw query) is withheld, with the SQLSTATE kept', () => {
    const error = known(
      'P2007',
      `\nInvalid \`prisma.user.findUnique()\` invocation:\n\n\nInvalid input value: invalid input syntax for type uuid: "${SECRET}"`,
      {
        modelName: 'User',
        driverAdapterError: {
          cause: {
            originalCode: '22P02',
            originalMessage: `invalid input syntax for type uuid: "${SECRET}"`,
            kind: 'InvalidInputValue',
            message: `invalid input syntax for type uuid: "${SECRET}"`,
          },
        },
      },
    );
    scrubPrismaError(error);
    expect(asLogged(error)).not.toContain(SECRET);
    expect(error.code).toBe('P2007');
    expect(error.message).toContain('Invalid `prisma.user.findUnique()` invocation:');
    expect(error.message).toContain('Database error P2007 (SQLSTATE 22P02)');
    expect(error.meta).toMatchObject({
      modelName: 'User',
      driverAdapterError: { cause: { originalCode: '22P02' } },
    });
  });

  it('TC-008 free text in other meta keys is dropped for a code that is not value-free', () => {
    const error = known('P2023', `Inconsistent column data: ${SECRET}`, {
      modelName: 'User',
      message: SECRET,
      column: SECRET,
    });
    scrubPrismaError(error);
    expect(asLogged(error)).not.toContain(SECRET);
    expect(error.meta).toEqual({ modelName: 'User' });
  });

  it('TC-008 a unique, foreign key or not-found error is value-free and is left as it is', () => {
    const unique = known(
      'P2002',
      '\nInvalid `prisma.refreshToken.create()` invocation:\n\n\nUnique constraint failed on the constraint: `refresh_tokens_token_hash_key`',
      {
        modelName: 'RefreshToken',
        driverAdapterError: {
          cause: {
            originalCode: '23505',
            originalMessage:
              'duplicate key value violates unique constraint "refresh_tokens_token_hash_key"',
            kind: 'UniqueConstraintViolation',
            constraint: { index: 'refresh_tokens_token_hash_key' },
            table: 'refresh_tokens',
          },
        },
      },
    );
    const before = { message: unique.message, meta: JSON.stringify(unique.meta) };
    scrubPrismaError(unique);
    expect({ message: unique.message, meta: JSON.stringify(unique.meta) }).toEqual(before);
    const missing = known(
      'P2025',
      'An operation failed because it depends on one or more records that were required but not found. No record was found for an update.',
      { modelName: 'User', cause: 'No record was found for an update.' },
    );
    const copy = missing.message;
    scrubPrismaError(missing);
    expect(missing.message).toBe(copy);
    expect(missing.meta).toEqual({
      modelName: 'User',
      cause: 'No record was found for an update.',
    });
  });

  it('TC-008 a validation error keeps the invocation and the names of the rejected arguments, not their values', () => {
    const error = new Prisma.PrismaClientValidationError(
      `\nInvalid \`prisma.user.update()\` invocation:\n\n{\n  data: {\n    fullName: 123,\n              ~~~\n    email: "${SECRET}"\n  }\n}\n\nArgument \`fullName\`: Invalid value provided. Expected String, provided Int.\nInvalid value for argument \`role\`. Expected UserRole.`,
      { clientVersion: 'test' },
    );
    scrubPrismaError(error);
    expect(asLogged(error)).not.toContain(SECRET);
    expect(asLogged(error)).not.toContain('123');
    expect(error.message).toContain('Invalid `prisma.user.update()` invocation:');
    expect(error.message).toContain('(fullName, role)');
    expect(error).toBeInstanceOf(Prisma.PrismaClientValidationError);
  });

  it('TC-008 an unknown request error is withheld, and the stack keeps its frames', () => {
    const error = new Prisma.PrismaClientUnknownRequestError(
      `\nInvalid \`prisma.x.y()\` invocation:\n\n\nsomething with ${SECRET}`,
      { clientVersion: 'test' },
    );
    const frames = (error.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line));
    scrubPrismaError(error);
    expect(asLogged(error)).not.toContain(SECRET);
    expect(error.stack).toContain(error.message);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) expect(error.stack).toContain(frame);
  });

  describe('a bare DriverAdapterError, which Prisma did not wrap (PR #82 review S1)', () => {
    const check = (): DriverAdapterError =>
      new DriverAdapterError({
        kind: 'postgres',
        code: '23514',
        originalCode: '23514',
        severity: 'ERROR',
        message: `new row for relation "invitations" violates check constraint "invitations_check" for ${SECRET}`,
        originalMessage: `new row for relation "invitations" violates check constraint "invitations_check" for ${SECRET}`,
        detail: `Failing row contains (a, b, ${SECRET}, 2026-10-06, 2026-10-05).`,
        hint: `Check the value ${SECRET}.`,
        table: 'invitations',
        constraint: 'invitations_check',
      });

    it('TC-008 a value in its message, detail and hint is gone, and the name, kind and code are kept', () => {
      const error = check();
      expect(asLogged(error)).toContain(SECRET); // as built, before the scrub
      expect(scrubPrismaError(error)).toBe(error);
      expect(asLogged(error)).not.toContain(SECRET);
      expect(asLogged(error)).not.toContain('Failing row');
      expect(error).toBeInstanceOf(DriverAdapterError);
      expect(error.name).toBe('DriverAdapterError');
      expect(error.cause).toEqual({
        kind: 'postgres',
        code: '23514',
        originalCode: '23514',
        severity: 'ERROR',
        table: 'invitations',
        constraint: 'invitations_check',
      });
      expect(error.message).toBe(
        "Database driver error postgres (SQLSTATE 23514). The database's message is withheld because it can contain argument values.",
      );
      expect(error.stack).toContain(error.message);
    });

    it('TC-008 its text is dropped even for a SQLSTATE that is usually value-free: nothing has classified this error', () => {
      const error = new DriverAdapterError({
        kind: 'TransactionWriteConflict',
        originalCode: '40001',
        originalMessage: `could not serialize access ${SECRET}`,
        message: `could not serialize access ${SECRET}`,
        detail: `Reason code: ${SECRET}.`,
      });
      scrubPrismaError(error);
      expect(asLogged(error)).not.toContain(SECRET);
      expect(error.cause).toEqual({ kind: 'TransactionWriteConflict', originalCode: '40001' });
      expect(error.message).toContain('TransactionWriteConflict (SQLSTATE 40001)');
    });

    it('TC-008 a kind with nothing but the kind (its own message is the kind name) is kept readable', () => {
      const error = new DriverAdapterError({ kind: 'TransactionWriteConflict' });
      expect(error.message).toBe('TransactionWriteConflict');
      scrubPrismaError(error);
      expect(error.cause).toEqual({ kind: 'TransactionWriteConflict' });
      expect(error.message).toMatch(/^Database driver error TransactionWriteConflict\./);
    });

    it('TC-008 keys the adapter adds for other kinds (cause, reason, user, host, db) are dropped, and a kind with odd characters is dropped too', () => {
      const error = new DriverAdapterError({
        kind: `Odd kind ${SECRET}`,
        cause: `value "${SECRET}" is out of range for type integer`,
        reason: SECRET,
        user: SECRET,
        host: SECRET,
        db: SECRET,
      });
      scrubPrismaError(error);
      expect(asLogged(error)).not.toContain(SECRET);
      expect(asLogged(error)).not.toContain('is out of range');
      expect(error.cause).toEqual({});
      expect(error.message).toMatch(/^Database driver error\. /);
    });

    it('TC-008 it is an error Prisma recognises by name and an object cause only: other errors are untouched', () => {
      const named = Object.assign(new Error(`text ${SECRET}`), { name: 'DriverAdapterError' });
      expect(scrubPrismaError(named)).toBe(named);
      expect(named.message).toContain(SECRET); // no object cause: not an adapter error
      const withCause = new Error(`text ${SECRET}`, { cause: { detail: SECRET } });
      expect(scrubPrismaError(withCause)).toBe(withCause);
      expect(withCause.message).toContain(SECRET); // not named DriverAdapterError
      const stringCause = Object.assign(new Error(`text ${SECRET}`), {
        name: 'DriverAdapterError',
        cause: SECRET,
      });
      scrubPrismaError(stringCause);
      expect(stringCause.message).toContain(SECRET);
    });

    it('TC-008 scrubbing twice gives the same error', () => {
      const error = check();
      scrubPrismaError(error);
      const once = { message: error.message, cause: JSON.stringify(error.cause) };
      scrubPrismaError(error);
      expect({ message: error.message, cause: JSON.stringify(error.cause) }).toEqual(once);
    });

    it('TC-008 the same adapter error inside a known request error (what Prisma wraps) is scrubbed as before', () => {
      const adapter = new DriverAdapterError({
        kind: 'InvalidInputValue',
        originalCode: '22P02',
        originalMessage: `invalid input syntax for type uuid: "${SECRET}"`,
        message: `invalid input syntax for type uuid: "${SECRET}"`,
      });
      const wrapped = known('P2007', `Invalid input value: ${adapter.message}`, {
        modelName: 'User',
        driverAdapterError: adapter,
      });
      scrubPrismaError(wrapped);
      expect(asLogged(wrapped)).not.toContain(SECRET);
      expect(wrapped.code).toBe('P2007');
      expect(adapter.cause).toEqual({ kind: 'InvalidInputValue', originalCode: '22P02' });
    });
  });

  it('TC-008 anything that is not a Prisma request or validation error comes back untouched', () => {
    const plain = new Error(`connection to host failed ${SECRET}`);
    expect(scrubPrismaError(plain)).toBe(plain);
    expect(plain.message).toContain(SECRET);
    expect(scrubPrismaError('text')).toBe('text');
    expect(scrubPrismaError(undefined)).toBeUndefined();
  });
});

describe('failing queries against Postgres carry no argument values (NFR-04, FU-DB-70)', () => {
  let db: MigratedDatabase;
  let owner: ReturnType<typeof createPrismaClient>;
  let factory: ReturnType<typeof createPrismaClient>;
  let base: ReturnType<typeof createPrismaClient>;
  let scoped: ReturnType<typeof createOrgScopedClient>;
  let orgContext: OrgContextService;
  let T: TenantFixture;

  beforeAll(async () => {
    db = await startMigratedDatabase();
    owner = createPrismaClient(db.ownerUrl);
    factory = createPrismaClient(db.appUserUrl);
    base = createPrismaClient(db.appUserUrl);
    orgContext = new OrgContextService();
    scoped = createOrgScopedClient(base, orgContext);
    T = await createTenant(owner, 'err');
    await owner.refreshToken.create({
      data: {
        userId: T.userId,
        familyId: '11111111-1111-4111-8111-111111111111',
        tokenHash: SECRET,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
  });

  afterAll(async () => {
    await factory?.$disconnect();
    await base?.$disconnect();
    await owner?.$disconnect();
    await db?.stop();
  });

  const inOrg = <R>(run: () => Promise<R>): Promise<R> => orgContext.runInOrg(T.orgId, run);
  const caught = async (run: () => Promise<unknown>): Promise<Error> => {
    try {
      await run();
    } catch (error) {
      return error as Error;
    }
    throw new Error('the query was expected to fail');
  };

  it('TC-008 a unique violation on a known token hash does not carry the hash, with the plain factory client and the scoped one', async () => {
    const data = {
      userId: T.userId,
      familyId: '22222222-2222-4222-8222-222222222222',
      tokenHash: SECRET,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const fromFactory = await caught(() => factory.refreshToken.create({ data }));
    const fromScoped = await caught(() => inOrg(() => scoped.refreshToken.create({ data })));
    for (const error of [fromFactory, fromScoped]) {
      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
      expect(asLogged(error)).not.toContain(SECRET);
      // What a log reader needs is still there: which constraint failed.
      expect(error.message).toContain('refresh_tokens_token_hash_key');
    }
  });

  it("TC-008 errorFormat 'minimal': no source code frame (file path, line, the calling code) in the message", async () => {
    const error = await caught(() =>
      factory.refreshToken.create({
        data: {
          userId: T.userId,
          familyId: '22222222-2222-4222-8222-222222222222',
          tokenHash: SECRET,
          expiresAt: new Date(),
        },
      }),
    );
    expect(error.message).not.toContain('.spec.ts');
    expect(error.message).not.toContain(resolve(__dirname));
    expect(error.message).toMatch(/^\nInvalid `prisma\.refreshToken\.create\(\)` invocation:/);
  });

  const failures: Array<
    [string, (c: ReturnType<typeof createOrgScopedClient>) => Promise<unknown>]
  > = [
    [
      'an id that is not a uuid (P2007, echoes the value)',
      (c) => c.user.findUnique({ where: { id: `${SECRET}-id` } }),
    ],
    [
      'a check violation (P2039, "Failing row contains" lists the row)',
      (c) =>
        c.invitation.create({
          data: {
            orgId: T.orgId,
            testId: T.rows.Test.filter.id as string,
            candidateId: T.rows.Candidate.filter.id as string,
            tokenHash: `${SECRET}-check`,
            windowStart: new Date('2026-10-06T00:00:00Z'),
            windowEnd: new Date('2026-10-05T00:00:00Z'),
          },
        }),
    ],
    [
      'a foreign key violation',
      (c) =>
        c.refreshToken.create({
          data: {
            userId: '33333333-3333-4333-8333-333333333333',
            familyId: '22222222-2222-4222-8222-222222222222',
            tokenHash: `${SECRET}-fk`,
            expiresAt: new Date(),
          },
        }),
    ],
    [
      'a record not found',
      (c) =>
        c.user.update({
          where: { id: '44444444-4444-4444-8444-444444444444' },
          data: { fullName: `${SECRET}-nf` },
        }),
    ],
    [
      'a validation error (wrong type)',
      (c) =>
        c.user.update({
          where: { id: T.userId },
          data: { fullName: 123, email: `${SECRET}-val` } as never,
        }),
    ],
    [
      'a validation error (not an enum value)',
      (c) => c.user.update({ where: { id: T.userId }, data: { role: `${SECRET}-enum` } as never }),
    ],
    [
      'a validation error in a where',
      (c) =>
        c.session.findMany({ where: { id: { equals: { nested: `${SECRET}-where` } } } as never }),
    ],
  ];

  it.each(failures)(
    'TC-008 %s: nothing the caller passed is in the logged error, through the scoped client',
    async (_name, run) => {
      const error = await caught(() => inOrg(() => run(scoped)));
      expect(error.name).toMatch(/^PrismaClient(KnownRequest|Validation)Error$/);
      expect(asLogged(error)).not.toContain(SECRET);
    },
  );

  it('TC-008 the same errors from the plain factory client, to show what minimal alone leaves in', async () => {
    // errorFormat 'minimal' does not remove values: an echoed uuid, a failing row, a validation
    // dump. That is why the scoped client scrubs them (error-scrub.ts). A service on the plain
    // client (BE-02's interim PrismaModule, the seed) must not log such an error as it is.
    const plain = await caught(() => factory.user.findUnique({ where: { id: `${SECRET}-id` } }));
    expect(asLogged(plain)).toContain(SECRET);
    const scrubbed = scrubPrismaError(plain) as Error;
    expect(asLogged(scrubbed)).not.toContain(SECRET);
  });

  it('TC-008 a failing raw query in runRawSql is scrubbed too', async () => {
    const error = await caught(() =>
      inOrg(() =>
        orgContext.runRawSql('probe: a raw statement that fails on its parameter', () =>
          scoped.$queryRawUnsafe('SELECT $1::uuid', `${SECRET}-raw`),
        ),
      ),
    );
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(asLogged(error)).not.toContain(SECRET);
  });

  it('TC-008 an interactive transaction rolls back with the same scrubbed error', async () => {
    const error = await caught(() =>
      inOrg(() =>
        scoped.$transaction(async (tx) => {
          await tx.user.findUnique({ where: { id: `${SECRET}-tx` } });
        }),
      ),
    );
    expect(asLogged(error)).not.toContain(SECRET);
  });

  it('TC-008 a batch transaction: the error of a failing item', async () => {
    const error = await caught(() =>
      inOrg(() =>
        scoped.$transaction([
          scoped.user.findMany(),
          scoped.user.findUnique({ where: { id: `${SECRET}-batch` } }),
        ]),
      ),
    );
    expect(asLogged(error)).not.toContain(SECRET);
  });

  it('TC-008 a Serializable transaction that fails at COMMIT surfaces as a bare DriverAdapterError, which scrubPrismaError handles (PR #82 review S1)', async () => {
    // Found against Prisma 7.10 and Postgres 16: the runtime wraps an adapter error into a known
    // request error (P20xx, with the adapter error in meta.driverAdapterError) while a statement
    // runs, but a commit is not wrapped, so a serialization failure there (SQLSTATE 40001, kind
    // TransactionWriteConflict) reaches the caller as the adapter's own error. The org-scoped
    // client's extension does not see $transaction itself, so it does not scrub this error; its
    // text is the database's fixed wording today, and scrubPrismaError is the defence if a caller
    // logs it or if another kind ever arrives this way. If Prisma starts wrapping it, this test
    // fails on the first assertion: review the README "Errors and logging" paragraph then.
    // Both transactions have read and written before either commits (a barrier, not a sleep, so
    // load cannot reorder them); the second to commit fails.
    let arrived = 0;
    let release: () => void = () => undefined;
    const bothWritten = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const overlapping = (c: ReturnType<typeof createPrismaClient>, name: string) =>
      c.$transaction(
        async (tx) => {
          await tx.test.count({ where: { orgId: T.orgId } });
          await tx.test.create({ data: { orgId: T.orgId, name, durationMinutes: 5 } });
          arrived += 1;
          if (arrived === 2) release();
          await Promise.race([bothWritten, new Promise((r) => setTimeout(r, 3_000))]);
        },
        { isolationLevel: 'Serializable' },
      );
    const results = await Promise.allSettled([
      overlapping(factory, 'serializable-one'),
      overlapping(factory, 'serializable-two'),
    ]);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failed).toHaveLength(1);
    const error = failed[0]?.reason as Error & { cause: Record<string, unknown> };
    expect(error).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(error.name).toBe('DriverAdapterError');
    expect(error.cause).toMatchObject({ kind: 'TransactionWriteConflict', originalCode: '40001' });

    expect(scrubPrismaError(error)).toBe(error);
    expect(error.name).toBe('DriverAdapterError');
    expect(error.cause).toEqual({ kind: 'TransactionWriteConflict', originalCode: '40001' });
    expect(error.message).toBe(
      "Database driver error TransactionWriteConflict (SQLSTATE 40001). The database's message is withheld because it can contain argument values.",
    );
    expect(asLogged(error)).not.toContain('could not serialize');
  }, 60_000);

  it('TC-008 the scrub does not hide the failure: class, code and the constraint name survive', async () => {
    const error = (await caught(() =>
      inOrg(() =>
        scoped.invitation.create({
          data: {
            orgId: T.orgId,
            testId: T.rows.Test.filter.id as string,
            candidateId: T.rows.Candidate.filter.id as string,
            tokenHash: 'x',
            windowStart: new Date('2026-10-06T00:00:00Z'),
            windowEnd: new Date('2026-10-05T00:00:00Z'),
          },
        }),
      ),
    )) as Prisma.PrismaClientKnownRequestError;
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(error.code).toBe('P2039');
    expect(error.message).toContain('invitations_check');
  });
});

describe('query logging is never enabled (NFR-04, FU-DB-70)', () => {
  const SRC = resolve(__dirname, '..');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (path.includes(`${sep}generated`)) return [];
      return statSync(path).isDirectory() ? files(path) : [path];
    });
  const source = files(SRC).filter(
    (file) =>
      file.endsWith('.ts') &&
      !/\.(spec|e2e-spec)\.ts$/.test(file) &&
      !file.includes(`${sep}testing${sep}`),
  );

  it('TC-008 the client factory sets errorFormat minimal and passes no log option', () => {
    const factory = readFileSync(join(SRC, 'database', 'create-prisma-client.ts'), 'utf8');
    const code = factory
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(code).toMatch(/errorFormat:\s*'minimal'/);
    expect(code).not.toMatch(/\blog\s*:/);
  });

  it('TC-008 no source file turns on Prisma query logging or listens to query events', () => {
    const offenders = source
      .filter((file) => {
        const text = readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
          .join('\n');
        return (
          /\$on\(\s*['"]query['"]/.test(text) ||
          /\blog\s*:\s*\[[^\]]*['"](query|emit)['"]/.test(text)
        );
      })
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
