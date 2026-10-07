import { randomUUID } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { ageStatement, renderConsentPdf, toBlocks } from './consent-pdf.renderer';

const base = {
  orgName: 'Acme Hiring',
  documentVersion: '2026-10-v1',
  bodyMd:
    '# Consent\n\nWe record **screen**, webcam and microphone.\n\n- Retention 90 days\n- Appeals in 7 days\n',
  legalApproved: true,
  signedName: 'Ada Lovelace',
  signedAt: new Date('2026-10-05T12:34:56.000Z'),
  consentId: randomUUID(),
  sessionId: randomUUID(),
  ageConfirmed: true,
};

describe('Signed consent PDF (FR-401, C-07, C-30, TC-095)', () => {
  it('TC-095: renders a real PDF document', async () => {
    const pdf = await renderConsentPdf(base);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.subarray(pdf.length - 8).toString('latin1')).toContain('%%EOF');
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it('TC-095: two renders of the same record are the same size class (deterministic content)', async () => {
    const a = await renderConsentPdf(base);
    const b = await renderConsentPdf(base);
    expect(Math.abs(a.length - b.length)).toBeLessThan(200);
  });

  it('D-17: a placeholder text and an unapproved text render too (the PDF says so)', async () => {
    const pdf = await renderConsentPdf({ ...base, legalApproved: false });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('FR-401: Markdown is reduced to plain blocks: headings, paragraphs, list items', () => {
    expect(toBlocks(base.bodyMd)).toEqual([
      { kind: 'h1', text: 'Consent' },
      { kind: 'p', text: 'We record screen, webcam and microphone.' },
      { kind: 'p', text: '• Retention 90 days' },
      { kind: 'p', text: '• Appeals in 7 days' },
    ]);
    expect(toBlocks('')).toEqual([]);
    expect(toBlocks('[link](http://x.test) and `code`')).toEqual([
      { kind: 'p', text: 'link and code' },
    ]);
  });

  it('FR-401 C-30 TC-095: the 18+ statement is made only for a confirmed signature', () => {
    expect(ageStatement(true)).toBe('The signer confirmed being 18 years of age or older.');
    expect(ageStatement(false)).toBe('Age confirmation: not recorded.');
  });

  it.each([
    [
      true,
      'The signer confirmed being 18 years of age or older.',
      'Age confirmation: not recorded.',
    ],
    [
      false,
      'Age confirmation: not recorded.',
      'The signer confirmed being 18 years of age or older.',
    ],
  ])(
    'FR-401 C-30 TC-095: the rendered text for ageConfirmed=%s has the right statement and not the other',
    async (ageConfirmed, present, absent) => {
      const lines: string[] = [];
      const proto = PDFDocument.prototype as { text: (this: unknown, t: unknown) => unknown };
      const real = proto.text;
      const spy = jest.spyOn(proto, 'text').mockImplementation(function (
        this: unknown,
        t: unknown,
      ) {
        lines.push(String(t));
        return real.call(this, t);
      });
      try {
        await renderConsentPdf({ ...base, ageConfirmed });
      } finally {
        spy.mockRestore();
      }
      expect(lines).toContain(present);
      expect(lines).not.toContain(absent);
    },
  );
});
