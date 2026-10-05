// Keeps argument values out of the errors Prisma throws, because they are logged (FU-DB-70; NFR-04:
// never log secrets, tokens, OTPs or candidate media keys).
//
// `errorFormat: 'minimal'` (create-prisma-client.ts) drops the code frame, but it does not stop
// values reaching an error. Shown on Prisma 7 against Postgres, with the format already minimal:
//   - a validation error prints the rejected arguments, values included, in message and stack;
//   - `invalid input syntax for type uuid: "<the value>"` echoes the value in the message and in
//     `meta.driverAdapterError.cause`, and the same for a failing raw query;
//   - a check or not-null violation puts `Failing row contains (...)`, every column of the row,
//     in `meta.driverAdapterError.cause.detail`.
// pino's error serializer logs the message, the stack and own properties such as `meta`, so a bad
// lookup of a token hash would put the hash in the log. A unique, foreign key or not-found error is
// already value-free.
//
// meta.driverAdapterError is an Error whose own message is the database's text; util.inspect (what
// console prints) shows it even though JSON does not.
//
// scrubPrismaError rewrites such an error IN PLACE, so it keeps its class and `code` and callers'
// `instanceof` and `error.code` checks still work: free text that can hold values is replaced by a
// fixed sentence, and the cause of a driver error keeps only codes and names. It sends no query.
import { Prisma } from '../generated/prisma/client.js';

/** Known request error codes whose message is a fixed sentence with a constraint or model name. */
const VALUE_FREE_CODES = new Set(['P2002', 'P2003', 'P2025', 'P2024', 'P2028', 'P2034']);

/** Postgres error classes whose message names a constraint or table and never a value. */
const VALUE_FREE_SQLSTATES = new Set([
  '23505', // unique violation
  '23503', // foreign key violation
  '23514', // check violation
  '23502', // not-null violation
  '42501', // permission denied
  '40001', // serialization failure
  '40P01', // deadlock
  '55P03', // lock not available
  '57014', // query canceled
]);

/** Keys of a driver error's cause that hold codes and names. Everything else is dropped. */
const CAUSE_NAMES = new Set([
  'name',
  'originalCode',
  'kind',
  'code',
  'severity',
  'constraint',
  'table',
  'column',
]);
/** Free text of the cause, kept only when the SQLSTATE says it is value-free. */
const CAUSE_TEXT = new Set(['originalMessage', 'message']);

type PlainObject = Record<string, unknown>;

function isObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null;
}

/** "Invalid `prisma.user.findUnique()` invocation:" from the start of a Prisma message. */
function invocationHeader(message: string): string {
  const match = /Invalid `([^`]*)` invocation/.exec(message);
  return `Invalid \`${match?.[1] ?? 'invocation'}\` invocation:`;
}

/** The driver error cause inside `meta`, when there is one. */
function causeOf(meta: unknown): PlainObject | undefined {
  if (!isObject(meta)) return undefined;
  const adapter = meta.driverAdapterError;
  return isObject(adapter) && isObject(adapter.cause) ? adapter.cause : undefined;
}

function sqlstateOf(cause: PlainObject | undefined): string | undefined {
  const code = cause?.originalCode ?? cause?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/** Drops everything from the cause except codes and names (and its text, when that is safe). */
function scrubCause(cause: PlainObject, keepText: boolean): void {
  for (const key of Object.keys(cause)) {
    if (CAUSE_NAMES.has(key) || (keepText && CAUSE_TEXT.has(key))) continue;
    delete cause[key];
  }
}

/** Replaces the message and rebuilds the stack from it, keeping the original frames. */
function setMessage(error: Error, message: string): void {
  const frames = (error.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line));
  error.message = message;
  error.stack = [`${error.name}: ${message}`, ...frames].join('\n');
}

function scrubKnownRequest(error: Prisma.PrismaClientKnownRequestError): void {
  const meta: unknown = error.meta;
  const cause = causeOf(meta);
  const sqlstate = sqlstateOf(cause);
  const valueFree =
    VALUE_FREE_CODES.has(error.code) ||
    (sqlstate !== undefined && VALUE_FREE_SQLSTATES.has(sqlstate));

  if (cause !== undefined) scrubCause(cause, valueFree);
  if (!valueFree) {
    // meta.driverAdapterError is itself an Error: its message (not enumerable, but printed by
    // util.inspect and console) is the database's text, so it is replaced too.
    const adapter = isObject(meta) ? meta.driverAdapterError : undefined;
    if (adapter instanceof Error) {
      setMessage(
        adapter,
        `Database error${sqlstate === undefined ? '' : ` (SQLSTATE ${sqlstate})`}.`,
      );
    }
    // Keep the model name and the scrubbed driver error; the rest of meta is free text.
    if (isObject(meta)) {
      for (const key of Object.keys(meta)) {
        if (key !== 'modelName' && key !== 'driverAdapterError') delete meta[key];
      }
    }
    setMessage(
      error,
      `${invocationHeader(error.message)}\n\n\nDatabase error ${error.code}` +
        `${sqlstate === undefined ? '' : ` (SQLSTATE ${sqlstate})`}. The database's message is ` +
        'withheld because it can contain argument values.',
    );
  }
}

function scrubValidation(error: Prisma.PrismaClientValidationError): void {
  const names = new Set<string>();
  for (const match of error.message.matchAll(/[Aa]rgument `([A-Za-z_][A-Za-z0-9_.]*)`/g)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  const listed = [...names].slice(0, 10);
  setMessage(
    error,
    `${invocationHeader(error.message)}\n\n\nPrisma rejected the arguments` +
      `${listed.length === 0 ? '' : ` (${listed.join(', ')})`}. The values are withheld from the ` +
      'message because it is logged.',
  );
}

function scrubUnknown(error: Error): void {
  setMessage(
    error,
    `${invocationHeader(error.message)}\n\n\nUnknown database error. The message is withheld ` +
      'because it can contain argument values.',
  );
}

/**
 * Scrubs a Prisma error in place and returns it. Anything that is not a Prisma request or
 * validation error comes back untouched (a connection error names a host, not a value).
 */
export function scrubPrismaError(error: unknown): unknown {
  try {
    if (error instanceof Prisma.PrismaClientKnownRequestError) scrubKnownRequest(error);
    else if (error instanceof Prisma.PrismaClientValidationError) scrubValidation(error);
    else if (error instanceof Prisma.PrismaClientUnknownRequestError) scrubUnknown(error);
  } catch {
    // The error is rethrown as it is: scrubbing must never hide the original failure.
  }
  return error;
}
