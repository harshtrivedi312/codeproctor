// Renders a job and sends it. The consent PDF is read by object key here, at send time: the bytes
// live in memory for the send only and never in the queue payload.
import { MailTransport, ObjectReader, scrub } from './mail-transport';
import { renderMail } from './mail-templates';
import type { EmailJob } from './mail-templates';

export class MailProcessor {
  constructor(
    private readonly transport: MailTransport,
    private readonly objects: ObjectReader,
  ) {}

  readonly handle = async (job: EmailJob): Promise<void> => {
    const rendered = renderMail(job);
    let attachment: { filename: string; contentType: string; content: Buffer } | undefined;
    if (rendered.attachmentKey) {
      let content: Buffer;
      try {
        content = await this.objects.read(rendered.attachmentKey);
      } catch (e) {
        throw scrub(e, 'attachment read failed');
      }
      attachment = {
        filename: rendered.attachmentFilename ?? 'attachment.pdf',
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
