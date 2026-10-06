// Mail wiring (C-31, DL-33). EMAIL_PROVIDER=noop binds NoopMailPort (local, test); ses binds the
// queued mail path: QueuedMailPort -> EmailQueuePort (in-process now, BullMQ later, see
// email-queue.port.ts) -> MailProcessor -> SesMailTransport. ObjectReader stays unconfigured until
// the storage module provides one; consent-copy mail fails (and is dropped after its retries)
// until then.
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import { EmailQueuePort } from './email-queue.port';
import { InProcessEmailQueue } from './in-process-email-queue';
import { MailPort, NoopMailPort } from './mail.port';
import { MailProcessor } from './mail-processor';
import { MailTransport, ObjectReader, UnconfiguredObjectReader } from './mail-transport';
import { QueuedMailPort } from './queued-mail.port';
import { SesMailTransport } from './ses-mail.transport';

const sesOnly = (config: ConfigService<Env, true>): boolean =>
  config.get('EMAIL_PROVIDER', { infer: true }) === 'ses';

@Global()
@Module({
  providers: [
    { provide: ObjectReader, useClass: UnconfiguredObjectReader },
    {
      provide: MailTransport,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): MailTransport | null => {
        if (!sesOnly(config)) return null;
        const from = config.get('SES_FROM_ADDRESS', { infer: true });
        if (!from) throw new Error('SES_FROM_ADDRESS is required when EMAIL_PROVIDER=ses');
        return new SesMailTransport({
          region: config.get('AWS_REGION', { infer: true }),
          fromAddress: from,
          configurationSet: config.get('SES_CONFIGURATION_SET', { infer: true }),
          endpoint: config.get('SES_ENDPOINT', { infer: true }),
        });
      },
    },
    {
      provide: EmailQueuePort,
      inject: [ConfigService, MailTransport, ObjectReader],
      useFactory: (
        config: ConfigService<Env, true>,
        transport: MailTransport | null,
        reader: ObjectReader,
      ): EmailQueuePort | null =>
        sesOnly(config) && transport
          ? new InProcessEmailQueue(new MailProcessor(transport, reader).handle)
          : null,
    },
    {
      provide: MailPort,
      inject: [EmailQueuePort],
      useFactory: (queue: EmailQueuePort | null): MailPort =>
        queue ? new QueuedMailPort(queue) : new NoopMailPort(),
    },
  ],
  exports: [MailPort],
})
export class MailModule {}
