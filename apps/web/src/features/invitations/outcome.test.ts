import { describe, expect, it } from 'vitest';
import { mailNextStep, mailReason, unprocessableText } from './outcome';

describe('FR-303: mail outcome words', () => {
  it('never says sent for an outcome that is not queued', () => {
    for (const mail of ['disabled', 'failed', 'noop', 'anything-else']) {
      expect(mailReason(mail)).toMatch(/no email was sent/);
    }
    expect(mailReason('disabled')).toMatch(/No email service/);
    expect(mailReason('failed')).toMatch(/could not be queued/);
  });

  it('says what to do and that there is no resend', () => {
    expect(mailNextStep('2030-01-01T00:00:00Z')).toMatch(/no resend option yet/);
    expect(mailNextStep()).toMatch(/administrator/);
  });
});

describe('FR-303: 422 text', () => {
  it('uses the code when there is one', () => {
    expect(unprocessableText('REASON_NOT_ENABLED', 'x', [])).toMatch(/not available yet/);
  });
  it('lists the slots from errors[]', () => {
    expect(
      unprocessableText('', 'Request validation failed', ['sections[0].questions[0]: a']),
    ).toMatch(/sections\[0\]\.questions\[0\]: a/);
  });
  it('falls back to the detail, then to a neutral sentence, never the closed window', () => {
    expect(unprocessableText('', 'The test is archived.', [])).toMatch(/The test is archived\./);
    expect(unprocessableText('', '', [])).not.toMatch(/closed/);
    expect(unprocessableText('', 'The test is archived.', [])).not.toMatch(/closed/);
  });
});
