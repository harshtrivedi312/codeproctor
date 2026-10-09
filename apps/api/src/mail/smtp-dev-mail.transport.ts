// Local development mail transport (DL-54): plain SMTP, no auth, no TLS, to Mailpit. Config refuses
// EMAIL_PROVIDER=smtp-dev unless APP_ENV is exactly development (see localAdapterProblem). Errors
// are scrubbed: nothing here logs an address, subject or body.
import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { MailError, MailTransport, scrub } from './mail-transport';
import type { OutgoingMail } from './mail-transport';
import { stripHeader } from './mail-templates';

export interface SmtpDevOptions {
  host: string;
  port: number;
  fromAddress: string;
}

const SIMPLE_ADDRESS = /^[^\s<>@",;]+@[^\s<>@",;]+$/;

export class SmtpDevMailTransport extends MailTransport {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(opts: SmtpDevOptions) {
    super();
    this.transporter = createTransport({
      host: opts.host,
      port: opts.port,
      secure: false,
      ignoreTLS: true,
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    });
    this.from = `"CodeProctor" <${stripHeader(opts.fromAddress)}>`;
  }

  async send(mail: OutgoingMail): Promise<void> {
    if (mail.to.length > 254 || !SIMPLE_ADDRESS.test(mail.to)) {
      throw new MailError('invalid recipient', 'none', true);
    }
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: mail.to,
        subject: stripHeader(mail.subject),
        text: mail.text,
        html: mail.html,
        ...(mail.attachment
          ? {
              attachments: [
                {
                  filename: stripHeader(mail.attachment.filename),
                  contentType: mail.attachment.contentType,
                  content: mail.attachment.content,
                },
              ],
            }
          : {}),
      });
    } catch (e) {
      throw scrub(e, 'mail transport failed');
    }
  }
}
