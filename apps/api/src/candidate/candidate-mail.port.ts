// Outbound candidate email behind a port. Backend A owns the mail module and its provider (BE-06,
// templates otp, otp-lockout and consent-copy); until it binds these methods the default fails. Implementations must never log the code, the
// URL or the PDF (ADR 0003 section 6). A port that cannot send must say so: the unbound default
// rejects, so no caller records "sent" (OTP_SENT, copy_emailed_at) for a message nobody got.
import { Logger } from '@nestjs/common';

export interface OtpMail {
  readonly code: string;
  readonly testName: string;
  readonly expiresInMinutes: number;
}

export interface OtpLockoutMail {
  readonly candidateName: string;
  readonly candidateEmail: string;
  readonly testName: string;
  readonly blockedMinutes: number;
}

export interface ConsentCopyMail {
  readonly pdf: Buffer;
  readonly filename: string;
  readonly documentVersion: string;
  readonly signedAt: Date;
}

export abstract class CandidateMailPort {
  /** Template `otp`: the 6-digit sign-in code for the invitation link (FR-106). */
  abstract sendOtp(to: string, mail: OtpMail): Promise<void>;
  /** Template `otp-lockout`: tells the recruiter that the link was blocked for 30 minutes (TC-007). */
  abstract sendOtpLockout(to: string, mail: OtpLockoutMail): Promise<void>;
  /** Template `consent-copy`: the signed consent PDF as an attachment (FR-401, C-07). */
  abstract sendConsentCopy(to: string, mail: ConsentCopyMail): Promise<void>;
}

export class MailNotBoundError extends Error {
  constructor(template: string) {
    super(`No email provider is bound for candidate mail (template ${template})`);
  }
}

export class UnboundCandidateMailPort extends CandidateMailPort {
  private readonly logger = new Logger(UnboundCandidateMailPort.name);

  private fail(template: string): Promise<never> {
    this.logger.warn(
      `No email provider is bound for candidate mail; template ${template} not sent`,
    );
    return Promise.reject(new MailNotBoundError(template));
  }

  sendOtp(): Promise<void> {
    return this.fail('otp');
  }

  sendOtpLockout(): Promise<void> {
    return this.fail('otp-lockout');
  }

  sendConsentCopy(): Promise<void> {
    return this.fail('consent-copy');
  }
}
