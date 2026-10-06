import { describe, expect, it } from 'vitest';
import {
  MAX_CSV_BYTES,
  MAX_CSV_ROWS,
  errorReportCsv,
  isEmail,
  looksLikeFormula,
  neutralise,
  parseInviteCsv,
  readRecords,
} from './csv';

describe('FR-304 TC-023: invitation CSV intake', () => {
  it('reads a plain file', () => {
    const r = parseInviteCsv('email,name\nada@example.test,Ada\ngrace@example.test,Grace\n');
    expect(r.fatal).toBeNull();
    expect(r.valid.map((v) => v.email)).toEqual(['ada@example.test', 'grace@example.test']);
    expect(r.problems).toEqual([]);
  });

  it('strips a byte order mark, so the first header still matches', () => {
    const r = parseInviteCsv('﻿email,name\r\nada@example.test,Ada\r\n');
    expect(r.fatal).toBeNull();
    expect(r.valid).toHaveLength(1);
  });

  it('accepts CRLF, LF and lone CR line ends', () => {
    for (const eol of ['\r\n', '\n', '\r']) {
      const r = parseInviteCsv(`email,name${eol}a@example.test,A${eol}b@example.test,B`);
      expect(r.valid.map((v) => v.name)).toEqual(['A', 'B']);
    }
  });

  it('handles quotes, doubled quotes, commas and newlines inside a cell', () => {
    const r = parseInviteCsv('email,name\r\na@example.test,"Lovelace, ""Ada""\nCountess"\r\n');
    expect(r.valid[0]?.name).toBe('Lovelace, "Ada"\nCountess');
  });

  it('refuses a quote that never closes', () => {
    expect(parseInviteCsv('email,name\na@example.test,"Ada\n').fatal).toBe('unterminated-quote');
  });

  it('accepts other header spellings and the optional reference column', () => {
    const r = parseInviteCsv('Full Name,E-mail,external_ref\nAda,a@example.test,EMP-1\n');
    expect(r.valid[0]).toMatchObject({
      name: 'Ada',
      email: 'a@example.test',
      externalRef: 'EMP-1',
    });
  });

  it('asks for the email and name columns', () => {
    expect(parseInviteCsv('mail,who\na@example.test,A').fatal).toBe('missing-column');
    expect(parseInviteCsv('email,name\n').fatal).toBe('no-header');
    expect(parseInviteCsv('').fatal).toBe('empty');
  });

  it('flags invalid emails, empty cells and over-long values, without echoing cells in the message', () => {
    const r = parseInviteCsv(
      [
        'email,name',
        'not-an-email,Ada',
        'a@example.test,',
        ',Bob',
        `c@example.test,${'x'.repeat(201)}`,
      ].join('\n'),
    );
    expect(r.valid).toEqual([]);
    expect(r.problems.map((p) => p.row)).toEqual([1, 2, 3, 4]);
    for (const p of r.problems) {
      expect(p.message).not.toContain('not-an-email');
      expect(p.message).not.toContain('@example.test');
    }
  });

  it('keeps the first of duplicate emails (any case) and reports the rest', () => {
    const r = parseInviteCsv(
      'email,name\na@example.test,A\nA@Example.test,A again\nb@example.test,B',
    );
    expect(r.valid.map((v) => v.row)).toEqual([1, 3]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ row: 2 });
    expect(r.problems[0]?.message).toContain('row 1');
  });

  it('keeps formula-like cells as data, reports them, and neutralises them in the report', () => {
    const r = parseInviteCsv(
      'email,name\na@example.test,=HYPERLINK("http://evil.test")\nb@example.test,+1\nc@example.test,@SUM(A1)',
    );
    expect(r.valid).toHaveLength(3);
    expect(r.formulaLike).toEqual([1, 2, 3]);
    expect(looksLikeFormula('=1+1')).toBe(true);
    expect(looksLikeFormula('Ada')).toBe(false);
    expect(neutralise('=1+1')).toBe("'=1+1");
    const report = errorReportCsv([{ row: 1, message: 'No.', email: '=cmd', name: '-2+3' }]);
    expect(report).toContain("'=cmd");
    expect(report).toContain("'-2+3");
    expect(report.split('\r\n')[0]).toBe('row,email,name,problem');
  });

  it('quotes cells in the report that contain commas, quotes or newlines', () => {
    const report = errorReportCsv([
      { row: 2, message: 'x', email: 'a@example.test', name: 'A, "B"' },
    ]);
    expect(report).toContain('"A, ""B"""');
  });

  it('allows exactly 10,000 rows and refuses 10,001', () => {
    const rows = (n: number) =>
      'email,name\n' + Array.from({ length: n }, (_, i) => `u${i}@e.test,N`).join('\n');
    const ok = parseInviteCsv(rows(MAX_CSV_ROWS));
    expect(ok.fatal).toBeNull();
    expect(ok.valid).toHaveLength(MAX_CSV_ROWS);
    const over = parseInviteCsv(rows(MAX_CSV_ROWS + 1));
    expect(over.fatal).toBe('too-many-rows');
    expect(over.valid).toEqual([]);
  });

  it('refuses a file over the size limit', () => {
    expect(parseInviteCsv('email,name\n' + 'x'.repeat(MAX_CSV_BYTES)).fatal).toBe('too-large');
  });

  it('skips blank lines but keeps row numbers aligned with the data rows', () => {
    const r = parseInviteCsv('email,name\n\na@example.test,A\n\n\nbad,B\n');
    expect(r.total).toBe(2);
    expect(r.problems[0]?.row).toBe(2);
  });

  it('email check rejects spaces, double dots and missing domains', () => {
    expect(isEmail('a@example.test')).toBe(true);
    expect(isEmail('a b@example.test')).toBe(false);
    expect(isEmail('a..b@example.test')).toBe(false);
    expect(isEmail('a@localhost')).toBe(false);
    expect(readRecords('a,b\r\nc,d').records).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});
