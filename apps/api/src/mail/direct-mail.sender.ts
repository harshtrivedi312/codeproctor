// Direct (awaited) send through the MailTransport, for mail whose caller must know it was handed
// to the transport before it records anything as sent (candidate OTP, consent copy). The queued
// path resolves on enqueue, not on delivery, so it cannot give that guarantee. This path renders
// the same templates and uses the same transport (smtp-dev locally, SES in the pilot), but there
// is no retry: a failure rejects with a payload-free MailError. Nothing here logs.
import { renderMail } from './mail-templates';
import type { EmailJob } from './mail-templates';
import { MAX_ATTACHMENT_BYTES, MailError } from './mail-transport';
import type { MailTransport, OutgoingMail } from './mail-transport';

export class DirectMailSender {
  constructor(
    private readonly transport: MailTransport | null,
    private readonly opts: { allowHttp?: boolean } = {},
  ) {}

  /** Resolves once the transport accepted the message; rejects with a MailError otherwise. */
  async send(job: EmailJob, attachment?: { filename: string; content: Buffer }): Promise<void> {
    if (!this.transport) throw new MailError('no mail transport is configured', 'none', true);
    const rendered = renderMail(job, { allowHttp: this.opts.allowHttp });
    const mail: OutgoingMail = {
      to: job.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    };
    // A template that says 'attached' must never go out without the file (the queue's processor
    // guards the same case).
    if (rendered.attachmentFilename !== undefined && !attachment) {
      throw new MailError('attachment missing', 'none', true);
    }
    if (attachment) {
      if (attachment.content.length === 0) throw new MailError('attachment empty', 'none', true);
      if (attachment.content.length > MAX_ATTACHMENT_BYTES) {
        throw new MailError('attachment too large', 'none', true);
      }
      mail.attachment = {
        filename: attachment.filename,
        contentType: 'application/pdf',
        content: attachment.content,
      };
    }
    await this.transport.send(mail);
  }
}
