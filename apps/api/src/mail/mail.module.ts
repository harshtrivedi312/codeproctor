// Mail wiring (C-31, DL-33). EMAIL_PROVIDER=noop binds NoopMailPort (local, test); ses binds the
// queued mail path: QueuedMailPort -> EmailQueuePort (in-process now, BullMQ later, see
// email-queue.port.ts) -> MailProcessor -> SesMailTransport. ObjectReader stays unconfigured until
// the storage module provides one; consent-copy mail fails (and is dropped after its retries)
// until then.
import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isLiveEnv } from '../config/env';
import type { Env } from '../config/env';
import { EmailQueuePort } from './email-queue.port';
import { InProcessEmailQueue } from './in-process-email-queue';
import { MailPort, NoopMailPort } from './mail.port';
import { MailProcessor } from './mail-processor';
import { MailTransport, ObjectReader, UnconfiguredObjectReader } from './mail-transport';
import { QueuedMailPort } from './queued-mail.port';
import { SesMailTransport } from './ses-mail.transport';
import { SmtpDevMailTransport } from './smtp-dev-mail.transport';

// True when mail goes through the queued path (ses, or smtp-dev for local Mailpit, DL-54).
const sesOnly = (config: ConfigService<Env, true>): boolean => {
  const provider = config.get('EMAIL_PROVIDER', { infer: true });
  return provider === 'ses' || provider === 'smtp-dev';
};

@Global()
@Module({
  providers: [
    { provide: ObjectReader, useClass: UnconfiguredObjectReader },
    {
      provide: MailTransport,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): MailTransport | null => {
        if (!sesOnly(config)) return null;
        if (config.get('EMAIL_PROVIDER', { infer: true }) === 'smtp-dev') {
          new Logger('MailModule').warn('smtp-dev mail: local only');
          return new SmtpDevMailTransport({
            host: config.get('SMTP_DEV_HOST', { infer: true }),
            port: config.get('SMTP_DEV_PORT', { infer: true }),
            fromAddress:
              config.get('SES_FROM_ADDRESS', { infer: true }) ?? 'no-reply@codeproctor.local',
          });
        }
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
          ? new InProcessEmailQueue(
              new MailProcessor(transport, reader, {
                allowHttp: !isLiveEnv({
                  APP_ENV: config.get('APP_ENV', { infer: true }),
                  NODE_ENV: config.get('NODE_ENV', { infer: true }),
                }),
              }).handle,
            )
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
