// Amazon SES transport (C-31). Credentials come from the AWS SDK default chain (instance role in
// pilot and production); there is deliberately no key option here. Errors are scrubbed.
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import MailComposer from 'nodemailer/lib/mail-composer';
import { MailError, MailTransport, scrub } from './mail-transport';
import type { OutgoingMail } from './mail-transport';
import { stripHeader } from './mail-templates';

export interface SesTransportOptions {
  region: string;
  /** Fixed sender address from config. */
  fromAddress: string;
  fromName?: string;
  configurationSet?: string;
  /** Tests only; refused at boot outside local and test. */
  endpoint?: string;
}

const SIMPLE_ADDRESS = /^[^\s<>@",;]+@[^\s<>@",;]+$/;

export class SesMailTransport extends MailTransport {
  private readonly client: SESv2Client;
  private readonly from: string;

  constructor(private readonly opts: SesTransportOptions) {
    super();
    this.client = new SESv2Client({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    });
    const name = stripHeader(opts.fromName ?? 'CodeProctor').replace(/["<>]/g, '');
    this.from = `"${name}" <${stripHeader(opts.fromAddress)}>`;
  }

  async send(mail: OutgoingMail): Promise<void> {
    if (!SIMPLE_ADDRESS.test(mail.to)) throw new MailError('invalid recipient');
    const subject = stripHeader(mail.subject);
    try {
      const content = mail.attachment
        ? {
            Raw: {
              Data: await new MailComposer({
                from: this.from,
                to: mail.to,
                subject,
                text: mail.text,
                html: mail.html,
                attachments: [
                  {
                    filename: stripHeader(mail.attachment.filename),
                    contentType: mail.attachment.contentType,
                    content: mail.attachment.content,
                  },
                ],
              })
                .compile()
                .build(),
            },
          }
        : {
            Simple: {
              Subject: { Data: subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: mail.text, Charset: 'UTF-8' },
                Html: { Data: mail.html, Charset: 'UTF-8' },
              },
            },
          };
      await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: this.from,
          Destination: { ToAddresses: [mail.to] },
          Content: content,
          ...(this.opts.configurationSet
            ? { ConfigurationSetName: this.opts.configurationSet }
            : {}),
        }),
      );
    } catch (e) {
      throw scrub(e, 'mail transport failed');
    }
  }
}
