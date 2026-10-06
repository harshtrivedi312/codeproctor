/*
 * CSV intake for bulk invitations (FR-304, TC-023). A careful hand-rolled RFC 4180 reader with hard
 * limits, because the content is candidate PII: it lives only in component state, is never logged,
 * never put in a URL or storage, and is cleared with the dialog. Cells that start with a
 * spreadsheet formula character (= + - @, a tab or a carriage return) are kept as data and only
 * ever shown as text (React escapes them); a downloaded error report neutralises them with a
 * leading apostrophe so a spreadsheet never runs them.
 */

export const MAX_CSV_BYTES = 1_000_000;
export const MAX_CSV_ROWS = 10_000;
export const MAX_EMAIL = 254;
export const MAX_NAME = 200;
export const MAX_EXTERNAL_REF = 200;
export const BULK_CHUNK = 200;

export type CsvError =
  'too-large' | 'too-many-rows' | 'unterminated-quote' | 'empty' | 'no-header' | 'missing-column';

export interface CsvRowInput {
  /** 1-based line of the row in the data (the first row after the header is 1). */
  row: number;
  email: string;
  name: string;
  externalRef: string;
}
export interface CsvProblem {
  row: number;
  /** Plain words, no cell content (so a problem can be shown and exported without re-leaking PII). */
  message: string;
  /** The raw cells, kept for the on-screen preview only. */
  email: string;
  name: string;
}
export interface CsvParse {
  fatal: CsvError | null;
  total: number;
  valid: CsvRowInput[];
  problems: CsvProblem[];
  /** Rows whose email or name start with a formula character (kept as data). */
  formulaLike: number[];
}

/** True when a spreadsheet could read the cell as a formula. */
export const looksLikeFormula = (cell: string): boolean => /^[=+\-@\t\r]/.test(cell);

/** For a CSV that is downloaded: a cell that could run as a formula gets a leading apostrophe. */
export const neutralise = (cell: string): string => (looksLikeFormula(cell) ? `'${cell}` : cell);

const csvCell = (cell: string): string => {
  const safe = neutralise(cell);
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Splits CSV text into records: BOM stripped, CRLF, LF and CR accepted, quotes and embedded newlines handled. */
export function readRecords(text: string): { records: string[][]; unterminated: boolean } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let inQuotes = false;
  let wasQuoted = false;
  let i = 0;
  const endCell = (): void => {
    record.push(wasQuoted ? cell : cell.trim());
    cell = '';
    wasQuoted = false;
  };
  const endRecord = (): void => {
    endCell();
    // A line with nothing in it is skipped; a line of empty cells is a row with problems.
    if (!(record.length === 1 && record[0] === '')) records.push(record);
    record = [];
  };
  while (i < src.length) {
    const ch = src[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else cell += ch;
    } else if (ch === '"' && cell.trim() === '') {
      inQuotes = true;
      wasQuoted = true;
      cell = '';
    } else if (ch === ',') endCell();
    else if (ch === '\r') {
      if (src[i + 1] === '\n') i += 1;
      endRecord();
    } else if (ch === '\n') endRecord();
    else cell += ch;
    i += 1;
  }
  if (inQuotes) return { records, unterminated: true };
  if (cell !== '' || record.length > 0 || wasQuoted) endRecord();
  return { records, unterminated: false };
}

const EMAIL = /^[^\s@"(),:;<>[\\\]]+@[^\s@"(),:;<>[\\\]]+\.[^\s@"(),:;<>[\\\]]{2,}$/;
export const isEmail = (v: string): boolean =>
  v.length <= MAX_EMAIL && EMAIL.test(v) && !v.includes('..');

const HEADERS: Record<string, 'email' | 'name' | 'externalRef'> = {
  email: 'email',
  'e-mail': 'email',
  name: 'name',
  'full name': 'name',
  full_name: 'name',
  fullname: 'name',
  external_ref: 'externalRef',
  externalref: 'externalRef',
  'external ref': 'externalRef',
};

/** Parses and validates an invitation CSV: header with email and name (and optionally external_ref). */
export function parseInviteCsv(text: string): CsvParse {
  const none = (fatal: CsvError): CsvParse => ({
    fatal,
    total: 0,
    valid: [],
    problems: [],
    formulaLike: [],
  });
  if (new TextEncoder().encode(text).length > MAX_CSV_BYTES) return none('too-large');
  const { records, unterminated } = readRecords(text);
  if (unterminated) return none('unterminated-quote');
  if (records.length === 0) return none('empty');
  const header = records[0] as string[];
  const col: Partial<Record<'email' | 'name' | 'externalRef', number>> = {};
  header.forEach((h, idx) => {
    const key = HEADERS[h.trim().toLowerCase()];
    if (key !== undefined && col[key] === undefined) col[key] = idx;
  });
  if (col.email === undefined || col.name === undefined) return none('missing-column');
  const data = records.slice(1);
  if (data.length === 0) return none('no-header');
  if (data.length > MAX_CSV_ROWS) return { ...none('too-many-rows'), total: data.length };
  const valid: CsvRowInput[] = [];
  const problems: CsvProblem[] = [];
  const formulaLike: number[] = [];
  const seen = new Map<string, number>();
  data.forEach((cells, idx) => {
    const row = idx + 1;
    const email = (cells[col.email as number] ?? '').trim();
    const name = (cells[col.name as number] ?? '').trim();
    const externalRef = col.externalRef === undefined ? '' : (cells[col.externalRef] ?? '').trim();
    if (looksLikeFormula(email) || looksLikeFormula(name)) formulaLike.push(row);
    const problem = (message: string): void => void problems.push({ row, message, email, name });
    if (email === '') return problem('The email is empty.');
    if (!isEmail(email)) return problem('This is not a valid email address.');
    if (name === '') return problem('The name is empty.');
    if (name.length > MAX_NAME) return problem(`The name is longer than ${MAX_NAME} characters.`);
    if (externalRef.length > MAX_EXTERNAL_REF)
      return problem(`The reference is longer than ${MAX_EXTERNAL_REF} characters.`);
    const key = email.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined)
      return problem(`The same email as row ${first}; only the first one is invited.`);
    seen.set(key, row);
    valid.push({ row, email, name, externalRef });
  });
  return { fatal: null, total: data.length, valid, problems, formulaLike };
}

export const FATAL_MESSAGE: Record<CsvError, string> = {
  'too-large': 'This file is larger than 1 MB. Split it into smaller files.',
  'too-many-rows': `This file has more than ${MAX_CSV_ROWS.toLocaleString('en-US')} rows. Split it into smaller files.`,
  'unterminated-quote': 'A quoted cell is never closed. Check the quotes in your file.',
  empty: 'The file is empty.',
  'no-header': 'The file has a header but no candidates.',
  'missing-column':
    'The first line must name the columns, and it needs "email" and "name". Download the example to see the layout.',
};

/** The rows that could not be invited, as a CSV the recruiter can fix and upload again. Formula-like cells are neutralised. */
export function errorReportCsv(problems: readonly CsvProblem[]): string {
  return [
    ['row', 'email', 'name', 'problem'],
    ...problems.map((p) => [String(p.row), p.email, p.name, p.message]),
  ]
    .map((r) => r.map(csvCell).join(','))
    .join('\r\n');
}

export const EXAMPLE_CSV =
  'email,name\r\nada@example.test,Ada Lovelace\r\ngrace@example.test,Grace Hopper\r\n';
