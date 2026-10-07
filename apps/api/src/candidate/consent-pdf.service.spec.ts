import { ConsentPdfService } from './consent-pdf.service';
import { renderConsentPdf } from './consent-pdf.renderer';

jest.mock('./consent-pdf.renderer', () => ({
  renderConsentPdf: jest.fn(() => Promise.resolve(Buffer.from('%PDF-test'))),
}));

const SESSION = '00000000-0000-4000-8000-000000000001';
const ORG = '00000000-0000-4000-8000-000000000002';

const ok = <T>(value: T) => jest.fn(() => Promise.resolve(value));

function build(ageConfirmedAt: Date | null): ConsentPdfService {
  const client = {
    consent: {
      findUnique: ok({
        id: 'c1',
        consentTextId: 't1',
        signedName: 'Ada Lovelace',
        signedAt: new Date('2026-10-05T12:00:00.000Z'),
        ageConfirmedAt,
        pdfKey: null,
        copyEmailedAt: new Date(),
      }),
      updateMany: ok({ count: 1 }),
    },
    consentText: {
      findUnique: ok({ version: 'v1', bodyMd: 'x', legalApprovedAt: new Date() }),
    },
    organization: { findUnique: ok({ name: 'Acme' }) },
    session: { findUnique: ok({ invitationId: 'i1' }) },
  };
  return new ConsentPdfService(
    { client } as never,
    { runInOrg: (_org: string, fn: () => Promise<unknown>) => fn() } as never,
    { putObject: jest.fn(), deleteObject: jest.fn() },
    { sendConsentCopy: jest.fn() } as never,
  );
}

describe('ConsentPdfService age statement (FR-401, C-30, D-55, TC-095)', () => {
  beforeEach(() => jest.mocked(renderConsentPdf).mockClear());

  it('TC-095 C-30: a consent row without age_confirmed_at is rendered with ageConfirmed false', async () => {
    await build(null).generate(ORG, SESSION);
    expect(renderConsentPdf).toHaveBeenCalledWith(expect.objectContaining({ ageConfirmed: false }));
  });

  it('TC-095 C-30: a consent row with age_confirmed_at is rendered with ageConfirmed true', async () => {
    await build(new Date('2026-10-05T12:00:00.000Z')).generate(ORG, SESSION);
    expect(renderConsentPdf).toHaveBeenCalledWith(expect.objectContaining({ ageConfirmed: true }));
  });
});
