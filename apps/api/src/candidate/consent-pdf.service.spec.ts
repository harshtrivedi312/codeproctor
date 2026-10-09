import { CONSENT_PDF_JOB_WRITE_COLUMNS, ConsentPdfService } from './consent-pdf.service';
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

describe('ConsentPdfService writes only the PDF columns (FU-DB-266, C-30, D-55, FR-401)', () => {
  function run(overrides: { pdfKey: string | null; copyEmailedAt: Date | null }) {
    const updateMany = jest.fn(() => Promise.resolve({ count: 1 }));
    const client = {
      consent: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            id: 'c1',
            consentTextId: 't1',
            signedName: 'Ada Lovelace',
            signedAt: new Date('2026-10-05T12:00:00.000Z'),
            ageConfirmedAt: new Date('2026-10-05T12:00:00.000Z'),
            ...overrides,
          }),
        ),
        updateMany,
      },
      consentText: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            version: '1.0',
            bodyMd: 'x',
            legalApprovedAt: new Date(),
            legalApprovedBy: 'Counsel',
          }),
        ),
      },
      organization: { findUnique: jest.fn(() => Promise.resolve({ name: 'Acme' })) },
      session: { findUnique: jest.fn(() => Promise.resolve({ invitationId: 'i1' })) },
      invitation: { findUnique: jest.fn(() => Promise.resolve({ candidateId: 'cand1' })) },
      candidate: { findUnique: jest.fn(() => Promise.resolve({ email: 'a@example.com' })) },
    };
    const service = new ConsentPdfService(
      { client } as never,
      { runInOrg: (_org: string, fn: () => Promise<unknown>) => fn() } as never,
      { putObject: jest.fn(), deleteObject: jest.fn() },
      { sendConsentCopy: jest.fn() } as never,
      { get: (k: string) => ({ APP_ENV: 'development', NODE_ENV: 'development' })[k] } as never,
    );
    return { service, updateMany };
  }

  it.each([
    [
      'PDF and copy both missing',
      { pdfKey: null, copyEmailedAt: null },
      [['pdfGeneratedAt', 'pdfKey'], ['copyEmailedAt']],
    ],
    [
      'PDF missing, copy already sent',
      { pdfKey: null, copyEmailedAt: new Date() },
      [['pdfGeneratedAt', 'pdfKey']],
    ],
    ['PDF stored, copy missing', { pdfKey: 'k', copyEmailedAt: null }, [['copyEmailedAt']]],
    ['both done', { pdfKey: 'k', copyEmailedAt: new Date() }, []],
  ] as const)(
    'FU-DB-266: %s writes exactly the expected PDF columns, never signedAt, signedName or ageConfirmedAt',
    async (_name, state, expected) => {
      const { service, updateMany } = run({ ...state });
      await expect(service.generate(ORG, SESSION)).resolves.toBe(true);
      const calls = updateMany.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>;
      expect(calls.map(([a]) => Object.keys(a.data).sort())).toEqual(expected);
      const allowed: readonly string[] = CONSENT_PDF_JOB_WRITE_COLUMNS;
      for (const [args] of calls) {
        for (const column of Object.keys(args.data)) expect(allowed).toContain(column);
        for (const forbidden of [
          'signedAt',
          'signedName',
          'ageConfirmedAt',
          'consentTextId',
          'ip',
        ]) {
          expect(Object.keys(args.data)).not.toContain(forbidden);
        }
      }
    },
  );

  it('FU-DB-266: the allowed list is exactly the three PDF columns', () => {
    expect([...CONSENT_PDF_JOB_WRITE_COLUMNS].sort()).toEqual(
      ['copyEmailedAt', 'pdfGeneratedAt', 'pdfKey'].sort(),
    );
  });
});
