// MailPort backed by the email queue. Builds a minimal job (template id plus params) and returns
// once the queue has accepted it; rendering and sending happen in MailProcessor.
import { EmailQueuePort } from './email-queue.port';
import { MailPort } from './mail.port';
import type {
  ConsentCopyMail,
  ErasureDelayedMail,
  InvitationMail,
  MailOutcome,
  OtpLockoutMail,
  OtpMail,
  ReminderMail,
} from './mail.port';
import type { EmailJob } from './mail-templates';

export class QueuedMailPort extends MailPort {
  constructor(private readonly queue: EmailQueuePort) {
    super();
  }

  private async put(job: EmailJob): Promise<MailOutcome> {
    try {
      return (await this.queue.enqueue(job)) === 'accepted' ? 'queued' : 'failed';
    } catch {
      return 'failed';
    }
  }

  async sendPasswordReset(to: string, resetUrl: string): Promise<void> {
    await this.put({ template: 'password-reset', to, params: { resetUrl } });
  }
  async sendStaffInvite(to: string, inviteUrl: string): Promise<void> {
    await this.put({ template: 'staff-invite', to, params: { inviteUrl } });
  }
  async sendStaffAccountLocked(
    to: string,
    locked: { email: string; name: string; minutes: number },
  ): Promise<void> {
    await this.put({
      template: 'staff-account-locked',
      to,
      params: { lockedEmail: locked.email, lockedName: locked.name, minutes: locked.minutes },
    });
  }
  sendInvitation(to: string, m: InvitationMail): Promise<MailOutcome> {
    return this.put({
      template: 'invitation',
      to,
      params: {
        inviteUrl: m.inviteUrl,
        windowStartsAt: m.windowStartsAt.toISOString(),
        windowEndsAt: m.windowEndsAt.toISOString(),
      },
    });
  }
  sendReminder(to: string, m: ReminderMail): Promise<MailOutcome> {
    return this.put({
      template: 'reminder',
      to,
      params: { inviteUrl: m.inviteUrl, windowEndsAt: m.windowEndsAt.toISOString() },
    });
  }
  sendResults(to: string): Promise<MailOutcome> {
    return this.put({ template: 'results', to, params: {} });
  }
  sendOtp(to: string, m: OtpMail): Promise<MailOutcome> {
    return this.put({ template: 'otp', to, params: { otp: m.otp, minutes: m.minutes } });
  }
  sendOtpLockout(to: string, m: OtpLockoutMail): Promise<MailOutcome> {
    return this.put({
      template: 'otp-lockout',
      to,
      params: { candidateEmail: m.candidateEmail, minutes: m.minutes },
    });
  }
  sendConsentCopy(to: string, m: ConsentCopyMail): Promise<MailOutcome> {
    return this.put({ template: 'consent-copy', to, params: { pdfKey: m.pdfKey } });
  }
  sendErasureDelayed(to: string, m: ErasureDelayedMail): Promise<MailOutcome> {
    return this.put({
      template: 'erasure-delayed',
      to,
      params: { delayedUntil: m.delayedUntil.toISOString() },
    });
  }
}
