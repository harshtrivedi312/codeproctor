// Outbound email behind an interface. The provider and the templates arrive in Step 6; until
// then the default implementation drops the message. Implementations must never log the URL
// or the token it carries (ADR 0003 section 6).
export abstract class MailPort {
  /** Template password-reset (FR-107). resetUrl carries the single-use token. */
  abstract sendPasswordReset(to: string, resetUrl: string): Promise<void>;
}

export class NoopMailPort extends MailPort {
  sendPasswordReset(): Promise<void> {
    return Promise.resolve();
  }
}
