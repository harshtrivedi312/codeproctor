import { Global, Module } from '@nestjs/common';
import { MailPort, NoopMailPort } from './mail.port';

@Global()
@Module({
  providers: [{ provide: MailPort, useClass: NoopMailPort }],
  exports: [MailPort],
})
export class MailModule {}
