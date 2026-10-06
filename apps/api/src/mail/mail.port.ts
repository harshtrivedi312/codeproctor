// Outbound email behind an interface. The provider and the templates arrive in Step 6; until
// then the default implementation drops the message. Implementations must never log the URL
// or the token it carries (ADR 0003 section 6).
export abstract class MailPort {
  /** Template password-reset (FR-107). resetUrl carries the single-use token. */
  abstract sendPasswordReset(to: string, resetUrl: string): Promise<void>;

  /** Template staff-invite (ADR 0003 section 4). inviteUrl carries the 72 hour single-use token. */
  abstract sendStaffInvite(to: string, inviteUrl: string): Promise<void>;

  /**
   * Template staff-account-locked (P-03, FR-101): sent to each SUPER_ADMIN of the org when a staff
   * account of that org gets locked. Names the locked account, never any secret.
   */
  abstract sendStaffAccountLocked(
    to: string,
    locked: { email: string; name: string; minutes: number },
  ): Promise<void>;
}

export class NoopMailPort extends MailPort {
  sendPasswordReset(): Promise<void> {
    return Promise.resolve();
  }
  sendStaffInvite(): Promise<void> {
    return Promise.resolve();
  }
  sendStaffAccountLocked(): Promise<void> {
    return Promise.resolve();
  }
}
