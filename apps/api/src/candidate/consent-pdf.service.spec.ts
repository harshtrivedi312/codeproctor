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
    { get: (k: string) => ({ APP_ENV: 'development', NODE_ENV: 'development' })[k] } as never,
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

describe('ConsentPdfService demo text in shared environments (FR-401, C-07, TC-095, K2/F6)', () => {
  function buildWith(appEnv: string, text: Record<string, unknown>) {
    const putObject = jest.fn();
    const sendConsentCopy = jest.fn();
    const client = {
      consent: {
        findUnique: ok({
          id: 'c1',
          consentTextId: 't1',
          signedName: 'Ada Lovelace',
          signedAt: new Date('2026-10-05T12:00:00.000Z'),
          ageConfirmedAt: new Date(),
          pdfKey: null,
          copyEmailedAt: null,
        }),
        updateMany: ok({ count: 1 }),
      },
      consentText: { findUnique: ok(text) },
      organization: { findUnique: ok({ name: 'Acme' }) },
      session: { findUnique: ok({ invitationId: 'i1' }) },
      invitation: { findUnique: ok({ candidateId: 'cand1' }) },
      candidate: { findUnique: ok({ email: 'a@example.com' }) },
    };
    const service = new ConsentPdfService(
      { client } as never,
      { runInOrg: (_org: string, fn: () => Promise<unknown>) => fn() } as never,
      { putObject, deleteObject: jest.fn() },
      { sendConsentCopy } as never,
      { get: (k: string) => ({ APP_ENV: appEnv, NODE_ENV: 'production' })[k] } as never,
    );
    return { service, putObject, sendConsentCopy };
  }
  const DEMO = {
    version: '0.2-local-demo',
    bodyMd: 'demo',
    legalApprovedAt: new Date(),
    legalApprovedBy: 'local-demo (synthetic data, development only)',
  };

  beforeEach(() => jest.mocked(renderConsentPdf).mockClear());

  it.each(['staging', 'pilot', 'production'])(
    'TC-095, K2/F6: APP_ENV %s neither renders, stores nor emails the demo text',
    async (appEnv) => {
      const { service, putObject, sendConsentCopy } = buildWith(appEnv, DEMO);
      await expect(service.generate(ORG, SESSION)).resolves.toBe(false);
      expect(renderConsentPdf).not.toHaveBeenCalled();
      expect(putObject).not.toHaveBeenCalled();
      expect(sendConsentCopy).not.toHaveBeenCalled();
    },
  );

  it('TC-095, K2/F6: a real approved text is still rendered, stored and emailed in a shared env', async () => {
    const { service, putObject, sendConsentCopy } = buildWith('pilot', {
      version: '1.0',
      bodyMd: 'real',
      legalApprovedAt: new Date(),
      legalApprovedBy: 'Counsel, Example LLP',
    });
    await expect(service.generate(ORG, SESSION)).resolves.toBe(true);
    expect(putObject).toHaveBeenCalledTimes(1);
    expect(sendConsentCopy).toHaveBeenCalledTimes(1);
  });
});
