// CandidateMailPort bound to the mail module (BE-06). Sends are awaited through DirectMailSender,
// so each method resolves only after the transport (smtp-dev or SES) accepted the message and
// rejects otherwise: OtpService and ConsentService record OTP_SENT / copy_emailed_at after resolve.
// Never logs the code, the PDF, an address or a body (ADR 0003 section 6).
import { Injectable } from '@nestjs/common';
import { DirectMailSender } from '../mail/direct-mail.sender';
import { CandidateMailPort } from './candidate-mail.port';
import type { ConsentCopyMail, OtpLockoutMail, OtpMail } from './candidate-mail.port';

@Injectable()
export class MailBackedCandidateMailPort extends CandidateMailPort {
  constructor(private readonly sender: DirectMailSender) {
    super();
  }

  sendOtp(to: string, mail: OtpMail): Promise<void> {
    return this.sender.send({
      template: 'otp',
      to,
      params: { otp: mail.code, minutes: mail.expiresInMinutes },
    });
  }

  sendOtpLockout(to: string, mail: OtpLockoutMail): Promise<void> {
    return this.sender.send({
      template: 'otp-lockout',
      to,
      params: {
        candidateEmail: mail.candidateEmail,
        candidateName: mail.candidateName,
        testName: mail.testName,
        minutes: mail.blockedMinutes,
      },
    });
  }

  sendConsentCopy(to: string, mail: ConsentCopyMail): Promise<void> {
    return this.sender.send(
      {
        template: 'consent-copy',
        to,
        params: { documentVersion: mail.documentVersion, signedAt: mail.signedAt.toISOString() },
      },
      { filename: mail.filename, content: mail.pdf },
    );
  }
}
