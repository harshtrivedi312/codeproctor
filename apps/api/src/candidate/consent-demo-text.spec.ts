// K2/F6 of the compliance review of 2026-10-08: the dev-only demo consent text ("0.2-local-demo")
// must not be served or accepted in a shared environment, even with legal_approved_at set.
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import type { PrismaService } from '../database/prisma.service';
import type { SessionStateService } from '../session/session-state.service';
import type { CandidateContext } from './candidate.types';
import type { CandidateScope } from './candidate-scope';
import { ConsentService } from './consent.service';
import { isDemoConsentText } from './demo-consent';
import type { SessionJobsService } from './session-jobs.service';

const ctx = {
  sessionId: 's1',
  orgId: 'o1',
  status: 'OPENED',
} as unknown as CandidateContext;

type TextRow = {
  id: string;
  version: string;
  bodyMd: string;
  legalApprovedAt: Date | null;
  legalApprovedBy: string | null;
};
const DEMO: TextRow = {
  id: 't1',
  version: '0.2-local-demo',
  bodyMd: 'demo',
  legalApprovedAt: new Date('2026-10-01T00:00:00Z'),
  legalApprovedBy: 'local-demo (synthetic data, development only)',
};
const REAL: TextRow = {
  id: 't2',
  version: '1.0',
  bodyMd: 'real',
  legalApprovedAt: new Date('2026-10-01T00:00:00Z'),
  legalApprovedBy: 'Counsel, Example LLP',
};

function service(
  appEnv: string,
  row: TextRow,
  options: { signedAt?: Date | null; nodeEnv?: string; requireApproval?: boolean } = {},
): ConsentService {
  const prisma = {
    client: {
      consent: {
        findUnique: () =>
          Promise.resolve(
            options.signedAt ? { consentTextId: row.id, signedAt: options.signedAt } : null,
          ),
      },
      organization: { findUnique: () => Promise.resolve({ currentConsentTextId: row.id }) },
      consentText: { findUnique: () => Promise.resolve(row) },
    },
  } as unknown as PrismaService;
  const scope = {
    asCandidate: (_c: unknown, fn: () => unknown) => Promise.resolve(fn()),
    asOrg: (_c: unknown, fn: () => unknown) => Promise.resolve(fn()),
  } as unknown as CandidateScope;
  const values: Record<string, unknown> = {
    APP_ENV: appEnv,
    NODE_ENV: options.nodeEnv ?? 'production',
    REQUIRE_LEGAL_APPROVED_CONSENT: options.requireApproval ?? false,
  };
  const config = { get: (k: string) => values[k] } as unknown as ConfigService<Env, true>;
  return new ConsentService(
    prisma,
    scope,
    {} as SessionStateService,
    {} as SessionJobsService,
    config,
  );
}

/** The machine code of the CodedHttpException a call rejects with, or null when it resolves. */
async function codeOf(call: Promise<unknown>): Promise<string | null> {
  try {
    await call;
    return null;
  } catch (e) {
    const body = (e as { getResponse?: () => unknown }).getResponse?.();
    return (body as { code?: string } | undefined)?.code ?? 'OTHER';
  }
}

const sign = (svc: ConsentService, textId: string): Promise<unknown> =>
  svc.sign(
    ctx,
    { consentTextId: textId, signedName: 'Ada Lovelace', confirmedAge18: true },
    {
      ip: '203.0.113.9',
      userAgent: 'jest',
    },
  );

describe('Demo consent text in shared environments (FR-401, C-07, compliance K2/F6)', () => {
  it('FR-401, K2/F6: the marker is the version suffix -local-demo or an approver starting local-demo', () => {
    expect(isDemoConsentText({ version: '0.2-local-demo', legalApprovedBy: null })).toBe(true);
    expect(isDemoConsentText({ version: '1.0', legalApprovedBy: 'local-demo (x)' })).toBe(true);
    expect(isDemoConsentText({ version: '1.0', legalApprovedBy: 'Counsel, Example LLP' })).toBe(
      false,
    );
    expect(isDemoConsentText({ version: '1.0-local-demo2', legalApprovedBy: null })).toBe(false);
    expect(isDemoConsentText({ version: '1.0', legalApprovedBy: null })).toBe(false);
  });

  it.each(['staging', 'pilot', 'production'])(
    'FR-401, C-07: APP_ENV %s refuses to serve the approved demo text (CONSENT_NOT_APPROVED)',
    async (appEnv) => {
      expect(await codeOf(service(appEnv, DEMO).get(ctx))).toBe('CONSENT_NOT_APPROVED');
    },
  );

  it('FR-401, C-07: a demo text already signed is refused too (a restore must not keep serving it)', async () => {
    expect(
      await codeOf(service('pilot', DEMO, { signedAt: new Date('2026-10-02T00:00:00Z') }).get(ctx)),
    ).toBe('CONSENT_NOT_APPROVED');
  });

  it.each(['staging', 'pilot', 'production'])(
    'FR-401, C-07: APP_ENV %s refuses to accept a signature on the demo text',
    async (appEnv) => {
      expect(await codeOf(sign(service(appEnv, DEMO), DEMO.id))).toBe('CONSENT_NOT_APPROVED');
    },
  );

  it('FR-401, C-07, K2/F6: a misspelled APP_ENV counts as shared (allowlist), and NODE_ENV production always does', async () => {
    expect(await codeOf(service('prod', DEMO).get(ctx))).toBe('CONSENT_NOT_APPROVED');
    expect(await codeOf(service('development', DEMO, { nodeEnv: 'production' }).get(ctx))).toBe(
      'CONSENT_NOT_APPROVED',
    );
  });

  it('FR-401, C-07, K2/F6: with approval required (pilot and production) the demo marker, not the approval gate, refuses an approved demo text', async () => {
    expect(await codeOf(service('pilot', DEMO, { requireApproval: true }).get(ctx))).toBe(
      'CONSENT_NOT_APPROVED',
    );
  });

  it('FR-401, K2/F6: the marker ignores case and surrounding spaces', () => {
    expect(isDemoConsentText({ version: '0.2-LOCAL-DEMO ', legalApprovedBy: null })).toBe(true);
    expect(isDemoConsentText({ version: '1.0', legalApprovedBy: ' Local-Demo (x)' })).toBe(true);
  });

  it.each(['development', 'test'])(
    'FR-401: APP_ENV %s still serves the demo text',
    async (appEnv) => {
      const view = await service(appEnv, DEMO, { nodeEnv: 'development' }).get(ctx);
      expect(view).toMatchObject({ consentTextId: 't1', version: '0.2-local-demo' });
    },
  );

  it.each(['staging', 'pilot', 'production'])(
    'FR-401: APP_ENV %s serves a real approved text',
    async (appEnv) => {
      const view = await service(appEnv, REAL).get(ctx);
      expect(view).toMatchObject({ consentTextId: 't2', version: '1.0', legalApproved: true });
    },
  );
});
