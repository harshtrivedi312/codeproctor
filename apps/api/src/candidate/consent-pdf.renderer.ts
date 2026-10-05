// Signed consent PDF (FR-401, C-07, D-17): the document text, version, signed name, server
// timestamp and the 18+ confirmation (C-30). pdfkit only: no headless browser (ADR 0001). BE-14
// reuses this renderer for the report PDF. The text is rendered as plain paragraphs with simple
// Markdown headings; nothing from the candidate except the typed name is placed in the file.
import PDFDocument from 'pdfkit';

export interface ConsentPdfInput {
  readonly orgName: string;
  readonly documentVersion: string;
  readonly bodyMd: string;
  /** False while the text is a placeholder: the PDF says so on every page header. */
  readonly legalApproved: boolean;
  readonly signedName: string;
  readonly signedAt: Date;
  readonly consentId: string;
  readonly sessionId: string;
  readonly ageConfirmed: boolean;
}

interface Block {
  readonly kind: 'h1' | 'h2' | 'h3' | 'p';
  readonly text: string;
}

/** Strips the Markdown the consent text uses (headings, emphasis, list markers) down to blocks. */
export function toBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: 'p', text: paragraph.join(' ') });
    paragraph = [];
  };
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = (heading[1] ?? '#').length;
      blocks.push({ kind: level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3', text: clean(heading[2] ?? '') });
    } else if (line === '') {
      flush();
    } else if (/^[-*]\s+/.test(line)) {
      flush();
      blocks.push({ kind: 'p', text: `• ${clean(line.replace(/^[-*]\s+/, ''))}` });
    } else {
      paragraph.push(clean(line));
    }
  }
  flush();
  return blocks;
}

function clean(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/[*_`]/g, '').replace(/\[(.+?)\]\(.+?\)/g, '$1');
}

export function renderConsentPdf(input: ConsentPdfInput): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 56,
      // Fixed metadata: no author name, no machine data, and a reproducible creation date.
      info: {
        Title: `Consent document ${input.documentVersion}`,
        Producer: 'CodeProctor',
        Creator: 'CodeProctor',
        CreationDate: input.signedAt,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    doc.font('Helvetica-Bold').fontSize(16).text(`${input.orgName}: consent document`);
    doc.font('Helvetica').fontSize(10).fillColor('#444444');
    doc.text(`Version ${input.documentVersion}`);
    if (!input.legalApproved) {
      doc
        .moveDown(0.5)
        .fillColor('#b00020')
        .font('Helvetica-Bold')
        .text('PLACEHOLDER TEXT: NOT APPROVED BY LEGAL. NOT FOR REAL CANDIDATES.');
    }
    doc.moveDown().fillColor('#000000');

    for (const block of toBlocks(input.bodyMd)) {
      if (block.kind === 'h1') doc.moveDown(0.5).font('Helvetica-Bold').fontSize(14);
      else if (block.kind === 'h2') doc.moveDown(0.5).font('Helvetica-Bold').fontSize(12);
      else if (block.kind === 'h3') doc.moveDown(0.3).font('Helvetica-Bold').fontSize(11);
      else doc.moveDown(0.3).font('Helvetica').fontSize(10.5);
      doc.text(block.text, { align: 'left' });
    }

    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(14).text('Signature record');
    doc.moveDown().font('Helvetica').fontSize(11);
    doc.text(`Signed by typing the full legal name: ${input.signedName}`);
    doc.text(`Signed at (server time, UTC): ${input.signedAt.toISOString()}`);
    doc.text(`Document version: ${input.documentVersion}`);
    doc.text(
      input.ageConfirmed
        ? 'The signer confirmed being 18 years of age or older.'
        : 'Age confirmation: not recorded.',
    );
    doc.moveDown().fontSize(9).fillColor('#444444');
    doc.text(`Record: ${input.consentId}`);
    doc.text(`Session: ${input.sessionId}`);
    doc.moveDown(0.5);
    doc.text(
      'The signer read the document to the end and signed electronically by typing their full legal name. ' +
        'The date and time were set by the server, not by the signer.',
    );
    doc.end();
  });
}
