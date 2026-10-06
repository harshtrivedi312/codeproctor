// Outbound email behind an interface (DL-33: one MailPort, owned by mail/). Implementations must
// never log an address, URL, token, OTP or object key (ADR 0003 section 6, CLAUDE.md).
//
// The methods added in BE-06b resolve to a MailOutcome so a caller can tell "accepted for delivery"
// from "could not even be queued" ('queued' means accepted by the email queue, not delivered). The
// three original methods keep Promise<void> so existing callers and typed test fakes are unchanged;
// FU-BE-89 widens them to MailOutcome together with its callers.
export type MailOutcome = 'queued' | 'failed' | 'disabled';

/** Parameters of the candidate and recruiter mails added in BE-06b. Dates are server times. */
export interface InvitationMail {
  /** Single-use invitation link carrying the token. Never logged. */
  inviteUrl: string;
  windowStartsAt: Date;
  windowEndsAt: Date;
}
export interface ReminderMail {
  inviteUrl: string;
  windowEndsAt: Date;
}
export interface OtpMail {
  /** The 6 digit one-time code. Never logged. */
  otp: string;
  minutes: number;
}
export interface OtpLockoutMail {
  /** Address of the locked candidate, shown to the recruiter only. */
  candidateEmail: string;
  minutes: number;
}
export interface ConsentCopyMail {
  /**
   * Object-storage key of the signed consent PDF (consents.pdf_key). The key, not the bytes, goes
   * into the job; the processor reads the object at send time. Never logged.
   */
  pdfKey: string;
}
export interface ErasureDelayedMail {
  /** Server date until which the erasure is delayed (D-19). */
  delayedUntil: Date;
}

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

  /** Template invitation (FR-303): test link plus the start window. No recruiter free text. */
  abstract sendInvitation(to: string, mail: InvitationMail): Promise<MailOutcome>;

  /** Template reminder: sent 24 hours before window_end. */
  abstract sendReminder(to: string, mail: ReminderMail): Promise<MailOutcome>;

  /** Template results: a notification only, it carries no result data. */
  abstract sendResults(to: string): Promise<MailOutcome>;

  /** Template otp: the candidate's email one-time code. */
  abstract sendOtp(to: string, mail: OtpMail): Promise<MailOutcome>;

  /** Template otp-lockout: recruiter notice that a candidate link is blocked (TC-007). */
  abstract sendOtpLockout(to: string, mail: OtpLockoutMail): Promise<MailOutcome>;

  /** Template consent-copy (D-17): the signed consent PDF attached, read by object key. */
  abstract sendConsentCopy(to: string, mail: ConsentCopyMail): Promise<MailOutcome>;

  /** Template erasure-delayed (D-19). */
  abstract sendErasureDelayed(to: string, mail: ErasureDelayedMail): Promise<MailOutcome>;
}

/** Drops every message. Bound when EMAIL_PROVIDER=noop (local, test). */
export class NoopMailPort extends MailPort {
  private drop(): Promise<MailOutcome> {
    return Promise.resolve('disabled');
  }
  sendPasswordReset(): Promise<void> {
    return Promise.resolve();
  }
  sendStaffInvite(): Promise<void> {
    return Promise.resolve();
  }
  sendStaffAccountLocked(): Promise<void> {
    return Promise.resolve();
  }
  sendInvitation(): Promise<MailOutcome> {
    return this.drop();
  }
  sendReminder(): Promise<MailOutcome> {
    return this.drop();
  }
  sendResults(): Promise<MailOutcome> {
    return this.drop();
  }
  sendOtp(): Promise<MailOutcome> {
    return this.drop();
  }
  sendOtpLockout(): Promise<MailOutcome> {
    return this.drop();
  }
  sendConsentCopy(): Promise<MailOutcome> {
    return this.drop();
  }
  sendErasureDelayed(): Promise<MailOutcome> {
    return this.drop();
  }
}
