import { describe, expect, it } from 'vitest';
import { MOCK_CONSENT_BODY, MOCK_CONSENT_ID } from '@/mocks/candidate/handlers';
import type { ConsentDocument } from '@/features/candidate-flow/wire';
import { evaluateConsentDocument } from './placeholder-guard';
import { safeUrl } from './consent-markdown';

const approved: ConsentDocument = {
  consentTextId: MOCK_CONSENT_ID,
  version: '1.0',
  bodyMd: MOCK_CONSENT_BODY,
  legalApproved: true,
  signed: false,
  signedAt: null,
};

describe('consent placeholder guard (FR-401, C-09)', () => {
  it('FR-401: lets an approved text with no fill-ins through', () => {
    expect(evaluateConsentDocument(approved)).toEqual({ ok: true });
  });

  it('FR-401: refuses when the API says the text is not legally approved', () => {
    expect(evaluateConsentDocument({ ...approved, legalApproved: false })).toEqual({
      ok: false,
      reason: 'NOT_APPROVED',
    });
  });

  it('FR-401: refuses when the API flags legalApprovalRequired, even if legalApproved is true', () => {
    expect(evaluateConsentDocument({ ...approved, legalApprovalRequired: true })).toEqual({
      ok: false,
      reason: 'APPROVAL_REQUIRED',
    });
  });

  it.each([
    ['a square-bracket fill-in', 'Document version [x.y] ' + MOCK_CONSENT_BODY],
    ['an unfilled address', MOCK_CONSENT_BODY + '\nRysun Labs Inc., [address]'],
    ['the retention-days fill-in', MOCK_CONSENT_BODY + '\nDeleted [N] days later.'],
    ['the word placeholder', MOCK_CONSENT_BODY + '\nThis is a Legal placeholder.'],
    ['the word DRAFT', 'DRAFT v0.3 ' + MOCK_CONSENT_BODY],
    ['a demo address', MOCK_CONSENT_BODY + '\nWrite to privacy@example.com.'],
    ['a not-approved notice', MOCK_CONSENT_BODY + '\nThis text has not been approved.'],
  ])('FR-401: refuses text that contains %s', (_name, bodyMd) => {
    const result = evaluateConsentDocument({ ...approved, bodyMd });
    expect(result).toEqual({ ok: false, reason: 'PLACEHOLDER_TEXT' });
  });

  it('FR-401: refuses a placeholder version label and an empty or tiny text', () => {
    expect(evaluateConsentDocument({ ...approved, version: '[x.y]' }).ok).toBe(false);
    expect(evaluateConsentDocument({ ...approved, bodyMd: '   ' }).ok).toBe(false);
    expect(evaluateConsentDocument({ ...approved, bodyMd: 'Short.' }).ok).toBe(false);
  });

  it('FR-401: ordinary markdown links are not mistaken for fill-ins', () => {
    const withLink =
      approved.bodyMd + '\nRead the [retention schedule](https://acme.test/retention).';
    expect(evaluateConsentDocument({ ...approved, bodyMd: withLink })).toEqual({ ok: true });
  });
});

describe('consent link safety (FR-401)', () => {
  it('FR-401: allows http, https, mailto and site-relative links only', () => {
    expect(safeUrl('https://a.test/x')).toBe('https://a.test/x');
    expect(safeUrl('mailto:a@b.test')).toBe('mailto:a@b.test');
    expect(safeUrl('/retention')).toBe('/retention');
    expect(safeUrl('javascript:alert(1)')).toBe('');
    expect(safeUrl('data:text/html;base64,AAAA')).toBe('');
    expect(safeUrl('//evil.test/x')).toBe('');
    expect(safeUrl('  JaVaScRiPt:alert(1)')).toBe('');
  });
});
