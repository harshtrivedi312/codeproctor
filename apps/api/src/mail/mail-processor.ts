// Renders a job and sends it. The consent PDF is read by object key here, at send time: the bytes
// live in memory for the send only and never in the queue payload.
import {
  MAX_ATTACHMENT_BYTES,
  MailError,
  MailTransport,
  ObjectReader,
  scrub,
} from './mail-transport';
import { renderMail } from './mail-templates';
import type { EmailJob } from './mail-templates';

export class MailProcessor {
  constructor(
    private readonly transport: MailTransport,
    private readonly objects: ObjectReader,
    private readonly opts: { allowHttp?: boolean } = {},
  ) {}

  readonly handle = async (job: EmailJob): Promise<void> => {
    const rendered = renderMail(job, { allowHttp: this.opts.allowHttp });
    let attachment: { filename: string; contentType: string; content: Buffer } | undefined;
    // A mail that promises an attachment never goes out without one.
    if (rendered.attachmentFilename !== undefined) {
      if (!rendered.attachmentKey) throw new MailError('attachment key missing', 'none', true);
      let content: Buffer;
      try {
        content = await this.objects.read(rendered.attachmentKey, MAX_ATTACHMENT_BYTES);
      } catch (e) {
        throw scrub(e, 'attachment read failed');
      }
      if (content.length === 0) throw new MailError('attachment empty', 'none', true);
      if (content.length > MAX_ATTACHMENT_BYTES) {
        throw new MailError('attachment too large', 'none', true);
      }
      attachment = {
        filename: rendered.attachmentFilename,
        contentType: 'application/pdf',
        content,
      };
    }
    await this.transport.send({
      to: job.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      attachment,
    });
  };
}
