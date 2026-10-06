import { MailNotBoundError, UnboundCandidateMailPort } from './candidate-mail.port';

describe('Unbound candidate mail (FR-106, FR-401)', () => {
  it('FR-106: the default port fails, so nothing is recorded as sent for a message nobody received', async () => {
    const port = new UnboundCandidateMailPort();
    await expect(port.sendOtp()).rejects.toBeInstanceOf(MailNotBoundError);
    await expect(port.sendOtpLockout()).rejects.toBeInstanceOf(MailNotBoundError);
    await expect(port.sendConsentCopy()).rejects.toBeInstanceOf(MailNotBoundError);
  });
});
